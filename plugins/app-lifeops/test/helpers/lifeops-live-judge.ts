import type { SelectedLiveProvider } from "./lifeops-live-harness.ts";
import { CerebrasJudge } from "../../../../packages/scenario-runner/src/cerebras-judge.ts";

export type LlmJudgeResult = {
  passed: boolean;
  reasoning: string;
  score: number;
  /** Canonical verdict (additive, non-breaking). */
  verdict?: "PASS" | "FAIL" | "REVIEW";
};

/**
 * Map a parsed CerebrasJudge response onto the lifeops-specific shape.
 * Lifeops uses `passed`/`reasoning` rather than `verdict`/`reason`. The
 * `passed` boolean here is unanchored to the minimum-score cutoff — the
 * caller applies that after; we only validate that the model emitted a
 * numeric score and reasoning.
 */
function parseJudgeResult(parsed: Record<string, unknown> | null):
  | (LlmJudgeResult & { reasoning: string })
  | null {
  if (!parsed) return null;
  const score =
    typeof parsed.score === "number"
      ? parsed.score
      : Number.parseFloat(String(parsed.score ?? ""));
  if (!Number.isFinite(score)) return null;
  // lifeops legacy: reasoning may also be carried in `reason`.
  const reasoningField = parsed.reasoning ?? parsed.reason;
  if (typeof reasoningField !== "string") return null;
  const passedField = parsed.passed;
  const passed = typeof passedField === "boolean" ? passedField : score >= 0.75;
  return {
    passed,
    reasoning: reasoningField.trim(),
    score: Math.max(0, Math.min(1, score)),
  };
}

function buildJudgePrompt(args: {
  rubric: string;
  text: string;
  minimumScore: number;
  label: string;
  transcript?: string;
}): string {
  return [
    "Judge whether the assistant output satisfies the rubric.",
    "Return ONLY valid JSON with exactly these fields:",
    '  {"passed": boolean, "score": number, "reasoning": string}',
    "",
    `Label: ${args.label}`,
    `Minimum passing score: ${args.minimumScore}`,
    `Rubric: ${args.rubric}`,
    args.transcript
      ? `Conversation context: ${JSON.stringify(args.transcript)}`
      : "",
    `Assistant output: ${JSON.stringify(args.text)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// `provider` is accepted for backwards compat with the existing call sites
// but ignored: the judge always runs on Cerebras gpt-oss-120b regardless of
// which provider the agent under test is using. This is the whole point of
// the redirect — the judge must be a different model than the one being
// graded.
export async function judgeTextWithLlm(args: {
  provider?: SelectedLiveProvider;
  rubric: string;
  text: string;
  minimumScore?: number;
  label: string;
  transcript?: string;
}): Promise<LlmJudgeResult> {
  const minimumScore = args.minimumScore ?? 0.75;
  const prompt = buildJudgePrompt({
    rubric: args.rubric,
    text: args.text,
    minimumScore,
    label: args.label,
    transcript: args.transcript,
  });
  const judge = new CerebrasJudge();
  const response = await judge.judge(prompt, { maxTokens: 1024 });
  const parsed = parseJudgeResult(response.json);
  if (!parsed) {
    throw new Error(
      `Judge returned invalid JSON for ${args.label}: ${response.raw}`,
    );
  }
  const passed = parsed.passed && parsed.score >= minimumScore;
  return {
    ...parsed,
    passed,
    verdict: passed
      ? "PASS"
      : parsed.score <= 0.25
        ? "FAIL"
        : "REVIEW",
  };
}
