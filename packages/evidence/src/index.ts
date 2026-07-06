/** Public surface of @elizaos/evidence: schema, bundle builder, provenance, ingestors. */

export {
  type AddArtifactOptions,
  type BundleProvenance,
  createBundle,
  type CreateBundleOptions,
  EvidenceBundle,
  type FinalizeResult,
  formatRunId,
  verifyBundle,
  type VerifyIssue,
  type VerifyReport,
} from "./bundle.ts";
export { canonicalJson, canonicalJsonBytes } from "./canonical.ts";
export {
  EvidenceError,
  type EvidenceErrorOptions,
  EvidenceValidationError,
  type ValidationIssue,
} from "./errors.ts";
export {
  ingestAllSilos,
  ingestNamedSilo,
  type IngestResult,
  SILO_NAMES,
} from "./ingest.ts";
export {
  buildEnvFingerprint,
  collectGitProvenance,
  type GitProvenance,
  type ProcessFacts,
  resolveRunnerKind,
} from "./provenance.ts";
export {
  ARTIFACT_KINDS,
  type ArtifactEntry,
  type ArtifactKind,
  type BundleManifest,
  type BundleMeta,
  isBundleRelativePath,
  parseManifest,
  parseMeta,
  RUNNER_KINDS,
  type RunnerKind,
  type Tier,
  TIERS,
} from "./schema.ts";
