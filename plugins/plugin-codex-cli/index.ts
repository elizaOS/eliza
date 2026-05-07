import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
  TextStreamResult,
} from "@elizaos/core";
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
  return {
    prompt: params.prompt,
    system: (params as GenerateTextParams & { system?: string }).system,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    model: getCodexModel(runtime),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    responseFormat: params.responseFormat,
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

async function generateObjectWithCodex(
  runtime: IAgentRuntime,
  params: ObjectGenerationParams,
  modelType: string
): Promise<Record<string, JsonValue>> {
  const schemaInstruction = params.schema
    ? `\n\nReturn only a JSON object matching this JSON Schema:\n${JSON.stringify(params.schema)}`
    : "\n\nReturn only a JSON object.";
  const prompt = `${params.prompt}${schemaInstruction}`;
  const result = await createBackend(runtime).generate({
    prompt,
    model: getCodexModel(runtime),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    responseFormat: { type: "json_object" },
  });
  try {
    const parsed = JSON.parse(result.text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, JsonValue>;
  } catch (err) {
    throw new Error(
      `codex ${modelType} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  throw new Error(`codex ${modelType} returned non-object JSON`);
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
  [ModelType.OBJECT_SMALL]: (runtime: IAgentRuntime, params: ObjectGenerationParams) =>
    generateObjectWithCodex(runtime, params, ModelType.OBJECT_SMALL),
  [ModelType.OBJECT_LARGE]: (runtime: IAgentRuntime, params: ObjectGenerationParams) =>
    generateObjectWithCodex(runtime, params, ModelType.OBJECT_LARGE),
} as unknown as Plugin["models"];

export const codexCliPlugin: Plugin = {
  name: "codex-cli",
  description: "ChatGPT Codex model provider using the codex CLI OAuth token cache",
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
