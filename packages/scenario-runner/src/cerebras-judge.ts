/**
 * Shared Cerebras judge transport.
 *
 * Single class consumed by all Cerebras-as-judge call sites in the repo:
 *
 *   - packages/scenario-runner/src/judge.ts                 (scenario judge)
 *   - plugins/app-lifeops/test/helpers/lifeops-live-judge.ts (lifeops live judge)
 *   - plugins/app-training/src/core/cerebras-eval-model.ts  (training judge)
 *   - packages/benchmarks/personality-bench/src/judge/checks/llm-judge.ts
 *                                                           (personality multi-pass judge)
 *
 * Prompts, rubrics, and pass counts stay with the callers. This class only
 * owns transport, retry, tolerant JSON parsing, and a canonical verdict
 * shape. Callers map the canonical shape back to their own return types.
 */
/** Canonical verdict alias re-exported for callers that don't pull types.ts. */
export type CerebrasJudgeVerdict = "PASS" | "FAIL" | "REVIEW";

/** Verdicts produced by personality-bench style judges that use NEEDS_REVIEW. */
export type CerebrasJudgeVerdictWide = CerebrasJudgeVerdict | "NEEDS_REVIEW";

/** Canonical response shape every Cerebras judge call resolves to. */
export interface JudgeResponse {
  /** Raw model text — exactly what the API returned, before parsing. */
  raw: string;
  /** Parsed JSON object or null if the model output never parsed. */
  json: Record<string, unknown> | null;
  /** 0..1 score when the model emitted a `score` field. */
  score?: number;
  /** Canonical verdict when the model emitted `verdict` or it can be derived from `score`. */
  verdict?: CerebrasJudgeVerdict;
  /** Free-text justification when the model emitted `reason` (or equivalent). */
  reason?: string;
}

export interface CerebrasJudgeOptions {
  /** Default `gpt-oss-120b`. Override per call via judge() options if needed. */
  model?: string;
  /** OpenAI-compatible base. Default `https://api.cerebras.ai/v1`. */
  baseUrl?: string;
  /** Bearer key. Defaults to `process.env.CEREBRAS_API_KEY`. */
  apiKey?: string;
  /** Per-request abort timeout. Default 60000ms. */
  timeoutMs?: number;
  /** Retry count on 429/5xx (transport-only retries, not parse retries). Default 2. */
  maxRetries?: number;
}

export interface JudgeCallOptions {
  /** Max output tokens. Default 1024. */
  maxTokens?: number;
  /** Temperature. Default 0. */
  temperature?: number;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** When true, sets `response_format: { type: "json_object" }`. Default false. */
  jsonObjectMode?: boolean;
  /** Reasoning effort hint for `gpt-oss-*` models. Default "low" for fast judges. */
  reasoningEffort?: "low" | "medium" | "high";
}

