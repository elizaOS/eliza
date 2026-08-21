/** Builds explicit test-only release policies from already-created fixtures. */

import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import type { ProviderQualificationArtifact } from "./qualification-artifact.ts";
import {
  PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA,
  type ProviderQualificationReleaseTrustPolicy,
} from "./release-trust-policy.ts";

/**
 * This intentionally derives trust from a fixture and must never be used by a
 * runtime or release path. Production trust policies are authored externally.
 */
export function createTestReleaseTrustPolicyForArtifact(
  artifact: ProviderQualificationArtifact,
): ProviderQualificationReleaseTrustPolicy {
  const pins = artifact.reverification.publicKeyPins;
  const attestation =
    artifact.reverification.signedObserverEvidence.payload
      .deploymentAttestation;
  const core = {
    schema: PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA,
    releaseId: "test-only-derived-policy",
    repositorySha: artifact.repositorySha,
    deploymentSha: artifact.deploymentSha,
    organizations: {
      manifestAuthority: {
        organizationId: "test-authority.example",
        keys: pins.manifestAuthorities,
      },
      providerObserver: {
        organizationId: "test-observer.example",
        keys: pins.providerObservers,
        allowedWorkloadSha256s: [attestation.statement.workloadSha256],
        allowedStatementSha256s: [
          canonicalSha256(
            attestation.statement,
            "providerDeploymentAttestationStatement",
          ),
        ],
      },
      deploymentAttestationIssuer: {
        organizationId: "test-attestation-issuer.example",
        keys: pins.deploymentAttestationIssuers,
      },
      semanticJudge: {
        organizationId: "test-judge.example",
        keys: pins.semanticJudges,
      },
      cleanup: {
        organizationId: "test-observer.example",
        keys: pins.providerObservers,
      },
    },
  };
  return {
    ...core,
    policySha256: canonicalSha256(
      canonicalJsonValue(core, "providerQualificationReleaseTrustPolicyCore"),
      "providerQualificationReleaseTrustPolicy",
    ),
  } as unknown as ProviderQualificationReleaseTrustPolicy;
}
