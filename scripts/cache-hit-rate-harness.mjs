#!/usr/bin/env node
import crypto from "node:crypto";

const _DEFAULT_SMALL_MODEL = "openai/gpt-oss-120b:nitro";
const DEFAULT_LARGE_MODEL = "deepseek/deepseek-v4-pro";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...valueParts] = arg.slice(2).split("=");
    args[key] = valueParts.length > 0 ? valueParts.join("=") : "true";
  }
  return args;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
}

function stablePrefix() {
  const lineCount = Math.max(
    96,
    Number(process.env.ELIZA_CACHE_PREFIX_LINES ?? 320),
  );
  const repeated = Array.from(
    { length: lineCount },
    (_, index) =>
      `Stable planner instruction ${index}: preserve character, tool protocol, cache markers, and action policy.`,
  ).join("\n");
  return [
    "Eliza cache validation harness.",
    "This prefix is intentionally stable across calls to measure prompt-cache hit rate.",
    repeated,
  ].join("\n");
}

function plannerTool() {
  return {
    type: "function",
    function: {
      name: "PLAN_ACTIONS",
      description: "Return a compact action plan for the agent runtime.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                input: { type: "object" },
              },
              required: ["name", "input"],
            },
          },
        },
        required: ["actions"],
      },
    },
  };
}

function openAICompatiblePayload({
  model,
  callIndex,
  provider,
  includeTools = true,
  forceTool = false,
  scenario = "tool-call",
}) {
  const cacheKey = process.env.ELIZA_CACHE_PROMPT_KEY ?? "eliza-cache-harness";
  const explicitCacheControl = openRouterExplicitCacheControl(provider, model);
  const stableSystemContent = explicitCacheControl
    ? [
        {
          type: "text",
          text: stablePrefix(),
          cache_control: explicitCacheControl,
        },
      ]
    : stablePrefix();
  const providerOptions = {
    gateway: { caching: "auto" },
    openrouter: {
      promptCacheKey: cacheKey,
      prompt_cache_key: cacheKey,
    },
    openai: {
      promptCacheKey: cacheKey,
      prompt_cache_key: cacheKey,
    },
    cerebras: {
      prompt_cache_key: cacheKey,
    },
  };

  return {
    model,
    messages: [
      { role: "system", content: stableSystemContent },
      {
        role: "user",
        content:
          "Stable conversation anchor: cache validation for this planner call.",
      },
      {
        role: "user",
        content: dynamicUserMessage(callIndex, scenario),
      },
    ],
    ...(includeTools
      ? {
          tools: [plannerTool()],
          tool_choice: openAICompatibleToolChoice(forceTool),
        }
      : {}),
    max_tokens: maxTokens(),
    temperature: 0,
    prompt_cache_key: cacheKey,
    ...(provider === "elizacloud"
      ? {
          providerOptions,
          provider_options: providerOptions,
        }
      : {}),
  };
}

