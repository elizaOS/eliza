// Compact embedding preset table for mobile agent bundles, pinned to the small
// CPU-safe local embedding model.
"use strict";

const COMPACT_ELIZA_1_EMBEDDING = {
  model: "bge-small-en-v1.5-q4_k_m.gguf",
  modelRepo: "CompendiumLabs/bge-small-en-v1.5-gguf",
  dimensions: 384,
  gpuLayers: 0,
  contextSize: 512,
  downloadSizeMB: 24,
};

const EMBEDDING_PRESETS = {
  fallback: {
    tier: "fallback",
    label: "Efficient (mobile CPU)",
    description:
      "BGE-small-en-v1.5 local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  standard: {
    tier: "standard",
    label: "Efficient (mobile)",
    description:
      "BGE-small-en-v1.5 local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  performance: {
    tier: "performance",
    label: "Efficient (mobile)",
    description:
      "BGE-small-en-v1.5 local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
};

function detectEmbeddingTier() {
  return "fallback";
}

function detectEmbeddingPreset() {
  return EMBEDDING_PRESETS.fallback;
}

function selectEmbeddingTierFromHardware() {
  return "fallback";
}

function selectEmbeddingPresetFromHardware() {
  return EMBEDDING_PRESETS.fallback;
}

module.exports = {
  COMPACT_ELIZA_1_EMBEDDING,
  EMBEDDING_PRESETS,
  detectEmbeddingPreset,
  detectEmbeddingTier,
  selectEmbeddingPresetFromHardware,
  selectEmbeddingTierFromHardware,
};
