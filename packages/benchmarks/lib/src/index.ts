/**
 * Public entry for `@elizaos-benchmarks/lib`.
 *
 * Re-exports the canonical metrics schema plus the MODEL_TIER registry and
 * dflash local-llama-cpp adapter. Future shared helpers (delta
 * computation, aggregator utilities, etc.) land here in later waves.
 */

// `ModelTier` is declared in both metrics-schema.ts (Zod-inferred from
// `MODEL_TIERS`) and model-tiers.ts (free-standing union). The two
// definitions resolve to the same string-literal set; we re-export
// metrics-schema's version and omit it from the model-tiers wildcard
// so the public surface stays unambiguous.
export * from "./metrics-schema.ts";
export {
  type ModelTierProvider,
  type TierSpec,
  DEFAULT_TIERS,
  isModelTier,
  resolveTier,
} from "./model-tiers.ts";
export * from "./local-llama-cpp.ts";
export {
  type RetrievalStageName,
  type RetrievalTierDefaults,
  RETRIEVAL_DEFAULTS_BY_TIER,
  resolveRetrievalDefaults,
} from "./retrieval-defaults.ts";
