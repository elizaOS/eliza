/**
 * Defines the cryptographically authenticated response boundary shared by
 * provider-canary services. Each envelope binds an exact HTTPS endpoint,
 * organizational identity, role, request digest, freshness window, and result
 * to one pinned Ed25519 key before a caller may consume the result.
 */

import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import { providerObserverKeyId } from "./qualification.ts";

export const PROVIDER_SERVICE_IDENTITY_SCHEMA =
  "eliza.provider-canary-service-identity.v1" as const;
export const PROVIDER_SERVICE_SIGNED_RESPONSE_SCHEMA =
  "eliza.provider-canary-signed-response.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_CLOCK_SKEW_MS = 5_000;
const SIGNING_DOMAIN = `${PROVIDER_SERVICE_SIGNED_RESPONSE_SCHEMA}\0`;

export interface ProviderServiceResponsePin {
  endpoint: string;
  organizationId: string;
  administrativeDomain: string;
  publicKeyPem: string;
  keyId: string;
  serviceIdentitySha256: string;
}

export interface ProviderServiceSignedResponsePayload {
  schema: typeof PROVIDER_SERVICE_SIGNED_RESPONSE_SCHEMA;
  endpoint: string;
  organizationId: string;
  administrativeDomain: string;
  serviceIdentitySha256: string;
  role: string;
  requestNonce: string;
  requestSha256: string;
  respondedAtIso: string;
  expiresAtIso: string;
  keyId: string;
  resultSha256: string;
  result: CanonicalJsonValue;
}

export interface SignedProviderServiceResponse {
  payload: ProviderServiceSignedResponsePayload;
  signature: string;
}

export interface ProviderServiceResponseSigner {
  keyId: string;
  publicKeyPem: string;
  sign(input: {
    purpose: "service-response";
    payloadSha256: string;
    bytes: Uint8Array;
  }): Promise<string>;
}

function fail(message: string): never {
  throw new Error(`provider service response refused: ${message}`);
}

