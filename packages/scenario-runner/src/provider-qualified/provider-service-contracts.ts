/**
 * Defines the data-only correlation and cleanup contracts shared by deployed
 * provider-service roles. Keeping these declarations free of runtime imports
 * lets reviewed deployment bundles avoid pulling in controller orchestration.
 */

import type { ProviderCanaryScenarioId } from "./canary-catalog.ts";
import type { ProviderControllerFamily } from "./controller-registry.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";

export const PROVIDER_CLEANUP_PROOF_SCHEMA =
  "eliza.provider-canary-cleanup-proof.v1" as const;
export const DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA =
  "eliza.provider-canary-deployed-composite-raw-material.v1" as const;

export interface ProviderBridgeCorrelation {
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  controllerFamily: ProviderControllerFamily;
  runId: string;
  runNonce: string;
  manifestSha256: string;
  repositorySha: string;
  deploymentSha: string;
  targetOperationSha256: string;
  failureProbesSha256: string;
}

export interface ProviderCleanupProofPayload {
  schema: typeof PROVIDER_CLEANUP_PROOF_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  runId: string;
  runNonce: string;
  manifestSha256: string;
  cleanupScopeSha256: string;
  rawControllerMaterialSha256: string;
  qualificationArtifactSha256?: string;
  disposition: "cleaned" | "no-resources-created";
  completedAtIso: string;
}

export interface SignedProviderCleanupProof {
  keyId: string;
  payload: ProviderCleanupProofPayload;
  signature: string;
}
