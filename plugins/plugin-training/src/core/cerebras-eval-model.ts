// Cerebras / Anthropic eval+training LLM client for app-training.
//
// Routes optimizer scoring + variant generation through a real provider so
// the agent under optimization is never used to grade itself. Mirrors the
// app-lifeops eval-model helper but lives in app-training so production code
// here never imports across another package's `test/` boundary.
//
// Judge-shaped calls (`judgeWithCerebras` / `judgeWithCerebrasShared`)
// route their transport through the shared `CerebrasJudge` class in
// scenario-runner so all four Cerebras judges in the repo share retry +
// parsing logic.

import {
  CerebrasJudge,
  type JudgeResponse,
} from "@elizaos/scenario-runner/cerebras-judge";

interface ResolvedClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  role: "eval" | "training";
  providerName: "cerebras" | "anthropic";
}

export interface CerebrasChatRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CerebrasChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

export interface CerebrasChatResponse {
  text: string;
  usage?: CerebrasChatUsage;
  raw?: unknown;
}

export type EvalModelClient = (
  req: CerebrasChatRequest,
) => Promise<CerebrasChatResponse>;

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function resolveCerebrasApiKey(role: "eval" | "training"): string {
  const apiKey = readEnv(
    role === "eval" ? "EVAL_CEREBRAS_API_KEY" : "TRAIN_CEREBRAS_API_KEY",
    "CEREBRAS_API_KEY",
    "ELIZA_E2E_CEREBRAS_API_KEY",
  );
  if (!apiKey) {
    throw new Error(
      `[${role}-model] CEREBRAS_API_KEY is not set. ` +
        `Eval/training runs require Cerebras credentials. ` +
        `Set CEREBRAS_API_KEY in eliza/.env.`,
    );
  }
  return apiKey;
}

function resolveBaseUrl(): string {
  return readEnv("CEREBRAS_BASE_URL") ?? "https://api.cerebras.ai/v1";
}

