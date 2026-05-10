// Public entry point for the Eliza-1 manifest module.
// Catalogs / downloader / recommendation should import from here, not
// from the schema/types/validator files individually.

export {
  ELIZA_1_BACKENDS,
  ELIZA_1_KERNELS,
  ELIZA_1_MANIFEST_SCHEMA_URL,
  ELIZA_1_MANIFEST_SCHEMA_VERSION,
  ELIZA_1_TIERS,
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
  REQUIRED_KERNELS_BY_TIER,
  SUPPORTED_BACKENDS_BY_TIER,
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
} from "./types";

export {
  canSetAsDefault,
  missingRequiredKernels,
  parseManifestOrThrow,
  validateManifest,
  type ValidationErr,
  type ValidationOk,
  type ValidationResult,
} from "./validator";