interface ChatCompletionShape {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** Clamp a finite number to [0, 1]; returns 0 for non-finite inputs. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Walk a string and return the first balanced `{...}` window, respecting
 * string boundaries and escape sequences. Used as a tolerant fallback when
 * the model wraps the JSON in prose. Returns null when no balanced object
 * is found.
 *
 * Exported because the scenario-runner judge (and the test suite) use it
 * directly.
 */
export function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Tolerant JSON parser. Tries: strict parse → ```json fenced parse →
 * first-`{` to last-`}` window → balanced-object scan. Returns null when
 * the model output never resolves to a JSON object.
 */
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
  const balanced = extractBalancedJsonObject(trimmed);
  if (balanced) candidates.push(balanced);
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

/**
 * Map a numeric score to a canonical verdict. Threshold: `>= 0.75` is PASS,
 * `<= 0.25` is FAIL, anything in between is REVIEW. This is an additive
 * field on JudgeResponse — callers that have their own verdict logic ignore
 * it.
 */
export function verdictFromScore(score: number): CerebrasJudgeVerdict {
  if (score >= 0.75) return "PASS";
  if (score <= 0.25) return "FAIL";
  return "REVIEW";
}

/**
 * Map a string verdict produced by the model to the canonical
 * PASS/FAIL/REVIEW set. Returns undefined when the input isn't a recognized
 * verdict string. Accepts YES/NO/NEEDS_REVIEW (personality-bench style) and
 * PASS/FAIL/REVIEW (scenario-runner style).
 */
export function normalizeVerdict(
  raw: unknown,
): CerebrasJudgeVerdict | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toUpperCase();
  if (v === "PASS" || v === "YES") return "PASS";
  if (v === "FAIL" || v === "NO") return "FAIL";
  if (v === "REVIEW" || v === "NEEDS_REVIEW") return "REVIEW";
  return undefined;
}

class CerebrasJudgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "CerebrasJudgeError";
  }
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cerebras gpt-oss-120b judge transport.
 *
 * Single shared client for the four judge call sites in this repo. Owns
 * transport (HTTP, auth, abort, retry, response_format) and parsing.
 * Prompt construction and verdict mapping belong to callers — this class
 * gives them a canonical {raw, json, score?, verdict?, reason?} response
 * they can map onto their own return types.
 */
export class CerebrasJudge {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: CerebrasJudgeOptions = {}) {
    this.model = options.model ?? "gpt-oss-120b";
    this.baseUrl = (options.baseUrl ?? "https://api.cerebras.ai/v1").replace(
      /\/$/,
      "",
    );
    const apiKey = options.apiKey ?? process.env.CEREBRAS_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "[cerebras-judge] CEREBRAS_API_KEY is not set and no apiKey was provided to the constructor.",
      );
    }
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** Returns true when an API key is present in env. */
  static isAvailable(): boolean {
    return Boolean(process.env.CEREBRAS_API_KEY?.trim());
  }

  /**
   * Execute a single judge call. Retries on 429/5xx (up to `maxRetries`
   * times) with exponential backoff. Throws on 4xx (other than 429) and
   * after retries are exhausted.
   */
  async judge(
    prompt: string,
    options: JudgeCallOptions = {},
  ): Promise<JudgeResponse> {
    const raw = await this.callChat(prompt, options);
    const json = tolerantJsonParse(raw);
    const response: JudgeResponse = { raw, json };
    if (json) {
      const scoreField = json.score;
      const score =
        typeof scoreField === "number"
          ? scoreField
          : Number.parseFloat(String(scoreField ?? ""));
      if (Number.isFinite(score)) {
        response.score = clamp01(score);
      }
      const explicitVerdict = normalizeVerdict(json.verdict);
      if (explicitVerdict) {
        response.verdict = explicitVerdict;
      } else if (response.score !== undefined) {
        response.verdict = verdictFromScore(response.score);
      }
      const reasonField =
        typeof json.reason === "string"
          ? json.reason
          : typeof json.reasoning === "string"
            ? json.reasoning
            : undefined;
      if (reasonField !== undefined && reasonField.length > 0) {
        response.reason = reasonField.trim();
      }
    }
    return response;
  }

  /**
   * Internal: dispatch one chat completion with retries on 429/5xx.
   * Returns the raw assistant content (no parsing). Exposed via judge();
   * not exported because the parsed surface is the contract.
   */
  private async callChat(
    prompt: string,
    options: JudgeCallOptions,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.buildMessages(prompt, options.systemPrompt),
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 1024,
    };
    if (this.model.startsWith("gpt-oss")) {
      body.reasoning_effort = options.reasoningEffort ?? "low";
    }
    if (options.jsonObjectMode) {
      body.response_format = { type: "json_object" };
    }

    let lastError: CerebrasJudgeError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errBody = await response.text();
          if (shouldRetryStatus(response.status) && attempt < this.maxRetries) {
            const backoffMs = 250 * 2 ** attempt;
            await sleep(backoffMs);
            continue;
          }
          throw new CerebrasJudgeError(
            `cerebras error ${response.status}: ${errBody.slice(0, 300)}`,
            response.status,
            errBody,
          );
        }
        const data = (await response.json()) as ChatCompletionShape;
        return data.choices?.[0]?.message?.content ?? "";
      } catch (err) {
        if (err instanceof CerebrasJudgeError) {
          if (!shouldRetryStatus(err.status ?? 0) || attempt >= this.maxRetries) {
            throw err;
          }
          lastError = err;
          const backoffMs = 250 * 2 ** attempt;
          await sleep(backoffMs);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("[cerebras-judge] retries exhausted");
  }

  private buildMessages(
    prompt: string,
    systemPrompt?: string,
  ): Array<{ role: "system" | "user"; content: string }> {
    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (systemPrompt && systemPrompt.length > 0) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }
}
