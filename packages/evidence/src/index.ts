/** Public surface of @elizaos/evidence: schema, bundle builder, provenance, ingestors. */

export {
  type AddArtifactOptions,
  type BundleProvenance,
  type CreateBundleOptions,
  createBundle,
  EvidenceBundle,
  type FinalizeResult,
  formatRunId,
  type VerifyIssue,
  type VerifyReport,
  verifyBundle,
} from "./bundle.ts";
export { canonicalJson, canonicalJsonBytes } from "./canonical.ts";
export {
  EvidenceError,
  type EvidenceErrorOptions,
  EvidenceValidationError,
  type ValidationIssue,
} from "./errors.ts";
export {
  type IngestResult,
  ingestAllSilos,
  ingestNamedSilo,
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
  TIERS,
  type Tier,
} from "./schema.ts";
export {
  fingerprintPublicKey,
  generateCertificationKeypair,
  type GeneratedKeypair,
  type ResolveSigningKeyOptions,
  resolveSigningKey,
  SIGNING_KEY_ENV_VAR,
} from "./certify/keys.ts";
export {
  type AnalysisFinding,
  type ArtifactRequirement,
  type CertificationRequirements,
  type LaneRequirement,
  type LaneRollup,
  parseRequirements,
  parseVerdictsDocument,
  type RollupResult,
  type RollupSummary,
  rollupBundle,
} from "./certify/rollup.ts";
export {
  type Certification,
  type CertificationPayload,
  type CertificationReviewer,
  type CertificationSignature,
  type CertificationVerdict,
  parseCertification,
  parseCertificationPayload,
  REVIEWER_KINDS,
  type ReviewerKind,
  tierSatisfies,
  VERDICT_VALUES,
  type VerdictValue,
} from "./certify/schema.ts";
export {
  CERTIFICATION_FAILURE_CODES,
  type CertificationFailure,
  type CertificationFailureCode,
  type CertificationVerifyOptions,
  type CertificationVerifyReport,
  signCertification,
  verifyCertification,
} from "./certify/sign.ts";
