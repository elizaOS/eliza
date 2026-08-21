/**
 * Defines the portable deployment-attestation envelope consumed by provider
 * qualification. The generic verifier proves only that an independently
 * trusted Ed25519 verifier signed the exact deployment binding; obtaining and
 * validating platform-native evidence remains the verifier operator's job.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";

export const PROVIDER_DEPLOYMENT_ATTESTATION_STATEMENT_SCHEMA =
  "eliza.provider-deployment-attestation-statement.v1" as const;
export const PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA =
  "eliza.provider-deployment-attestation-envelope.v1" as const;

export interface ProviderDeploymentAttestationStatement {
  schema: typeof PROVIDER_DEPLOYMENT_ATTESTATION_STATEMENT_SCHEMA;
  issuerKeyId: string;
  subject: string;
  audience: string;
  runId: string;
  runNonce: string;
  repositorySha: string;
  deploymentSha: string;
  workloadSha256: string;
  /** Digest of the provider-specific evidence bytes checked by the issuer. */
  platformEvidenceSha256: string;
  issuedAtIso: string;
  expiresAtIso: string;
}

export interface SignedProviderDeploymentAttestation {
  schema: typeof PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA;
  statement: ProviderDeploymentAttestationStatement;
  signature: string;
}

export interface VerifiedProviderDeploymentAttestation {
  issuerKeyId: string;
  statementSha256: string;
  workloadSha256: string;
  platformEvidenceSha256: string;
  issuedAtIso: string;
  expiresAtIso: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_MAX_LIFETIME_MS = 5 * 60_000;
const DEFAULT_CLOCK_SKEW_MS = 5_000;

function fail(message: string, context?: Record<string, unknown>): never {
  throw new ElizaError(`provider deployment attestation ${message}`, {
    code: "PROVIDER_DEPLOYMENT_ATTESTATION_INVALID",
    context,
    severity: "fatal",
  });
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${path} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const missing = keys.filter((key) => descriptors[key] === undefined);
  const unknown = Object.keys(descriptors).filter((key) => !keys.includes(key));
  const accessors = Object.entries(descriptors)
    .filter(([, descriptor]) => !("value" in descriptor))
    .map(([key]) => key);
  if (missing.length || unknown.length || accessors.length) {
    fail(`${path} violates the closed data shape`, {
      missing,
      unknown,
      accessors,
    });
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, path: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    fail(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  const result = boundedString(value, path, 64);
  if (!SHA256.test(result)) fail(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function sourceSha(value: unknown, path: string): string {
  const result = boundedString(value, path, 64);
  if (!SOURCE_SHA.test(result)) fail(`${path} must be a source digest`);
  return result;
}

function time(value: unknown, path: string): { iso: string; epochMs: number } {
  const iso = boundedString(value, path, 64);
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs) || new Date(epochMs).toISOString() !== iso) {
    fail(`${path} must be a canonical ISO timestamp`);
  }
  return { iso, epochMs };
}

/** Canonical subject expected for the exact deployment workload. */
export function providerDeploymentAttestationSubject(
  workloadSha256: string,
): string {
  digest(workloadSha256, "workloadSha256");
  return `urn:eliza:provider-deployment:${workloadSha256}`;
}

/** Canonical qualification audience expected for one scenario. */
export function providerDeploymentAttestationAudience(
  scenarioId: string,
): string {
  boundedString(scenarioId, "scenarioId");
  return `urn:eliza:provider-qualification:${scenarioId}`;
}

/** Parse an envelope without trusting its signer or its self-declared fields. */
export function validateProviderDeploymentAttestationEnvelope(
  value: unknown,
): SignedProviderDeploymentAttestation {
  const snapshot = canonicalJsonValue(value, "providerDeploymentAttestation");
  const envelope = record(snapshot, "envelope", [
    "schema",
    "statement",
    "signature",
  ]);
  if (envelope.schema !== PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA) {
    fail("envelope schema is unsupported");
  }
  boundedString(envelope.signature, "envelope.signature", 256);
  const statement = record(envelope.statement, "envelope.statement", [
    "schema",
    "issuerKeyId",
    "subject",
    "audience",
    "runId",
    "runNonce",
    "repositorySha",
    "deploymentSha",
    "workloadSha256",
    "platformEvidenceSha256",
    "issuedAtIso",
    "expiresAtIso",
  ]);
  if (statement.schema !== PROVIDER_DEPLOYMENT_ATTESTATION_STATEMENT_SCHEMA) {
    fail("statement schema is unsupported");
  }
  digest(statement.issuerKeyId, "envelope.statement.issuerKeyId");
  boundedString(statement.subject, "envelope.statement.subject");
  boundedString(statement.audience, "envelope.statement.audience");
  boundedString(statement.runId, "envelope.statement.runId");
  boundedString(statement.runNonce, "envelope.statement.runNonce");
  sourceSha(statement.repositorySha, "envelope.statement.repositorySha");
  sourceSha(statement.deploymentSha, "envelope.statement.deploymentSha");
  digest(statement.workloadSha256, "envelope.statement.workloadSha256");
  digest(
    statement.platformEvidenceSha256,
    "envelope.statement.platformEvidenceSha256",
  );
  time(statement.issuedAtIso, "envelope.statement.issuedAtIso");
  time(statement.expiresAtIso, "envelope.statement.expiresAtIso");
  return snapshot as unknown as SignedProviderDeploymentAttestation;
}

/** Exact canonical statement bytes signed by a configured external verifier. */
export function providerDeploymentAttestationSigningBytes(
  statement: ProviderDeploymentAttestationStatement,
): Buffer {
  const envelope = validateProviderDeploymentAttestationEnvelope({
    schema: PROVIDER_DEPLOYMENT_ATTESTATION_ENVELOPE_SCHEMA,
    statement,
    signature: "validation-placeholder",
  });
  return Buffer.from(
    canonicalJson(
      canonicalJsonValue(
        envelope.statement,
        "providerDeploymentAttestationStatement",
      ),
    ),
    "utf8",
  );
}

/**
 * Verify the external verifier signature and every run/deployment binding.
 * No platform identity is inferred from labels: callers must configure a
 * provider-specific verifier public key whose operator validates native
 * platform evidence before signing this portable statement.
 */
export function verifyProviderDeploymentAttestation(input: {
  envelope: SignedProviderDeploymentAttestation;
  trustedIssuerPublicKeysPem: readonly [string, ...string[]];
  expected: {
    runId: string;
    runNonce: string;
    scenarioId: string;
    repositorySha: string;
    deploymentSha: string;
    workloadSha256: string;
  };
  nowIso: string;
  maxLifetimeMs?: number;
  maxClockSkewMs?: number;
}): VerifiedProviderDeploymentAttestation {
  const envelope = validateProviderDeploymentAttestationEnvelope(
    input.envelope,
  );
  const statement = envelope.statement;
  const now = time(input.nowIso, "nowIso").epochMs;
  const issued = time(statement.issuedAtIso, "statement.issuedAtIso").epochMs;
  const expires = time(
    statement.expiresAtIso,
    "statement.expiresAtIso",
  ).epochMs;
  const maxLifetimeMs = input.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const maxClockSkewMs = input.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    maxLifetimeMs <= 0 ||
    maxLifetimeMs > DEFAULT_MAX_LIFETIME_MS ||
    !Number.isSafeInteger(maxClockSkewMs) ||
    maxClockSkewMs < 0 ||
    maxClockSkewMs > DEFAULT_CLOCK_SKEW_MS
  ) {
    fail("freshness controls exceed protocol bounds");
  }
  if (
    expires <= issued ||
    expires - issued > maxLifetimeMs ||
    issued > now + maxClockSkewMs ||
    expires < now - maxClockSkewMs
  ) {
    fail("statement is stale, future-dated, or overlong");
  }
  const expectedSubject = providerDeploymentAttestationSubject(
    input.expected.workloadSha256,
  );
  const expectedAudience = providerDeploymentAttestationAudience(
    input.expected.scenarioId,
  );
  if (
    statement.subject !== expectedSubject ||
    statement.audience !== expectedAudience ||
    statement.runId !== input.expected.runId ||
    statement.runNonce !== input.expected.runNonce ||
    statement.repositorySha !== input.expected.repositorySha ||
    statement.deploymentSha !== input.expected.deploymentSha ||
    statement.workloadSha256 !== input.expected.workloadSha256
  ) {
    fail("statement does not match the expected run and workload");
  }
  const keyPem = input.trustedIssuerPublicKeysPem.find((pem) => {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      fail("trusted issuer keys must be Ed25519");
    }
    return (
      createHash("sha256")
        .update(key.export({ type: "spki", format: "der" }))
        .digest("hex") === statement.issuerKeyId
    );
  });
  if (!keyPem) fail("issuer is not in the configured trust roots");
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
  } catch (error) {
    throw new ElizaError(
      "provider deployment attestation signature is malformed",
      {
        code: "PROVIDER_DEPLOYMENT_ATTESTATION_INVALID",
        cause: error,
        severity: "fatal",
      },
    );
  }
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      providerDeploymentAttestationSigningBytes(statement),
      createPublicKey(keyPem),
      signature,
    )
  ) {
    fail("signature is invalid");
  }
  return {
    issuerKeyId: statement.issuerKeyId,
    statementSha256: canonicalSha256(
      statement,
      "providerDeploymentAttestationStatement",
    ),
    workloadSha256: statement.workloadSha256,
    platformEvidenceSha256: statement.platformEvidenceSha256,
    issuedAtIso: statement.issuedAtIso,
    expiresAtIso: statement.expiresAtIso,
  };
}
