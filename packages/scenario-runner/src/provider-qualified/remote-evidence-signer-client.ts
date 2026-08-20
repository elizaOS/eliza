/**
 * Calls independently operated HTTPS evidence signers and accepts an envelope
 * only after exact request correlation, payload echo, freshness, and pinned
 * Ed25519 verification succeed locally. The boundary transports a bearer
 * credential but never accepts private signing material.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import {
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  type SemanticJudgeEvidencePayload,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";

export const REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA =
  "eliza.remote-evidence-sign-request.v1" as const;
export const REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA =
  "eliza.remote-evidence-sign-response.v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export type RemoteEvidenceSignerRole = "observer" | "semantic-judge";

export interface RemoteEvidenceSignerPin {
  role: RemoteEvidenceSignerRole;
  endpoint: string;
  organizationId: string;
  publicKeyPem: string;
  keyId: string;
  serviceIdentitySha256: string;
}

export interface RemoteEvidenceSignerClientOptions {
  pin: RemoteEvidenceSignerPin;
  bearerToken: string;
  timeoutMs?: number;
  requestTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface RemoteEvidenceSignRequest {
  schema: typeof REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA;
  role: RemoteEvidenceSignerRole;
  serviceIdentitySha256: string;
  keyId: string;
  requestNonce: string;
  requestedAtIso: string;
  expiresAtIso: string;
  manifestSha256: string;
  runId: string;
  runNonce: string;
  scenarioId: string;
  trajectorySetSha256: string;
  payloadSha256: string;
  payloadCanonicalBase64url: string;
}

interface RemoteEvidenceSignResponse<Envelope> {
  schema: typeof REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA;
  role: RemoteEvidenceSignerRole;
  serviceIdentitySha256: string;
  requestNonce: string;
  requestSha256: string;
  payloadSha256: string;
  respondedAtIso: string;
  keyId: string;
  signature: string;
  signedEnvelope: Envelope;
}

export interface ProviderObserverSignerClient {
  readonly pin: Readonly<RemoteEvidenceSignerPin>;
  sign(
    payload: ProviderObserverEvidencePayload,
  ): Promise<SignedProviderObserverEvidence>;
}

export interface SemanticJudgeSignerClient {
  readonly pin: Readonly<RemoteEvidenceSignerPin>;
  sign(
    payload: SemanticJudgeEvidencePayload,
  ): Promise<SignedSemanticJudgeEvidence>;
}

function fail(message: string): never {
  throw new Error(`remote evidence signer refused: ${message}`);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${path} has an unsupported shape`);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    fail(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  const result = string(value, path);
  if (!SHA256_PATTERN.test(result)) fail(`${path} must be a SHA-256 digest`);
  return result;
}

function timestamp(value: unknown, path: string): number {
  const result = string(value, path);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    fail(`${path} must be a canonical ISO-8601 timestamp`);
  }
  return parsed;
}

function endpointUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("endpoint must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail("endpoint must be credential-free HTTPS without query or fragment");
  }
  return url;
}

function endpointOrigin(raw: string): string {
  return endpointUrl(raw).origin;
}

/** Recompute the immutable identity pin operators authorize for a signer. */
export function remoteEvidenceSignerIdentitySha256(input: {
  role: RemoteEvidenceSignerRole;
  endpoint: string;
  organizationId: string;
  keyId: string;
}): string {
  const organizationId = string(input.organizationId, "organizationId");
  if (organizationId.length > 256) fail("organizationId is too long");
  return canonicalSha256(
    {
      role: input.role,
      endpointUrl: endpointUrl(input.endpoint).href,
      organizationId,
      keyId: hash(input.keyId, "keyId"),
    },
    "remoteEvidenceSignerIdentity",
  );
}

