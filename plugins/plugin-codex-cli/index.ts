import type { GenerateTextParams, IAgentRuntime, Plugin, TextStreamResult } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { CodexBackend, type CodexGenerateResult } from "./src/codex-backend";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as string;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as string;

const CODEX_SUPPORTED_MODELS = [
  "gpt-5",
  "gpt-5-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.5-pro",
] as const;

type RuntimeWithSettings = IAgentRuntime & {
  getSetting?: (key: string) => string | number | boolean | undefined | null;
};

type TextResultWithNativeTools = {
  text: string;
  toolCalls: CodexGenerateResult["toolCalls"];
  finishReason?: string;
  usage?: CodexGenerateResult["usage"];
};

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = (runtime as RuntimeWithSettings).getSetting?.(key);
  return value === undefined || value === null ? readEnv(key) : String(value);
}

function getCodexModel(runtime: IAgentRuntime): string {
  return getSetting(runtime, "CODEX_MODEL") ?? "gpt-5.5";
}

const backendByRuntime = new WeakMap<IAgentRuntime, CodexBackend>();

function createBackend(runtime: IAgentRuntime): CodexBackend {
  const existing = backendByRuntime.get(runtime);
  if (existing) return existing;

  const jitterRaw = getSetting(runtime, "CODEX_JITTER_MS_MAX");
  const jitterMaxMs = jitterRaw === undefined ? undefined : Number.parseInt(jitterRaw, 10);
  const backend = new CodexBackend({
    authPath: getSetting(runtime, "CODEX_AUTH_PATH"),
    baseUrl: getSetting(runtime, "CODEX_BASE_URL"),
    model: getCodexModel(runtime),
    originator: getSetting(runtime, "CODEX_ORIGINATOR"),
    jitterMaxMs: Number.isFinite(jitterMaxMs) ? jitterMaxMs : undefined,
  });
  backendByRuntime.set(runtime, backend);
  return backend;
}

function toTextReturn(
  params: GenerateTextParams,
  result: CodexGenerateResult
): string | TextResultWithNativeTools {
  if (params.tools?.length || params.messages?.length || result.toolCalls.length > 0) {
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
    };
  }
  return result.text;
}

function buildCodexGenerateParams(runtime: IAgentRuntime, params: GenerateTextParams) {
  // Honor `responseSchema` natively. OpenAI-compatible Codex models accept
  // `response_format: { type: "json_schema", schema }` for guaranteed JSON
  // output; if the caller already passed a custom `responseFormat`, leave it
  // alone.
  const paramsWithSchema = params as GenerateTextParams & {
    responseSchema?: unknown;
    system?: string;
  };
  const responseFormat =
    params.responseFormat ??
    (paramsWithSchema.responseSchema
      ? {
          type: "json_schema" as const,
          schema: paramsWithSchema.responseSchema as Record<string, unknown>,
        }
      : undefined);
  return {
    prompt: params.prompt,
    system: paramsWithSchema.system,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    model: getCodexModel(runtime),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    responseFormat,
  };
}

function streamTextWithCodex(runtime: IAgentRuntime, params: GenerateTextParams): TextStreamResult {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let done = false;

  const wake = () => {
    notify?.();
    notify = undefined;
  };

  const resultPromise = createBackend(runtime)
    .generate({
      ...buildCodexGenerateParams(runtime, params),
      onTextDelta: (delta) => {
        queue.push(delta);
        wake();
      },
    })
    .finally(() => {
      done = true;
      wake();
    });

  async function* textStream(): AsyncIterable<string> {
    while (!done || queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return {
    textStream: textStream(),
    text: resultPromise.then((result) => result.text),
    usage: resultPromise.then((result) =>
      result.usage
        ? {
            promptTokens: result.usage.inputTokens,
            completionTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined
    ),
    finishReason: resultPromise.then((result) => result.finishReason),
  };
}

async function generateTextWithCodex(
  runtime: IAgentRuntime,
  params: GenerateTextParams,
  modelType: string
): Promise<string | TextResultWithNativeTools | TextStreamResult> {
  const model = getCodexModel(runtime);
  logger.debug(`[codex-cli] Using ${modelType} model: ${model}`);
  if (params.stream) return streamTextWithCodex(runtime, params);
  const result = await createBackend(runtime).generate(buildCodexGenerateParams(runtime, params));
  return toTextReturn(params, result);
}

const codexModels = {
  [ModelType.TEXT_SMALL]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, ModelType.TEXT_SMALL),
  [TEXT_NANO_MODEL_TYPE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, TEXT_NANO_MODEL_TYPE),
  [TEXT_MEDIUM_MODEL_TYPE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, TEXT_MEDIUM_MODEL_TYPE),
  [ModelType.TEXT_LARGE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, ModelType.TEXT_LARGE),
  [TEXT_MEGA_MODEL_TYPE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, TEXT_MEGA_MODEL_TYPE),
  [RESPONSE_HANDLER_MODEL_TYPE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, RESPONSE_HANDLER_MODEL_TYPE),
  [ACTION_PLANNER_MODEL_TYPE]: (runtime: IAgentRuntime, params: GenerateTextParams) =>
    generateTextWithCodex(runtime, params, ACTION_PLANNER_MODEL_TYPE),
} as Plugin["models"];

export const codexCliPlugin: Plugin = {
  name: "codex-cli",
  description: "ChatGPT Codex model provider using the codex CLI OAuth token cache",
  autoEnable: {
    // No env-key auto-enable; activated when an auth profile selects codex-cli
    // as its provider (e.g. via subscription onboarding).
    shouldEnable: (_env, config) => {
      const auth = (config as { auth?: { profiles?: Record<string, unknown> } }).auth;
      const profiles = auth?.profiles;
      if (!profiles || typeof profiles !== "object") return false;
      return Object.values(profiles).some((profile) => {
        if (!profile || typeof profile !== "object") return false;
        return (profile as { provider?: unknown }).provider === "codex-cli";
      });
    },
  },
  config: {
    CODEX_AUTH_PATH: readEnv("CODEX_AUTH_PATH") ?? null,
    CODEX_BASE_URL: readEnv("CODEX_BASE_URL") ?? null,
    CODEX_MODEL: readEnv("CODEX_MODEL") ?? null,
    CODEX_JITTER_MS_MAX: readEnv("CODEX_JITTER_MS_MAX") ?? null,
    CODEX_ORIGINATOR: readEnv("CODEX_ORIGINATOR") ?? null,
  },
  async init(): Promise<void> {
    logger.info(`[codex-cli] initialized. Supported models: ${CODEX_SUPPORTED_MODELS.join(", ")}`);
  },
  models: codexModels,
};

export * from "./src/codex-auth";
export * from "./src/sse-parser";
export * from "./src/tool-format-openai";
export { CODEX_SUPPORTED_MODELS, CodexBackend };

export default codexCliPlugin;
