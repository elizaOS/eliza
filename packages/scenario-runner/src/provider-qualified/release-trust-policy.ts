/**
 * Validates the repository/operator-owned trust anchor used to publish provider
 * qualification evidence. Portable capsules carry verification material, but
 * this policy is the external authority that decides which organizations,
 * keys, workload attestations, and release revisions are acceptable.
 */

import { createPublicKey, type KeyObject } from "node:crypto";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import { providerObserverKeyId } from "./qualification.ts";
import type {
  ProviderQualificationArtifact,
  ProviderQualificationPublicKeyPin,
} from "./qualification-artifact.ts";

export const PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA =
  "eliza.provider-qualification-release-trust-policy.v2" as const;

interface ReleaseSignerOrganization {
  organizationId: string;
  keys: readonly [
    ProviderQualificationPublicKeyPin,
    ...ProviderQualificationPublicKeyPin[],
  ];
}

export interface ProviderQualificationReleaseTrustPolicy {
  schema: typeof PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA;
  policySha256: string;
  releaseId: string;
  repositorySha: string;
  deploymentSha: string;
  organizations: {
    manifestAuthority: ReleaseSignerOrganization;
    providerObserver: ReleaseSignerOrganization & {
      allowedWorkloadSha256s: readonly [string, ...string[]];
      allowedStatementSha256s: readonly [string, ...string[]];
    };
    deploymentAttestationIssuer: ReleaseSignerOrganization;
    semanticJudge: ReleaseSignerOrganization;
    cleanup: ReleaseSignerOrganization;
  };
}

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function fail(message: string): never {
  throw new Error(`provider qualification release trust policy ${message}`);
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const missing = keys.filter((key) => descriptors[key] === undefined);
  const unknown = Object.keys(descriptors).filter((key) => !keys.includes(key));
  const accessors = Object.entries(descriptors)
    .filter(([, descriptor]) => !("value" in descriptor))
    .map(([key]) => key);
  if (missing.length || unknown.length || accessors.length) {
    fail(
      `${path} violates the closed data shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}; accessors=${accessors.join(",") || "none"})`,
    );
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    fail(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function digestList(value: unknown, path: string): [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    fail(`${path} must contain 1-256 SHA-256 digests`);
  }
  const values = value.map((item, index) => {
    if (typeof item !== "string" || !SHA256.test(item)) {
      fail(`${path}[${index}] must be a lowercase SHA-256 digest`);
    }
    return item;
  });
  if (new Set(values).size !== values.length)
    fail(`${path} contains duplicates`);
  return values as [string, ...string[]];
}

function normalizePins(
  values: readonly unknown[],
  path: string,
): [ProviderQualificationPublicKeyPin, ...ProviderQualificationPublicKeyPin[]] {
  if (values.length === 0 || values.length > 16)
    fail(`${path} must contain 1-16 keys`);
  const seen = new Set<string>();
  return values.map((value, index) => {
    const pin = record(value, `${path}[${index}]`, [
      "keyId",
      "algorithm",
      "spkiPem",
    ]);
    if (
      pin.algorithm !== "ed25519" ||
      typeof pin.spkiPem !== "string" ||
      pin.spkiPem.includes("PRIVATE KEY")
    ) {
      fail(`${path}[${index}] must contain an Ed25519 public SPKI PEM`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey(pin.spkiPem);
    } catch (error) {
      throw new Error(
        `provider qualification release trust policy ${path}[${index}] is not a valid public key`,
        { cause: error },
      );
    }
    if (key.asymmetricKeyType !== "ed25519")
      fail(`${path}[${index}] must be Ed25519`);
    const spkiPem = key.export({ type: "spki", format: "pem" });
    const keyId = providerObserverKeyId(spkiPem);
    if (pin.keyId !== keyId || seen.has(keyId))
      fail(`${path}[${index}] has an invalid or duplicate keyId`);
    seen.add(keyId);
    return { keyId, algorithm: "ed25519", spkiPem };
  }) as [
    ProviderQualificationPublicKeyPin,
    ...ProviderQualificationPublicKeyPin[],
  ];
}

function signerOrganization(
  value: unknown,
  path: string,
  observer = false,
): ReleaseSignerOrganization & {
  allowedWorkloadSha256s?: [string, ...string[]];
  allowedStatementSha256s?: [string, ...string[]];
} {
  const item = record(
    value,
    path,
    observer
      ? [
          "organizationId",
          "keys",
          "allowedWorkloadSha256s",
          "allowedStatementSha256s",
        ]
      : ["organizationId", "keys"],
  );
  if (!Array.isArray(item.keys) || item.keys.length === 0) {
    fail(`${path}.keys must be non-empty`);
  }
  const pins = normalizePins(item.keys, `${path}.keys`);
  return {
    organizationId: string(item.organizationId, `${path}.organizationId`),
    keys: pins,
    ...(observer
      ? {
          allowedWorkloadSha256s: digestList(
            item.allowedWorkloadSha256s,
            `${path}.allowedWorkloadSha256s`,
          ),
          allowedStatementSha256s: digestList(
            item.allowedStatementSha256s,
            `${path}.allowedStatementSha256s`,
          ),
        }
      : {}),
  };
}

/** Parse a closed, digest-bound release trust policy without TOFU behavior. */
export function validateProviderQualificationReleaseTrustPolicy(
  value: unknown,
): ProviderQualificationReleaseTrustPolicy {
  const policy = canonicalJsonValue(
    value,
    "providerQualificationReleaseTrustPolicy",
  );
  const top = record(policy, "policy", [
    "schema",
    "policySha256",
    "releaseId",
    "repositorySha",
    "deploymentSha",
    "organizations",
  ]);
  if (top.schema !== PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA) {
    fail("schema is unsupported");
  }
  if (typeof top.policySha256 !== "string" || !SHA256.test(top.policySha256)) {
    fail("policySha256 must be a lowercase SHA-256 digest");
  }
  for (const field of ["repositorySha", "deploymentSha"] as const) {
    if (typeof top[field] !== "string" || !SOURCE_SHA.test(top[field])) {
      fail(`${field} must be a lowercase source digest`);
    }
  }
  const organizations = record(top.organizations, "policy.organizations", [
    "manifestAuthority",
    "providerObserver",
    "deploymentAttestationIssuer",
    "semanticJudge",
    "cleanup",
  ]);
  const parsed = {
    schema: PROVIDER_QUALIFICATION_RELEASE_TRUST_POLICY_SCHEMA,
    releaseId: string(top.releaseId, "policy.releaseId"),
    repositorySha: top.repositorySha as string,
    deploymentSha: top.deploymentSha as string,
    organizations: {
      manifestAuthority: signerOrganization(
        organizations.manifestAuthority,
        "policy.organizations.manifestAuthority",
      ),
      providerObserver: signerOrganization(
        organizations.providerObserver,
        "policy.organizations.providerObserver",
        true,
      ),
      deploymentAttestationIssuer: signerOrganization(
        organizations.deploymentAttestationIssuer,
        "policy.organizations.deploymentAttestationIssuer",
      ),
      semanticJudge: signerOrganization(
        organizations.semanticJudge,
        "policy.organizations.semanticJudge",
      ),
      cleanup: signerOrganization(
        organizations.cleanup,
        "policy.organizations.cleanup",
      ),
    },
  };
  const ids = [
    parsed.organizations.manifestAuthority.organizationId,
    parsed.organizations.providerObserver.organizationId,
    parsed.organizations.deploymentAttestationIssuer.organizationId,
    parsed.organizations.semanticJudge.organizationId,
  ];
  if (new Set(ids).size !== ids.length) {
    fail(
      "authority, observer, attestation issuer, and judge organizations must be distinct",
    );
  }
  if (
    parsed.organizations.cleanup.organizationId !==
    parsed.organizations.providerObserver.organizationId
  ) {
    fail("cleanup must be owned by the authorized observer organization");
  }
  const roleKeys = [
    parsed.organizations.manifestAuthority.keys,
    parsed.organizations.providerObserver.keys,
    parsed.organizations.deploymentAttestationIssuer.keys,
    parsed.organizations.semanticJudge.keys,
  ].map((pins) => new Set(pins.map((pin) => pin.keyId)));
  if (
    [...roleKeys[0]].some((id) =>
      roleKeys.slice(1).some((keys) => keys.has(id)),
    ) ||
    [...roleKeys[1]].some((id) => roleKeys[2].has(id) || roleKeys[3].has(id)) ||
    [...roleKeys[2]].some((id) => roleKeys[3].has(id))
  ) {
    fail(
      "authority, observer, attestation issuer, and judge keys must be cryptographically distinct",
    );
  }
  const core = canonicalJsonValue(
    parsed,
    "providerQualificationReleaseTrustPolicyCore",
  );
  if (
    canonicalSha256(core, "providerQualificationReleaseTrustPolicy") !==
    top.policySha256
  ) {
    fail("policySha256 does not match the canonical policy");
  }
  return {
    ...parsed,
    policySha256: top.policySha256,
  } as ProviderQualificationReleaseTrustPolicy;
}

function allowedPins(
  actual: readonly ProviderQualificationPublicKeyPin[],
  allowed: readonly ProviderQualificationPublicKeyPin[],
  path: string,
): void {
  const byId = new Map(allowed.map((pin) => [pin.keyId, pin.spkiPem]));
  if (actual.some((pin) => byId.get(pin.keyId) !== pin.spkiPem)) {
    fail(`${path} contains a key not authorized by the external policy`);
  }
}

/** Authorize a portable artifact against an independently supplied policy. */
export function authorizeProviderQualificationArtifactForRelease(input: {
  artifact: ProviderQualificationArtifact;
  policy: ProviderQualificationReleaseTrustPolicy;
}): void {
  const policy = validateProviderQualificationReleaseTrustPolicy(input.policy);
  const artifact = input.artifact;
  if (
    artifact.repositorySha !== policy.repositorySha ||
    artifact.deploymentSha !== policy.deploymentSha
  ) {
    fail("artifact repository or deployment is outside the authorized release");
  }
  const pins = artifact.reverification.publicKeyPins;
  allowedPins(
    pins.manifestAuthorities,
    policy.organizations.manifestAuthority.keys,
    "manifest authority pins",
  );
  allowedPins(
    pins.providerObservers,
    policy.organizations.providerObserver.keys,
    "observer pins",
  );
  allowedPins(
    pins.deploymentAttestationIssuers,
    policy.organizations.deploymentAttestationIssuer.keys,
    "deployment attestation issuer pins",
  );
  allowedPins(
    pins.semanticJudges,
    policy.organizations.semanticJudge.keys,
    "semantic judge pins",
  );
  const observer = artifact.reverification.signedObserverEvidence;
  const semantic = artifact.reverification.signedSemanticJudgeEvidence;
  const manifestKey =
    artifact.reverification.manifest.trust.manifestAuthorityKeyId;
  if (
    !policy.organizations.manifestAuthority.keys.some(
      (pin) => pin.keyId === manifestKey,
    )
  )
    fail("manifest signer is not policy-authorized");
  if (
    !policy.organizations.providerObserver.keys.some(
      (pin) => pin.keyId === observer.keyId,
    )
  )
    fail("observer signer is not policy-authorized");
  if (
    !policy.organizations.semanticJudge.keys.some(
      (pin) => pin.keyId === semantic.keyId,
    )
  )
    fail("semantic judge signer is not policy-authorized");
  const attestation = observer.payload.deploymentAttestation;
  if (
    !policy.organizations.deploymentAttestationIssuer.keys.some(
      (pin) => pin.keyId === attestation.statement.issuerKeyId,
    ) ||
    !policy.organizations.providerObserver.allowedWorkloadSha256s.includes(
      attestation.statement.workloadSha256,
    ) ||
    !policy.organizations.providerObserver.allowedStatementSha256s.includes(
      canonicalSha256(
        attestation.statement,
        "providerDeploymentAttestationStatement",
      ),
    )
  ) {
    fail(
      "observer workload attestation is not authorized by the external policy",
    );
  }
}

/** Require the cleanup signer to be in the release policy's observer-owned ring. */
export function authorizeProviderCleanupSignerForRelease(input: {
  pin: ProviderQualificationPublicKeyPin;
  policy: ProviderQualificationReleaseTrustPolicy;
}): void {
  const policy = validateProviderQualificationReleaseTrustPolicy(input.policy);
  if (
    !policy.organizations.cleanup.keys.some(
      (pin) =>
        pin.keyId === input.pin.keyId && pin.spkiPem === input.pin.spkiPem,
    )
  ) {
    fail("cleanup signer is not authorized by the external policy");
  }
}