function anthropicPayload({
  model,
  callIndex,
  includeTools = true,
  forceTool = false,
  scenario = "tool-call",
}) {
  return {
    model,
    max_tokens: maxTokens(),
    temperature: 0,
    system: [
      {
        type: "text",
        text: stablePrefix(),
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    ...(includeTools
      ? {
          tools: [
            {
              name: "PLAN_ACTIONS",
              description:
                "Return a compact action plan for the agent runtime.",
              input_schema: plannerTool().function.parameters,
            },
          ],
          tool_choice: forceTool
            ? { type: "tool", name: "PLAN_ACTIONS" }
            : { type: "auto" },
        }
      : {}),
    messages: [
      {
        role: "user",
        content:
          "Stable conversation anchor: cache validation for this planner call.",
      },
      {
        role: "user",
        content: dynamicUserMessage(callIndex, scenario),
      },
    ],
  };
}

function dynamicUserMessage(callIndex, scenario) {
  if (scenario === "reply") {
    return `Dynamic message ${callIndex}: use PLAN_ACTIONS with exactly one action named REPLY and input { "message": "cache validation ok" }.`;
  }
  return `Dynamic message ${callIndex}: use PLAN_ACTIONS with exactly one action named PLAY_TRACK and input { "query": "Blue Monday" }.`;
}

function openAICompatibleToolChoice(forceTool) {
  return forceTool
    ? { type: "function", function: { name: "PLAN_ACTIONS" } }
    : "auto";
}

function openRouterExplicitCacheControl(provider, model) {
  if (provider !== "openrouter") return undefined;
  const normalized = String(model ?? "").toLowerCase();
  if (normalized.startsWith("anthropic/")) {
    return { type: "ephemeral", ttl: "1h" };
  }
  if (normalized.includes("gemini")) {
    return { type: "ephemeral" };
  }
  return undefined;
}

function providerConfig(provider, args) {
  const configs = {
    elizacloud: {
      label: "Eliza Cloud via OpenRouter DeepSeek V4 Pro",
      endpoint: `${(
        process.env.ELIZAOS_CLOUD_BASE_URL ?? "https://www.elizacloud.ai/api/v1"
      ).replace(/\/+$/, "")}/chat/completions`,
      apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
      apiKeyName: "ELIZAOS_CLOUD_API_KEY",
      model:
        args.model ??
        process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL ??
        DEFAULT_LARGE_MODEL,
      kind: "openai-compatible",
    },
    openrouter: {
      label: "OpenRouter DeepSeek V4 Pro",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: process.env.OPENROUTER_API_KEY,
      apiKeyName: "OPENROUTER_API_KEY",
      model: args.model ?? DEFAULT_LARGE_MODEL,
      kind: "openai-compatible",
    },
    openai: {
      label: "OpenAI small response handler",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: process.env.OPENAI_API_KEY,
      apiKeyName: "OPENAI_API_KEY",
      model: args.model ?? "gpt-5.4-mini",
      kind: "openai-compatible",
    },
    anthropic: {
      label: "Anthropic large planner",
      endpoint: "https://api.anthropic.com/v1/messages",
      apiKey: process.env.ANTHROPIC_API_KEY,
      apiKeyName: "ANTHROPIC_API_KEY",
      model: args.model ?? "claude-opus-4-7",
      kind: "anthropic",
    },
  };

  const config = configs[provider];
  if (!config) {
    throw new Error(
      `Unknown provider "${provider}". Use elizacloud, openrouter, openai, or anthropic.`,
    );
  }
  return config;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value, key) {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : {};
}

function numericValue(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeCacheUsage(usageOrResponse) {
  const responseRoot = isRecord(usageOrResponse) ? usageOrResponse : {};
  const root = isRecord(responseRoot.usage) ? responseRoot.usage : responseRoot;
  const inputTokenDetails = recordAt(root, "inputTokenDetails");
  const promptTokensDetails = recordAt(root, "prompt_tokens_details");
  const inputTokensDetailsSnake = recordAt(root, "input_tokens_details");
  const cacheReadInputTokens = numericValue(
    root.cacheReadInputTokens,
    root.cache_read_input_tokens,
    root.cacheReadTokens,
    inputTokenDetails.cacheReadTokens,
    inputTokenDetails.cacheReadInputTokens,
    promptTokensDetails.cache_read_input_tokens,
    inputTokensDetailsSnake.cache_read_input_tokens,
  );
  const cachedInputTokens =
    numericValue(
      root.cachedInputTokens,
      root.cached_input_tokens,
      root.cachedTokens,
      root.cached_tokens,
      inputTokenDetails.cachedInputTokens,
      inputTokenDetails.cachedTokens,
      inputTokenDetails.cacheReadTokens,
      promptTokensDetails.cached_tokens,
      inputTokensDetailsSnake.cached_tokens,
      cacheReadInputTokens,
    ) ?? cacheReadInputTokens;
  const cacheCreationInputTokens = numericValue(
    root.cacheCreationInputTokens,
    root.cache_creation_input_tokens,
    root.cacheWriteInputTokens,
    inputTokenDetails.cacheCreationInputTokens,
    inputTokenDetails.cacheCreationTokens,
    inputTokensDetailsSnake.cache_creation_input_tokens,
  );
  const inputTokens = numericValue(
    root.inputTokens,
    root.input_tokens,
    root.promptTokens,
    root.prompt_tokens,
  );
  const outputTokens = numericValue(
    root.outputTokens,
    root.output_tokens,
    root.completionTokens,
    root.completion_tokens,
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens: numericValue(root.totalTokens, root.total_tokens),
    cacheReadInputTokens: cacheReadInputTokens ?? cachedInputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    cacheHitRate:
      inputTokens && cachedInputTokens !== undefined
        ? cachedInputTokens / inputTokens
        : undefined,
    rawUsage: root,
  };
}

function summarize(observations) {
  const summary = observations.reduce(
    (acc, item) => {
      acc.calls += 1;
      acc.inputTokens += item.inputTokens ?? 0;
      acc.outputTokens += item.outputTokens ?? 0;
      acc.cacheReadInputTokens += item.cacheReadInputTokens ?? 0;
      acc.cacheCreationInputTokens += item.cacheCreationInputTokens ?? 0;
      acc.cachedInputTokens += item.cachedInputTokens ?? 0;
      return acc;
    },
    {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      cacheHitRate: 0,
    },
  );
  summary.cacheHitRate =
    summary.inputTokens > 0
      ? summary.cachedInputTokens / summary.inputTokens
      : 0;
  return summary;
}

function sanitizeRequest(payload) {
  return {
    model: payload.model,
    promptCacheKey: payload.prompt_cache_key ?? payload.promptCacheKey,
    messageShape: Array.isArray(payload.messages)
      ? payload.messages.map((message) => ({
          role: message.role,
          contentHash: sha256(JSON.stringify(message.content ?? "")),
          contentLength: JSON.stringify(message.content ?? "").length,
          cacheControlBlocks: countCacheControlBlocks(message.content),
        }))
      : undefined,
    systemHash: payload.system
      ? sha256(JSON.stringify(payload.system))
      : undefined,
    tools: Array.isArray(payload.tools)
      ? payload.tools.map(
          (tool) => tool.function?.name ?? tool.name ?? "unknown",
        )
      : undefined,
    toolChoice: payload.tool_choice ?? payload.toolChoice,
    responseFormat: payload.response_format?.type,
    providerOptionsKeys: isRecord(payload.providerOptions)
      ? Object.keys(payload.providerOptions).sort()
      : undefined,
    providerOptionsHash: payload.providerOptions
      ? sha256(JSON.stringify(payload.providerOptions))
      : undefined,
  };
}

function countCacheControlBlocks(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlBlocks(item), 0);
  }
  if (!isRecord(value)) return 0;
  return (
    (isRecord(value.cache_control) ? 1 : 0) +
    Object.entries(value).reduce((sum, [key, item]) => {
      return key === "cache_control"
        ? sum
        : sum + countCacheControlBlocks(item);
    }, 0)
  );
}

function summarizeResponse(data) {
  if (!isRecord(data)) return {};
  const choices = Array.isArray(data.choices) ? data.choices : [];
  if (choices.length > 0) {
    return {
      id: typeof data.id === "string" ? data.id : undefined,
      choices: choices.map((choice) => {
        const message = isRecord(choice.message) ? choice.message : {};
        return {
          finishReason: choice.finish_reason ?? choice.finishReason,
          role: message.role,
          contentLength:
            typeof message.content === "string"
              ? message.content.length
              : undefined,
          contentHash:
            typeof message.content === "string"
              ? sha256(message.content)
              : undefined,
          toolCalls: summarizeToolCalls(
            message.tool_calls ?? message.toolCalls,
          ),
        };
      }),
    };
  }

  const content = Array.isArray(data.content) ? data.content : [];
  if (content.length > 0) {
    return {
      id: typeof data.id === "string" ? data.id : undefined,
      stopReason: data.stop_reason,
      content: content.map((part) => {
        if (!isRecord(part)) return { type: "unknown" };
        return {
          type: part.type,
          name: part.name,
          textLength:
            typeof part.text === "string" ? part.text.length : undefined,
          textHash:
            typeof part.text === "string" ? sha256(part.text) : undefined,
          inputLength: part.input
            ? JSON.stringify(part.input).length
            : undefined,
          inputHash: part.input
            ? sha256(JSON.stringify(part.input))
            : undefined,
        };
      }),
    };
  }

  return {
    id: typeof data.id === "string" ? data.id : undefined,
    keys: Object.keys(data).sort(),
  };
}

function summarizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => {
    const fn = isRecord(call.function) ? call.function : {};
    const args =
      typeof fn.arguments === "string"
        ? fn.arguments
        : fn.arguments
          ? JSON.stringify(fn.arguments)
          : "";
    const parsedArgs = parseJsonObject(args);
    return {
      id: typeof call.id === "string" ? call.id : undefined,
      type: call.type,
      name: fn.name ?? call.name,
      argumentsLength: args.length,
      argumentsHash: args ? sha256(args) : undefined,
      argumentsJson: parsedArgs !== undefined,
      argumentKeys: parsedArgs ? Object.keys(parsedArgs).sort() : undefined,
      actionNames: extractToolArgumentActionNames(parsedArgs),
    };
  });
}

