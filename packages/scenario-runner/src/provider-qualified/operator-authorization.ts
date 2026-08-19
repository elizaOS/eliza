/**
 * Authorizes one provider-canary manifest with an offline Ed25519 operator key
 * and verifies that authorization against deployment-pinned public keys before
 * authenticated ingress. Private key material is accepted only as a Node key
 * object and is never serialized into the returned cross-process bundle.
 */

import {
  createPublicKey,
  type KeyObject,
  sign as signPayload,
  verify as verifySignature,
} from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { preflightProviderCanary } from "./canary-controller.ts";
import {
  canonicalJsonValue,
  createProviderQualificationManifest,
  type ProviderQualificationManifest,
  type ProviderRunBindings,
} from "./manifest.ts";
import {
  type ProviderQualificationManifestSignature,
  providerManifestSigningBytes,
  providerObserverKeyId,
} from "./qualification.ts";

export const PROVIDER_CANARY_AUTHORIZATION_SCHEMA =
  "eliza.provider-canary-authorization.v1" as const;

export interface ProviderCanaryAuthorization {
  schema: typeof PROVIDER_CANARY_AUTHORIZATION_SCHEMA;
  manifest: ProviderQualificationManifest;
  manifestSignature: ProviderQualificationManifestSignature;
}

export interface AuthorizedProviderCanaryPreflight {
  status: "operator-authorization-validated";
  scenarioId: string;
  authorization: ProviderCanaryAuthorization;
}

const MAX_PINNED_MANIFEST_AUTHORITIES = 16;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function fail(message: string): never {
  throw new Error(`provider-canary operator authorization ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${path} violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireCanonicalEd25519Signature(
  value: unknown,
  path: string,
): Buffer {
  if (
    typeof value !== "string" ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    fail(`${path} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== value) {
    fail(`${path} must be one canonical Ed25519 signature`);
  }
  return bytes;
}

function authorityKeyId(privateKey: KeyObject): string {
  if (
    !(privateKey instanceof Object) ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    fail("manifestAuthorityPrivateKey must be an Ed25519 private KeyObject");
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  return providerObserverKeyId(publicKeyPem);
}

/**
 * Build and authorize the exact canonical manifest for one canary run.
 *
 * Key generation and custody intentionally remain outside this package so an
 * operator can use an offline signer or inject a short-lived KeyObject without
 * placing private PEM data in JSON, environment variables, or evidence files.
 */
export function authorizeProviderCanary(input: {
  scenario: ScenarioDefinition;
  bindings: ProviderRunBindings;
  manifestAuthorityPrivateKey: KeyObject;
}): ProviderCanaryAuthorization {
  const keyId = authorityKeyId(input.manifestAuthorityPrivateKey);
  const manifest = createProviderQualificationManifest({
    scenario: input.scenario,
    bindings: input.bindings,
  });
  if (manifest.trust.manifestAuthorityKeyId !== keyId) {
    fail(
      "manifestAuthorityPrivateKey does not match bindings.trust.manifestAuthorityKeyId",
    );
  }
  const manifestSignature = Object.freeze({
    keyId,
    manifestSha256: manifest.manifestSha256,
    signature: signPayload(
      null,
      providerManifestSigningBytes(manifest),
      input.manifestAuthorityPrivateKey,
    ).toString("base64url"),
  });
  return Object.freeze({
    schema: PROVIDER_CANARY_AUTHORIZATION_SCHEMA,
    manifest,
    manifestSignature,
  });
}

/**
 * Validate a serialized authorization bundle against the exact scenario and
 * deployment-owned authority pins. Success proves operator authorization only;
 * it does not execute ingress or create provider, trajectory, or judge proof.
 */
export function preflightAuthorizedProviderCanary(input: {
  scenario: ScenarioDefinition;
  authorization: unknown;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
}): AuthorizedProviderCanaryPreflight {
  const snapshot = canonicalJsonValue(
    input.authorization,
    "authorization",
  ) as unknown;
  const authorization = record(snapshot, "authorization");
  exactKeys(authorization, "authorization", [
    "schema",
    "manifest",
    "manifestSignature",
  ]);
  if (authorization.schema !== PROVIDER_CANARY_AUTHORIZATION_SCHEMA) {
    fail("authorization.schema is unsupported");
  }

  const preflight = preflightProviderCanary(
    input.scenario,
    authorization.manifest,
  );
  const signatureRecord = record(
    authorization.manifestSignature,
    "authorization.manifestSignature",
  );
  exactKeys(signatureRecord, "authorization.manifestSignature", [
    "keyId",
    "manifestSha256",
    "signature",
  ]);
  const keyId = requireHash(
    signatureRecord.keyId,
    "authorization.manifestSignature.keyId",
  );
  const manifestSha256 = requireHash(
    signatureRecord.manifestSha256,
    "authorization.manifestSignature.manifestSha256",
  );
  const signature = requireCanonicalEd25519Signature(
    signatureRecord.signature,
    "authorization.manifestSignature.signature",
  );
  if (
    keyId !== preflight.manifest.trust.manifestAuthorityKeyId ||
    manifestSha256 !== preflight.manifest.manifestSha256
  ) {
    fail(
      "manifest signature correlation does not match the canonical manifest",
    );
  }

  const pins = canonicalJsonValue(
    input.pinnedManifestAuthorityPublicKeysPem,
    "pinnedManifestAuthorityPublicKeysPem",
  ) as unknown as readonly string[];
  if (
    !Array.isArray(pins) ||
    pins.length === 0 ||
    pins.length > MAX_PINNED_MANIFEST_AUTHORITIES
  ) {
    fail(
      `pinnedManifestAuthorityPublicKeysPem must contain 1-${MAX_PINNED_MANIFEST_AUTHORITIES} keys`,
    );
  }
  const pinnedById = new Map<string, KeyObject>();
  for (const [index, pem] of pins.entries()) {
    if (typeof pem !== "string" || pem.length > 32_768) {
      fail(
        `pinnedManifestAuthorityPublicKeysPem[${index}] must be a bounded PEM string`,
      );
    }
    let publicKey: KeyObject;
    let pinnedKeyId: string;
    try {
      pinnedKeyId = providerObserverKeyId(pem);
      publicKey = createPublicKey(pem);
    } catch (error) {
      // error-policy:J2 retain the key parser failure at the operator boundary.
      throw new Error(
        `provider-canary operator authorization pinnedManifestAuthorityPublicKeysPem[${index}] is not a valid Ed25519 public key`,
        { cause: error },
      );
    }
    if (pinnedById.has(pinnedKeyId)) {
      fail(
        `pinnedManifestAuthorityPublicKeysPem[${index}] duplicates an earlier key`,
      );
    }
    pinnedById.set(pinnedKeyId, publicKey);
  }
  const authority = pinnedById.get(keyId);
  if (
    !authority ||
    !verifySignature(
      null,
      providerManifestSigningBytes(preflight.manifest),
      authority,
      signature,
    )
  ) {
    fail("manifest signature is invalid or not signed by a pinned authority");
  }

  const validatedAuthorization = Object.freeze({
    schema: PROVIDER_CANARY_AUTHORIZATION_SCHEMA,
    manifest: preflight.manifest,
    manifestSignature: Object.freeze({
      keyId,
      manifestSha256,
      signature: signature.toString("base64url"),
    }),
  });
  return Object.freeze({
    status: "operator-authorization-validated",
    scenarioId: input.scenario.id,
    authorization: validatedAuthorization,
  });
}
