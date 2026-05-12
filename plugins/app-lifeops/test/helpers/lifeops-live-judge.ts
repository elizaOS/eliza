import { judgeWithCerebras } from "./lifeops-eval-model.ts";
import type { SelectedLiveProvider } from "./lifeops-live-harness.ts";

export type LlmJudgeResult = {
  passed: boolean;
  reasoning: string;
  score: number;
};

function parseJudgeResult(raw: string): LlmJudgeResult | null {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```json\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(fenced) as {
      passed?: unknown;
      reasoning?: unknown;
      score?: unknown;
    };
    if (
      typeof parsed.passed !== "boolean" ||
      typeof parsed.reasoning !== "string" ||
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score)
    ) {
      return null;
    }
    return {
      passed: parsed.passed,
      reasoning: parsed.reasoning.trim(),
      score: Math.max(0, Math.min(1, parsed.score)),
    };
  } catch {
    return null;
  }
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
  const raw = await judgeWithCerebras(prompt, { maxTokens: 1024 });
  const parsed = parseJudgeResult(raw);
  if (!parsed) {
    throw new Error(`Judge returned invalid JSON for ${args.label}: ${raw}`);
  }
  return {
    ...parsed,
    passed: parsed.passed && parsed.score >= minimumScore,
  };
}
