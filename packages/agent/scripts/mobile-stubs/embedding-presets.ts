// Compact embedding preset table for mobile agent bundles, pinned to the small
// CPU-safe local embedding model.
"use strict";

const COMPACT_ELIZA_1_EMBEDDING = {
  model: "gte-small_fp16.gguf",
  modelRepo: "ChristianAzinn/gte-small-gguf",
  dimensions: 384,
  gpuLayers: 0,
  contextSize: 512,
  downloadSizeMB: 64,
};

const EMBEDDING_PRESETS = {
  fallback: {
    tier: "fallback",
    label: "Efficient (mobile CPU)",
    description: "gte-small local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  standard: {
    tier: "standard",
    label: "Efficient (mobile)",
    description: "gte-small local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  performance: {
    tier: "performance",
    label: "Efficient (mobile)",
    description: "gte-small local embeddings for the mobile agent bundle",
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
