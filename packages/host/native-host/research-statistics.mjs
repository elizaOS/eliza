/** Pure research arithmetic; hosts own cohorts, evidence quality and interpretation. */

/** @param {number} successes @param {number} trials */
export function wilson95Interval(successes, trials) {
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    successes < 0 ||
    trials < 0 ||
    successes > trials
  ) {
    throw new RangeError("Invalid binomial counts");
  }
  if (!trials) return null;
  const p = successes / trials,
    z = 1.959963984540054;
  const a = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / a;
  const half =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) /
    a;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  };
}

/**
 * Deterministic percentile bootstrap of independent sampling-unit values.
 * Quantiles use nearest rank. This does not establish independence or causal effects.
 * @param {readonly number[]} values
 * @param {{resamples: number, seed: number, lowerQuantile: number, upperQuantile: number, maxDraws: number}} options
 */
export function bootstrapMeanInterval(
  values,
  { resamples, seed, lowerQuantile, upperQuantile, maxDraws },
) {
  if (
    !Array.isArray(values) ||
    !Number.isSafeInteger(resamples) ||
    resamples < 1 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isFinite(lowerQuantile) ||
    !Number.isFinite(upperQuantile) ||
    lowerQuantile <= 0 ||
    upperQuantile >= 1 ||
    lowerQuantile >= upperQuantile ||
    !Number.isSafeInteger(maxDraws) ||
    maxDraws < 1 ||
    !Number.isSafeInteger(values.length * resamples) ||
    values.length * resamples > maxDraws
  ) {
    throw new RangeError("Invalid bootstrap policy");
  }
  const input = Array.from(values);
  if (
    input.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new RangeError("Invalid bootstrap values");
  }
  if (input.length < 2) return null;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const samples = Array.from({ length: resamples }, () => {
    let total = 0;
    for (let i = 0; i < input.length; i++)
      total += input[Math.floor(random() * input.length)];
    const mean = total / input.length;
    if (!Number.isFinite(mean)) throw new RangeError("Bootstrap mean overflow");
    return mean;
  }).sort((a, b) => a - b);
  return {
    lower: samples[Math.ceil(lowerQuantile * resamples) - 1],
    upper: samples[Math.ceil(upperQuantile * resamples) - 1],
  };
}
