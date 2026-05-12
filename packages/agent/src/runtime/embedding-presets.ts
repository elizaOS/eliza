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

const COMPACT_ELIZA_1_EMBEDDING = {
  model: "text/eliza-1-lite-0_6b-32k.gguf",
  modelRepo: "elizaos/eliza-1-lite-0_6b",
  dimensions: 1024,
  contextSize: 32768,
  downloadSizeMB: 512,
} as const;

/** All available presets, indexed by tier. */
export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
  fallback: {
    tier: "fallback",
    label: "Efficient (CPU)",
    description:
      "Eliza-1 lite local embeddings for Intel Macs and low-RAM machines",
    model: COMPACT_ELIZA_1_EMBEDDING.model,
    modelRepo: COMPACT_ELIZA_1_EMBEDDING.modelRepo,
    dimensions: COMPACT_ELIZA_1_EMBEDDING.dimensions,
    gpuLayers: 0,
    contextSize: COMPACT_ELIZA_1_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_ELIZA_1_EMBEDDING.downloadSizeMB,
  },
  standard: {
    tier: "standard",
    label: "Efficient (Metal GPU)",
    description: "Eliza-1 lite local embeddings with Metal acceleration",
    model: COMPACT_ELIZA_1_EMBEDDING.model,
    modelRepo: COMPACT_ELIZA_1_EMBEDDING.modelRepo,
    dimensions: COMPACT_ELIZA_1_EMBEDDING.dimensions,
    gpuLayers: "auto",
    contextSize: COMPACT_ELIZA_1_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_ELIZA_1_EMBEDDING.downloadSizeMB,
  },
  performance: {
    tier: "performance",
    label: "Efficient (High-memory GPU)",
    description: "Eliza-1 lite local embeddings for high-memory Macs",
    model: COMPACT_ELIZA_1_EMBEDDING.model,
    modelRepo: COMPACT_ELIZA_1_EMBEDDING.modelRepo,
    dimensions: COMPACT_ELIZA_1_EMBEDDING.dimensions,
    gpuLayers: "auto",
    contextSize: COMPACT_ELIZA_1_EMBEDDING.contextSize,
    downloadSizeMB: COMPACT_ELIZA_1_EMBEDDING.downloadSizeMB,
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
