/**
 * `@elizaos/plugin-mlx` — MLX (Apple Silicon) provider plugin.
 *
 * Mirrors `@elizaos/plugin-ollama` and `@elizaos/plugin-lmstudio`:
 * model-type → handler wiring, init-time detection logging, and a
 * self-describing `autoEnable` block that activates the plugin when
 * `mlx_lm.server` is reachable AND the host is `darwin-arm64`.
 *
 * `mlx_lm.server` is OpenAI-compatible, so the actual byte-on-wire shape lives
 * in `@ai-sdk/openai-compatible` and the handlers are in `models/*`.
 *
 * ## Platform gate
 *
 * MLX (the Apple ML framework) is `darwin-arm64`-only. The plugin therefore
 * refuses to auto-enable on any other platform — there is no MLX runtime to
 * connect to. Operators who explicitly want to point at a remote mlx-lm
 * instance from a non-Apple-Silicon host can still load the plugin manually.
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
import { getApiKey, getBaseURL, isAppleSiliconHost, shouldAutoDetect } from "./utils/config";
import { detectMlx } from "./utils/detect";

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

export const mlxPlugin: Plugin = {
  name: "mlx",
  description:
    "MLX (Apple Silicon) provider for local LLM inference via mlx_lm.server's OpenAI-compatible API",
  autoEnable: {
    envKeys: ["MLX_BASE_URL"],
    // Auto-enable when mlx_lm.server is reachable at the default localhost
    // endpoint, but only on Apple Silicon — MLX itself doesn't run anywhere
    // else.
    shouldEnable: async () => {
      if (!isAppleSiliconHost()) {
        return false;
      }
      try {
        const result = await detectMlx({ timeoutMs: 750 });
        return result.available;
      } catch {
        return false;
      }
    },
  },

  config: {
    MLX_BASE_URL: env.MLX_BASE_URL ?? null,
    MLX_API_KEY: env.MLX_API_KEY ?? null,
    MLX_SMALL_MODEL: env.MLX_SMALL_MODEL ?? null,
    MLX_LARGE_MODEL: env.MLX_LARGE_MODEL ?? null,
    MLX_EMBEDDING_MODEL: env.MLX_EMBEDDING_MODEL ?? null,
    MLX_AUTO_DETECT: env.MLX_AUTO_DETECT ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
  },

  async init(_config, runtime) {
    if (!isAppleSiliconHost()) {
      logger.warn(
        { src: "plugin:mlx", platform: process.platform, arch: process.arch },
        "[MLX] Plugin loaded on a non-darwin-arm64 host. mlx_lm.server only runs on Apple Silicon; expect connection failures unless MLX_BASE_URL points at a remote Apple Silicon host."
      );
    }

    const baseURL = getBaseURL(runtime);
    if (!shouldAutoDetect(runtime)) {
      logger.debug("[MLX] MLX_AUTO_DETECT disabled — skipping init probe.");
      return;
    }

    const result = await detectMlx({
      baseURL,
      apiKey: getApiKey(runtime),
      fetcher: runtime.fetch ?? undefined,
      timeoutMs: 2000,
    });

    if (!result.available) {
      logger.warn(
        { src: "plugin:mlx", baseURL, error: result.error },
        "[MLX] /v1/models probe failed — plugin will only succeed once mlx_lm.server is running."
      );
      return;
    }

    const modelCount = result.models?.length ?? 0;
    logger.info(`[MLX] Detected ${modelCount} model${modelCount === 1 ? "" : "s"} at ${baseURL}`);
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
      name: "mlx_plugin_tests",
      tests: [
        {
          name: "mlx_test_models_endpoint",
          fn: async (runtime: IAgentRuntime) => {
            const result = await detectMlx({
              baseURL: getBaseURL(runtime),
              apiKey: getApiKey(runtime),
              fetcher: runtime.fetch ?? undefined,
            });
            if (!result.available) {
              logger.error({ result }, "[MLX] /v1/models probe failed");
              return;
            }
            logger.log({ models: result.models?.length ?? 0 }, "[MLX] /v1/models OK");
          },
        },
      ],
    },
  ],
};