function validatePin(
  pin: RemoteEvidenceSignerPin,
  expectedRole: RemoteEvidenceSignerRole,
): Readonly<RemoteEvidenceSignerPin> {
  const snapshot = canonicalJsonValue(
    pin,
    "pin",
  ) as unknown as RemoteEvidenceSignerPin;
  exactKeys(
    record(snapshot, "pin"),
    [
      "role",
      "endpoint",
      "organizationId",
      "publicKeyPem",
      "keyId",
      "serviceIdentitySha256",
    ],
    "pin",
  );
  if (snapshot.role !== expectedRole) fail(`pin role must be ${expectedRole}`);
  endpointUrl(snapshot.endpoint);
  if (snapshot.publicKeyPem.includes("PRIVATE KEY"))
    fail("private key material is forbidden");
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(snapshot.publicKeyPem);
  } catch {
    return fail("publicKeyPem must be a valid SPKI public key");
  }
  if (publicKey.asymmetricKeyType !== "ed25519")
    fail("publicKeyPem must be Ed25519");
  if (
    providerObserverKeyId(snapshot.publicKeyPem) !==
    hash(snapshot.keyId, "pin.keyId")
  ) {
    fail("keyId does not match publicKeyPem");
  }
  const expectedIdentity = remoteEvidenceSignerIdentitySha256(snapshot);
  if (
    hash(snapshot.serviceIdentitySha256, "pin.serviceIdentitySha256") !==
    expectedIdentity
  ) {
    fail(
      "service identity pin does not match endpoint, organization, role, and key",
    );
  }
  return Object.freeze({ ...snapshot });
}

/**
 * Ensure observer and judge are independently pinned organizations, origins,
 * and Ed25519 keys before either receives evidence.
 */
export function preflightIndependentEvidenceSigners(input: {
  observer: RemoteEvidenceSignerPin;
  judge: RemoteEvidenceSignerPin;
}): {
  observer: Readonly<RemoteEvidenceSignerPin>;
  judge: Readonly<RemoteEvidenceSignerPin>;
} {
  const observer = validatePin(input.observer, "observer");
  const judge = validatePin(input.judge, "semantic-judge");
  if (endpointOrigin(observer.endpoint) === endpointOrigin(judge.endpoint)) {
    fail("observer and judge endpoint origins must be distinct");
  }
  if (observer.organizationId === judge.organizationId) {
    fail("observer and judge organizations must be distinct");
  }
  if (observer.keyId === judge.keyId) {
    fail("observer and judge keys must be distinct");
  }
  return Object.freeze({ observer, judge });
}

