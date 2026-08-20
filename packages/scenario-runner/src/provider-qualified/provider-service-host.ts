/**
 * Hosts the deployment-owned half of the reference provider-canary protocol.
 * The transport is closed-shape and role-authorized; provider adapters retain
 * responsibility for real execution and independent observation while signing
 * keys remain behind an HSM-compatible interface.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import type { ServerOptions } from "node:https";
import { createServer, type Server } from "node:https";
import path from "node:path";
import process from "node:process";
import {
  PROVIDER_CLEANUP_PROOF_SCHEMA,
  type ProviderCleanupProofPayload,
  type SignedProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import {
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";
import {
  REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA,
  REFERENCE_OPERATOR_SECRET_RESPONSE_SCHEMA,
  REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA,
  REFERENCE_OPERATOR_SERVICE_RESPONSE_SCHEMA,
} from "./reference-operator-bundle.ts";
import {
  REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA,
  REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA,
  remoteEvidenceSignerIdentitySha256,
} from "./remote-evidence-signer-client.ts";

export const PROVIDER_SERVICE_ERROR_SCHEMA =
  "eliza.provider-canary-service-error.v1" as const;
export const DEFAULT_PROVIDER_SERVICE_PATH =
  "/provider-canary/v1/service" as const;
export const DEFAULT_PROVIDER_SECRET_PATH =
  "/provider-canary/v1/secrets" as const;
export const PROVIDER_CLEANUP_RESULT_SCHEMA =
  "eliza.provider-canary-cleanup-result.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_STRING_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_TTL_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export type ProviderServiceRole =
  | "controller-execute"
  | "observer-begin"
  | "observer-complete"
  | "observer-sign"
  | "observer-cleanup-sign"
  | "semantic-judge-evaluate"
  | "semantic-judge-sign"
  | "cleanup-execute"
  | "secret-resolve";

export interface ProviderServiceCorrelation {
  manifestSha256: string;
  runId: string;
  scenarioId: string;
  operationKind: string;
}

export interface ProviderServiceAuthorizationRequest {
  role: ProviderServiceRole;
  bearerTokenSha256: string;
  requestSha256: string;
  requestNonce: string;
  correlation?: ProviderServiceCorrelation;
  requestedSecretRefs?: readonly string[];
  nowIso: string;
}

export interface ProviderServiceAuthorizationGrant {
  grantSha256: string;
  role: ProviderServiceRole;
  bearerTokenSha256: string;
  requestSha256: string;
  requestNonce: string;
  manifestSha256?: string;
  runId?: string;
  scenarioId?: string;
  operationKind?: string;
  allowedSecretRefs?: readonly string[];
  notBeforeIso: string;
  expiresAtIso: string;
}

export interface ProviderServiceRoleAuthorizer {
  authorize(
    request: ProviderServiceAuthorizationRequest,
  ): Promise<ProviderServiceAuthorizationGrant>;
}

export interface StaticProviderServiceAuthorization {
  bearerTokenSha256: string;
  policy: Omit<
    ProviderServiceAuthorizationGrant,
    "grantSha256" | "bearerTokenSha256" | "requestSha256" | "requestNonce"
  >;
}

export interface ProviderServiceStateStore {
  /** Atomically claims a nonce. A false result is a replay or collision. */
  claimReplay(input: {
    namespace: string;
    nonce: string;
    requestSha256: string;
    expiresAtIso: string;
  }): Promise<boolean>;
  /** Atomically records one canonical value. Replacing a key is forbidden. */
  putOnce(key: string, value: CanonicalJsonValue): Promise<boolean>;
  get(key: string): Promise<CanonicalJsonValue | undefined>;
}

export interface ProviderServiceAdapterContext
  extends ProviderServiceCorrelation {
  requestNonce: string;
  requestSha256: string;
  authorizationGrantSha256: string;
}

export interface ProviderControllerServiceAdapter {
  execute(
    context: ProviderServiceAdapterContext,
    payload: unknown,
  ): Promise<unknown>;
}

export interface ProviderObserverServiceAdapter {
  begin(
    context: ProviderServiceAdapterContext,
    payload: unknown,
  ): Promise<unknown>;
  complete(
    context: ProviderServiceAdapterContext,
    payload: unknown,
  ): Promise<unknown>;
  /**
   * Re-query observer-owned session/provider state before signing. Returning
   * the supplied validation digest attests that this exact payload was checked.
   */
  validateEvidenceForSigning(input: {
    context: ProviderServiceAdapterContext;
    payload: ProviderObserverEvidencePayload;
    payloadSha256: string;
    completedMaterialSha256: string;
    expectedValidationSha256: string;
  }): Promise<{ validationSha256: string }>;
  /** Re-query cleanup/provider state; never trust the cleanup service result alone. */
  validateCleanupForSigning(input: {
    context: ProviderServiceAdapterContext;
    cleanupResult: ProviderCleanupExecutionResult;
    cleanupResultSha256: string;
    expectedValidationSha256: string;
  }): Promise<{
    validationSha256: string;
    payload: ProviderCleanupProofPayload;
  }>;
}

export interface ProviderSemanticJudgeServiceAdapter {
  evaluate(
    context: ProviderServiceAdapterContext,
    payload: unknown,
  ): Promise<unknown>;
  /** Re-query judge-owned evaluation state before authorizing this signature. */
  validateEvidenceForSigning(input: {
    context: ProviderServiceAdapterContext;
    payload: SemanticJudgeEvidencePayload;
    payloadSha256: string;
    verdictsSha256: string;
    expectedValidationSha256: string;
  }): Promise<{ validationSha256: string }>;
}

export interface ProviderCleanupServiceAdapter {
  executeCleanup(
    context: ProviderServiceAdapterContext,
    payload: unknown,
  ): Promise<ProviderCleanupExecutionResult>;
}

export interface ProviderCleanupExecutionResult {
  schema: typeof PROVIDER_CLEANUP_RESULT_SCHEMA;
  manifestSha256: string;
  runId: string;
  runNonce: string;
  scenarioId: string;
  operationKind: string;
  cleanupScopeSha256: string;
  rawControllerMaterialSha256: string;
  qualificationArtifactSha256?: string;
  completedStagesSha256: string;
  failed: boolean;
  disposition: "cleaned" | "no-resources-created";
  completedAtIso: string;
  cleanupReceiptSha256: string;
}

