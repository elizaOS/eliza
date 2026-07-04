// Judge-based scorer for the prose/NL LifeOps optimization tasks (#11384).
//
// Four of the eight LifeOps capabilities emit narrative text
// (reminder_dispatch, meeting_prep, morning_brief) or a prose-bearing JSON
// envelope (screentime_recap). The deterministic scorers in
// `optimizers/scoring.ts` (exact structured-field match / token overlap)
// return ~0 for any live completion of those tasks, so GEPA has no gradient
// to optimize against. This module grades a completion against an explicit
// per-example rubric using a live judge model instead.
//
// The judge transport is injected (`EvalModelClient`) so this stays
// provider-agnostic: Cerebras, Anthropic, or the subscription-only CLI lane
// (#10757) all work. Parsing is strict — an unparsable judge reply is retried
// once and then thrown, never silently defaulted to a score.

import type { EvalModelClient } from "./cerebras-eval-model.js";

/** LifeOps tasks whose outputs need judge-based (not exact-match) scoring. */
export const LIFEOPS_JUDGE_TASKS: ReadonlySet<string> = new Set([
  "reminder_dispatch",
  "meeting_prep",
  "morning_brief",
  "screentime_recap",
]);

/**
 * `expectedOutput` payload for a judge-scored seed example: a calibration
 * reference answer plus the rubric items the judge grades one by one.
 */
export interface JudgeRubricExpectation {
  /** One acceptable answer, shown to the judge for calibration only. */
  reference: string;
  /** Objectively checkable criteria; score = fraction that pass. */
  rubric: string[];
}

export function encodeJudgeExpectation(
  expectation: JudgeRubricExpectation,
): string {
  return JSON.stringify(expectation);
}

export function parseJudgeExpectation(
  expected: string,
): JudgeRubricExpectation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(expected);
  } catch {
    throw new Error(
      `[lifeops-judge] expectedOutput is not JSON: ${expected.slice(0, 120)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { reference?: unknown }).reference !== "string" ||
    !Array.isArray((parsed as { rubric?: unknown }).rubric)
  ) {
    throw new Error(
      "[lifeops-judge] expectedOutput must be {reference: string, rubric: string[]}",
    );
  }
  const rubric = (parsed as { rubric: unknown[] }).rubric.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  if (rubric.length === 0) {
    throw new Error("[lifeops-judge] rubric must contain at least one item");
  }
  return {
    reference: (parsed as { reference: string }).reference,
    rubric,
  };
}

export function buildLifeOpsJudgePrompt(args: {
  task: string;
  actual: string;
  expectation: JudgeRubricExpectation;
}): string {
  const rubricLines = args.expectation.rubric
    .map((item, idx) => `${idx + 1}. ${item}`)
    .join("\n");
  return [
    `You are grading one model completion for the LifeOps assistant task "${args.task}".`,
    "",
    "Candidate completion:",
    "<<<",
    args.actual.trim().length > 0 ? args.actual.trim() : "(empty completion)",
    ">>>",
    "",
    "Reference answer (one acceptable answer, for calibration only — the candidate does NOT need to match it):",
    "<<<",
    args.expectation.reference,
    ">>>",
    "",
    "Rubric — judge each item strictly against the candidate completion only:",
    rubricLines,
    "",
    "Return JSON only, no prose, no code fences:",
    `{"items":[{"index":1,"pass":true,"reason":"..."}]}`,
    `with exactly ${args.expectation.rubric.length} entries, one per rubric item, in order.`,
  ].join("\n");
}

export interface JudgeItemVerdict {
  index: number;
  pass: boolean;
  reason: string;
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Strictly parse the judge reply into one verdict per rubric item. Throws
 * on any shape mismatch — the caller retries once and then propagates.
 */
export function parseJudgeVerdicts(
  raw: string,
  rubricLength: number,
): JudgeItemVerdict[] {
  const cleaned = stripFences(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `[lifeops-judge] judge reply has no JSON object: ${cleaned.slice(0, 160)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error(
      `[lifeops-judge] judge reply is not valid JSON: ${cleaned.slice(0, 160)}`,
    );
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== rubricLength) {
    throw new Error(
      `[lifeops-judge] judge returned ${Array.isArray(items) ? items.length : "no"} items, expected ${rubricLength}`,
    );
  }
  return items.map((item, idx) => {
    const pass = (item as { pass?: unknown }).pass;
    if (typeof pass !== "boolean") {
      throw new Error(
        `[lifeops-judge] rubric item ${idx + 1} verdict "pass" is not a boolean`,
      );
    }
    const reason = (item as { reason?: unknown }).reason;
    return {
      index: idx + 1,
      pass,
      reason: typeof reason === "string" ? reason : "",
    };
  });
}

const JUDGE_MAX_TOKENS = 700;
const JUDGE_ATTEMPTS = 2;

/**
 * Build an async per-example comparator for `createPromptScorer` that grades
 * `actual` against the rubric encoded in `expected`. Score is the fraction of
 * rubric items the judge passes (0..1).
 */
export function createLifeOpsJudgeCompare(
  task: string,
  client: EvalModelClient,
): (actual: string, expected: string) => Promise<number> {
  return async (actual, expected) => {
    const expectation = parseJudgeExpectation(expected);
    const prompt = buildLifeOpsJudgePrompt({ task, actual, expectation });
    let lastError: unknown;
    for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt += 1) {
      const response = await client({
        prompt,
        temperature: 0,
        maxTokens: JUDGE_MAX_TOKENS,
      });
      try {
        const verdicts = parseJudgeVerdicts(
          response.text,
          expectation.rubric.length,
        );
        const passed = verdicts.filter((v) => v.pass).length;
        return passed / verdicts.length;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("[lifeops-judge] judge reply unparsable after retries");
  };
}
