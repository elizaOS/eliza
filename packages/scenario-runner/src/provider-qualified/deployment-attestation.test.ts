/**
 * Exercises the portable deployment-attestation verifier with real ephemeral
 * Ed25519 signatures and adversarial binding, trust-root, and freshness cases.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA,
  PROVIDER_DEPLOYMENT_ATTESTATION_STATEMENT_SCHEMA,
  providerDeploymentAttestationAudience,
  providerDeploymentAttestationSigningBytes,
  providerDeploymentAttestationSubject,
  type SignedProviderDeploymentAttestation,
  verifyProviderDeploymentAttestation,
} from "./deployment-attestation.ts";
import { providerObserverKeyId } from "./qualification.ts";

const EXPECTED = {
  runId: "provider-run-123",
  runNonce: "nonce-1234567890",
  scenarioId: "provider.gmail.confirmed-send",
  repositorySha: "a".repeat(40),
  deploymentSha: "b".repeat(64),
  workloadSha256: "c".repeat(64),
};
const NOW = "2026-08-20T12:00:00.000Z";

function fixture(): {
  envelope: SignedProviderDeploymentAttestation;
  publicKeyPem: string;
  resign: () => void;
} {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const envelope: SignedProviderDeploymentAttestation = {
    schema: PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA,
    statement: {
      schema: PROVIDER_DEPLOYMENT_ATTESTATION_STATEMENT_SCHEMA,
      issuerKeyId: providerObserverKeyId(publicKeyPem),
      subject: providerDeploymentAttestationSubject(EXPECTED.workloadSha256),
      audience: providerDeploymentAttestationAudience(EXPECTED.scenarioId),
      runId: EXPECTED.runId,
      runNonce: EXPECTED.runNonce,
      repositorySha: EXPECTED.repositorySha,
      deploymentSha: EXPECTED.deploymentSha,
      workloadSha256: EXPECTED.workloadSha256,
      platformEvidenceSha256: "d".repeat(64),
      issuedAtIso: "2026-08-20T11:59:58.000Z",
      expiresAtIso: "2026-08-20T12:03:58.000Z",
    },
    signature: "pending",
  };
  const resign = () => {
    envelope.signature = sign(
      null,
      providerDeploymentAttestationSigningBytes(envelope.statement),
      keyPair.privateKey,
    ).toString("base64url");
  };
  resign();
  return { envelope, publicKeyPem, resign };
}

describe("provider deployment attestation", () => {
  it("verifies exact statement bytes against an explicitly trusted issuer", () => {
    const value = fixture();
    expect(
      verifyProviderDeploymentAttestation({
        envelope: value.envelope,
        trustedIssuerPublicKeysPem: [value.publicKeyPem],
        expected: EXPECTED,
        nowIso: NOW,
      }),
    ).toMatchObject({
      issuerKeyId: value.envelope.statement.issuerKeyId,
      workloadSha256: EXPECTED.workloadSha256,
      platformEvidenceSha256: "d".repeat(64),
    });
  });

  it.each([
    ["subject", "urn:attacker:other-workload"],
    ["audience", "urn:attacker:other-audience"],
    ["runNonce", "attacker-nonce"],
    ["repositorySha", "9".repeat(40)],
    ["deploymentSha", "8".repeat(64)],
    ["workloadSha256", "7".repeat(64)],
  ] as const)("rejects a re-signed substituted %s", (field, value) => {
    const fixtureValue = fixture();
    fixtureValue.envelope.statement[field] = value;
    fixtureValue.resign();
    expect(() =>
      verifyProviderDeploymentAttestation({
        envelope: fixtureValue.envelope,
        trustedIssuerPublicKeysPem: [fixtureValue.publicKeyPem],
        expected: EXPECTED,
        nowIso: NOW,
      }),
    ).toThrow(/does not match/);
  });

  it("rejects unknown roots, stale statements, and altered statement bytes", () => {
    const value = fixture();
    const attacker = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(() =>
      verifyProviderDeploymentAttestation({
        envelope: value.envelope,
        trustedIssuerPublicKeysPem: [attacker],
        expected: EXPECTED,
        nowIso: NOW,
      }),
    ).toThrow(/trust roots/);

    value.envelope.statement.expiresAtIso = "2026-08-20T11:59:00.000Z";
    value.resign();
    expect(() =>
      verifyProviderDeploymentAttestation({
        envelope: value.envelope,
        trustedIssuerPublicKeysPem: [value.publicKeyPem],
        expected: EXPECTED,
        nowIso: NOW,
      }),
    ).toThrow(/stale/);

    const altered = fixture();
    altered.envelope.statement.platformEvidenceSha256 = "e".repeat(64);
    expect(() =>
      verifyProviderDeploymentAttestation({
        envelope: altered.envelope,
        trustedIssuerPublicKeysPem: [altered.publicKeyPem],
        expected: EXPECTED,
        nowIso: NOW,
      }),
    ).toThrow(/signature/);
  });
});
