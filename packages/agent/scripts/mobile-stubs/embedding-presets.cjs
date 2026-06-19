"use strict";

const COMPACT_ELIZA_1_EMBEDDING = {
  model: "bundles/0_8b/text/eliza-1-0_8b-128k.gguf",
  modelRepo: "elizaos/eliza-1",
  dimensions: 1024,
  gpuLayers: 0,
  contextSize: 131072,
  downloadSizeMB: 512,
};

const EMBEDDING_PRESETS = {
  fallback: {
    tier: "fallback",
    label: "Efficient (mobile)",
    description: "Eliza-1 lite local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  standard: {
    tier: "standard",
    label: "Efficient (mobile)",
    description: "Eliza-1 lite local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
  performance: {
    tier: "performance",
    label: "Efficient (mobile)",
    description: "Eliza-1 lite local embeddings for the mobile agent bundle",
    ...COMPACT_ELIZA_1_EMBEDDING,
  },
};

function detectEmbeddingTier() {
  return "fallback";
}

function detectEmbeddingPreset() {
  return EMBEDDING_PRESETS.fallback;
}

module.exports = {
  COMPACT_ELIZA_1_EMBEDDING,
  EMBEDDING_PRESETS,
  detectEmbeddingPreset,
  detectEmbeddingTier,
};
