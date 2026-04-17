/**
 * LLM-as-judge: scores a candidate text against a rubric using the runtime's
 * registered TEXT_LARGE model. Returns a 0.0..1.0 score. Real LLM only — no
 * heuristics fallback, no fake scores.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";

const JUDGE_PROMPT_TEMPLATE = `You are a strict evaluator. Score the candidate response against the rubric from 0.0 (fails completely) to 1.0 (fully satisfies).

RUBRIC:
{rubric}

CANDIDATE RESPONSE:
{candidate}

Respond with ONLY a JSON object on one line, no markdown, no prose:
{"score": <0.0-1.0 float>, "reason": "<one-sentence justification>"}`;

export interface JudgeResult {
  score: number;
  reason: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseJudgeJson(raw: string): JudgeResult {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) {
    throw new Error(
      `[scenario-judge] model did not return a JSON object. Raw: ${raw.slice(0, 200)}`,
    );
  }
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  const score =
    typeof parsed.score === "number"
      ? parsed.score
      : Number.parseFloat(String(parsed.score ?? ""));
  const reason =
    typeof parsed.reason === "string" ? parsed.reason : "(no reason)";
  return { score: clamp01(score), reason };
}

export async function judgeTextWithLlm(
  runtime: IAgentRuntime,
  candidate: string,
  rubric: string,
): Promise<JudgeResult> {
  const prompt = JUDGE_PROMPT_TEMPLATE.replace("{rubric}", rubric).replace(
    "{candidate}",
    candidate,
  );

  const output = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt,
    maxTokens: 200,
    temperature: 0,
  });

  const raw = typeof output === "string" ? output : JSON.stringify(output);
  try {
    return parseJudgeJson(raw);
  } catch (err) {
    logger.warn(
      `[scenario-judge] failed to parse judge output: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
