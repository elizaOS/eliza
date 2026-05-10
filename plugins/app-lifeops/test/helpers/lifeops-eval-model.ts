// Shared eval/training LLM client for lifeops.
// All evaluation/judging and training callsites route through this helper
// so the agent under test (Anthropic Opus 4.7) is never used to grade itself.

interface ResolvedClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  role: "eval" | "training";
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

export type EvalModelClient = (req: CerebrasChatRequest) => Promise<CerebrasChatResponse>;

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
  return readEnv("EVAL_MODEL", "EVAL_MODEL_NAME") ?? readEnv("CEREBRAS_MODEL") ?? "gpt-oss-120b";
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

function resolveConfig(role: "eval" | "training"): ResolvedClientConfig {
  const provider = resolveProvider(role);
  if (provider !== "cerebras") {
    throw new Error(
      `[${role}-model] only the "cerebras" provider is wired today; got "${provider}". ` +
        `Set ${role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER"}=cerebras.`,
    );
  }
  return {
    apiKey: resolveCerebrasApiKey(role),
    baseUrl: resolveBaseUrl(),
    model: role === "eval" ? resolveEvalModel() : resolveTrainingModel(),
    role,
  };
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

  // gpt-oss-120b is a reasoning model. Without an effort hint it spends
  // tokens on hidden reasoning before producing the answer, which can blow
  // through max_tokens. Default to "low" for fast eval/judge calls.
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: req.temperature ?? 0,
    max_tokens: req.maxTokens ?? 1024,
  };
  if (config.model.startsWith("gpt-oss")) {
    body.reasoning_effort = req.reasoningEffort ?? "low";
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
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

export function getEvalModelClient(): EvalModelClient {
  const config = resolveConfig("eval");
  return (req) => callCerebras(config, req);
}

export function getTrainingModelClient(): EvalModelClient {
  const config = resolveConfig("training");
  return (req) => callCerebras(config, req);
}

export async function judgeWithCerebras(
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; systemPrompt?: string },
): Promise<string> {
  const client = getEvalModelClient();
  const result = await client({
    prompt,
    systemPrompt: options?.systemPrompt,
    temperature: options?.temperature ?? 0,
    maxTokens: options?.maxTokens ?? 700,
  });
  return result.text;
}

// Adapter shaped like runtime.useModel("TEXT_LARGE", { prompt, ... }) so
// existing optimizer / prompt-compare consumers can drop it in unchanged.
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
  return provider === "cerebras" && !!readEnv("CEREBRAS_API_KEY", "EVAL_CEREBRAS_API_KEY");
}

export function isCerebrasTrainingEnabled(): boolean {
  const provider = resolveProvider("training");
  return provider === "cerebras" && !!readEnv("CEREBRAS_API_KEY", "TRAIN_CEREBRAS_API_KEY");
}
