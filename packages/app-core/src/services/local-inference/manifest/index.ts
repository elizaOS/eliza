// Public entry point for the Eliza-1 manifest module.
// Catalogs / downloader / recommendation should import from here, not
// from the schema/types/validator files individually.

export {
  ELIZA_1_BACKENDS,
  ELIZA_1_KERNELS,
  ELIZA_1_MANIFEST_SCHEMA_URL,
  ELIZA_1_MANIFEST_SCHEMA_VERSION,
  ELIZA_1_TIERS,
  ELIZA_1_VOICE_CAPABILITIES,
  ELIZA_1_VOICE_MANIFEST_VERSION,
  Eliza1BackendEnumSchema,
  Eliza1EvalsSchema,
  Eliza1FileEntrySchema,
  Eliza1FilesSchema,
  Eliza1KernelEnumSchema,
  Eliza1KernelsSchema,
  Eliza1LineageSchema,
  Eliza1ManifestSchema,
  Eliza1RamBudgetSchema,
  Eliza1TierEnumSchema,
  Eliza1VerifiedBackendStatusSchema,
  Eliza1VoiceSchema,
  REQUIRED_KERNELS_BY_TIER,
  SUPPORTED_BACKENDS_BY_TIER,
  VOICE_PRESET_CACHE_PATH,
} from "./schema";

export type {
  Eliza1Backend,
  Eliza1DeviceCaps,
  Eliza1Evals,
  Eliza1FileEntry,
  Eliza1Files,
  Eliza1Kernel,
  Eliza1Kernels,
  Eliza1Lineage,
  Eliza1Manifest,
  Eliza1RamBudget,
  Eliza1Tier,
  Eliza1VerifiedBackendStatus,
  Eliza1Voice,
} from "./types";

export {
  canSetAsDefault,
  missingRequiredKernels,
  parseManifestOrThrow,
  type ValidationErr,
  type ValidationOk,
  type ValidationResult,
  validateManifest,
} from "./validator";
