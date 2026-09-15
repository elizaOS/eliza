/**
 * LLM-as-judge: scores a candidate text against a rubric using the runtime's
 * registered TEXT_LARGE model. Returns a 0.0..1.0 score. Real LLM only — no
 * heuristics fallback, no fake scores.
 *
 * Transport for the Cerebras path is delegated to `CerebrasJudge`
 * (cerebras-judge.ts). Prompt + retry-on-parse-failure semantics stay here.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  CerebrasJudge,
  extractBalancedJsonObject,
  type JudgeResponse,
  parseJudgeScore,
} from "./cerebras-judge.ts";

const JUDGE_PROMPT_TEMPLATE = `Score the candidate response against the rubric from 0.0 (fails completely) to 1.0 (fully satisfies).

The candidate may contain both natural-language replies and structured execution evidence such as action traces, result payloads, browser-task status, intervention requests, connector dispatches, and artifacts. Treat that structured evidence as primary proof of whether the flow actually happened. Do not require the assistant prose itself to restate every connector name when the trace already proves execution.

RUBRIC:
{rubric}

CANDIDATE RESPONSE:
{candidate}

Respond with ONLY a JSON object on one line, no markdown, no prose, no code fences:
{"score": <0.0-1.0 float>, "reason": "<justification>"}`;

const MAX_RETRIES = 2;

type LifeOpsEvalModelModule = {
  isCerebrasEvalEnabled: () => boolean;
};

let lifeOpsEvalModelModule: Promise<LifeOpsEvalModelModule> | null = null;

async function isCerebrasJudgeEnabled(): Promise<boolean> {
  lifeOpsEvalModelModule ??= import(
    "../../../plugins/plugin-personal-assistant/test/helpers/lifeops-eval-model.ts"
  ) as Promise<LifeOpsEvalModelModule>;
  const { isCerebrasEvalEnabled } = await lifeOpsEvalModelModule;
  return isCerebrasEvalEnabled();
}

export interface JudgeEvidence {
  prompt: string;
  transport: "runtime" | "cerebras";
  attempts: Array<{ raw: string; accepted: boolean }>;
}

interface ParsedJudgeResult {
  score: number;
  reason: string;
  /** Canonical verdict (additive, non-breaking). */
  verdict?: "PASS" | "FAIL" | "REVIEW";
  /** Raw model text from the underlying call. */
  raw?: string;
}

export interface JudgeResult extends ParsedJudgeResult {
  evidence: JudgeEvidence;
}

function judgeResponseToResult(
  response: JudgeResponse,
): ParsedJudgeResult | null {
  if (
    response.score === undefined ||
    !response.reason ||
    response.reason.trim().length === 0
  )
    return null;
  return {
    score: response.score,
    reason: response.reason,
    verdict: response.verdict,
    raw: response.raw,
  };
}

function parseJudgeJson(raw: string): ParsedJudgeResult | null {
  const balanced = extractBalancedJsonObject(raw);
  if (!balanced) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(balanced) as Record<string, unknown>;
  } catch {
    // error-policy:J3 malformed model output is an invalid judgment and must retry.
    return null;
  }
  const score = parseJudgeScore(parsed.score);
  if (score === undefined) return null;
  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0)
    return null;
  return {
    score,
    reason: parsed.reason,
    verdict: score >= 0.75 ? "PASS" : score <= 0.25 ? "FAIL" : "REVIEW",
    raw,
  };
}

export class JudgeParseError extends Error {
  readonly raw: string;
  constructor(
    attempts: number,
    raw: string,
    readonly evidence?: JudgeEvidence,
  ) {
    super(
      `[scenario-judge] model did not return a parseable JSON object after ${attempts} attempt(s). Raw: ${raw}`,
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
  const prompt = JUDGE_PROMPT_TEMPLATE.replace(
    /\{rubric\}|\{candidate\}/g,
    (placeholder) => (placeholder === "{rubric}" ? rubric : candidate),
  );

  // Prefer an independent judge when configured so the agent's provider does
  // not grade its own response; other hosts use their registered TEXT_LARGE model.
  const cerebrasJudge = (await isCerebrasJudgeEnabled())
    ? new CerebrasJudge()
    : null;

  const evidence: JudgeEvidence = {
    prompt,
    transport: cerebrasJudge ? "cerebras" : "runtime",
    attempts: [],
  };
  let lastRaw = "";
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    let result: ParsedJudgeResult | null;
    if (cerebrasJudge) {
      const response = await cerebrasJudge.judge(prompt, {
        temperature: 0,
      });
      lastRaw = response.raw;
      result = judgeResponseToResult(response);
    } else {
      const output = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0,
      });
      const raw = typeof output === "string" ? output : JSON.stringify(output);
      lastRaw = raw;
      result = parseJudgeJson(raw);
    }
    evidence.attempts.push({ raw: lastRaw, accepted: result !== null });
    if (result) {
      if (attempt > 1) {
        logger.info(
          `[scenario-judge] parsed on attempt ${attempt} after earlier unparseable output`,
        );
      }
      return { ...result, evidence };
    }
    logger.warn(
      `[scenario-judge] attempt ${attempt} produced unparseable output (${lastRaw.length} chars); ${
        attempt <= MAX_RETRIES ? "retrying" : "giving up"
      }`,
    );
  }

  throw new JudgeParseError(MAX_RETRIES + 1, lastRaw, evidence);
}
