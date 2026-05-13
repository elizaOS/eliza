/**
 * @fileoverview LLM-judge cross-check layer.
 *
 * Wraps Cerebras gpt-oss-120b (OpenAI-compatible). The judge runs `passes`
 * independent calls with temperature=0 and slightly perturbed system prompts;
 * agreement across passes drives confidence. Disagreement always routes to
 * NEEDS_REVIEW — never a silent flip.
 *
 * No real Anthropic Opus judge here per the W3-3 brief.
 */

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

/** OpenAI-compatible chat completion shape we actually need. */
interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
}

const PERTURBATIONS: ReadonlyArray<string> = [
  "You are a meticulous personality-benchmark judge. Be strict.",
  "You are an independent reviewer scoring assistant transcripts. Be conservative.",
  "You are an evaluation auditor. Reject ambiguous evidence.",
];

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

export function tolerantJsonParse(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = parseJsonObject(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    const parsed = parseJsonObject(fenced[1].trim());
    if (parsed) return parsed;
  }

  const candidate = extractFirstJsonObject(trimmed);
  return candidate ? parseJsonObject(candidate) : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const fallbackPrompt = PERTURBATIONS[0] ?? "You are a strict judge.";
    const systemPrompt =
      PERTURBATIONS[systemPromptIndex % PERTURBATIONS.length] ?? fallbackPrompt;
    const res = await fetch(
      `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 200,
          messages: [
            {
              role: "system",
              content: `${systemPrompt}\n${question.systemHint}`,
            },
            { role: "user", content: buildUserMessage(question) },
          ],
        }),
      },
    );
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    return extractJson(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