export interface ProviderSecretBrokerAdapter {
  resolve(input: {
    requestNonce: string;
    requestSha256: string;
    authorizationGrantSha256: string;
    secretRefs: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
}

/** An HSM/KMS adapter: no private signing material crosses this interface. */
export interface ProviderServiceEd25519Signer {
  keyId: string;
  publicKeyPem: string;
  sign(input: {
    purpose: "observer-evidence" | "semantic-judge-evidence" | "cleanup-proof";
    payloadSha256: string;
    bytes: Uint8Array;
  }): Promise<string>;
}

export interface ProviderCanaryServiceHostOptions {
  authorizer: ProviderServiceRoleAuthorizer;
  stateStore: ProviderServiceStateStore;
  controller?: ProviderControllerServiceAdapter;
  observer?: {
    adapter: ProviderObserverServiceAdapter;
    signer: ProviderServiceEd25519Signer;
    endpoint: string;
    organizationId: string;
  };
  semanticJudge?: {
    adapter: ProviderSemanticJudgeServiceAdapter;
    signer: ProviderServiceEd25519Signer;
    endpoint: string;
    organizationId: string;
  };
  cleanup?: ProviderCleanupServiceAdapter;
  secretBroker?: ProviderSecretBrokerAdapter;
  servicePath?: string;
  secretPath?: string;
  maxBodyBytes?: number;
  now?: () => Date;
  audit?: (event: {
    outcome: "accepted" | "refused";
    role?: ProviderServiceRole;
    requestSha256?: string;
    requestId: string;
  }) => void;
}

export interface ProviderCanaryServiceHost {
  handle(request: Request): Promise<Response>;
}

interface ServiceRequest {
  schema: typeof REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA;
  role: string;
  requestNonce: string;
  manifestSha256: string;
  runId: string;
  scenarioId: string;
  operationKind: string;
  payload: unknown;
}

interface RemoteSignRequest {
  schema: typeof REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA;
  role: "observer" | "semantic-judge";
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

class ProviderServiceRefusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 500,
  ) {
    super("provider service request refused");
  }
}

function refuse(status: ProviderServiceRefusal["status"]): never {
  throw new ProviderServiceRefusal(status);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    refuse(400);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  ) {
    refuse(400);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    refuse(400);
  }
}

function boundedString(value: unknown, maximum = 8_192): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    refuse(400);
  }
  return value;
}

function hash(value: unknown): string {
  const candidate = boundedString(value, 64);
  if (!HASH_PATTERN.test(candidate)) refuse(400);
  return candidate;
}

function nonce(value: unknown): string {
  const candidate = boundedString(value, 256);
  if (!NONCE_PATTERN.test(candidate)) refuse(400);
  return candidate;
}

function canonicalIso(value: unknown): { iso: string; milliseconds: number } {
  const iso = boundedString(value, 64);
  const milliseconds = Date.parse(iso);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== iso
  ) {
    refuse(400);
  }
  return { iso, milliseconds };
}

function safePath(value: string): string {
  if (!value.startsWith("/") || value.includes("?") || value.includes("#"))
    refuse(500);
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalJsonValue(value, "providerServiceRequest")))
    .digest("hex");
}

function correlationFromService(
  request: ServiceRequest,
): ProviderServiceCorrelation {
  return Object.freeze({
    manifestSha256: hash(request.manifestSha256),
    runId: boundedString(request.runId, 256),
    scenarioId: boundedString(request.scenarioId, 256),
    operationKind: boundedString(request.operationKind, 256),
  });
}

function parseBearer(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) refuse(401);
  const token = authorization.slice(7);
  if (token.length < 16 || token.length > 8_192 || /[\r\n]/.test(token))
    refuse(401);
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function boundedJson(
  request: Request,
  maximum: number,
): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") refuse(415);
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  ) {
    refuse(413);
  }
  if (!request.body) refuse(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      refuse(413);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // error-policy:J3 external HTTPS input becomes an explicit fixed refusal.
    return refuse(400);
  }
}

function validateGrant(input: {
  grant: ProviderServiceAuthorizationGrant;
  request: ProviderServiceAuthorizationRequest;
  nowMs: number;
}): ProviderServiceAuthorizationGrant {
  const grant = plainRecord(
    canonicalJsonValue(input.grant, "authorizationGrant"),
  ) as unknown as ProviderServiceAuthorizationGrant;
  const allowed = [
    "grantSha256",
    "role",
    "bearerTokenSha256",
    "requestSha256",
    "requestNonce",
    "manifestSha256",
    "runId",
    "scenarioId",
    "operationKind",
    "allowedSecretRefs",
    "notBeforeIso",
    "expiresAtIso",
  ];
  if (Object.keys(grant).some((key) => !allowed.includes(key))) refuse(403);
  const required = [
    "grantSha256",
    "role",
    "bearerTokenSha256",
    "requestSha256",
    "requestNonce",
    "notBeforeIso",
    "expiresAtIso",
  ];
  if (required.some((key) => !Object.hasOwn(grant, key))) refuse(403);
  const notBefore = canonicalIso(grant.notBeforeIso).milliseconds;
  const expires = canonicalIso(grant.expiresAtIso).milliseconds;
  if (
    grant.role !== input.request.role ||
    grant.bearerTokenSha256 !== input.request.bearerTokenSha256 ||
    grant.requestSha256 !== input.request.requestSha256 ||
    grant.requestNonce !== input.request.requestNonce ||
    input.nowMs < notBefore - MAX_CLOCK_SKEW_MS ||
    input.nowMs > expires ||
    expires <= notBefore ||
    expires - notBefore > MAX_REQUEST_TTL_MS
  )
    refuse(403);
  if (input.request.correlation) {
    if (grant.allowedSecretRefs !== undefined) refuse(403);
    for (const key of [
      "manifestSha256",
      "runId",
      "scenarioId",
      "operationKind",
    ] as const) {
      if (grant[key] !== input.request.correlation[key]) refuse(403);
    }
  }
  if (input.request.requestedSecretRefs) {
    if (
      grant.manifestSha256 !== undefined ||
      grant.runId !== undefined ||
      grant.scenarioId !== undefined ||
      grant.operationKind !== undefined
    )
      refuse(403);
    const allowedRefs = grant.allowedSecretRefs;
    if (
      !Array.isArray(allowedRefs) ||
      canonicalJson([...allowedRefs]) !==
        canonicalJson([...input.request.requestedSecretRefs])
    )
      refuse(403);
  }
  const payload = { ...grant } as Record<string, unknown>;
  delete payload.grantSha256;
  if (
    grant.grantSha256 !==
    canonicalSha256(payload as CanonicalJsonValue, "providerServiceGrant")
  )
    refuse(403);
  return Object.freeze({ ...grant });
}