function resolveEvalModel(): string {
  return (
    readEnv("EVAL_MODEL", "EVAL_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}

function resolveTrainingModel(): string {
  return (
    readEnv("TRAIN_MODEL", "TRAINING_MODEL", "TRAIN_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}

function resolveProvider(role: "eval" | "training"): string {
  return (
    readEnv(
      role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER",
      role === "eval" ? "EVAL_PROVIDER" : "TRAINING_PROVIDER",
    ) ?? "cerebras"
  );
}

function resolveAnthropicApiKey(role: "eval" | "training"): string {
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error(
      `[${role}-model] ANTHROPIC_API_KEY is not set; required when ${
        role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER"
      }=anthropic.`,
    );
  }
  return apiKey;
}

function resolveAnthropicModel(role: "eval" | "training"): string {
  const explicitAnthropic = readEnv("ANTHROPIC_LARGE_MODEL");
  if (explicitAnthropic) return explicitAnthropic;
  if (role === "eval") {
    return (
      readEnv("EVAL_ANTHROPIC_MODEL", "EVAL_MODEL_NAME") ??
      "claude-haiku-4-5-20251001"
    );
  }
  return (
    readEnv("TRAIN_ANTHROPIC_MODEL", "TRAIN_MODEL_NAME") ??
    "claude-haiku-4-5-20251001"
  );
}

function resolveConfig(role: "eval" | "training"): ResolvedClientConfig {
  const provider = resolveProvider(role);
  if (provider === "cerebras") {
    return {
      apiKey: resolveCerebrasApiKey(role),
      baseUrl: resolveBaseUrl(),
      model: role === "eval" ? resolveEvalModel() : resolveTrainingModel(),
      role,
      providerName: "cerebras",
    };
  }
  if (provider === "anthropic") {
    return {
      apiKey: resolveAnthropicApiKey(role),
      baseUrl: "https://api.anthropic.com/v1",
      model: resolveAnthropicModel(role),
      role,
      providerName: "anthropic",
    };
  }
  throw new Error(
    `[${role}-model] unknown provider "${provider}"; supported: cerebras, anthropic. ` +
      `Set ${role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER"}=cerebras|anthropic.`,
  );
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_CHAT_ATTEMPTS = 5;

/**
 * POST the chat-completions request, retrying transient failures (429 + 5xx +
 * network errors) with exponential backoff. A single optimizer run fans out
 * into dozens of provider calls, so one transient 500 (common on serverless
 * gpt-oss-120b relays) would otherwise abort the whole generation. A
 * non-retryable status is returned to the caller unchanged for its own
 * error-body handling.
 */
async function fetchChatWithRetry(
  config: ResolvedClientConfig,
  body: Record<string, unknown>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHAT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      lastError = new Error(
        `[${config.role}-model] cerebras transient ${response.status}`,
      );
      // Drain the body so the socket can be reused before we retry.
      await response.text().catch(() => undefined);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_CHAT_ATTEMPTS) {
      const backoffMs = Math.min(8000, 400 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`[${config.role}-model] chat request failed`);
}

async function callCerebras(
  config: ResolvedClientConfig,
  req: CerebrasChatRequest,
): Promise<CerebrasChatResponse> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt && req.systemPrompt.length > 0) {
    messages.push({ role: "system", content: req.systemPrompt });
  }
  messages.push({ role: "user", content: req.prompt });

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: req.temperature ?? 0,
    max_tokens: req.maxTokens ?? 1024,
  };
  // gpt-oss exposes a `reasoning_effort` knob; match it on the bare id and on
  // the `<vendor>/gpt-oss-*` form used by OpenAI-compatible relays.
  if (/(^|\/)gpt-oss/.test(config.model)) {
    body.reasoning_effort = req.reasoningEffort ?? "low";
  }

  const response = await fetchChatWithRetry(config, body);
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `[${config.role}-model] cerebras error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
          cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
        }
      : undefined,
    raw: data,
  };
}

async function callAnthropic(
  config: ResolvedClientConfig,
  req: CerebrasChatRequest,
): Promise<CerebrasChatResponse> {
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: req.maxTokens ?? 1024,
    temperature: req.temperature ?? 0,
    messages: [{ role: "user", content: req.prompt }],
  };
  if (req.systemPrompt && req.systemPrompt.length > 0) {
    body.system = req.systemPrompt;
  }
  const response = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `[${config.role}-model] anthropic error ${response.status}: ${errBody.slice(0, 300)}`,
    );
  }
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text" || (!c.type && typeof c.text === "string"))
    .map((c) => c.text ?? "")
    .join("");
  return {
    text,
    usage: data.usage
      ? {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens:
            (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          cachedTokens: data.usage.cache_read_input_tokens,
        }
      : undefined,
    raw: data,
  };
}

function dispatch(
  config: ResolvedClientConfig,
  req: CerebrasChatRequest,
): Promise<CerebrasChatResponse> {
  return config.providerName === "anthropic"
    ? callAnthropic(config, req)
    : callCerebras(config, req);
}

export function getEvalModelClient(): EvalModelClient {
  const config = resolveConfig("eval");
  return (req) => dispatch(config, req);
}

export function getTrainingModelClient(): EvalModelClient {
  const config = resolveConfig("training");
  return (req) => dispatch(config, req);
}

/**
 * Cerebras-only judge helper. Routes through the shared `CerebrasJudge`
 * transport (tolerant parsing, 429/5xx retry, json_object opt-in). The
 * Cerebras eval provider is the only one configured here; callers that
 * need Anthropic should use `getEvalModelClient()` directly.
 *
 * Returns the raw model text for backward compatibility with existing
 * callers. New callers should consume `judgeWithCerebrasShared()` (below)
 * to get the canonical {raw, json, score?, verdict?, reason?} shape.
 */
export async function judgeWithCerebras(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
): Promise<string> {
  const response = await judgeWithCerebrasShared(prompt, options);
  return response.raw;
}

/**
 * New canonical entry: returns the full JudgeResponse for callers that
 * want the parsed score/verdict/reason without re-parsing the raw text.
 */
export async function judgeWithCerebrasShared(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
): Promise<JudgeResponse> {
  const provider = resolveProvider("eval");
  if (provider !== "cerebras") {
    // Caller asked for the eval-as-judge route but the eval provider is
    // pinned to a non-Cerebras model. Fall back to the eval client so the
    // judge still runs (cross-grader rule), but skip the shared CerebrasJudge
    // transport — only Cerebras is supported there today.
    const client = getEvalModelClient();
    const result = await client({
      prompt,
      systemPrompt: options?.systemPrompt,
      temperature: options?.temperature ?? 0,
      maxTokens: options?.maxTokens ?? 700,
    });
    return { raw: result.text, json: null };
  }
  const judge = new CerebrasJudge({
    apiKey: resolveCerebrasApiKey("eval"),
    baseUrl: resolveBaseUrl(),
    model: resolveEvalModel(),
  });
  return judge.judge(prompt, {
    systemPrompt: options?.systemPrompt,
    temperature: options?.temperature ?? 0,
    maxTokens: options?.maxTokens ?? 700,
  });
}

// Adapter shaped like runtime.useModel("TEXT_LARGE", { prompt, ... }) so
// optimizer / prompt-compare consumers can drop it in unchanged.
export function getTrainingUseModelAdapter(): (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string> {
  const client = getTrainingModelClient();
  return async (input) => {
    const result = await client({
      prompt: input.prompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    return result.text;
  };
}

export function isCerebrasEvalEnabled(): boolean {
  const provider = resolveProvider("eval");
  return (
    provider === "cerebras" &&
    !!readEnv("CEREBRAS_API_KEY", "EVAL_CEREBRAS_API_KEY")
  );
}

export function isCerebrasTrainingEnabled(): boolean {
  const provider = resolveProvider("training");
  return (
    provider === "cerebras" &&
    !!readEnv("CEREBRAS_API_KEY", "TRAIN_CEREBRAS_API_KEY")
  );
}
