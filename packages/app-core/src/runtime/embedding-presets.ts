import {
  detectEmbeddingTier,
  EMBEDDING_PRESETS as upstreamEmbeddingPresets,
} from "@elizaos/agent";

export { detectEmbeddingTier };

/**
 * Upstream presets plus a local override of the `performance` preset so the
 * large E5-Mistral **embedding** GGUF is not mistaken for a chat LLM (the
 * filename contains `instruct` from the E5 family).
 *
 * CYCLE-BREAK NOTE: an `agent ↔ app-core` ESM cycle was crashing the bench
 * server boot with `Cannot access 'upstreamEmbeddingPresets' before
 * initialization` (TDZ at the module-load eager spread). Defer the spread
 * until first read via a lazy-init Proxy. By the time anything READS
 * `EMBEDDING_PRESETS.fallback`, the upstream module has fully initialized,
 * so the spread succeeds.
 */
let _embeddingPresetsCache: typeof upstreamEmbeddingPresets | null = null;
function _computeEmbeddingPresets(): typeof upstreamEmbeddingPresets {
  if (_embeddingPresetsCache) return _embeddingPresetsCache;
  _embeddingPresetsCache = {
    ...upstreamEmbeddingPresets,
    performance: {
      ...upstreamEmbeddingPresets.performance,
      label: "Efficient (compact text embedding)",
      description:
        "384-dim compact text-embedding model (~133MB). Powers memory / knowledge vectors only — not chat. " +
        "The framework keeps the default SQL-safe and fast instead of auto-selecting a multi-GB embedding GGUF.",
    },
  } as typeof upstreamEmbeddingPresets;
  return _embeddingPresetsCache;
}

export const EMBEDDING_PRESETS: typeof upstreamEmbeddingPresets = new Proxy(
  {} as typeof upstreamEmbeddingPresets,
  {
    get(_t, prop) {
      return Reflect.get(_computeEmbeddingPresets(), prop);
    },
    has(_t, prop) {
      return Reflect.has(_computeEmbeddingPresets(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(_computeEmbeddingPresets());
    },
    getOwnPropertyDescriptor(_t, prop) {
      return Reflect.getOwnPropertyDescriptor(_computeEmbeddingPresets(), prop);
    },
  },
);

export function detectEmbeddingPreset() {
  const tier = detectEmbeddingTier();
  return _computeEmbeddingPresets()[tier];
}