function parseServiceRequest(value: unknown): ServiceRequest {
  const request = plainRecord(value);
  exactKeys(request, [
    "schema",
    "role",
    "requestNonce",
    "manifestSha256",
    "runId",
    "scenarioId",
    "operationKind",
    "payload",
  ]);
  if (request.schema !== REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA) refuse(400);
  const role = boundedString(request.role, 64);
  if (!ROLE_PATTERN.test(role)) refuse(400);
  nonce(request.requestNonce);
  correlationFromService(request as unknown as ServiceRequest);
  canonicalJsonValue(request.payload, "servicePayload");
  return request as unknown as ServiceRequest;
}

function serviceRole(
  value: string,
): Exclude<
  ProviderServiceRole,
  "observer-sign" | "semantic-judge-sign" | "secret-resolve"
> {
  if (
    ![
      "controller-execute",
      "observer-begin",
      "observer-complete",
      "observer-cleanup-sign",
      "semantic-judge-evaluate",
      "cleanup-execute",
    ].includes(value)
  )
    refuse(403);
  return value as Exclude<
    ProviderServiceRole,
    "observer-sign" | "semantic-judge-sign" | "secret-resolve"
  >;
}

function stateCorrelationKey(
  kind: string,
  correlation: ProviderServiceCorrelation,
): string {
  return `${kind}:${canonicalSha256(correlation, "serviceStateCorrelation")}`;
}

function signingCorrelationKey(
  kind: "observer" | "semantic-judge",
  correlation: Pick<
    ProviderServiceCorrelation,
    "manifestSha256" | "runId" | "scenarioId"
  >,
): string {
  return `${kind}-signing-correlation:${canonicalSha256(
    {
      manifestSha256: correlation.manifestSha256,
      runId: correlation.runId,
      scenarioId: correlation.scenarioId,
    },
    "signingCorrelation",
  )}`;
}

function adapterContext(input: {
  correlation: ProviderServiceCorrelation;
  requestNonce: string;
  requestSha256: string;
  grantSha256: string;
}): ProviderServiceAdapterContext {
  return Object.freeze({
    ...input.correlation,
    requestNonce: input.requestNonce,
    requestSha256: input.requestSha256,
    authorizationGrantSha256: input.grantSha256,
  });
}

