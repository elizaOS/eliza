import type {
  ElizaConfig,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "./types.ts";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_TOKENS = 8_192;

const DEFAULT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text"];
const DEFAULT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type ModelTokenMetadataSource =
  | "model-config"
  | "agent-defaults"
  | "runtime-default";

export interface ModelTokenMetadata {
  modelId: string;
  providerId?: string;
  contextWindow: number;
  maxTokens: number;
  source: ModelTokenMetadataSource;
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toFiniteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeCost(value: unknown): ModelDefinitionConfig["cost"] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    input: toFiniteNonNegativeNumber(record.input) ?? 0,
    output: toFiniteNonNegativeNumber(record.output) ?? 0,
    cacheRead: toFiniteNonNegativeNumber(record.cacheRead) ?? 0,
    cacheWrite: toFiniteNonNegativeNumber(record.cacheWrite) ?? 0,
  };
}

function normalizeInput(value: unknown): ModelDefinitionConfig["input"] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_MODEL_INPUT];
  }

  const normalized = value.filter(
    (entry): entry is "text" | "image" => entry === "text" || entry === "image",
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_MODEL_INPUT];
}

export function normalizeModelDefinitionConfig(
  model: Partial<ModelDefinitionConfig> & { id: string },
  defaults?: {
    contextWindow?: number;
    maxTokens?: number;
  },
): ModelDefinitionConfig {
  const contextWindow =
    toPositiveInt(model.contextWindow) ??
    toPositiveInt(defaults?.contextWindow) ??
    DEFAULT_MODEL_CONTEXT_WINDOW;
  const maxTokens =
    toPositiveInt(model.maxTokens) ??
    toPositiveInt(defaults?.maxTokens) ??
    DEFAULT_MODEL_MAX_TOKENS;

  return {
    ...model,
    id: model.id,
    name:
      typeof model.name === "string" && model.name.trim().length > 0
        ? model.name
        : model.id,
    reasoning: Boolean(model.reasoning),
    input: normalizeInput(model.input),
    cost: normalizeCost(model.cost ?? DEFAULT_MODEL_COST),
    contextWindow,
    maxTokens,
  };
}

export function normalizeModelMetadataInConfig(config: ElizaConfig): void {
  const providers = config.models?.providers;
  if (!providers) return;

  const discoveryDefaults = config.models?.bedrockDiscovery;
  const defaults = {
    contextWindow: discoveryDefaults?.defaultContextWindow,
    maxTokens: discoveryDefaults?.defaultMaxTokens,
  };

  for (const [providerId, provider] of Object.entries(providers)) {
    const providerRecord = provider as ModelProviderConfig;
    providerRecord.models = (providerRecord.models ?? []).map((model) =>
      normalizeModelDefinitionConfig(
        { ...model, id: model.id },
        providerId === "bedrock" ? defaults : undefined,
      ),
    );
  }
}

function normalizeModelLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function configuredModelKeys(providerId: string, modelId: string): string[] {
  const normalizedProvider = normalizeModelLookupKey(providerId);
  const normalizedModel = normalizeModelLookupKey(modelId);
  const slashSuffix = normalizedModel.split("/").at(-1) ?? normalizedModel;
  return [
    normalizedModel,
    `${normalizedProvider}/${normalizedModel}`,
    `${normalizedProvider}/${slashSuffix}`,
    slashSuffix,
  ];
}

function readAgentDefaultContextTokens(
  config?: ElizaConfig,
): number | undefined {
  return toPositiveInt(config?.agents?.defaults?.contextTokens);
}

function findConfiguredModel(
  config: ElizaConfig | undefined,
  modelId: string | undefined,
):
  | {
      providerId: string;
      model: ModelDefinitionConfig;
    }
  | undefined {
  if (!config?.models?.providers || !modelId) return undefined;
  const lookupKey = normalizeModelLookupKey(modelId);
  if (!lookupKey) return undefined;

  for (const [providerId, provider] of Object.entries(
    config.models.providers,
  )) {
    for (const model of provider.models ?? []) {
      if (configuredModelKeys(providerId, model.id).includes(lookupKey)) {
        return { providerId, model };
      }
    }
  }

  return undefined;
}

export function resolveModelTokenMetadata(
  config?: ElizaConfig,
  modelId?: string,
): ModelTokenMetadata {
  const configured = findConfiguredModel(config, modelId);
  if (configured) {
    return {
      modelId: configured.model.id,
      providerId: configured.providerId,
      contextWindow:
        toPositiveInt(configured.model.contextWindow) ??
        DEFAULT_MODEL_CONTEXT_WINDOW,
      maxTokens:
        toPositiveInt(configured.model.maxTokens) ?? DEFAULT_MODEL_MAX_TOKENS,
      source: "model-config",
    };
  }

  const defaultContextWindow = readAgentDefaultContextTokens(config);
  if (defaultContextWindow !== undefined) {
    return {
      modelId: modelId?.trim() || "runtime-default",
      contextWindow: defaultContextWindow,
      maxTokens: DEFAULT_MODEL_MAX_TOKENS,
      source: "agent-defaults",
    };
  }

  return {
    modelId: modelId?.trim() || "runtime-default",
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MODEL_MAX_TOKENS,
    source: "runtime-default",
  };
}