function string(value: unknown, path: string, maximum = 8_192): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    fail(`${path} must be a bounded non-empty string`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  )
    fail(`${path} has an unsupported shape`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function hash(value: unknown, path: string): string {
  const result = string(value, path);
  if (!HASH_PATTERN.test(result)) fail(`${path} must be a SHA-256 digest`);
  return result;
}

function endpoint(value: unknown, path: string): string {
  const raw = string(value, path);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return fail(`${path} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    fail(`${path} must be credential-free HTTPS without query or fragment`);
  return parsed.href;
}

function timestamp(value: unknown, path: string): number {
  const raw = string(value, path);
  const milliseconds = Date.parse(raw);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== raw
  )
    fail(`${path} must be a canonical ISO-8601 timestamp`);
  return milliseconds;
}

function organization(value: unknown, path: string): string {
  return string(value, path, 256);
}

function role(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!ROLE_PATTERN.test(result)) fail(`${path} is invalid`);
  return result;
}

function nonce(value: unknown, path: string): string {
  const result = string(value, path, 256);
  if (!NONCE_PATTERN.test(result)) fail(`${path} is invalid`);
  return result;
}

/** Derive the immutable endpoint and organizational identity operators pin. */
export function providerServiceIdentitySha256(input: {
  endpoint: string;
  organizationId: string;
  administrativeDomain: string;
  keyId: string;
}): string {
  return canonicalSha256(
    {
      schema: PROVIDER_SERVICE_IDENTITY_SCHEMA,
      endpoint: endpoint(input.endpoint, "endpoint"),
      organizationId: organization(input.organizationId, "organizationId"),
      administrativeDomain: organization(
        input.administrativeDomain,
        "administrativeDomain",
      ),
      keyId: hash(input.keyId, "keyId"),
    },
    "providerServiceIdentity",
  );
}

/** Return the domain-separated canonical bytes an HSM must sign. */
export function providerServiceResponseSigningBytes(
  payload: ProviderServiceSignedResponsePayload,
): Buffer {
  return Buffer.from(
    `${SIGNING_DOMAIN}${canonicalJson(canonicalJsonValue(payload, "serviceResponsePayload"))}`,
    "utf8",
  );
}

/** Construct and HSM-sign one closed, request-bound response envelope. */
export async function signProviderServiceResponse(input: {
  pin: Omit<ProviderServiceResponsePin, "publicKeyPem">;
  signer: ProviderServiceResponseSigner;
  role: string;
  requestNonce: string;
  requestSha256: string;
  respondedAtIso: string;
  expiresAtIso: string;
  result: unknown;
}): Promise<SignedProviderServiceResponse> {
  const expectedIdentity = providerServiceIdentitySha256(input.pin);
  if (input.pin.serviceIdentitySha256 !== expectedIdentity)
    fail("service identity does not match the response endpoint");
  if (input.signer.keyId !== input.pin.keyId)
    fail("signer key does not match the service identity");
  if (providerObserverKeyId(input.signer.publicKeyPem) !== input.signer.keyId)
    fail("signer public key does not match its key id");
  const result = canonicalJsonValue(input.result, "serviceResponseResult");
  const payload: ProviderServiceSignedResponsePayload = {
    schema: PROVIDER_SERVICE_SIGNED_RESPONSE_SCHEMA,
    endpoint: endpoint(input.pin.endpoint, "endpoint"),
    organizationId: organization(input.pin.organizationId, "organizationId"),
    administrativeDomain: organization(
      input.pin.administrativeDomain,
      "administrativeDomain",
    ),
    serviceIdentitySha256: expectedIdentity,
    role: role(input.role, "role"),
    requestNonce: nonce(input.requestNonce, "requestNonce"),
    requestSha256: hash(input.requestSha256, "requestSha256"),
    respondedAtIso: new Date(
      timestamp(input.respondedAtIso, "respondedAtIso"),
    ).toISOString(),
    expiresAtIso: new Date(
      timestamp(input.expiresAtIso, "expiresAtIso"),
    ).toISOString(),
    keyId: hash(input.signer.keyId, "keyId"),
    resultSha256: canonicalSha256(result, "serviceResponseResult"),
    result,
  };
  if (Date.parse(payload.expiresAtIso) <= Date.parse(payload.respondedAtIso))
    fail("response expiry must be after its signing time");
  const bytes = providerServiceResponseSigningBytes(payload);
  const signature = await input.signer.sign({
    purpose: "service-response",
    payloadSha256: canonicalSha256(payload, "serviceResponsePayload"),
    bytes,
  });
  if (!BASE64URL_PATTERN.test(signature)) fail("signature is not base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    signatureBytes.byteLength !== 64 ||
    !verifySignature(
      null,
      bytes,
      createPublicKey(input.signer.publicKeyPem),
      signatureBytes,
    )
  )
    fail("HSM returned an invalid Ed25519 signature");
  return Object.freeze({ payload: Object.freeze(payload), signature });
}

/** Verify an envelope before exposing its result to a provider-canary caller. */
export function verifyProviderServiceResponse(input: {
  value: unknown;
  pin: ProviderServiceResponsePin;
  expectedRole: string;
  expectedRequestNonce: string;
  expectedRequestSha256: string;
  requestedAtIso: string;
  expiresAtIso: string;
  completedAtIso: string;
}): CanonicalJsonValue {
  const envelope = record(input.value, "response");
  exactKeys(envelope, ["payload", "signature"], "response");
  const payload = record(envelope.payload, "response.payload");
  exactKeys(
    payload,
    [
      "schema",
      "endpoint",
      "organizationId",
      "administrativeDomain",
      "serviceIdentitySha256",
      "role",
      "requestNonce",
      "requestSha256",
      "respondedAtIso",
      "expiresAtIso",
      "keyId",
      "resultSha256",
      "result",
    ],
    "response.payload",
  );
  const expectedIdentity = providerServiceIdentitySha256(input.pin);
  if (
    payload.schema !== PROVIDER_SERVICE_SIGNED_RESPONSE_SCHEMA ||
    endpoint(payload.endpoint, "response.payload.endpoint") !==
      endpoint(input.pin.endpoint, "pin.endpoint") ||
    organization(payload.organizationId, "response.payload.organizationId") !==
      organization(input.pin.organizationId, "pin.organizationId") ||
    organization(
      payload.administrativeDomain,
      "response.payload.administrativeDomain",
    ) !==
      organization(
        input.pin.administrativeDomain,
        "pin.administrativeDomain",
      ) ||
    hash(
      payload.serviceIdentitySha256,
      "response.payload.serviceIdentitySha256",
    ) !== expectedIdentity ||
    hash(input.pin.serviceIdentitySha256, "pin.serviceIdentitySha256") !==
      expectedIdentity ||
    role(payload.role, "response.payload.role") !==
      role(input.expectedRole, "expectedRole") ||
    nonce(payload.requestNonce, "response.payload.requestNonce") !==
      nonce(input.expectedRequestNonce, "expectedRequestNonce") ||
    hash(payload.requestSha256, "response.payload.requestSha256") !==
      hash(input.expectedRequestSha256, "expectedRequestSha256") ||
    hash(payload.keyId, "response.payload.keyId") !==
      hash(input.pin.keyId, "pin.keyId")
  )
    fail("signed response correlation does not match the request and pin");
  if (providerObserverKeyId(input.pin.publicKeyPem) !== input.pin.keyId)
    fail("pinned public key does not match its key id");
  const result = canonicalJsonValue(payload.result, "response.payload.result");
  if (
    hash(payload.resultSha256, "response.payload.resultSha256") !==
    canonicalSha256(result, "serviceResponseResult")
  )
    fail("result digest does not match the signed result");
  const requestedAtMs = timestamp(input.requestedAtIso, "requestedAtIso");
  const requestExpiresAtMs = timestamp(input.expiresAtIso, "expiresAtIso");
  const completedAtMs = timestamp(input.completedAtIso, "completedAtIso");
  const respondedAtMs = timestamp(
    payload.respondedAtIso,
    "response.payload.respondedAtIso",
  );
  const responseExpiresAtMs = timestamp(
    payload.expiresAtIso,
    "response.payload.expiresAtIso",
  );
  if (
    responseExpiresAtMs !== requestExpiresAtMs ||
    requestExpiresAtMs <= requestedAtMs ||
    respondedAtMs < requestedAtMs - MAX_CLOCK_SKEW_MS ||
    respondedAtMs > requestExpiresAtMs ||
    respondedAtMs > completedAtMs + MAX_CLOCK_SKEW_MS ||
    completedAtMs > requestExpiresAtMs + MAX_CLOCK_SKEW_MS
  )
    fail("signed response is outside the authorized freshness window");
  const typedPayload = canonicalJsonValue(
    payload,
    "serviceResponsePayload",
  ) as unknown as ProviderServiceSignedResponsePayload;
  const signature = string(envelope.signature, "response.signature");
  if (!BASE64URL_PATTERN.test(signature)) fail("signature is not base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    signatureBytes.byteLength !== 64 ||
    !verifySignature(
      null,
      providerServiceResponseSigningBytes(typedPayload),
      createPublicKey(input.pin.publicKeyPem),
      signatureBytes,
    )
  )
    fail("Ed25519 response signature is invalid");
  return result;
}