function success(value: unknown): Response {
  return new Response(
    canonicalJson(canonicalJsonValue(value, "serviceResponse")),
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function refusal(
  status: ProviderServiceRefusal["status"],
  requestId: string,
): Response {
  return new Response(
    canonicalJson({
      schema: PROVIDER_SERVICE_ERROR_SCHEMA,
      error: "request-refused",
      requestId,
    }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function evidenceProjection(
  payload: ProviderObserverEvidencePayload,
): CanonicalJsonValue {
  return canonicalJsonValue(
    {
      observerProvenance: payload.observerProvenance,
      observations: payload.observations,
      connectorBindings: payload.connectorBindings,
      failureProbeObservations: payload.failureProbeObservations,
      stageReferences: payload.stageReferences,
      providerEffectAssurances: payload.providerEffectAssurances,
    },
    "observerEvidenceProjection",
  );
}

function signerSnapshot(
  signer: ProviderServiceEd25519Signer,
): ProviderServiceEd25519Signer {
  if (signer.publicKeyPem.includes("PRIVATE KEY")) refuse(500);
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(signer.publicKeyPem);
  } catch {
    return refuse(500);
  }
  if (
    key.asymmetricKeyType !== "ed25519" ||
    providerObserverKeyId(signer.publicKeyPem) !== hash(signer.keyId)
  )
    refuse(500);
  if (typeof signer.sign !== "function") refuse(500);
  return Object.freeze({
    keyId: signer.keyId,
    publicKeyPem: signer.publicKeyPem,
    sign: signer.sign,
  });
}

async function signAndVerify(input: {
  signer: ProviderServiceEd25519Signer;
  purpose: Parameters<ProviderServiceEd25519Signer["sign"]>[0]["purpose"];
  bytes: Buffer;
}): Promise<string> {
  const payloadSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const signature = await input.signer.sign({
    purpose: input.purpose,
    payloadSha256,
    bytes: input.bytes,
  });
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(signature))
    refuse(500);
  const decoded = Buffer.from(signature, "base64url");
  if (
    decoded.byteLength !== 64 ||
    !verifySignature(
      null,
      input.bytes,
      createPublicKey(input.signer.publicKeyPem),
      decoded,
    )
  )
    refuse(500);
  return signature;
}

function parseRemoteSignRequest(value: unknown): RemoteSignRequest {
  const request = plainRecord(value);
  exactKeys(request, [
    "schema",
    "role",
    "serviceIdentitySha256",
    "keyId",
    "requestNonce",
    "requestedAtIso",
    "expiresAtIso",
    "manifestSha256",
    "runId",
    "runNonce",
    "scenarioId",
    "trajectorySetSha256",
    "payloadSha256",
    "payloadCanonicalBase64url",
  ]);
  if (
    request.schema !== REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA ||
    !["observer", "semantic-judge"].includes(String(request.role))
  )
    refuse(400);
  nonce(request.requestNonce);
  for (const key of [
    "serviceIdentitySha256",
    "keyId",
    "manifestSha256",
    "trajectorySetSha256",
    "payloadSha256",
  ] as const)
    hash(request[key]);
  canonicalIso(request.requestedAtIso);
  canonicalIso(request.expiresAtIso);
  boundedString(request.runId, 256);
  boundedString(request.runNonce, 256);
  boundedString(request.scenarioId, 256);
  boundedString(request.payloadCanonicalBase64url, 3 * 1024 * 1024);
  return request as unknown as RemoteSignRequest;
}

function decodeSignPayload(request: RemoteSignRequest): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(request.payloadCanonicalBase64url)) refuse(400);
  const bytes = Buffer.from(request.payloadCanonicalBase64url, "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STRING_BYTES)
    refuse(413);
  if (
    createHash("sha256").update(bytes).digest("hex") !== request.payloadSha256
  )
    refuse(400);
  try {
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      canonicalJson(canonicalJsonValue(decoded, "signedPayload")) !==
      bytes.toString("utf8")
    )
      refuse(400);
    return decoded;
  } catch (error) {
    // error-policy:J3 signed bytes are untrusted remote input.
    if (error instanceof ProviderServiceRefusal) throw error;
    return refuse(400);
  }
}

function signCorrelation(
  request: RemoteSignRequest,
  payload: ProviderObserverEvidencePayload | SemanticJudgeEvidencePayload,
  operationKind: string,
): ProviderServiceCorrelation {
  if (
    payload.manifestSha256 !== request.manifestSha256 ||
    payload.runId !== request.runId ||
    payload.runNonce !== request.runNonce ||
    payload.scenarioId !== request.scenarioId ||
    payload.trajectorySetSha256 !== request.trajectorySetSha256
  )
    refuse(400);
  return Object.freeze({
    manifestSha256: hash(request.manifestSha256),
    runId: boundedString(request.runId, 256),
    scenarioId: boundedString(request.scenarioId, 256),
    operationKind: boundedString(operationKind, 256),
  });
}

async function authorize(input: {
  options: ProviderCanaryServiceHostOptions;
  role: ProviderServiceRole;
  bearerTokenSha256: string;
  requestSha256: string;
  requestNonce: string;
  correlation?: ProviderServiceCorrelation;
  requestedSecretRefs?: readonly string[];
  nowMs: number;
}): Promise<ProviderServiceAuthorizationGrant> {
  let raw: ProviderServiceAuthorizationGrant;
  try {
    raw = await input.options.authorizer.authorize({
      role: input.role,
      bearerTokenSha256: input.bearerTokenSha256,
      requestSha256: input.requestSha256,
      requestNonce: input.requestNonce,
      ...(input.correlation ? { correlation: input.correlation } : {}),
      ...(input.requestedSecretRefs
        ? { requestedSecretRefs: input.requestedSecretRefs }
        : {}),
      nowIso: new Date(input.nowMs).toISOString(),
    });
  } catch {
    // error-policy:J1 authorization failures are not reflected to callers.
    return refuse(403);
  }
  return validateGrant({
    grant: raw,
    request: {
      role: input.role,
      bearerTokenSha256: input.bearerTokenSha256,
      requestSha256: input.requestSha256,
      requestNonce: input.requestNonce,
      ...(input.correlation ? { correlation: input.correlation } : {}),
      ...(input.requestedSecretRefs
        ? { requestedSecretRefs: input.requestedSecretRefs }
        : {}),
      nowIso: new Date(input.nowMs).toISOString(),
    },
    nowMs: input.nowMs,
  });
}

async function claimReplay(input: {
  store: ProviderServiceStateStore;
  role: ProviderServiceRole;
  grant: ProviderServiceAuthorizationGrant;
  nonce: string;
  requestSha256: string;
}): Promise<void> {
  const claimed = await input.store.claimReplay({
    namespace: `${input.role}:${input.grant.grantSha256}`,
    nonce: input.nonce,
    requestSha256: input.requestSha256,
    expiresAtIso: input.grant.expiresAtIso,
  });
  if (!claimed) refuse(409);
}

function validateCleanupResult(
  value: unknown,
  correlation: ProviderServiceCorrelation,
): ProviderCleanupExecutionResult {
  const result = canonicalJsonValue(
    value,
    "cleanupExecutionResult",
  ) as unknown as ProviderCleanupExecutionResult;
  const record = plainRecord(result);
  const required = [
    "schema",
    "manifestSha256",
    "runId",
    "runNonce",
    "scenarioId",
    "operationKind",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "completedStagesSha256",
    "failed",
    "disposition",
    "completedAtIso",
    "cleanupReceiptSha256",
  ];
  if (
    Object.keys(record).some(
      (key) => ![...required, "qualificationArtifactSha256"].includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    result.schema !== PROVIDER_CLEANUP_RESULT_SCHEMA ||
    result.manifestSha256 !== correlation.manifestSha256 ||
    result.runId !== correlation.runId ||
    result.scenarioId !== correlation.scenarioId ||
    result.operationKind !== correlation.operationKind ||
    typeof result.failed !== "boolean" ||
    !["cleaned", "no-resources-created"].includes(result.disposition)
  )
    refuse(403);
  boundedString(result.runNonce, 256);
  for (const digest of [
    result.cleanupScopeSha256,
    result.rawControllerMaterialSha256,
    result.completedStagesSha256,
    result.cleanupReceiptSha256,
    ...(result.qualificationArtifactSha256
      ? [result.qualificationArtifactSha256]
      : []),
  ])
    hash(digest);
  canonicalIso(result.completedAtIso);
  return Object.freeze({ ...result });
}

function validateCleanupProofForResult(input: {
  value: unknown;
  result: ProviderCleanupExecutionResult;
}): ProviderCleanupProofPayload {
  const snapshot = canonicalJsonValue(
    input.value,
    "cleanupProofPayload",
  ) as unknown as ProviderCleanupProofPayload;
  const record = plainRecord(snapshot);
  const required = [
    "schema",
    "scenarioId",
    "runId",
    "runNonce",
    "manifestSha256",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "disposition",
    "completedAtIso",
  ];
  if (
    Object.keys(record).some(
      (key) => ![...required, "qualificationArtifactSha256"].includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    snapshot.schema !== PROVIDER_CLEANUP_PROOF_SCHEMA ||
    snapshot.manifestSha256 !== input.result.manifestSha256 ||
    snapshot.runId !== input.result.runId ||
    snapshot.runNonce !== input.result.runNonce ||
    snapshot.scenarioId !== input.result.scenarioId ||
    snapshot.cleanupScopeSha256 !== input.result.cleanupScopeSha256 ||
    snapshot.rawControllerMaterialSha256 !==
      input.result.rawControllerMaterialSha256 ||
    snapshot.qualificationArtifactSha256 !==
      input.result.qualificationArtifactSha256 ||
    snapshot.disposition !== input.result.disposition ||
    snapshot.completedAtIso !== input.result.completedAtIso
  )
    refuse(403);
  canonicalIso(snapshot.completedAtIso);
  return Object.freeze({ ...snapshot });
}

async function handleService(input: {
  options: ProviderCanaryServiceHostOptions;
  value: unknown;
  bearerTokenSha256: string;
  nowMs: number;
}): Promise<Response> {
  const request = parseServiceRequest(input.value);
  const role = serviceRole(request.role);
  const correlation = correlationFromService(request);
  const digest = requestHash(input.value);
  const requestNonce = nonce(request.requestNonce);
  const grant = await authorize({
    options: input.options,
    role,
    bearerTokenSha256: input.bearerTokenSha256,
    requestSha256: digest,
    requestNonce,
    correlation,
    nowMs: input.nowMs,
  });
  await claimReplay({
    store: input.options.stateStore,
    role,
    grant,
    nonce: requestNonce,
    requestSha256: digest,
  });
  const context = adapterContext({
    correlation,
    requestNonce,
    requestSha256: digest,
    grantSha256: grant.grantSha256,
  });
  let result: unknown;
  if (role === "controller-execute") {
    if (!input.options.controller) refuse(403);
    result = await input.options.controller.execute(context, request.payload);
  } else if (role === "observer-begin") {
    if (!input.options.observer) refuse(403);
    result = await input.options.observer.adapter.begin(
      context,
      request.payload,
    );
    if (
      !(await input.options.stateStore.putOnce(
        stateCorrelationKey("observer-begin", correlation),
        canonicalJsonValue(result, "observerBeginResult"),
      ))
    )
      refuse(409);
  } else if (role === "observer-complete") {
    if (!input.options.observer) refuse(403);
    const payload = plainRecord(request.payload);
    const session = canonicalJsonValue(
      payload.session,
      "observerCompletionSession",
    );
    const began = await input.options.stateStore.get(
      stateCorrelationKey("observer-begin", correlation),
    );
    if (began === undefined || canonicalJson(began) !== canonicalJson(session))
      refuse(403);
    result = await input.options.observer.adapter.complete(
      context,
      request.payload,
    );
    if (
      !(await input.options.stateStore.putOnce(
        stateCorrelationKey("observer-complete", correlation),
        canonicalJsonValue(result, "observerCompletionResult"),
      ))
    )
      refuse(409);
    if (
      !(await input.options.stateStore.putOnce(
        signingCorrelationKey("observer", correlation),
        canonicalJsonValue(correlation, "observerSigningCorrelation"),
      ))
    )
      refuse(409);
  } else if (role === "semantic-judge-evaluate") {
    if (!input.options.semanticJudge) refuse(403);
    result = await input.options.semanticJudge.adapter.evaluate(
      context,
      request.payload,
    );
    if (
      !(await input.options.stateStore.putOnce(
        stateCorrelationKey("judge-evaluate", correlation),
        canonicalJsonValue(result, "semanticJudgeResult"),
      ))
    )
      refuse(409);
    if (
      !(await input.options.stateStore.putOnce(
        signingCorrelationKey("semantic-judge", correlation),
        canonicalJsonValue(correlation, "judgeSigningCorrelation"),
      ))
    )
      refuse(409);
  } else if (role === "cleanup-execute") {
    if (!input.options.cleanup) refuse(403);
    result = validateCleanupResult(
      await input.options.cleanup.executeCleanup(context, request.payload),
      correlation,
    );
    if (
      !(await input.options.stateStore.putOnce(
        stateCorrelationKey("cleanup-result", correlation),
        canonicalJsonValue(result, "cleanupExecutionResult"),
      ))
    )
      refuse(409);
  } else {
    if (!input.options.observer) refuse(403);
    const requestPayload = plainRecord(request.payload);
    exactKeys(requestPayload, ["cleanupResult"]);
    const cleanupResult = validateCleanupResult(
      requestPayload.cleanupResult,
      correlation,
    );
    const cleanupResultSha256 = canonicalSha256(
      cleanupResult as unknown as CanonicalJsonValue,
      "cleanupExecutionResult",
    );
    const expectedValidationSha256 = canonicalSha256(
      { requestSha256: digest, cleanupResultSha256 },
      "observerCleanupValidation",
    );
    const validation =
      await input.options.observer.adapter.validateCleanupForSigning({
        context,
        cleanupResult,
        cleanupResultSha256,
        expectedValidationSha256,
      });
    if (validation.validationSha256 !== expectedValidationSha256) refuse(403);
    const proof = validateCleanupProofForResult({
      value: validation.payload,
      result: cleanupResult,
    });
    const bytes = Buffer.from(
      canonicalJson(proof as unknown as CanonicalJsonValue),
      "utf8",
    );
    const signer = signerSnapshot(input.options.observer.signer);
    const signature = await signAndVerify({
      signer,
      purpose: "cleanup-proof",
      bytes,
    });
    result = Object.freeze({
      keyId: signer.keyId,
      payload: proof,
      signature,
    } satisfies SignedProviderCleanupProof);
  }
  return success({
    schema: REFERENCE_OPERATOR_SERVICE_RESPONSE_SCHEMA,
    role,
    requestNonce,
    requestSha256: digest,
    result: canonicalJsonValue(result, "serviceResult"),
  });
}

async function handleRemoteSign(input: {
  options: ProviderCanaryServiceHostOptions;
  value: unknown;
  bearerTokenSha256: string;
  nowMs: number;
}): Promise<Response> {
  const request = parseRemoteSignRequest(input.value);
  const payload = decodeSignPayload(request) as
    | ProviderObserverEvidencePayload
    | SemanticJudgeEvidencePayload;
  const role: ProviderServiceRole =
    request.role === "observer" ? "observer-sign" : "semantic-judge-sign";
  if (
    (request.role === "observer" &&
      payload.schema !== PROVIDER_OBSERVER_EVIDENCE_SCHEMA) ||
    (request.role === "semantic-judge" &&
      payload.schema !== SEMANTIC_JUDGE_EVIDENCE_SCHEMA)
  )
    refuse(400);
  const savedCorrelation = await input.options.stateStore.get(
    signingCorrelationKey(
      request.role === "observer" ? "observer" : "semantic-judge",
      request,
    ),
  );
  if (savedCorrelation === undefined) refuse(403);
  const saved = plainRecord(savedCorrelation);
  exactKeys(saved, ["manifestSha256", "runId", "scenarioId", "operationKind"]);
  const correlation = signCorrelation(
    request,
    payload,
    boundedString(saved.operationKind, 256),
  );
  if (
    canonicalJson(savedCorrelation) !==
    canonicalJson(canonicalJsonValue(correlation, "signingCorrelation"))
  )
    refuse(403);
  const digest = requestHash(input.value);
  const requestedAt = canonicalIso(request.requestedAtIso).milliseconds;
  const expiresAt = canonicalIso(request.expiresAtIso).milliseconds;
  if (
    requestedAt > input.nowMs + MAX_CLOCK_SKEW_MS ||
    expiresAt <= requestedAt ||
    expiresAt - requestedAt > MAX_REQUEST_TTL_MS ||
    input.nowMs > expiresAt
  )
    refuse(403);
  const grant = await authorize({
    options: input.options,
    role,
    bearerTokenSha256: input.bearerTokenSha256,
    requestSha256: digest,
    requestNonce: request.requestNonce,
    correlation,
    nowMs: input.nowMs,
  });
  await claimReplay({
    store: input.options.stateStore,
    role,
    grant,
    nonce: request.requestNonce,
    requestSha256: digest,
  });
  const context = adapterContext({
    correlation,
    requestNonce: request.requestNonce,
    requestSha256: digest,
    grantSha256: grant.grantSha256,
  });
  let envelope: SignedProviderObserverEvidence | SignedSemanticJudgeEvidence;
  let signer: ProviderServiceEd25519Signer;
  if (role === "observer-sign") {
    if (!input.options.observer) refuse(403);
    signer = signerSnapshot(input.options.observer.signer);
    if (request.keyId !== signer.keyId) refuse(403);
    const identity = remoteEvidenceSignerIdentitySha256({
      role: "observer",
      endpoint: input.options.observer.endpoint,
      organizationId: input.options.observer.organizationId,
      keyId: signer.keyId,
    });
    if (request.serviceIdentitySha256 !== identity) refuse(403);
    const material = await input.options.stateStore.get(
      stateCorrelationKey("observer-complete", correlation),
    );
    if (
      material === undefined ||
      canonicalJson(material) !==
        canonicalJson(
          evidenceProjection(payload as ProviderObserverEvidencePayload),
        )
    )
      refuse(403);
    const completedMaterialSha256 = canonicalSha256(
      material,
      "completedObserverMaterial",
    );
    const expectedValidationSha256 = canonicalSha256(
      {
        requestSha256: digest,
        payloadSha256: request.payloadSha256,
        completedMaterialSha256,
      },
      "observerSigningValidation",
    );
    const validation =
      await input.options.observer.adapter.validateEvidenceForSigning({
        context,
        payload: payload as ProviderObserverEvidencePayload,
        payloadSha256: request.payloadSha256,
        completedMaterialSha256,
        expectedValidationSha256,
      });
    if (validation.validationSha256 !== expectedValidationSha256) refuse(403);
    const bytes = providerEvidenceSigningBytes(
      payload as ProviderObserverEvidencePayload,
    );
    const signature = await signAndVerify({
      signer,
      purpose: "observer-evidence",
      bytes,
    });
    envelope = {
      keyId: signer.keyId,
      payload: payload as ProviderObserverEvidencePayload,
      signature,
    };
  } else {
    if (!input.options.semanticJudge) refuse(403);
    signer = signerSnapshot(input.options.semanticJudge.signer);
    if (request.keyId !== signer.keyId) refuse(403);
    const identity = remoteEvidenceSignerIdentitySha256({
      role: "semantic-judge",
      endpoint: input.options.semanticJudge.endpoint,
      organizationId: input.options.semanticJudge.organizationId,
      keyId: signer.keyId,
    });
    if (request.serviceIdentitySha256 !== identity) refuse(403);
    const verdicts = await input.options.stateStore.get(
      stateCorrelationKey("judge-evaluate", correlation),
    );
    if (
      verdicts === undefined ||
      canonicalJson(verdicts) !==
        canonicalJson(
          canonicalJsonValue(
            (payload as SemanticJudgeEvidencePayload).verdicts,
            "semanticVerdicts",
          ),
        )
    )
      refuse(403);
    const verdictsSha256 = canonicalSha256(verdicts, "semanticVerdicts");
    const expectedValidationSha256 = canonicalSha256(
      {
        requestSha256: digest,
        payloadSha256: request.payloadSha256,
        verdictsSha256,
      },
      "judgeSigningValidation",
    );
    const validation =
      await input.options.semanticJudge.adapter.validateEvidenceForSigning({
        context,
        payload: payload as SemanticJudgeEvidencePayload,
        payloadSha256: request.payloadSha256,
        verdictsSha256,
        expectedValidationSha256,
      });
    if (validation.validationSha256 !== expectedValidationSha256) refuse(403);
    const bytes = semanticEvidenceSigningBytes(
      payload as SemanticJudgeEvidencePayload,
    );
    const signature = await signAndVerify({
      signer,
      purpose: "semantic-judge-evidence",
      bytes,
    });
    envelope = {
      keyId: signer.keyId,
      payload: payload as SemanticJudgeEvidencePayload,
      signature,
    };
  }
  const signature = envelope.signature;
  return success({
    schema: REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA,
    role: request.role,
    serviceIdentitySha256: request.serviceIdentitySha256,
    requestNonce: request.requestNonce,
    requestSha256: digest,
    payloadSha256: request.payloadSha256,
    respondedAtIso: new Date(input.nowMs).toISOString(),
    keyId: signer.keyId,
    signature,
    signedEnvelope: envelope,
  });
}

async function handleSecret(input: {
  options: ProviderCanaryServiceHostOptions;
  value: unknown;
  bearerTokenSha256: string;
  nowMs: number;
}): Promise<Response> {
  if (!input.options.secretBroker) refuse(403);
  const request = plainRecord(input.value);
  exactKeys(request, ["schema", "requestNonce", "secretRefs"]);
  if (request.schema !== REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA) refuse(400);
  const requestNonce = nonce(request.requestNonce);
  if (
    !Array.isArray(request.secretRefs) ||
    request.secretRefs.length === 0 ||
    request.secretRefs.length > 64
  )
    refuse(400);
  const secretRefs = request.secretRefs.map((value) =>
    boundedString(value, 256),
  );
  if (
    new Set(secretRefs).size !== secretRefs.length ||
    canonicalJson(secretRefs) !== canonicalJson([...secretRefs].sort())
  )
    refuse(400);
  const digest = requestHash(input.value);
  const grant = await authorize({
    options: input.options,
    role: "secret-resolve",
    bearerTokenSha256: input.bearerTokenSha256,
    requestSha256: digest,
    requestNonce,
    requestedSecretRefs: secretRefs,
    nowMs: input.nowMs,
  });
  await claimReplay({
    store: input.options.stateStore,
    role: "secret-resolve",
    grant,
    nonce: requestNonce,
    requestSha256: digest,
  });
  const values = plainRecord(
    await input.options.secretBroker.resolve({
      requestNonce,
      requestSha256: digest,
      authorizationGrantSha256: grant.grantSha256,
      secretRefs,
    }),
  );
  exactKeys(values, secretRefs);
  for (const ref of secretRefs) {
    const value = boundedString(values[ref], 64 * 1024);
    if (value.includes("PRIVATE KEY")) refuse(500);
  }
  return success({
    schema: REFERENCE_OPERATOR_SECRET_RESPONSE_SCHEMA,
    requestNonce,
    values,
  });
}

/** Create a Fetch-compatible handler suitable for a TLS terminator or Node HTTPS. */
export function createProviderCanaryServiceHost(
  options: ProviderCanaryServiceHostOptions,
): ProviderCanaryServiceHost {
  const servicePath = safePath(
    options.servicePath ?? DEFAULT_PROVIDER_SERVICE_PATH,
  );
  const secretPath = safePath(
    options.secretPath ?? DEFAULT_PROVIDER_SECRET_PATH,
  );
  if (servicePath === secretPath) refuse(500);
  const maximum = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BODY_BYTES)
    refuse(500);
  const observerSigner = options.observer
    ? signerSnapshot(options.observer.signer)
    : undefined;
  const judgeSigner = options.semanticJudge
    ? signerSnapshot(options.semanticJudge.signer)
    : undefined;
  if (
    observerSigner &&
    judgeSigner &&
    observerSigner.keyId === judgeSigner.keyId
  )
    refuse(500);
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      const requestId = randomBytes(16).toString("base64url");
      let role: ProviderServiceRole | undefined;
      let digest: string | undefined;
      try {
        const url = new URL(request.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          refuse(404);
        if (request.method !== "POST") refuse(405);
        if (url.pathname !== servicePath && url.pathname !== secretPath)
          refuse(404);
        const bearerTokenSha256 = parseBearer(request);
        const value = await boundedJson(request, maximum);
        digest = requestHash(value);
        const nowMs = (options.now ?? (() => new Date()))().getTime();
        if (!Number.isFinite(nowMs)) refuse(500);
        let response: Response;
        if (url.pathname === secretPath) {
          role = "secret-resolve";
          response = await handleSecret({
            options,
            value,
            bearerTokenSha256,
            nowMs,
          });
        } else {
          const schema = plainRecord(value).schema;
          if (schema === REMOTE_EVIDENCE_SIGN_REQUEST_SCHEMA) {
            const rawRole = plainRecord(value).role;
            role =
              rawRole === "observer" ? "observer-sign" : "semantic-judge-sign";
            response = await handleRemoteSign({
              options,
              value,
              bearerTokenSha256,
              nowMs,
            });
          } else {
            role = serviceRole(String(plainRecord(value).role));
            response = await handleService({
              options,
              value,
              bearerTokenSha256,
              nowMs,
            });
          }
        }
        options.audit?.({
          outcome: "accepted",
          role,
          requestSha256: digest,
          requestId,
        });
        return response;
      } catch (error) {
        // error-policy:J1 the HTTPS boundary never reflects secrets or adapter errors.
        const status =
          error instanceof ProviderServiceRefusal ? error.status : 500;
        options.audit?.({
          outcome: "refused",
          ...(role ? { role } : {}),
          ...(digest ? { requestSha256: digest } : {}),
          requestId,
        });
        return refusal(status, requestId);
      }
    },
  });
}