function optionsForRole(
  options: RemoteEvidenceSignerClientOptions,
  role: RemoteEvidenceSignerRole,
) {
  const pin = validatePin(options.pin, role);
  const bearerToken = string(options.bearerToken, "bearerToken");
  if (/\r|\n/.test(bearerToken) || bearerToken.length > 8_192) {
    fail("bearerToken is invalid");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const requestTtlMs = options.requestTtlMs ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  if (
    !Number.isSafeInteger(requestTtlMs) ||
    requestTtlMs < 1 ||
    requestTtlMs > MAX_REQUEST_TTL_MS
  ) {
    fail(`requestTtlMs must be between 1 and ${MAX_REQUEST_TTL_MS}`);
  }
  return {
    pin,
    bearerToken,
    timeoutMs,
    requestTtlMs,
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? (() => new Date()),
  };
}

function correlation(
  payload: ProviderObserverEvidencePayload | SemanticJudgeEvidencePayload,
) {
  return {
    manifestSha256: hash(payload.manifestSha256, "payload.manifestSha256"),
    runId: string(payload.runId, "payload.runId"),
    runNonce: string(payload.runNonce, "payload.runNonce"),
    scenarioId: string(payload.scenarioId, "payload.scenarioId"),
    trajectorySetSha256: hash(
      payload.trajectorySetSha256,
      "payload.trajectorySetSha256",
    ),
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    fail("response body exceeds the byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail("response body exceeds the byte limit");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function parseResponse<Envelope>(
  value: unknown,
): RemoteEvidenceSignResponse<Envelope> {
  const response = record(value, "response");
  exactKeys(
    response,
    [
      "schema",
      "role",
      "serviceIdentitySha256",
      "requestNonce",
      "requestSha256",
      "payloadSha256",
      "respondedAtIso",
      "keyId",
      "signature",
      "signedEnvelope",
    ],
    "response",
  );
  return response as unknown as RemoteEvidenceSignResponse<Envelope>;
}

async function requestSignature<
  Payload extends
    | ProviderObserverEvidencePayload
    | SemanticJudgeEvidencePayload,
  Envelope extends SignedProviderObserverEvidence | SignedSemanticJudgeEvidence,
>(
  options: RemoteEvidenceSignerClientOptions,
  role: RemoteEvidenceSignerRole,
  payload: Payload,
  signingBytes: (payload: Payload) => Buffer,
): Promise<Envelope> {
  const normalized = optionsForRole(options, role);
  const payloadSnapshot = canonicalJsonValue(
    payload,
    "evidencePayload",
  ) as unknown as Payload;
  const payloadBytes = signingBytes(payloadSnapshot);
  if (payloadBytes.byteLength > 2 * 1024 * 1024)
    fail("evidence payload exceeds the byte limit");
  const nowMs = normalized.now().getTime();
  if (!Number.isFinite(nowMs)) fail("clock returned an invalid time");
  const request: RemoteEvidenceSignRequest = {
    schema: REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA,
    role,
    serviceIdentitySha256: normalized.pin.serviceIdentitySha256,
    keyId: normalized.pin.keyId,
    requestNonce: randomBytes(32).toString("base64url"),
    requestedAtIso: new Date(nowMs).toISOString(),
    expiresAtIso: new Date(nowMs + normalized.requestTtlMs).toISOString(),
    ...correlation(payloadSnapshot),
    payloadSha256: createHash("sha256").update(payloadBytes).digest("hex"),
    payloadCanonicalBase64url: payloadBytes.toString("base64url"),
  };
  const requestBody = canonicalJson(
    canonicalJsonValue(request, "remoteEvidenceSignRequest"),
  );
  if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BYTES)
    fail("signing request exceeds the byte limit");
  const requestSha256 = createHash("sha256")
    .update(requestBody, "utf8")
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalized.timeoutMs);
  let response: Response;
  try {
    response = await normalized.fetchImpl(normalized.pin.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: Object.freeze({
        Accept: "application/json",
        Authorization: `Bearer ${normalized.bearerToken}`,
        "Content-Type": "application/json",
      }),
      body: requestBody,
    });
  } catch {
    clearTimeout(timeout);
    // error-policy:J1 this credential-bearing transport boundary emits only a fixed refusal.
    return fail("HTTPS request failed");
  }
  let responseText: string;
  try {
    if (response.status >= 300 && response.status < 400)
      fail("redirects are forbidden");
    if (!response.ok) fail(`service returned HTTP ${response.status}`);
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json")
      fail("response content type must be application/json");
    responseText = await boundedResponseText(response);
  } catch (error) {
    // error-policy:J1 response streaming failures are translated without reflecting credentials.
    if (
      error instanceof Error &&
      error.message.startsWith("remote evidence signer refused:")
    )
      throw error;
    return fail("HTTPS response failed");
  } finally {
    clearTimeout(timeout);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(responseText);
  } catch (error) {
    // error-policy:J3 malformed service output becomes an explicit, secret-safe refusal.
    if (
      error instanceof Error &&
      error.message.startsWith("remote evidence signer refused:")
    )
      throw error;
    return fail("response body is not valid bounded JSON");
  }
  const completionNowMs = normalized.now().getTime();
  if (!Number.isFinite(completionNowMs))
    fail("clock returned an invalid completion time");
  if (completionNowMs > nowMs + normalized.requestTtlMs + MAX_CLOCK_SKEW_MS) {
    fail("response arrived after the authorized freshness window");
  }
  const remote = parseResponse<Envelope>(decoded);
  if (
    remote.schema !== REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA ||
    remote.role !== role ||
    hash(remote.serviceIdentitySha256, "response.serviceIdentitySha256") !==
      normalized.pin.serviceIdentitySha256 ||
    string(remote.requestNonce, "response.requestNonce") !==
      request.requestNonce ||
    hash(remote.requestSha256, "response.requestSha256") !== requestSha256 ||
    hash(remote.payloadSha256, "response.payloadSha256") !==
      request.payloadSha256 ||
    hash(remote.keyId, "response.keyId") !== normalized.pin.keyId
  )
    fail("response correlation does not match the request");
  const respondedAtMs = timestamp(
    remote.respondedAtIso,
    "response.respondedAtIso",
  );
  if (
    respondedAtMs < nowMs - MAX_CLOCK_SKEW_MS ||
    respondedAtMs > nowMs + normalized.requestTtlMs ||
    respondedAtMs > completionNowMs + MAX_CLOCK_SKEW_MS
  ) {
    fail("response is outside the authorized freshness window");
  }
  const envelope = record(
    remote.signedEnvelope,
    "response.signedEnvelope",
  ) as unknown as Envelope;
  exactKeys(
    envelope as unknown as Record<string, unknown>,
    ["keyId", "payload", "signature"],
    "response.signedEnvelope",
  );
  const signature = string(remote.signature, "response.signature");
  if (signature !== envelope.signature || remote.keyId !== envelope.keyId) {
    fail("response envelope key or signature was substituted");
  }
  if (
    canonicalJson(
      canonicalJsonValue(envelope.payload, "response.signedEnvelope.payload"),
    ) !== canonicalJson(payloadSnapshot as unknown as CanonicalJsonValue)
  ) {
    fail("response did not echo the exact canonical payload");
  }
  if (!BASE64URL_PATTERN.test(signature))
    fail("response signature is not base64url");
  const signatureBytes = Buffer.from(signature, "base64url");
  if (
    signatureBytes.byteLength !== 64 ||
    !verifySignature(
      null,
      payloadBytes,
      createPublicKey(normalized.pin.publicKeyPem),
      signatureBytes,
    )
  ) {
    fail("response Ed25519 signature is invalid");
  }
  const signedAtMs = timestamp(
    (envelope.payload as { signedAtIso?: unknown }).signedAtIso,
    "response.signedEnvelope.payload.signedAtIso",
  );
  if (
    signedAtMs < nowMs - MAX_CLOCK_SKEW_MS ||
    signedAtMs > nowMs + normalized.requestTtlMs ||
    signedAtMs > completionNowMs + MAX_CLOCK_SKEW_MS
  ) {
    fail("signed payload is outside the authorized freshness window");
  }
  return canonicalJsonValue(
    envelope,
    "verifiedSignedEnvelope",
  ) as unknown as Envelope;
}

/** Create a client that obtains and locally verifies provider-observer evidence. */
export function createProviderObserverSignerClient(
  options: RemoteEvidenceSignerClientOptions,
): ProviderObserverSignerClient {
  const pin = validatePin(options.pin, "observer");
  return Object.freeze({
    pin,
    sign: (payload: ProviderObserverEvidencePayload) =>
      requestSignature<
        ProviderObserverEvidencePayload,
        SignedProviderObserverEvidence
      >(options, "observer", payload, providerEvidenceSigningBytes),
  });
}

/** Create a client that obtains and locally verifies independent-judge evidence. */
export function createSemanticJudgeSignerClient(
  options: RemoteEvidenceSignerClientOptions,
): SemanticJudgeSignerClient {
  const pin = validatePin(options.pin, "semantic-judge");
  return Object.freeze({
    pin,
    sign: (payload: SemanticJudgeEvidencePayload) =>
      requestSignature<
        SemanticJudgeEvidencePayload,
        SignedSemanticJudgeEvidence
      >(options, "semantic-judge", payload, semanticEvidenceSigningBytes),
  });
}
