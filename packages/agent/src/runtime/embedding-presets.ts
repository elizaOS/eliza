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

/** All available presets, indexed by tier. */
export const EMBEDDING_PRESETS: Record<EmbeddingTier, EmbeddingPreset> = {
  fallback: {
    tier: "fallback",
    label: "Efficient (CPU)",
    description:
      "768-dim, 74MB download — best for Intel Macs and low-RAM machines",
    model: "nomic-embed-text-v1.5.Q4_K_S.gguf",
    modelRepo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    dimensions: 768,
    gpuLayers: 0,
    contextSize: 8192,
    downloadSizeMB: 74,
  },
  standard: {
    tier: "standard",
    label: "Balanced (Metal GPU)",
    description:
      "768-dim, 95MB download — great quality with Metal acceleration",
    model: "nomic-embed-text-v1.5.Q5_K_M.gguf",
    modelRepo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    dimensions: 768,
    gpuLayers: "auto",
    contextSize: 8192,
    downloadSizeMB: 95,
  },
  performance: {
    tier: "performance",
    label: "Maximum (7B model)",
    description:
      "4096-dim, 4.2GB download — SOTA retrieval quality, 32K context",
    model: "ggml-e5-mistral-7b-instruct-q4_k_m.gguf",
    modelRepo: "dranger003/e5-mistral-7b-instruct-GGUF",
    dimensions: 4096,
    gpuLayers: "auto",
    contextSize: 32768,
    downloadSizeMB: 4200,
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
