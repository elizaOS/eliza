// Shared eval/training LLM client for lifeops.
// All evaluation/judging and training callsites route through this helper
// so the agent under test (Anthropic Opus 4.7) is never used to grade itself.
function readEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}
function resolveCerebrasApiKey(role) {
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
function resolveBaseUrl() {
  return readEnv("CEREBRAS_BASE_URL") ?? "https://api.cerebras.ai/v1";
}
function resolveEvalModel() {
  return (
    readEnv("EVAL_MODEL", "EVAL_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}
function resolveTrainingModel() {
  return (
    readEnv("TRAIN_MODEL", "TRAINING_MODEL", "TRAIN_MODEL_NAME") ??
    readEnv("CEREBRAS_MODEL") ??
    "gpt-oss-120b"
  );
}
function resolveProvider(role) {
  return (
    readEnv(
      role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER",
      role === "eval" ? "EVAL_PROVIDER" : "TRAINING_PROVIDER",
    ) ?? "cerebras"
  );
}
function resolveAnthropicApiKey(role) {
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error(
      `[${role}-model] ANTHROPIC_API_KEY is not set; required when ${role === "eval" ? "EVAL_MODEL_PROVIDER" : "TRAIN_MODEL_PROVIDER"}=anthropic.`,
    );
  }
  return apiKey;
}
function resolveAnthropicModel(role) {
  // ANTHROPIC_LARGE_MODEL wins when provider=anthropic, even if a generic
  // *_MODEL var is also set. Otherwise the operator's "use Cerebras model
  // X" alias bleeds into the Anthropic call and 404s.
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
function resolveConfig(role) {
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
async function callCerebras(config, req) {
  const messages = [];
  if (req.systemPrompt && req.systemPrompt.length > 0) {
    messages.push({ role: "system", content: req.systemPrompt });
  }
  messages.push({ role: "user", content: req.prompt });
  // gpt-oss-120b is a reasoning model. Without an effort hint it spends
  // tokens on hidden reasoning before producing the answer, which can blow
  // through max_tokens. Default to "low" for fast eval/judge calls.
  const body = {
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
  const data = await response.json();
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
async function callAnthropic(config, req) {
  const body = {
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
  const data = await response.json();
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
function dispatch(config, req) {
  return config.providerName === "anthropic"
    ? callAnthropic(config, req)
    : callCerebras(config, req);
}
export function getEvalModelClient() {
  const config = resolveConfig("eval");
  return (req) => dispatch(config, req);
}
export function getTrainingModelClient() {
  const config = resolveConfig("training");
  return (req) => dispatch(config, req);
}
export async function judgeWithCerebras(prompt, options) {
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
export function getTrainingUseModelAdapter() {
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
export function isCerebrasEvalEnabled() {
  const provider = resolveProvider("eval");
  return (
    provider === "cerebras" &&
    !!readEnv("CEREBRAS_API_KEY", "EVAL_CEREBRAS_API_KEY")
  );
}
export function isCerebrasTrainingEnabled() {
  const provider = resolveProvider("training");
  return (
    provider === "cerebras" &&
    !!readEnv("CEREBRAS_API_KEY", "TRAIN_CEREBRAS_API_KEY")
  );
}
//# sourceMappingURL=lifeops-eval-model.js.map