/**
 * Adapt the Fetch-compatible host to Node's TLS server. TLS key material stays
 * in the deployment process and is never exposed to the canary runner.
 */
export function createProviderCanaryHttpsServer(input: {
  host: ProviderCanaryServiceHost;
  tls: ServerOptions;
  maxBodyBytes?: number;
}): Server {
  const maximum = input.maxBodyBytes ?? MAX_BODY_BYTES;
  return createServer(input.tls, async (request, response) => {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > maximum) {
          response.writeHead(413, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(
            canonicalJson({
              schema: PROVIDER_SERVICE_ERROR_SCHEMA,
              error: "request-refused",
              requestId: randomBytes(16).toString("base64url"),
            }),
          );
          return;
        }
        chunks.push(bytes);
      }
      const authority = request.headers.host;
      if (!authority) refuse(400);
      const body = Buffer.concat(chunks);
      const webRequest = new Request(
        `https://${authority}${request.url ?? "/"}`,
        {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([key, value]) =>
              value === undefined
                ? []
                : [[key, Array.isArray(value) ? value.join(",") : value]],
            ),
          ),
          ...(body.byteLength > 0 ? { body } : {}),
        },
      );
      const webResponse = await input.host.handle(webRequest);
      response.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries()),
      );
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      // error-policy:J1 Node transport failures receive one fixed response.
      if (!response.headersSent)
        response.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      response.end(
        canonicalJson({
          schema: PROVIDER_SERVICE_ERROR_SCHEMA,
          error: "request-refused",
          requestId: randomBytes(16).toString("base64url"),
        }),
      );
    }
  });
}

