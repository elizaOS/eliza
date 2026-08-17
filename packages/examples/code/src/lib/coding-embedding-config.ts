import {
  type BatchTextEmbeddingParams,
  type IAgentRuntime,
  ModelType,
  NoModelProviderConfiguredError,
  type Plugin,
  type TextEmbeddingParams,
} from "@elizaos/core";

export const CODING_EMBEDDING_CONTRACT = {
  model: "@cf/baai/bge-small-en-v1.5",
  dimensions: "384",
  pooling: "cls",
} as const;

type CodingEmbeddingContractSetting =
  | "EMBEDDING_MODEL"
  | "EMBEDDING_DIMENSIONS"
  | "EMBEDDING_POOLING";

export type CodingEmbeddingConfiguration =
  | { enabled: true }
  | {
      enabled: false;
      reason:
        | "missing_endpoint_and_credential"
        | "missing_endpoint"
        | "missing_credential"
        | "fallback_not_allowed";
    }
  | {
      enabled: false;
      reason: "incompatible_contract";
      setting: CodingEmbeddingContractSetting;
    };

function configured(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Opt Eliza Code into one stable semantic vector space.
 *
 * A chat-provider credential is deliberately not reused: the embedding plugin
 * is loaded only when its own endpoint and already-authorized credential are
 * both present. Incomplete or incompatible configuration leaves the coding
 * agent usable with semantic recall explicitly degraded.
 */
export function configureCodingEmbeddingEnv(
  env: Record<string, string | undefined> = process.env,
): CodingEmbeddingConfiguration {
  const hasEndpoint = configured(env.EMBEDDING_BASE_URL);
  const hasCredential = configured(env.EMBEDDING_API_KEY);

  if (!hasEndpoint && !hasCredential) {
    return { enabled: false, reason: "missing_endpoint_and_credential" };
  }
  if (!hasEndpoint) {
    return { enabled: false, reason: "missing_endpoint" };
  }
  if (!hasCredential) {
    return { enabled: false, reason: "missing_credential" };
  }

  // A fallback may have the same width while using a different model or
  // pooling space. The coding agent therefore fails closed instead of mixing
  // fallback vectors into its canonical BGE/CLS store.
  if (configured(env.EMBEDDING_FALLBACK_BASE_URL)) {
    return { enabled: false, reason: "fallback_not_allowed" };
  }

  const configuredContract: Array<{
    key: CodingEmbeddingContractSetting;
    expected: string;
    normalize: (value: string) => string;
  }> = [
    {
      key: "EMBEDDING_MODEL",
      expected: CODING_EMBEDDING_CONTRACT.model,
      normalize: (value) => value.trim(),
    },
    {
      key: "EMBEDDING_DIMENSIONS",
      expected: CODING_EMBEDDING_CONTRACT.dimensions,
      normalize: (value) => value.trim(),
    },
    {
      key: "EMBEDDING_POOLING",
      expected: CODING_EMBEDDING_CONTRACT.pooling,
      normalize: (value) => value.trim().toLowerCase(),
    },
  ];

  for (const { key, expected, normalize } of configuredContract) {
    const value = env[key];
    if (configured(value) && normalize(value) !== expected) {
      return { enabled: false, reason: "incompatible_contract", setting: key };
    }
  }

  env.EMBEDDING_BASE_URL = env.EMBEDDING_BASE_URL?.trim();
  env.EMBEDDING_API_KEY = env.EMBEDDING_API_KEY?.trim();
  env.EMBEDDING_MODEL = CODING_EMBEDDING_CONTRACT.model;
  env.EMBEDDING_DIMENSIONS = CODING_EMBEDDING_CONTRACT.dimensions;
  env.EMBEDDING_POOLING = CODING_EMBEDDING_CONTRACT.pooling;
  return { enabled: true };
}

/** Remove embedding ownership (including metadata) from a chat provider copy. */
export function withoutEmbeddingModels(plugin: Plugin): Plugin {
  const models = { ...(plugin.models ?? {}) };
  delete models[ModelType.TEXT_EMBEDDING];
  delete models[ModelType.TEXT_EMBEDDING_BATCH];

  const modelMetadata = plugin.modelMetadata
    ? { ...plugin.modelMetadata }
    : undefined;
  if (modelMetadata) {
    delete modelMetadata[ModelType.TEXT_EMBEDDING];
    delete modelMetadata[ModelType.TEXT_EMBEDDING_BATCH];
  }

  return {
    ...plugin,
    models,
    ...(modelMetadata ? { modelMetadata } : {}),
  };
}

const unavailableMessage =
  "Eliza Code semantic embeddings are disabled. Configure both " +
  "EMBEDDING_BASE_URL and EMBEDDING_API_KEY for the canonical " +
  "@cf/baai/bge-small-en-v1.5 384-dimension CLS embedding space.";

/**
 * Keeps the runtime bootable without ever fabricating a vector. Core treats
 * this typed probe failure as an explicit provider-unavailable degradation.
 */
export const codingEmbeddingUnavailablePlugin = {
  name: "eliza-code-embedding-unavailable",
  description:
    "Explicit unavailable embedding provider used when Eliza Code has no safe dedicated embedding configuration",
  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      _runtime: IAgentRuntime,
      _params: TextEmbeddingParams | string | null,
    ): Promise<number[]> => {
      throw new NoModelProviderConfiguredError(unavailableMessage);
    },
    [ModelType.TEXT_EMBEDDING_BATCH]: async (
      _runtime: IAgentRuntime,
      _params: BatchTextEmbeddingParams,
    ): Promise<number[][]> => {
      throw new NoModelProviderConfiguredError(unavailableMessage);
    },
  },
} satisfies Plugin;
