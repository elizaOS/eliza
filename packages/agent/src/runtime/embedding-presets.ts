import os from "node:os";

export type EmbeddingTier = "fallback" | "standard" | "performance";

export interface EmbeddingPreset {
  tier: EmbeddingTier;
  label: string;
  description: string;
  model: string;
  modelRepo: string;
  dimensions: number;
  gpuLayers: "auto" | 0;
  contextSize: number;
  downloadSizeMB: number;
}

const COMPACT_BGE_EMBEDDING = {
  model: "bge-small-en-v1.5.Q4_K_M.gguf",
  modelRepo: "ChristianAzinn/bge-small-en-v1.5-gguf",
  dimensions: 384,
  contextSize: 512,
  downloadSizeMB: 133,
} as const;

/** All available presets, indexed by tier. */
export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
  fallback: {
    tier: "fallback",
    label: "Efficient (CPU)",
    description:
      "384-dim, 133MB download — compact BGE default for Intel Macs and low-RAM machines",
    model: COMPACT_BGE_EMBEDDING.model,
    modelRepo: COMPACT_BGE_EMBEDDING.modelRepo,
    dimensions: COMPACT_BGE_EMBEDDING.dimensions,
    gpuLayers: 0,
    contextSize: COMPACT_BGE_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_BGE_EMBEDDING.downloadSizeMB,
  },
  standard: {
    tier: "standard",
    label: "Efficient (Metal GPU)",
    description:
      "384-dim, 133MB download — compact BGE default with Metal acceleration",
    model: COMPACT_BGE_EMBEDDING.model,
    modelRepo: COMPACT_BGE_EMBEDDING.modelRepo,
    dimensions: COMPACT_BGE_EMBEDDING.dimensions,
    gpuLayers: "auto",
    contextSize: COMPACT_BGE_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_BGE_EMBEDDING.downloadSizeMB,
  },
  performance: {
    tier: "performance",
    label: "Efficient (High-memory GPU)",
    description:
      "384-dim, 133MB download — keep local embeddings compact, SQL-safe, and fast even on high-memory Macs",
    model: COMPACT_BGE_EMBEDDING.model,
    modelRepo: COMPACT_BGE_EMBEDDING.modelRepo,
    dimensions: COMPACT_BGE_EMBEDDING.dimensions,
    gpuLayers: "auto",
    contextSize: COMPACT_BGE_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_BGE_EMBEDDING.downloadSizeMB,
  },
};

const BYTES_PER_GB = 1024 ** 3;

/** Detect the best embedding tier for the current hardware. */
export function detectEmbeddingTier(): EmbeddingTier {
  const totalRamGB = Math.round(os.totalmem() / BYTES_PER_GB);
  const isMac = process.platform === "darwin";
  const isAppleSilicon = isMac && process.arch === "arm64";

  if (!isAppleSilicon || totalRamGB <= 8) return "fallback";
  if (totalRamGB >= 128) return "performance";
  return "standard";
}

/** Get the preset for the current hardware. */
export function detectEmbeddingPreset(): EmbeddingPreset {
  return EMBEDDING_PRESETS[detectEmbeddingTier()];
}
