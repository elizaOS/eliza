/**
 * @fileoverview LLM-judge cross-check layer.
 *
 * Wraps Cerebras gpt-oss-120b (OpenAI-compatible). The judge runs `passes`
 * independent calls with temperature=0 and slightly perturbed system prompts;
 * agreement across passes drives confidence. Disagreement always routes to
 * NEEDS_REVIEW — never a silent flip.
 *
 * Transport (HTTP + auth + abort + tolerant JSON parsing + retry) is
 * delegated to the shared `CerebrasJudge` class in scenario-runner. The
 * personality-bench-specific multi-pass loop, perturbations, and verdict
 * aggregation stay here.
 */

import { CerebrasJudge } from "../../../../../scenario-runner/src/cerebras-judge.ts";
import type { LayerResult, Verdict } from "../../types.ts";

/** Structured payload the LLM is asked to return. */
interface LlmJudgePayload {
  verdict: "YES" | "NO" | "NEEDS_REVIEW";
  reason: string;
}

/** Configuration passed in by the rubric. */
export interface LlmJudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  passes: number;
  timeoutMs: number;
}

/** What the rubric hands to the judge — a single yes/no question + evidence. */
export interface LlmJudgeQuestion {
  question: string;
  systemHint: string;
  evidence: Record<string, string>;
}

const JSON_CONTRACT =
  'Respond with a single JSON object and nothing else. Schema: {"verdict":"YES"|"NO"|"NEEDS_REVIEW","reason":"<one sentence>"}. No prose, no code fences, no trailing commentary.';

const PERTURBATIONS: ReadonlyArray<string> = [
  `You are a meticulous personality-benchmark judge. Be strict. ${JSON_CONTRACT}`,
  `You are an independent reviewer scoring assistant transcripts. Be conservative. ${JSON_CONTRACT}`,
  `You are an evaluation auditor. Reject ambiguous evidence. ${JSON_CONTRACT}`,
];

export function tolerantJsonParse(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function extractJson(text: string): LlmJudgePayload | null {
  const parsed = tolerantJsonParse(text);
  if (!parsed) return null;
  const verdictRaw = String(parsed.verdict ?? "").toUpperCase();
  const reason = String(parsed.reason ?? "").trim();
  if (verdictRaw === "YES" || verdictRaw === "PASS") {
    return { verdict: "YES", reason };
  }
  if (verdictRaw === "NO" || verdictRaw === "FAIL") {
    return { verdict: "NO", reason };
  }
  if (verdictRaw === "NEEDS_REVIEW" || verdictRaw === "REVIEW") {
    return { verdict: "NEEDS_REVIEW", reason };
  }
  return null;
}

function buildUserMessage(question: LlmJudgeQuestion): string {
  const evidenceBlock = Object.entries(question.evidence)
    .map(([k, v]) => `<${k}>\n${v}\n</${k}>`)
    .join("\n\n");
  return [
    "Decide if the assistant respected the requested behaviour.",
    "",
    question.question,
    "",
    evidenceBlock,
    "",
    'Respond with strict JSON: {"verdict":"YES|NO|NEEDS_REVIEW","reason":"<one sentence>"}.',
    "Use NEEDS_REVIEW when the evidence is genuinely ambiguous; do not guess.",
  ].join("\n");
}

async function runOnePass(
  cfg: LlmJudgeConfig,
  question: LlmJudgeQuestion,
  systemPromptIndex: number,
): Promise<LlmJudgePayload | null> {
  const fallbackPrompt = PERTURBATIONS[0] ?? "You are a strict judge.";
  const systemPrompt =
    PERTURBATIONS[systemPromptIndex % PERTURBATIONS.length] ?? fallbackPrompt;
  try {
    const judge = new CerebrasJudge({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
      // personality-bench treats any non-200 as "this pass didn't parse" and
      // downgrades to NEEDS_REVIEW. Don't retry transport-level — the multi-
      // pass agreement check is the redundancy layer here.
      maxRetries: 0,
    });
    const response = await judge.judge(buildUserMessage(question), {
      systemPrompt: `${systemPrompt}\n${question.systemHint}`,
      temperature: 0,
      maxTokens: 200,
      jsonObjectMode: true,
    });
    return extractJson(response.raw);
  } catch {
    return null;
  }
}

function toVerdict(payload: LlmJudgePayload): Verdict {
  if (payload.verdict === "YES") return "PASS";
  if (payload.verdict === "NO") return "FAIL";
  return "NEEDS_REVIEW";
}

/**
 * Run the LLM judge. Returns a single LayerResult representing the combined
 * outcome across `passes` calls. If any pass cannot be parsed, the entire
 * layer downgrades to NEEDS_REVIEW with low confidence.
 */
export async function judgeWithLlm(
  cfg: LlmJudgeConfig,
  question: LlmJudgeQuestion,
): Promise<LayerResult> {
  if (!cfg.apiKey) {
    return {
      layer: "llm_judge",
      verdict: "NEEDS_REVIEW",
      confidence: 0,
      reason: "no LLM key configured — judge layer skipped",
    };
  }
  const passCount = Math.max(1, cfg.passes);
  const results: LlmJudgePayload[] = [];
  for (let i = 0; i < passCount; i++) {
    const res = await runOnePass(cfg, question, i);
    if (!res) {
      return {
        layer: "llm_judge",
        verdict: "NEEDS_REVIEW",
        confidence: 0.2,
        reason: `pass ${i + 1} did not return parseable JSON`,
      };
    }
    results.push(res);
  }
  const verdicts = results.map(toVerdict);
  const unanimous = verdicts.every((v) => v === verdicts[0]);
  if (unanimous) {
    const v = verdicts[0] ?? "NEEDS_REVIEW";
    return {
      layer: "llm_judge",
      verdict: v,
      confidence: v === "NEEDS_REVIEW" ? 0.5 : 0.9,
      reason: results.map((r) => r.reason).join(" | "),
      evidence: { passes: results },
    };
  }
  return {
    layer: "llm_judge",
    verdict: "NEEDS_REVIEW",
    confidence: 0.4,
    reason: `cross-pass disagreement: ${verdicts.join(", ")}`,
    evidence: { passes: results },
  };
}
