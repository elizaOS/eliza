/**
 * ScreenSpot grounding harness (#9170 M14).
 *
 * ScreenSpot scores click-grounding: given an instruction + screenshot, a model
 * predicts a click point; the sample is correct iff the point lands inside the
 * ground-truth element bbox. This module is the scorer + harness — it consumes a
 * grounder function (e.g. the M9 Set-of-Marks marks → `center`, or the M10
 * `predictClick` seam) and reports point-in-bbox accuracy.
 *
 * The dataset itself is NOT vendored (the real ScreenSpot images are large and
 * licensed separately); a runner provides samples + a grounder and gets a score.
 * Pure scoring is unit-tested with synthetic samples.
 */

export interface ScreenSpotSample {
  id: string;
  instruction: string;
  /** Ground-truth target bbox `[x, y, w, h]` in image pixels. */
  bbox: [number, number, number, number];
  imageWidth: number;
  imageHeight: number;
  /** Optional source group (e.g. "icon" / "text" / platform) for breakdowns. */
  group?: string;
}

export interface ScreenSpotPrediction {
  x: number;
  y: number;
}

/** A predicted point lands inside the bbox (inclusive of edges). Pure. */
export function pointInBbox(
  point: ScreenSpotPrediction,
  bbox: readonly [number, number, number, number],
): boolean {
  const [x, y, w, h] = bbox;
  return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
}

export interface ScreenSpotSampleResult {
  id: string;
  group?: string;
  predicted: ScreenSpotPrediction | null;
  correct: boolean;
}

export interface ScreenSpotScore {
  total: number;
  correct: number;
  /** correct / total (0 when total is 0). */
  accuracy: number;
  /** Per-group accuracy breakdown. */
  byGroup: Record<string, { total: number; correct: number; accuracy: number }>;
  results: ScreenSpotSampleResult[];
}

/**
 * Run a grounder over the samples and score point-in-bbox accuracy. The grounder
 * returns a predicted click point (or `null` when it abstains — counted wrong).
 * Samples run sequentially so a real grounder's per-call I/O is not blasted in
 * parallel.
 */
export async function scoreScreenSpot(
  samples: readonly ScreenSpotSample[],
  predict: (
    sample: ScreenSpotSample,
  ) => Promise<ScreenSpotPrediction | null> | ScreenSpotPrediction | null,
): Promise<ScreenSpotScore> {
  const results: ScreenSpotSampleResult[] = [];
  const groups = new Map<string, { total: number; correct: number }>();

  for (const sample of samples) {
    const predicted = await predict(sample);
    const correct = predicted ? pointInBbox(predicted, sample.bbox) : false;
    results.push({
      id: sample.id,
      ...(sample.group ? { group: sample.group } : {}),
      predicted,
      correct,
    });
    const key = sample.group ?? "all";
    const g = groups.get(key) ?? { total: 0, correct: 0 };
    g.total += 1;
    if (correct) g.correct += 1;
    groups.set(key, g);
  }

  const correct = results.filter((r) => r.correct).length;
  const total = results.length;
  const byGroup: ScreenSpotScore["byGroup"] = {};
  for (const [key, g] of groups) {
    byGroup[key] = {
      total: g.total,
      correct: g.correct,
      accuracy: g.total > 0 ? g.correct / g.total : 0,
    };
  }

  return {
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    byGroup,
    results,
  };
}
