// Forecast GTA VI's launch-day Twitch viewers, hour by hour (make.fun bounty
// gta6-twitch-ccu-forecast-01). Node 22, standard library only, no network.
//
// Idea: a launch day has a shape. Past big console launches that unlocked at
// midnight local time all trace a similar curve once you divide by their
// first-hour print: quiet while only New Zealand and Europe are in, then a
// surge as the US east coast (05:00Z) and west coast (08:00Z) wake up, a
// midday plateau, and a slow evening fade. So for each hour h = 2..24 I take
// the comparables' log-ratios ln(viewers_h / viewers_1), pool them with
// weights that favour launches whose hour-1 print is near this case's (in
// log space) and whose unlock rolled at midnight local time like GTA VI's,
// and read off a weighted median for the centre and a weighted spread for
// the quantile width. The median is robust to the odd launch that exploded
// or fizzled; the spread widens where past launches disagreed most. When
// too few comparables cover an hour, the forecast falls back to the house
// persistence shape (flat median, random-walk spread), so it never emits
// an invalid row.
//
// Everything is deterministic: fixed weights, fixed order, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** How far apart two hour-1 prints may be (in log units) before a launch
 *  stops informing this case: a Gaussian kernel with this width. */
const SCALE_SD = 1.2;
/** Weight given to a comparable whose unlock pattern differs from the
 *  target's rolling-midnight unlock (a simultaneous global unlock traces
 *  a different intraday shape). */
const OTHER_UNLOCK_WEIGHT = 0.3;
/** The quantile spread is the comparables' dispersion scaled by this. */
const SPREAD_MULT = 0.9;
/** The spread never goes below this (log units) or above this. */
const SPREAD_MIN = 0.12;
const SPREAD_MAX = 0.9;
/** Hours with fewer than this many usable comparables fall back to the
 *  house persistence shape. */
const MIN_COMPARABLES = 3;
/** The fallback spread, in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;

interface Comparable {
  name: string;
  day_start: string;
  unlock: string;
  hourly: Array<{ from: string; viewers: number | null }>;
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** True when the unlock note describes a rolling midnight-local unlock. */
const isRollingUnlock = (text: string | undefined): boolean =>
  /midnight local|rolling/i.test(text ?? '');

/**
 * A comparable's release-day curve: viewers for hours 1..24 of its UTC
 * release day, null where the source has no point for that hour.
 */
const releaseDayCurve = (comp: Comparable): Array<number | null> => {
  const curve: Array<number | null> = new Array(25).fill(null);
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return curve;
  for (const pt of comp.hourly ?? []) {
    if (pt.viewers == null || pt.viewers <= 0) continue;
    const h = Math.round((Date.parse(pt.from) - start) / 3600000) + 1;
    if (h >= 1 && h <= 24 && curve[h] === null) curve[h] = pt.viewers;
  }
  return curve;
};

/** Weighted median of [value, weight] pairs. */
const weightedMedian = (pairs: Array<[number, number]>): number => {
  const sorted = pairs.filter((p) => p[1] > 0).sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p[1];
    if (acc >= total / 2) return p[0];
  }
  return sorted[sorted.length - 1][0];
};

/** Weighted mean of [value, weight] pairs. */
const weightedMean = (pairs: Array<[number, number]>): number => {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  return pairs.reduce((s, p) => s + p[0] * p[1], 0) / total;
};

/** Weighted standard deviation of [value, weight] pairs around `mean`. */
const weightedStd = (pairs: Array<[number, number]>, mean: number): number => {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  const v = pairs.reduce((s, p) => s + p[1] * (p[0] - mean) ** 2, 0) / total;
  return Math.sqrt(Math.max(0, v));
};

/**
 * The five quantiles for one hour h, from the comparables' pooled
 * log-ratios at that hour. Falls back to persistence when the pool is
 * too thin. `curves` holds each usable comparable's release-day curve
 * together with its similarity weight to this case.
 */
const hourQuantiles = (
  p1: number,
  h: number,
  curves: Array<{ curve: Array<number | null>; weight: number }>,
): number[] => {
  const pairs: Array<[number, number]> = [];
  for (const { curve, weight } of curves) {
    const v1 = curve[1];
    const vh = curve[h];
    if (v1 == null || vh == null) continue;
    pairs.push([Math.log(vh / v1), weight]);
  }
  if (pairs.length < MIN_COMPARABLES) {
    return Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1))));
  }
  const centre = weightedMedian(pairs);
  const spread = Math.min(
    SPREAD_MAX,
    Math.max(SPREAD_MIN, SPREAD_MULT * weightedStd(pairs, weightedMean(pairs))),
  );
  // Build the row, then enforce the contest's shape rules outright:
  // finite, above 0, at most 1e9, non-decreasing.
  const raw = Z.map((z) => p1 * Math.exp(centre + z * spread));
  const row: number[] = [];
  for (let j = 0; j < raw.length; j++) {
    let q = round2(raw[j]);
    if (!Number.isFinite(q) || q <= 0) q = 1;
    if (q > 1e9) q = 1e9;
    if (j > 0 && q < row[j - 1]) q = row[j - 1];
    row.push(q);
  }
  return row;
};

/**
 * Forecast one case: pool the comparables, weight each by how close its
 * hour-1 print is to this case's (log-Gaussian kernel) and by whether its
 * unlock rolled at midnight local time like the target's, then forecast
 * hours 2..24 from the pooled shape scaled by this case's hour-1 print.
 */
const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('case has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const logP1 = Math.log(p1);
  const curves: Array<{ curve: Array<number | null>; weight: number }> = [];
  for (const comp of c.comparables ?? []) {
    // The GTA VI category's own pre-release history is not a launch:
    // its "day" is a premiere, not a midnight unlock, so it carries no
    // release-day shape and must not enter the pool.
    if (/not a launch/i.test(comp.unlock ?? '')) continue;
    const curve = releaseDayCurve(comp);
    if (curve[1] == null) continue;
    const scaleW = Math.exp(-((Math.log(curve[1]) - logP1) ** 2) / (2 * SCALE_SD * SCALE_SD));
    const unlockW = isRollingUnlock(comp.unlock) ? 1 : OTHER_UNLOCK_WEIGHT;
    curves.push({ curve, weight: scaleW * unlockW });
  }
  return c.forecast.map(({ hour }) => ({ hour, q: hourQuantiles(p1, hour, curves) }));
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}

