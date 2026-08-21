/**
 * Zerollama provider plugin registration — elizaOS's built-in Ollama-protocol inference plugin.
 *
 * ## Why this file exists separately from `models/*`
 *
 * Centralizes **plugin metadata**, **model-type → handler** wiring, and **init-time** logging
 * (base URL, model defaults) so model modules stay pure “call Ollama / AI SDK” logic.
 *
 * ## Text handlers and v5 parity
 *
 * `TEXT_*`, `RESPONSE_HANDLER`, and `ACTION_PLANNER` all route through `models/text.ts`, which uses:
 *
 * - **`generateText`** — default completion; structured output when `responseSchema` is set and
 *   streaming is not used for that shape; **`stream: true`** + schema-only (no tools) for nested
 *   extractors. **Why:** keeps JSON `format` on the supported completion path.
 * - **`streamText`** — plain SSE chat when `stream: true` with no tools/schema/`toolChoice`; and
 *   **`stream: true` + native tools** so Ollama can stream `/api/chat` with tools. For v5 planner
 *   model types under SSE, `models/text.ts` may yield a **single** `textStream` chunk of plan JSON
 *   so `useModel`’s concatenated string stays parseable. **Why:** core’s streaming path only
 *   accumulates `textStream` chunks, not the `text` promise; mixing arbitrary deltas with plan JSON
 *   breaks `parseMessageHandlerOutput`.
 *
 * Handlers return **`Promise<string | TextStreamResult>`** — **why:** `useModel` accepts either a
 * final string or a streaming object for text model keys; matching OpenRouter keeps orchestration
 * and SSE paths identical. ElizaOS v5 Stage 1 calls `RESPONSE_HANDLER` with **`messages`**,
 * **`tools`**, and **`toolChoice`**; the text adapter must accept the same shapes as
 * OpenRouter/OpenAI or local-only agents fail before the first reply. See `models/text.ts` and
 * `utils/ai-sdk-wire.ts` module comments for the full rationale.
 *
 * ## AI SDK log noise
 *
 * Suppresses noisy AI SDK warnings at load (`AI_SDK_LOG_WARNINGS`) because local inference
 * runs in tight loops during tests and desktop shells. **Why:** keeps CI and packaged logs readable.
 */