/** Create a canonical, self-hashed least-privilege authorization grant. */
export function createProviderServiceAuthorizationGrant(
  input: Omit<ProviderServiceAuthorizationGrant, "grantSha256">,
): ProviderServiceAuthorizationGrant {
  const snapshot = canonicalJsonValue(
    input,
    "providerServiceGrant",
  ) as unknown as Omit<ProviderServiceAuthorizationGrant, "grantSha256">;
  return Object.freeze({
    ...snapshot,
    grantSha256: canonicalSha256(
      snapshot as unknown as CanonicalJsonValue,
      "providerServiceGrant",
    ),
  });
}

/**
 * Exact hash-only authorization policy for deployments that do not need an
 * external policy engine. Raw bearer values are deliberately not accepted.
 */
export function createStaticProviderServiceRoleAuthorizer(
  entries: readonly StaticProviderServiceAuthorization[],
): ProviderServiceRoleAuthorizer {
  if (entries.length === 0 || entries.length > 512) refuse(500);
  const snapshot = entries.map((entry) => {
    const bearerTokenSha256 = hash(entry.bearerTokenSha256);
    const policy = canonicalJsonValue(
      entry.policy,
      "staticAuthorizationPolicy",
    ) as unknown as StaticProviderServiceAuthorization["policy"];
    return Object.freeze({ bearerTokenSha256, policy });
  });
  return Object.freeze({
    async authorize(request: ProviderServiceAuthorizationRequest) {
      const match = snapshot.find((entry) => {
        if (
          entry.bearerTokenSha256 !== request.bearerTokenSha256 ||
          entry.policy.role !== request.role
        )
          return false;
        if (request.correlation) {
          return (
            entry.policy.manifestSha256 ===
              request.correlation.manifestSha256 &&
            entry.policy.runId === request.correlation.runId &&
            entry.policy.scenarioId === request.correlation.scenarioId &&
            entry.policy.operationKind === request.correlation.operationKind
          );
        }
        return (
          request.requestedSecretRefs !== undefined &&
          entry.policy.allowedSecretRefs !== undefined &&
          canonicalJson([...entry.policy.allowedSecretRefs]) ===
            canonicalJson([...request.requestedSecretRefs])
        );
      });
      if (!match) throw new Error("authorization refused");
      return createProviderServiceAuthorizationGrant({
        ...match.policy,
        bearerTokenSha256: request.bearerTokenSha256,
        requestSha256: request.requestSha256,
        requestNonce: request.requestNonce,
      });
    },
  });
}

