/**
 * `@elizaos/plugin-embeddings` — provider-agnostic ("bring your own")
 * `TEXT_EMBEDDING` provider.
 *
 * Decouples embeddings from the chat brain. A self-hosted bot running on a
 * provider that serves no good embeddings (Claude, Cerebras, …) can point the
 * `EMBEDDING_*` vars at ANY OpenAI-compatible `/embeddings` endpoint (a personal
 * OpenAI key, Eliza Cloud, Voyage, or a local TEI / Infinity / vLLM / LM Studio
 * server) and get embeddings independently of chat.
 *
 * Purely additive: the plugin only loads when `EMBEDDING_BASE_URL` or
 * `EMBEDDING_API_KEY` is set (see auto-enable.ts), so existing deployments are
 * unaffected. It registers ONLY the embedding slots — no text/image/audio
 * handlers, no actions, providers, services, or evaluators.
 */

import type {
  BatchTextEmbeddingParams,
  IAgentRuntime,
  Plugin,
  ProcessEnvLike,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

import { handleBatchTextEmbedding, handleTextEmbedding } from "./models/embedding";
import {
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  hasEmbeddingConfig,
  logResolvedConfig,
} from "./utils/config";

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

export const embeddingsPlugin: Plugin = {
  name: "embeddings",
  description:
    "Provider-agnostic (bring-your-own) TEXT_EMBEDDING provider for any OpenAI-compatible /embeddings endpoint",

  // Manifest-driven auto-enable: see auto-enable.ts. Mirrored here so a runtime
  // that consults the inline `autoEnable.envKeys` (rather than the package
  // manifest) activates the plugin on the same signal.
  autoEnable: {
    envKeys: ["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY"],
  },

  // Registration priority for the embedding slot. The native priority sort is:
  //   local-inference @ 0  <  this @ 1  <  Eliza Cloud @ 50
  // So a bring-your-own endpoint beats a bare local embedder but yields to a
  // paired Eliza Cloud, which is the desired default. Override per-slot via the
  // runtime routing preferences when a different precedence is wanted.
  priority: 1,

  config: {
    EMBEDDING_BASE_URL: env.EMBEDDING_BASE_URL ?? null,
    EMBEDDING_API_KEY: env.EMBEDDING_API_KEY ?? null,
    EMBEDDING_MODEL: env.EMBEDDING_MODEL ?? null,
    EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS ?? null,
    EMBEDDING_BROWSER_URL: env.EMBEDDING_BROWSER_URL ?? null,
  },

  async init(_config, runtime) {
    if (!hasEmbeddingConfig(runtime)) {
      logger.warn(
        "[Embeddings] Neither EMBEDDING_BASE_URL nor EMBEDDING_API_KEY is set — " +
          "embedding calls will throw until one is configured."
      );
      return;
    }
    // Validate the dimension up-front so a misconfiguration surfaces at boot,
    // not on the first embedding call.
    getEmbeddingDimensions(runtime);
    if (!getEmbeddingBaseURL(runtime)) {
      logger.warn(
        "[Embeddings] EMBEDDING_API_KEY is set but EMBEDDING_BASE_URL is not — " +
          "set the endpoint URL for embedding calls to succeed."
      );
    }
    logResolvedConfig(runtime);
  },

  // ONLY the embedding slots are registered — this plugin is embedding-only.
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => handleTextEmbedding(runtime, params),

    [ModelType.TEXT_EMBEDDING_BATCH]: async (
      runtime: IAgentRuntime,
      params: BatchTextEmbeddingParams
    ): Promise<number[][]> => handleBatchTextEmbedding(runtime, params.texts),
  },
};

export { handleBatchTextEmbedding, handleTextEmbedding } from "./models/embedding";
export * from "./types";
export * from "./utils/config";

const defaultEmbeddingsPlugin = embeddingsPlugin;

export default defaultEmbeddingsPlugin;