import type {
  GenerateTextParams,
  IAgentRuntime,
  Plugin,
  ProcessEnvLike,
  TextEmbeddingParams,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
_globalThis.AI_SDK_LOG_WARNINGS ??= false;

import { handleTextToSpeech, handleTranscription } from "./models/audio";
import { handleTextEmbedding } from "./models/embedding";
import {
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "./models/text";
import { getApiBase, getBaseURL } from "./utils/config";

export const OLLAMA_INIT_PROBE_TIMEOUT_MS = 5_000;
const OLLAMA_PREWARM_TIMEOUT_MS = 120_000;

async function fetchOllamaTagsWithTimeout(apiBase: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort(
      new DOMException(`Ollama probe timed out after ${timeoutMs}ms`, "TimeoutError")
    );
  }, timeoutMs);
  try {
    return await fetch(`${apiBase}/api/tags`, { signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function readTruthyEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolvePrewarmModel(runtime: IAgentRuntime): string | null {
  const candidates = [
    runtime.getSetting("OLLAMA_SMALL_MODEL"),
    runtime.getSetting("SMALL_MODEL"),
    runtime.getSetting("OLLAMA_LARGE_MODEL"),
    runtime.getSetting("LARGE_MODEL"),
    process.env.OLLAMA_SMALL_MODEL,
    process.env.SMALL_MODEL,
    process.env.OLLAMA_LARGE_MODEL,
    process.env.LARGE_MODEL,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function scheduleOllamaPrewarm(
  runtime: IAgentRuntime,
  apiBase: string,
  model: string,
  fetchImpl: typeof fetch
): void {
  void fetchImpl(`${apiBase}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "hi",
      stream: false,
      options: { num_predict: 1 },
    }),
    signal: AbortSignal.timeout(OLLAMA_PREWARM_TIMEOUT_MS),
  }).catch((err) => {
    // error-policy:J7 optional prewarm is diagnostic optimization only; the
    // first real model call remains the authoritative readiness check.
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`[ollama] prewarm skipped: ${message}`);
    runtime.reportError("plugin-zerollama.prewarm", err, { apiBase, model });
  });
}

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();
const TEXT_NANO_MODEL_TYPE = ModelType.TEXT_NANO as string;
const TEXT_MEDIUM_MODEL_TYPE = ModelType.TEXT_MEDIUM as string;
const TEXT_MEGA_MODEL_TYPE = ModelType.TEXT_MEGA as string;
const RESPONSE_HANDLER_MODEL_TYPE = ModelType.RESPONSE_HANDLER as string;
const ACTION_PLANNER_MODEL_TYPE = ModelType.ACTION_PLANNER as string;

export const ollamaPlugin: Plugin = {
  name: "zerollama",
  description:
    "Zerollama/Ollama plugin for local LLM inference — text, embeddings, TTS, and ASR via the Ollama-compatible API with native zerollama optimizations",
  autoEnable: {
    envKeys: ["OLLAMA_BASE_URL", "OLLAMA_API_ENDPOINT", "OLLAMA_API_URL"],
  },

  config: {
    OLLAMA_BASE_URL: env.OLLAMA_BASE_URL ?? null,
    OLLAMA_API_ENDPOINT: env.OLLAMA_API_ENDPOINT ?? null,
    OLLAMA_API_URL: env.OLLAMA_API_URL ?? null,
    OLLAMA_NANO_MODEL: env.OLLAMA_NANO_MODEL ?? null,
    OLLAMA_SMALL_MODEL: env.OLLAMA_SMALL_MODEL ?? null,
    OLLAMA_MEDIUM_MODEL: env.OLLAMA_MEDIUM_MODEL ?? null,
    OLLAMA_LARGE_MODEL: env.OLLAMA_LARGE_MODEL ?? null,
    OLLAMA_MEGA_MODEL: env.OLLAMA_MEGA_MODEL ?? null,
    OLLAMA_RESPONSE_HANDLER_MODEL: env.OLLAMA_RESPONSE_HANDLER_MODEL ?? null,
    OLLAMA_SHOULD_RESPOND_MODEL: env.OLLAMA_SHOULD_RESPOND_MODEL ?? null,
    OLLAMA_ACTION_PLANNER_MODEL: env.OLLAMA_ACTION_PLANNER_MODEL ?? null,
    OLLAMA_PLANNER_MODEL: env.OLLAMA_PLANNER_MODEL ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    OLLAMA_EMBEDDING_MODEL: env.OLLAMA_EMBEDDING_MODEL ?? null,
    OLLAMA_DISABLE_STRUCTURED_OUTPUT: env.OLLAMA_DISABLE_STRUCTURED_OUTPUT ?? null,
    OLLAMA_TTS_MODEL: env.OLLAMA_TTS_MODEL ?? env.OLLAMA_SPEECH_MODEL ?? null,
    OLLAMA_TTS_VOICE: env.OLLAMA_TTS_VOICE ?? env.OLLAMA_SPEECH_VOICE ?? null,
    OLLAMA_TTS_SPEED: env.OLLAMA_TTS_SPEED ?? env.OLLAMA_SPEECH_SPEED ?? null,
    OLLAMA_TRANSCRIPTION_MODEL: env.OLLAMA_TRANSCRIPTION_MODEL ?? env.OLLAMA_ASR_MODEL ?? null,
  },

  async init(_config, runtime) {
    const baseURL = getBaseURL(runtime);
    const apiBase = getApiBase(runtime);

    if (!baseURL || baseURL === "http://localhost:11434/api") {
      const endpoint = runtime.getSetting("OLLAMA_API_ENDPOINT");
      if (!endpoint) {
        logger.warn("OLLAMA_API_ENDPOINT not set, using default localhost:11434");
      }
    }

    try {
      const fetchImpl = (runtime as { fetch?: typeof fetch }).fetch ?? fetch;
      const response = await fetchImpl(`${apiBase}/api/tags`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(OLLAMA_INIT_PROBE_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.warn(`Ollama API validation failed: ${response.statusText}`);
        return;
      }

      // Probe host flavor early so the first chat turn already picks native
      // zerollama wire (strict ChatRequest) vs AI SDK stock-Ollama path.
      try {
        const { resolveOllamaHostFlavor } = await import("./utils/host-flavor");
        await resolveOllamaHostFlavor(apiBase, fetchImpl);
      } catch (flavorErr) {
        // error-policy:J4 flavor detection is optional; unknown flavor keeps
        // the stock Ollama-compatible path available.
        logger.debug(
          `[ollama] host-flavor probe skipped: ${flavorErr instanceof Error ? flavorErr.message : String(flavorErr)}`
        );
      }

      if (readTruthyEnv("OLLAMA_PREWARM")) {
        const model = resolvePrewarmModel(runtime);
        if (model) {
          logger.info(`[ollama] prewarming model ${model}`);
          scheduleOllamaPrewarm(runtime, apiBase, model, fetchImpl);
        } else {
          logger.warn(
            "[ollama] OLLAMA_PREWARM=1 but no OLLAMA_SMALL_MODEL/OLLAMA_LARGE_MODEL configured"
          );
        }
      }
    } catch (fetchError: unknown) {
      // error-policy:J4 explicit degrade — `init` runs a connectivity probe; a
      // daemon-down result must not crash plugin load (the agent can start with
      // Ollama offline and the operator brings it up later). The failure is
      // surfaced per-call by ensureModelAvailable (throws), not swallowed there.
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.warn(`Ollama API validation error: ${message}`);
    }
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [TEXT_NANO_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextNano(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMedium(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleActionPlanner(runtime, params);
    },

    // Opt-in via OLLAMA_TTS_MODEL / OLLAMA_TRANSCRIPTION_MODEL (handlers throw
    // if unset). Local-inference HTTP routes and prefer-local routing still
    // prefer on-device Kokoro/ASR when available unless those env vars are set
    // (see tts-routes / asr-transcribe ollama-first lists).
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      params: Parameters<typeof handleTextToSpeech>[1]
    ) => handleTextToSpeech(runtime, params),

    [ModelType.TRANSCRIPTION]: async (
      runtime: IAgentRuntime,
      params: Parameters<typeof handleTranscription>[1]
    ) => handleTranscription(runtime, params),
  },

  tests: [
    {
      name: "ollama_plugin_tests",
      tests: [
        {
          name: "ollama_test_url_validation",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const apiBase = getApiBase(runtime);
              const response = await fetchOllamaTagsWithTimeout(
                apiBase,
                OLLAMA_INIT_PROBE_TIMEOUT_MS
              );
              if (!response.ok) {
                logger.error(`Failed to validate Ollama API: ${response.statusText}`);
              }
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — a probe failure is logged
              // as the test result; it must not throw out of the test harness.
              logger.error({ error }, "Error in ollama_test_url_validation");
              runtime.reportError("plugin-zerollama.test.url-validation", error);
            }
          },
        },
        {
          name: "ollama_test_text_embedding",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const embedding = await runModel(ModelType.TEXT_EMBEDDING, {
                text: "Hello, world!",
              });
              logger.log({ embedding }, "Generated embedding");
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — logged as the test result.
              logger.error({ error }, "Error in test_text_embedding");
              runtime.reportError("plugin-zerollama.test.text-embedding", error);
            }
          },
        },
        {
          name: "ollama_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_LARGE, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                logger.error("Failed to generate text");
                return;
              }
              logger.log({ text }, "Generated with test_text_large");
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — logged as the test result.
              logger.error({ error }, "Error in test_text_large");
              runtime.reportError("plugin-zerollama.test.text-large", error);
            }
          },
        },
        {
          name: "ollama_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_SMALL, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                logger.error("Failed to generate text");
                return;
              }
              logger.log({ text }, "Generated with test_text_small");
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — logged as the test result.
              logger.error({ error }, "Error in test_text_small");
              runtime.reportError("plugin-zerollama.test.text-small", error);
            }
          },
        },
        {
          name: "ollama_test_structured_output_via_text_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const result = await runModel(ModelType.TEXT_SMALL, {
                prompt:
                  "Generate a JSON object representing a user profile with name, age, and hobbies",
                temperature: 0.7,
                responseSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    age: { type: "number" },
                    hobbies: { type: "array", items: { type: "string" } },
                  },
                  required: ["name", "age", "hobbies"],
                },
              });
              logger.log({ result }, "Generated structured output via TEXT_SMALL");
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — logged as the test result.
              logger.error({ error }, "Error in test_structured_output_via_text_small");
              runtime.reportError("plugin-zerollama.test.structured-small", error);
            }
          },
        },
        {
          name: "ollama_test_structured_output_via_text_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const result = await runModel(ModelType.TEXT_LARGE, {
                prompt:
                  "Generate a detailed JSON object representing a restaurant with name, cuisine type, menu items with prices, and customer reviews",
                temperature: 0.7,
                responseSchema: { type: "object" },
              });
              logger.log({ result }, "Generated structured output via TEXT_LARGE");
            } catch (error) {
              // error-policy:J7 plugin self-test diagnostic — logged as the test result.
              logger.error({ error }, "Error in test_structured_output_via_text_large");
              runtime.reportError("plugin-zerollama.test.structured-large", error);
            }
          },
        },
      ],
    },
  ],
};
