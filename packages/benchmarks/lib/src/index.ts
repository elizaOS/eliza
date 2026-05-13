/**
 * Public entry for `@elizaos-benchmarks/lib`.
 *
 * Re-exports the canonical metrics schema plus the MODEL_TIER registry and
 * dflash local-llama-cpp adapter. Future shared helpers (delta
 * computation, aggregator utilities, etc.) land here in later waves.
 */

export {
  bundleIsPreRelease,
  ELIZA_ONE_MODEL_SIZES,
  ELIZA_ONE_RELEASE_STATES,
  type ElizaOneBundleManifest,
  type ElizaOneModelSize,
  type ElizaOneReleaseState,
  readElizaOneBundle,
} from "./eliza-1-bundle.ts";
export * from "./local-llama-cpp.ts";
// `ModelTier` is declared in both metrics-schema.ts (Zod-inferred from
// `MODEL_TIERS`) and model-tiers.ts (free-standing union). The two
// definitions resolve to the same string-literal set; we re-export
// metrics-schema's version and omit it from the model-tiers wildcard
// so the public surface stays unambiguous.
export * from "./metrics-schema.ts";
export {
  DEFAULT_TIERS,
  isModelTier,
  type ModelTierProvider,
  resolveTier,
  type TierSpec,
} from "./model-tiers.ts";
export {
  RETRIEVAL_DEFAULTS_BY_TIER,
  type RetrievalStageName,
  type RetrievalTierDefaults,
  resolveRetrievalDefaults,
} from "./retrieval-defaults.ts";
