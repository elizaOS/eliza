/**
 * Per-benchmark scorers.
 *
 *   - exactMatch: TextVQA-style normalised exact match against any reference answer.
 *   - anls: DocVQA's Average Normalized Levenshtein Similarity (Biten et al. 2019,
 *     https://arxiv.org/abs/1905.13648). Threshold τ = 0.5 (papers default).
 *   - relaxedNumeric: ChartQA's relaxed numeric correctness (±5% tolerance for
 *     numbers, exact-match otherwise). Masry et al. 2022,
 *     https://aclanthology.org/2022.findings-acl.177/.
 *   - bboxIoU + iouHit: ScreenSpot's "click inside bbox" or IoU > 0.5. Cheng et
 *     al. 2024, https://arxiv.org/abs/2401.10935.
 *   - osworldStepMatch: simple action-sequence agreement against a known-good
 *     trace (OSWorld's true scorer evaluates final environment state; our
 *     trace-similarity scorer is a fast proxy that does not require the full
 *     VM harness).
 *
 * Scorers return `[0, 1]`. They MUST not throw — return 0 for malformed input
 * and let the adapter attach a reason via `detail`.
 */
import type { BBox, Point, PredictedAction } from "../types.ts";

// ── TextVQA / VQA exact-match ──────────────────────────────────────────────

