/**
 * LLM-as-judge: scores a candidate text against a rubric using the runtime's
 * registered TEXT_LARGE model. Returns a 0.0..1.0 score. Real LLM only — no
 * heuristics fallback, no fake scores.
 *
 * Transport for the Cerebras path is delegated to `CerebrasJudge`
 * (cerebras-judge.ts). Prompt + retry-on-parse-failure semantics stay here.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import { isCerebrasEvalEnabled } from "../../../plugins/app-lifeops/test/helpers/lifeops-eval-model.ts";
import {
  CerebrasJudge,
  extractBalancedJsonObject,
  type JudgeResponse,
} from "./cerebras-judge.ts";

const JUDGE_PROMPT_TEMPLATE = `You are a strict evaluator. Score the candidate response against the rubric from 0.0 (fails completely) to 1.0 (fully satisfies).

The candidate may contain both natural-language replies and structured execution evidence such as action traces, result payloads, browser-task status, intervention requests, connector dispatches, and artifacts. Treat that structured evidence as primary proof of whether the flow actually happened. Do not require the assistant prose itself to restate every connector name when the trace already proves execution.

RUBRIC:
{rubric}

CANDIDATE RESPONSE:
{candidate}

Respond with ONLY a compact JSON object on one line, no markdown, no prose, no code fences. Keep "reason" under 20 words so the output fits in 120 tokens:
{"score": <0.0-1.0 float>, "reason": "<≤20 word justification>"}`;

const MAX_JUDGE_TOKENS = 512;
const MAX_RETRIES = 2;

export interface JudgeResult {
  score: number;
  reason: string;
  /** Canonical verdict (additive, non-breaking). */
  verdict?: "PASS" | "FAIL" | "REVIEW";
  /** Raw model text from the underlying call. */
  raw?: string;
}

function judgeResponseToResult(
  response: JudgeResponse,
): JudgeResult | null {
  if (response.score === undefined) return null;
  return {
    score: response.score,
    reason: response.reason && response.reason.length > 0
      ? response.reason
      : "(no reason)",
    verdict: response.verdict,
    raw: response.raw,
  };
}

function parseJudgeJson(raw: string): JudgeResult | null {
  const balanced = extractBalancedJsonObject(raw);
  if (!balanced) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(balanced) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scoreRaw = parsed.score;
  const score =
    typeof scoreRaw === "number"
      ? scoreRaw
      : Number.parseFloat(String(scoreRaw ?? ""));
  if (!Number.isFinite(score)) return null;
  const reason =
    typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason
      : "(no reason)";
  const clamped = score < 0 ? 0 : score > 1 ? 1 : score;
  return {
    score: clamped,
    reason,
    verdict: clamped >= 0.75 ? "PASS" : clamped <= 0.25 ? "FAIL" : "REVIEW",
  };
}

export class JudgeParseError extends Error {
  readonly raw: string;
  constructor(attempts: number, raw: string) {
    const preview =
      raw.length <= 300
        ? raw
        : `${raw.slice(0, 150)} … ${raw.slice(-100)} (${raw.length} chars)`;
    super(
      `[scenario-judge] model did not return a parseable JSON object after ${attempts} attempt(s). Raw: ${preview}`,
    );
    this.name = "JudgeParseError";
    this.raw = raw;
  }
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

  // Standing direction: scenario judging runs on Cerebras gpt-oss-120b so
  // the agent under test is never used to grade itself. Falls back to the
  // runtime's TEXT_LARGE provider when Cerebras isn't configured (unit
  // tests pass a stub runtime; CI without the key keeps working).
  const cerebrasJudge = isCerebrasEvalEnabled() ? new CerebrasJudge() : null;

  let lastRaw = "";
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    let result: JudgeResult | null;
    if (cerebrasJudge) {
      const response = await cerebrasJudge.judge(prompt, {
        maxTokens: MAX_JUDGE_TOKENS,
        temperature: 0,
      });
      lastRaw = response.raw;
      result = judgeResponseToResult(response);
    } else {
      const output = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: MAX_JUDGE_TOKENS,
        temperature: 0,
      });
      const raw = typeof output === "string" ? output : JSON.stringify(output);
      lastRaw = raw;
      result = parseJudgeJson(raw);
    }
    if (result) {
      if (attempt > 1) {
        logger.info(
          `[scenario-judge] parsed on attempt ${attempt} after earlier unparseable output`,
        );
      }
      return result;
    }
    logger.warn(
      `[scenario-judge] attempt ${attempt} produced unparseable output (${lastRaw.length} chars); ${
        attempt <= MAX_RETRIES ? "retrying" : "giving up"
      }`,
    );
  }

  throw new JudgeParseError(MAX_RETRIES + 1, lastRaw);
}
