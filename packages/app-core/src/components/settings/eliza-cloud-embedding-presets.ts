/** Curated models for Eliza Cloud TEXT_EMBEDDING (gateway must support the id). */
export const ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL = "text-embedding-3-small";

export type ElizaCloudEmbeddingPreset = {
  id: string;
  /** String for `ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS` (must be in core VECTOR_DIMS). */
  dimensions: string;
  labelKey: string;
};

export const ELIZA_CLOUD_EMBEDDING_PRESETS: readonly ElizaCloudEmbeddingPreset[] =
  [
    {
      id: "text-embedding-3-small",
      dimensions: "1536",
      labelKey: "embeddingGeneration.elizaCloudEmbeddingPresetSmall",
    },
    {
      id: "text-embedding-3-large",
      dimensions: "3072",
      labelKey: "embeddingGeneration.elizaCloudEmbeddingPresetLarge",
    },
    {
      id: "text-embedding-ada-002",
      dimensions: "1536",
      labelKey: "embeddingGeneration.elizaCloudEmbeddingPresetAda",
    },
  ] as const;

export function presetForElizaCloudEmbeddingModel(
  modelId: string,
): ElizaCloudEmbeddingPreset | undefined {
  const t = modelId.trim();
  return ELIZA_CLOUD_EMBEDDING_PRESETS.find((p) => p.id === t);
}

/**
 * Best-effort vector size for common embedding model ids (OpenAI slug,
 * OpenRouter, Eliza Cloud). User can still adjust via the dimensions control
 * when the gateway returns a different size.
 */
export function guessDimensionsForEmbeddingModelId(modelId: string): string {
  const preset = presetForElizaCloudEmbeddingModel(modelId);
  if (preset) return preset.dimensions;
  const id = modelId.toLowerCase();
  if (id.includes("text-embedding-3-large")) return "3072";
  if (id.includes("embedding-3-large")) return "3072";
  if (id.includes("3072")) return "3072";
  if (id.includes("text-embedding-3-small")) return "1536";
  if (id.includes("text-embedding-ada")) return "1536";
  if (id.includes("gemini") && id.includes("embed")) return "768";
  if (id.includes("nomic-embed")) return "768";
  if (id.includes("mistral-embed")) return "1024";
  if (id.includes("multilingual-e5") || id.includes("/e5-")) return "1024";
  return "1536";
}

export function readElizaCloudEmbeddingFromConfig(
  cfg: Record<string, unknown>,
): { model: string; dimensions: string } {
  const vars =
    ((cfg.env as Record<string, unknown> | undefined)?.vars as
      | Record<string, unknown>
      | undefined) ?? {};

  const fromEnv = (key: string): string =>
    typeof vars[key] === "string" ? (vars[key] as string).trim() : "";

  const plugins = cfg.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as
    | Record<string, { config?: Record<string, unknown> }>
    | undefined;
  const plug = entries?.elizacloud?.config;

  const fromPlugin = (key: string): string =>
    plug && typeof plug[key] === "string" ? (plug[key] as string).trim() : "";

  const modelRaw =
    fromEnv("ELIZAOS_CLOUD_EMBEDDING_MODEL") ||
    fromPlugin("ELIZAOS_CLOUD_EMBEDDING_MODEL");
  const model = modelRaw || ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL;

  const dimsRaw =
    fromEnv("ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS") ||
    fromPlugin("ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS");
  const preset = presetForElizaCloudEmbeddingModel(model);
  const dimensions = dimsRaw || preset?.dimensions || ("1536" as const);

  return { model, dimensions };
}