const ARTICLES = new Set(["a", "an", "the"]);
const PUNCTUATION = /[.,!?;:'"`()[\]{}]/g;

/**
 * VQA normalisation: lowercase, strip articles + punctuation, collapse
 * whitespace. Same recipe as the official VQAv2 evaluator
 * (https://visualqa.org/evaluation.html), which TextVQA inherits.
 */
export function normaliseAnswer(answer: string): string {
  if (!answer) return "";
  const lowered = answer.toLowerCase().trim();
  const stripped = lowered.replace(PUNCTUATION, " ");
  const tokens = stripped
    .split(/\s+/)
    .filter((tok) => tok && !ARTICLES.has(tok));
  return tokens.join(" ").trim();
}

/**
 * TextVQA scoring: prediction scores `min(matches/3, 1)` where `matches` is
 * the count of reference answers (10 per VQA sample) it matches after
 * normalisation. We accept any number of references.
 */
export function vqaSoftScore(prediction: string, references: string[]): number {
  if (!references.length) return 0;
  const normPred = normaliseAnswer(prediction);
  if (!normPred) return 0;
  let matches = 0;
  for (const ref of references) {
    if (normaliseAnswer(ref) === normPred) matches += 1;
  }
  return Math.min(matches / 3, 1);
}

/** Exact-match (binary) for completeness; preferred by some VQA leaderboards. */
export function exactMatch(prediction: string, references: string[]): number {
  const normPred = normaliseAnswer(prediction);
  if (!normPred) return 0;
  for (const ref of references) {
    if (normaliseAnswer(ref) === normPred) return 1;
  }
  return 0;
}

// ── DocVQA — ANLS ──────────────────────────────────────────────────────────

/** Iterative Levenshtein distance — O(n·m) time, O(min(n, m)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const prev = new Array<number>(shorter.length + 1);
  for (let i = 0; i <= shorter.length; i += 1) prev[i] = i;
  for (let j = 1; j <= longer.length; j += 1) {
    let prevDiag = prev[0];
    prev[0] = j;
    for (let i = 1; i <= shorter.length; i += 1) {
      const tmp = prev[i];
      const cost = shorter[i - 1] === longer[j - 1] ? 0 : 1;
      prev[i] = Math.min(prev[i] + 1, prev[i - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[shorter.length];
}

/**
 * Average Normalized Levenshtein Similarity for one prediction vs. a list
 * of accepted answers. Per the DocVQA paper:
 *   NLS(p, r) = 1 - levenshtein(p, r) / max(|p|, |r|)
 *   ANLS = max over references; threshold τ = 0.5 (below → score 0).
 */
export function anls(
  prediction: string,
  references: string[],
  threshold = 0.5,
): number {
  if (!references.length) return 0;
  const normPred = prediction.toLowerCase().trim();
  if (!normPred) return 0;
  let best = 0;
  for (const ref of references) {
    const normRef = ref.toLowerCase().trim();
    if (!normRef) continue;
    const dist = levenshtein(normPred, normRef);
    const denom = Math.max(normPred.length, normRef.length);
    const score = denom === 0 ? 0 : 1 - dist / denom;
    if (score > best) best = score;
  }
  return best >= threshold ? best : 0;
}

// ── ChartQA — relaxed numeric correctness ─────────────────────────────────

const NUMBER_RE = /-?\d+(?:\.\d+)?/;

function tryParseNumber(text: string): number | null {
  const match = text.replace(/[,%$]/g, "").match(NUMBER_RE);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * ChartQA scoring: numeric answers match if `|p - r| / |r| ≤ tolerance`
 * (default ±5%). Non-numeric answers fall back to normalised exact-match.
 */
export function relaxedNumeric(
  prediction: string,
  references: string[],
  tolerance = 0.05,
): number {
  if (!references.length) return 0;
  const predNum = tryParseNumber(prediction);
  for (const ref of references) {
    const refNum = tryParseNumber(ref);
    if (predNum !== null && refNum !== null) {
      if (refNum === 0) {
        if (Math.abs(predNum) <= tolerance) return 1;
        continue;
      }
      const relErr = Math.abs(predNum - refNum) / Math.abs(refNum);
      if (relErr <= tolerance) return 1;
      continue;
    }
    if (normaliseAnswer(prediction) === normaliseAnswer(ref)) return 1;
  }
  return 0;
}

// ── ScreenSpot — bbox containment + IoU ───────────────────────────────────

/** Return true when the click coordinate lies inside the bounding box. */
export function pointInBBox(point: Point, bbox: BBox): boolean {
  const [xMin, yMin, xMax, yMax] = bbox;
  return (
    point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax
  );
}

/**
 * IoU between two boxes; returns 0 when either is degenerate. Used for
 * predicted-bbox grounding (some grounders return a region rather than a
 * single click).
 */
export function bboxIoU(a: BBox, b: BBox): number {
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  if (ax2 <= ax1 || ay2 <= ay1 || bx2 <= bx1 || by2 <= by1) return 0;
  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);
  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const inter = interW * interH;
  if (inter === 0) return 0;
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  return inter / (areaA + areaB - inter);
}

/**
 * ScreenSpot scoring: 1 when the predicted click is inside the target bbox,
 * else 0. The CUA literature also reports IoU-thresholded versions for
 * region grounders; `iouHit` covers that path.
 */
export function clickHit(click: Point | undefined, bbox: BBox): number {
  if (!click) return 0;
  return pointInBBox(click, bbox) ? 1 : 0;
}

export function iouHit(predicted: BBox, target: BBox, threshold = 0.5): number {
  return bboxIoU(predicted, target) >= threshold ? 1 : 0;
}

// ── OSWorld — action-sequence agreement ───────────────────────────────────

/**
 * Compare a predicted action sequence to a reference trajectory. Score is
 * the fraction of reference steps that are matched in order, with a small
 * tolerance: CLICK actions match when the predicted click lies within
 * `clickTolerancePx` (default 32 px ≈ one large icon) of the reference,
 * TYPING matches on normalised text, HOTKEY/SCROLL match on type only.
 *
 * This is a fast trace-similarity proxy, not the full OSWorld environment
 * scorer (which executes actions in a VM and checks final state). We use
 * it for smoke runs and for cheap regression detection.
 */
export function osworldStepMatch(
  predicted: PredictedAction[],
  reference: PredictedAction[],
  clickTolerancePx = 32,
): number {
  if (!reference.length) return 0;
  // Longest-common-subsequence over (predicted, reference) under
  // `actionMatches`. Score = LCS / |reference|. This is permissive about
  // extra predicted steps (the agent overdoes it) and partial about
  // missing reference steps (the agent skips one).
  const m = predicted.length;
  const n = reference.length;
  const dp = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (actionMatches(predicted[i - 1], reference[j - 1], clickTolerancePx)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp[m][n] / reference.length;
}

function actionMatches(
  pred: PredictedAction,
  ref: PredictedAction,
  tolerancePx: number,
): boolean {
  if (pred.type !== ref.type) return false;
  if (ref.type === "CLICK") {
    if (pred.x === undefined || pred.y === undefined) return false;
    if (ref.x === undefined || ref.y === undefined) return true;
    const dx = pred.x - ref.x;
    const dy = pred.y - ref.y;
    return Math.sqrt(dx * dx + dy * dy) <= tolerancePx;
  }
  if (ref.type === "TYPING") {
    return (
      typeof pred.text === "string" &&
      typeof ref.text === "string" &&
      normaliseAnswer(pred.text) === normaliseAnswer(ref.text)
    );
  }
  if (ref.type === "HOTKEY") {
    if (!pred.keys || !ref.keys) return false;
    if (pred.keys.length !== ref.keys.length) return false;
    return pred.keys.every(
      (key, i) => key.toLowerCase() === ref.keys?.[i]?.toLowerCase(),
    );
  }
  return true;
}