function parseJsonObject(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractToolArgumentActionNames(args) {
  if (!isRecord(args)) return [];
  if (Array.isArray(args.actions)) {
    return args.actions
      .map((action) => (isRecord(action) ? action.name : undefined))
      .filter((name) => typeof name === "string");
  }
  if (typeof args.action === "string") return [args.action];
  if (typeof args.name === "string") return [args.name];
  return [];
}

function maxTokens() {
  const value = Number(process.env.ELIZA_CACHE_MAX_TOKENS ?? 256);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 256;
}

async function callProvider(config, payload) {
  const headers =
    config.kind === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        };

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { rawText: text };
  }
  if (!response.ok) {
    throw new Error(
      `${config.label} HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  return data;
}

function dryRun(args) {
  const provider = args.provider ?? "elizacloud";
  const config = providerConfig(provider, args);
  const includeTools = shouldIncludeTools(args);
  const forceTool = shouldForceTool(args);
  const scenario = args.scenario ?? "tool-call";
  const payload =
    config.kind === "anthropic"
      ? anthropicPayload({
          model: config.model,
          callIndex: 1,
          includeTools,
          forceTool,
          scenario,
        })
      : openAICompatiblePayload({
          model: config.model,
          callIndex: 1,
          provider,
          includeTools,
          forceTool,
          scenario,
        });
  const observations = [
    normalizeCacheUsage({
      prompt_tokens: 4096,
      completion_tokens: 24,
      cached_tokens: 0,
    }),
    normalizeCacheUsage({
      prompt_tokens: 4096,
      completion_tokens: 24,
      cached_tokens: 3072,
    }),
  ];

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        note: "No network call was made. Set ELIZA_CACHE_LIVE=1 and the provider API key to run live.",
        provider: config.label,
        model: config.model,
        largeModelLabel:
          config.model === DEFAULT_LARGE_MODEL
            ? `OpenRouter DeepSeek V4 Pro (${DEFAULT_LARGE_MODEL})`
            : undefined,
        request: sanitizeRequest(payload),
        observations,
        summary: summarize(observations),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const provider =
    args.provider ?? process.env.ELIZA_CACHE_PROVIDER ?? "elizacloud";
  const calls = Math.max(
    1,
    Number(args.calls ?? process.env.ELIZA_CACHE_CALLS ?? 3),
  );

  if (process.env.ELIZA_CACHE_LIVE !== "1") {
    dryRun({ ...args, provider });
    return;
  }

  const config = providerConfig(provider, args);
  if (!config.apiKey) {
    throw new Error(
      `Missing ${config.apiKeyName}; live cache harness will not run without it.`,
    );
  }
  const includeTools = shouldIncludeTools(args);
  const forceTool = shouldForceTool(args);
  const scenario = args.scenario ?? "tool-call";

  const observations = [];
  for (let index = 1; index <= calls; index += 1) {
    const payload =
      config.kind === "anthropic"
        ? anthropicPayload({
            model: config.model,
            callIndex: index,
            includeTools,
            forceTool,
            scenario,
          })
        : openAICompatiblePayload({
            model: config.model,
            callIndex: index,
            provider,
            includeTools,
            forceTool,
            scenario,
          });
    const started = performance.now();
    const data = await callProvider(config, payload);
    const latencyMs = Math.round(performance.now() - started);
    const observation = normalizeCacheUsage(data);
    observations.push(observation);
    console.log(
      JSON.stringify(
        {
          call: index,
          provider: config.label,
          model: config.model,
          largeModelLabel:
            config.model === DEFAULT_LARGE_MODEL
              ? `OpenRouter DeepSeek V4 Pro (${DEFAULT_LARGE_MODEL})`
              : undefined,
          latencyMs,
          prefixHash: sha256(stablePrefix()),
          request: sanitizeRequest(payload),
          response: summarizeResponse(data),
          usage: observation,
        },
        null,
        2,
      ),
    );
  }

  console.log(JSON.stringify({ summary: summarize(observations) }, null, 2));
}

function shouldIncludeTools(args) {
  return (
    args.tools !== "false" && args.tools !== "0" && args.noTools !== "true"
  );
}

function shouldForceTool(args) {
  return args.forceTool === "true" || args.forceTool === "1";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