/**
 * Protected-filesystem replay/state journal for a single service deployment.
 * It uses exclusive creates, refuses links and permissive directories, and
 * intentionally retains claims rather than reopening a replay window.
 */
export function createFileProviderServiceStateStore(
  stateDirectory: string,
): ProviderServiceStateStore {
  if (!path.isAbsolute(stateDirectory)) refuse(500);
  const rootStats = lstatSync(stateDirectory);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    (rootStats.mode & 0o077) !== 0
  )
    refuse(500);
  if (
    typeof process.getuid === "function" &&
    rootStats.uid !== process.getuid()
  )
    refuse(500);
  const namespace = path.join(stateDirectory, "provider-service-v1");
  try {
    mkdirSync(namespace, { mode: 0o700 });
  } catch (error) {
    // error-policy:J1 an existing protected state namespace is accepted below.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(namespace);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  )
    refuse(500);
  const filename = (kind: string, key: string) =>
    path.join(
      namespace,
      `${kind}-${createHash("sha256").update(key).digest("hex")}.json`,
    );
  const putExclusive = (file: string, value: CanonicalJsonValue): boolean => {
    let descriptor: number;
    try {
      descriptor = openSync(
        file,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeFileSync(descriptor, `${canonicalJson(value)}\n`, "utf8");
      fsyncSync(descriptor);
      const written = fstatSync(descriptor);
      if (!written.isFile() || (written.mode & 0o077) !== 0) refuse(500);
    } finally {
      closeSync(descriptor);
    }
    const directoryDescriptor = openSync(
      namespace,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return true;
  };
  const store: ProviderServiceStateStore = {
    async claimReplay(input) {
      return putExclusive(
        filename("replay", `${input.namespace}:${input.nonce}`),
        canonicalJsonValue(input, "replayClaim"),
      );
    },
    async putOnce(key, value) {
      return putExclusive(
        filename("state", key),
        canonicalJsonValue(value, "serviceState"),
      );
    },
    async get(key) {
      const file = filename("state", key);
      let descriptor: number;
      try {
        descriptor = openSync(
          file,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      try {
        const stats = fstatSync(descriptor);
        if (
          !stats.isFile() ||
          (stats.mode & 0o077) !== 0 ||
          stats.size > MAX_BODY_BYTES
        )
          refuse(500);
        return canonicalJsonValue(
          JSON.parse(readFileSync(descriptor, "utf8")),
          "storedServiceState",
        );
      } finally {
        closeSync(descriptor);
      }
    },
  };
  return Object.freeze(store);
}

/** Test-only state store; production deployments should use a durable atomic store. */
export function createInMemoryProviderServiceStateStore(): ProviderServiceStateStore {
  const replay = new Set<string>();
  const values = new Map<string, CanonicalJsonValue>();
  const store: ProviderServiceStateStore = {
    async claimReplay(input) {
      const key = `${input.namespace}:${input.nonce}`;
      if (replay.has(key)) return false;
      replay.add(key);
      return true;
    },
    async putOnce(key, value) {
      if (values.has(key)) return false;
      values.set(key, canonicalJsonValue(value, "memoryState"));
      return true;
    },
    async get(key) {
      return values.get(key);
    },
  };
  return Object.freeze(store);
}
