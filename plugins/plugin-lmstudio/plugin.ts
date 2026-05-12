/**
 * `@elizaos/plugin-lmstudio` — LM Studio provider plugin.
 *
 * Mirrors `@elizaos/plugin-ollama`: model-type → handler wiring, init-time
 * detection logging, and a self-describing `autoEnable` block that activates
 * the plugin when LM Studio is reachable.
 *
 * LM Studio is OpenAI-compatible, so the actual byte-on-wire shape lives in
 * `@ai-sdk/openai-compatible` and the handlers are in `models/*`.
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  Plugin,
  TextEmbeddingParams,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
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
import { getApiKey, getBaseURL, shouldAutoDetect } from "./utils/config";
import { detectLMStudio } from "./utils/detect";

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();
const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as string;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as string;

export const lmStudioPlugin: Plugin = {
  name: "lmstudio",
  description: "LM Studio provider for local LLM inference via the OpenAI-compatible API",
  autoEnable: {
    envKeys: ["LMSTUDIO_BASE_URL"],
    // Auto-enable when LM Studio is reachable at the default localhost endpoint, even
    // without an env var. Mirrors how plugin-ollama auto-detects.
    shouldEnable: async () => {
      try {
        const result = await detectLMStudio({ timeoutMs: 750 });
        return result.available;
      } catch {
        return false;
      }
    },
  },

  config: {
    LMSTUDIO_BASE_URL: env.LMSTUDIO_BASE_URL ?? null,
    LMSTUDIO_API_KEY: env.LMSTUDIO_API_KEY ?? null,
    LMSTUDIO_SMALL_MODEL: env.LMSTUDIO_SMALL_MODEL ?? null,
    LMSTUDIO_LARGE_MODEL: env.LMSTUDIO_LARGE_MODEL ?? null,
    LMSTUDIO_EMBEDDING_MODEL: env.LMSTUDIO_EMBEDDING_MODEL ?? null,
    LMSTUDIO_AUTO_DETECT: env.LMSTUDIO_AUTO_DETECT ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
  },

  async init(_config, runtime) {
    const baseURL = getBaseURL(runtime);
    if (!shouldAutoDetect(runtime)) {
      logger.debug("[LMStudio] LMSTUDIO_AUTO_DETECT disabled — skipping init probe.");
      return;
    }

    const result = await detectLMStudio({
      baseURL,
      apiKey: getApiKey(runtime),
      fetcher: runtime.fetch ?? undefined,
      timeoutMs: 2000,
    });

    if (!result.available) {
      logger.warn(
        { src: "plugin:lmstudio", baseURL, error: result.error },
        "[LMStudio] /v1/models probe failed — plugin will only succeed once LM Studio is running."
      );
      return;
    }

    const modelCount = result.models?.length ?? 0;
    logger.info(
      `[LMStudio] Detected ${modelCount} model${modelCount === 1 ? "" : "s"} at ${baseURL}`
    );
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
  },

  tests: [
    {
      name: "lmstudio_plugin_tests",
      tests: [
        {
          name: "lmstudio_test_models_endpoint",
          fn: async (runtime: IAgentRuntime) => {
            const result = await detectLMStudio({
              baseURL: getBaseURL(runtime),
              apiKey: getApiKey(runtime),
              fetcher: runtime.fetch ?? undefined,
            });
            if (!result.available) {
              logger.error({ result }, "[LMStudio] /v1/models probe failed");
              return;
            }
            logger.log({ models: result.models?.length ?? 0 }, "[LMStudio] /v1/models OK");
          },
        },
      ],
    },
  ],
};
