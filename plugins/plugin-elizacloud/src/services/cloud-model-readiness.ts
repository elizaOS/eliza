/**
 * Cloud text-model readiness: whether the effective TEXT_SMALL / TEXT_LARGE
 * model ids this agent will send to Eliza Cloud are listed in the Cloud model
 * catalog. Pure evaluation over a cached catalog snapshot — no inference, no
 * network — so status and health routes can read it on every poll.
 *
 * A stale override (for example a saved `ELIZAOS_CLOUD_LARGE_MODEL` that Cloud
 * has since retired) is reported as `model_not_available` naming the config key
 * and model id. A missing, empty, or unreachable catalog is `unknown`, which
 * callers must treat as retryable rather than as a permanent model removal.
 */
import { DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL, DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/host/protocol";

export const CLOUD_MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE" as const;

export type CloudTextModelType = "TEXT_SMALL" | "TEXT_LARGE";

export interface CloudMissingTextModel {
  modelType: CloudTextModelType;
  /** Setting that supplied the id, or `null` when the Cloud default is in use. */
  configKey: string | null;
  modelId: string;
}

export type CloudTextModelReadiness =
  | { status: "available"; checkedAt: number }
  | {
      status: "unknown";
      reason: "catalog_not_loaded" | "catalog_unavailable" | "catalog_empty";
      checkedAt: number | null;
    }
  | {
      status: "model_not_available";
      code: typeof CLOUD_MODEL_NOT_AVAILABLE;
      missing: CloudMissingTextModel[];
      message: string;
      checkedAt: number;
    };

interface CatalogModel {
  id: string;
  name: string;
}

interface EffectiveModel {
  modelType: CloudTextModelType;
  configKey: string | null;
  modelId: string;
}

const TEXT_MODEL_SOURCES: ReadonlyArray<{
  modelType: CloudTextModelType;
  keys: readonly string[];
  fallback: string;
}> = [
  {
    modelType: "TEXT_SMALL",
    keys: ["ELIZAOS_CLOUD_SMALL_MODEL", "SMALL_MODEL"],
    fallback: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  },
  {
    modelType: "TEXT_LARGE",
    keys: ["ELIZAOS_CLOUD_LARGE_MODEL", "LARGE_MODEL"],
    fallback: DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  },
];

/**
 * Resolve the ids the Cloud text handlers will actually request, in the same
 * precedence as `getSmallModel` / `getLargeModel`, keeping the source key.
 */
export function resolveEffectiveCloudTextModels(
  readSetting: (key: string) => string | undefined
): EffectiveModel[] {
  return TEXT_MODEL_SOURCES.map(({ modelType, keys, fallback }) => {
    for (const key of keys) {
      const value = readSetting(key)?.trim();
      if (value) return { modelType, configKey: key, modelId: value };
    }
    return { modelType, configKey: null, modelId: fallback };
  });
}

export function evaluateCloudTextModelReadiness(input: {
  catalogLoaded: boolean;
  checkedAt: number;
  catalogFailedAt: number;
  models: readonly CatalogModel[];
  readSetting: (key: string) => string | undefined;
}): CloudTextModelReadiness {
  if (!input.catalogLoaded) {
    return {
      status: "unknown",
      reason: input.catalogFailedAt > 0 ? "catalog_unavailable" : "catalog_not_loaded",
      checkedAt: null,
    };
  }
  if (input.models.length === 0) {
    return { status: "unknown", reason: "catalog_empty", checkedAt: input.checkedAt };
  }
  const listed = new Set<string>();
  for (const model of input.models) {
    listed.add(model.id);
    listed.add(model.name);
  }
  const missing = resolveEffectiveCloudTextModels(input.readSetting).filter(
    (model) => !listed.has(model.modelId)
  );
  if (missing.length === 0) {
    return { status: "available", checkedAt: input.checkedAt };
  }
  const detail = missing
    .map((model) =>
      model.configKey
        ? `${model.configKey}="${model.modelId}"`
        : `default ${model.modelType} model "${model.modelId}"`
    )
    .join(", ");
  return {
    status: "model_not_available",
    code: CLOUD_MODEL_NOT_AVAILABLE,
    missing,
    message: `Configured Eliza Cloud model is not available: ${detail}. Update or clear the setting to use a listed model.`,
    checkedAt: input.checkedAt,
  };
}
