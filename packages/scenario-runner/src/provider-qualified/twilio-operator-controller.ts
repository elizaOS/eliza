/**
 * Defines the fail-closed operator boundary for Twilio SMS and voice canaries.
 * It binds private routing and consent material to an authorized manifest,
 * verifies provider-signed ingress, and collects read-only Twilio REST receipts
 * without creating a provider effect or claiming qualification.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type { ProviderOperationKind } from "./operation-binding.ts";
import {
  type AuthorizedProviderCanaryExecutionPreflight,
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";

export const TWILIO_OPERATOR_PLAN_SCHEMA =
  "eliza.twilio-provider-canary-operator-plan.v1" as const;

const TWILIO_API_ORIGIN = "https://api.twilio.com";
const ACCOUNT_SID_PATTERN = /^AC[a-fA-F0-9]{32}$/;
const MESSAGE_SID_PATTERN = /^SM[a-fA-F0-9]{32}$/;
const CALL_SID_PATTERN = /^CA[a-fA-F0-9]{32}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INGRESS_BYTES = 256 * 1024;
const validatedPreflights = new WeakSet<object>();

export type TwilioCanaryChannel = "sms" | "voice";

export type TwilioOperatorBlockerCode =
  | "authenticated-deployed-ingress-unavailable"
  | "deployed-trajectory-export-unavailable"
  | "authenticated-event-replay-unavailable"
  | "independent-failure-probe-executor-unavailable";

export interface TwilioOperatorBlocker {
  code: TwilioOperatorBlockerCode;
  detail: string;
}

export interface TwilioOperatorPlan {
  schema: typeof TWILIO_OPERATOR_PLAN_SCHEMA;
  twilioApiOrigin: typeof TWILIO_API_ORIGIN;
  channel: TwilioCanaryChannel;
  accountSid: string;
  runNonce: string;
  fromE164: string;
  toE164: string;
  expectedPayload: string;
  idempotencyKey: string;
  confirmationIngressUrl: string;
  exactConfirmationBody: string;
  consent: {
    sourceNumberOperatorOwned: true;
    targetOwnerConsented: true;
    consentEvidenceRefSha256: string;
    voiceRecordingEnabled: false;
  };
  deploymentEvidence: {
    authenticatedIngressEndpoint: null;
    trajectoryExportEndpoint: null;
    authenticatedReplayExecutor: null;
    independentFailureProbeExecutor: null;
    providerStatusReadback: "twilio-rest-v2010";
  };
}

export interface TwilioOperatorPreflight {
  status: "twilio-operator-inputs-validated";
  scenarioId:
    | "provider.twilio-sms.confirmed-send"
    | "provider.twilio-voice.confirmed-call";
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: TwilioOperatorPlan;
  blockers: readonly TwilioOperatorBlocker[];
}

export interface TwilioAuthenticatedIngressReceipt {
  schema: "eliza.twilio-provider-canary-authenticated-ingress.v1";
  receivedAtIso: string;
  requestUrl: string;
  accountSid: string;
  messageSid: string;
  fromE164: string;
  toE164: string;
  bodySha256: string;
  rawFormSha256: string;
  signatureValidated: true;
  qualificationClaimed: false;
}

export interface TwilioRawStatusReceipt {
  schema: "eliza.twilio-provider-canary-raw-status.v1";
  collectedAtIso: string;
  channel: TwilioCanaryChannel;
  resourceSid: string;
  accountSid: string;
  fromE164: string;
  toE164: string;
  direction: "outbound-api";
  status: string;
  payloadSha256: string | null;
  rawResponseSha256: string;
  qualificationClaimed: false;
}

export type TwilioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(message: string): never {
  throw new Error(`twilio provider-canary operator ${message}`);
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

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function matching(
  value: unknown,
  path: string,
  pattern: RegExp,
  description: string,
): string {
  const candidate = requiredString(value, path);
  if (!pattern.test(candidate)) fail(`${path} must be ${description}`);
  return candidate;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedConfirmationBody(input: {
  channel: TwilioCanaryChannel;
  runNonce: string;
  fromE164: string;
  toE164: string;
  payload: string;
  idempotencyKey: string;
}): string {
  return `Confirm Twilio ${input.channel} canary ${input.runNonce}: from ${input.fromE164} to ${input.toE164}; payload-sha256 ${sha256(input.payload)}; idempotency-key ${input.idempotencyKey}`;
}

function parseHttpsUrl(value: unknown, path: string): string {
  const raw = requiredString(value, path);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J3 reject malformed operator input before any network access.
    throw new Error(`twilio provider-canary operator ${path} must be a URL`, {
      cause: error,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    fail(`${path} must be an HTTPS URL without credentials or a fragment`);
  }
  return url.toString();
}

function parsePlan(value: unknown): TwilioOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "twilioApiOrigin",
    "channel",
    "accountSid",
    "runNonce",
    "fromE164",
    "toE164",
    "expectedPayload",
    "idempotencyKey",
    "confirmationIngressUrl",
    "exactConfirmationBody",
    "consent",
    "deploymentEvidence",
  ]);
  if (plan.schema !== TWILIO_OPERATOR_PLAN_SCHEMA) {
    fail("plan.schema is unsupported");
  }
  if (plan.twilioApiOrigin !== TWILIO_API_ORIGIN) {
    fail(`plan.twilioApiOrigin must be ${TWILIO_API_ORIGIN}`);
  }
  if (plan.channel !== "sms" && plan.channel !== "voice") {
    fail('plan.channel must equal "sms" or "voice"');
  }
  const consent = record(plan.consent, "plan.consent");
  exactKeys(consent, "plan.consent", [
    "sourceNumberOperatorOwned",
    "targetOwnerConsented",
    "consentEvidenceRefSha256",
    "voiceRecordingEnabled",
  ]);
  if (
    consent.sourceNumberOperatorOwned !== true ||
    consent.targetOwnerConsented !== true
  ) {
    fail(
      "plan consent must attest operator ownership and target-owner consent",
    );
  }
  if (consent.voiceRecordingEnabled !== false) {
    fail("plan.consent.voiceRecordingEnabled must be false");
  }
  const deploymentEvidence = record(
    plan.deploymentEvidence,
    "plan.deploymentEvidence",
  );
  exactKeys(deploymentEvidence, "plan.deploymentEvidence", [
    "authenticatedIngressEndpoint",
    "trajectoryExportEndpoint",
    "authenticatedReplayExecutor",
    "independentFailureProbeExecutor",
    "providerStatusReadback",
  ]);
  for (const key of [
    "authenticatedIngressEndpoint",
    "trajectoryExportEndpoint",
    "authenticatedReplayExecutor",
    "independentFailureProbeExecutor",
  ] as const) {
    if (deploymentEvidence[key] !== null) {
      fail(
        `plan.deploymentEvidence.${key} must remain null until a repository-supported authenticated contract exists`,
      );
    }
  }
  if (deploymentEvidence.providerStatusReadback !== "twilio-rest-v2010") {
    fail(
      'plan.deploymentEvidence.providerStatusReadback must equal "twilio-rest-v2010"',
    );
  }
  const runNonce = matching(
    plan.runNonce,
    "plan.runNonce",
    NONCE_PATTERN,
    "32-128 unpadded base64url characters",
  );
  const fromE164 = matching(
    plan.fromE164,
    "plan.fromE164",
    E164_PATTERN,
    "an E.164 number",
  );
  const toE164 = matching(
    plan.toE164,
    "plan.toE164",
    E164_PATTERN,
    "an E.164 number",
  );
  if (fromE164 === toE164) fail("plan source and target numbers must differ");
  const expectedPayload = requiredString(
    plan.expectedPayload,
    "plan.expectedPayload",
  );
  const idempotencyKey = requiredString(
    plan.idempotencyKey,
    "plan.idempotencyKey",
  );
  const exactConfirmation = expectedConfirmationBody({
    channel: plan.channel,
    runNonce,
    fromE164,
    toE164,
    payload: expectedPayload,
    idempotencyKey,
  });
  if (plan.exactConfirmationBody !== exactConfirmation) {
    fail(
      "plan.exactConfirmationBody does not match the canonical confirmation",
    );
  }
  return Object.freeze({
    schema: TWILIO_OPERATOR_PLAN_SCHEMA,
    twilioApiOrigin: TWILIO_API_ORIGIN,
    channel: plan.channel,
    accountSid: matching(
      plan.accountSid,
      "plan.accountSid",
      ACCOUNT_SID_PATTERN,
      "a Twilio Account SID",
    ),
    runNonce,
    fromE164,
    toE164,
    expectedPayload,
    idempotencyKey,
    confirmationIngressUrl: parseHttpsUrl(
      plan.confirmationIngressUrl,
      "plan.confirmationIngressUrl",
    ),
    exactConfirmationBody: exactConfirmation,
    consent: Object.freeze({
      sourceNumberOperatorOwned: true,
      targetOwnerConsented: true,
      consentEvidenceRefSha256: matching(
        consent.consentEvidenceRefSha256,
        "plan.consent.consentEvidenceRefSha256",
        SHA256_PATTERN,
        "a lowercase SHA-256 digest",
      ),
      voiceRecordingEnabled: false,
    }),
    deploymentEvidence: Object.freeze({
      authenticatedIngressEndpoint: null,
      trajectoryExportEndpoint: null,
      authenticatedReplayExecutor: null,
      independentFailureProbeExecutor: null,
      providerStatusReadback: "twilio-rest-v2010",
    }),
  });
}

const BLOCKERS = Object.freeze([
  Object.freeze({
    code: "authenticated-deployed-ingress-unavailable",
    detail:
      "No repository-supported deployed endpoint accepts the exact Twilio-signed confirmation while returning a correlation handle for this isolated run.",
  }),
  Object.freeze({
    code: "deployed-trajectory-export-unavailable",
    detail:
      "No authenticated deployed-agent API exports the canonical isolated trajectory set for this Twilio ingress.",
  }),
  Object.freeze({
    code: "authenticated-event-replay-unavailable",
    detail:
      "No supported operator API replays the exact authenticated Twilio event and proves that the second delivery creates no second billable effect.",
  }),
  Object.freeze({
    code: "independent-failure-probe-executor-unavailable",
    detail:
      "No independent executor collects both manifest-bound denial/rejection probes and before/after Twilio snapshots.",
  }),
] as const satisfies readonly TwilioOperatorBlocker[]);

function scenarioContract(scenarioId: string): {
  scenarioId: TwilioOperatorPreflight["scenarioId"];
  channel: TwilioCanaryChannel;
  operationKind: ProviderOperationKind;
  capability: string;
} {
  if (scenarioId === "provider.twilio-sms.confirmed-send") {
    return {
      scenarioId,
      channel: "sms",
      operationKind: "twilio.sms-send",
      capability: "sms-send",
    };
  }
  if (scenarioId === "provider.twilio-voice.confirmed-call") {
    return {
      scenarioId,
      channel: "voice",
      operationKind: "twilio.call-create",
      capability: "call-create",
    };
  }
  fail("scenario must be a provider-qualified Twilio SMS or voice canary");
}

/** Validate all authorization, routing, consent, and confirmation inputs offline. */
export function preflightTwilioOperatorCanary(input: {
  scenario: ScenarioDefinition;
  authorization: unknown;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  providerTarget: unknown;
  operationInput: unknown;
  failureProbes: readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  plan: unknown;
}): TwilioOperatorPreflight {
  const contract = scenarioContract(input.scenario.id);
  const plan = parsePlan(input.plan);
  if (plan.channel !== contract.channel) {
    fail("plan channel does not match the scenario");
  }
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: contract.operationKind,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
    failureProbes: input.failureProbes,
  });
  const target = record(input.providerTarget, "providerTarget");
  const operation = record(input.operationInput, "operationInput");
  if (target.fromE164 !== plan.fromE164 || target.toE164 !== plan.toE164) {
    fail("plan E.164 routing does not match the signed raw provider target");
  }
  const payloadField = contract.channel === "sms" ? "body" : "message";
  if (
    operation[payloadField] !== plan.expectedPayload ||
    operation.idempotencyKey !== plan.idempotencyKey
  ) {
    fail("plan payload or idempotency key does not match the signed operation");
  }
  if (execution.authorization.manifest.run.nonce !== plan.runNonce) {
    fail("plan run nonce does not match the signed manifest");
  }
  const manifest = execution.authorization.manifest;
  const consentCapability = manifest.capabilities.find(
    (capability) =>
      capability.provider === "twilio" &&
      capability.capability === contract.capability,
  );
  if (
    !consentCapability ||
    consentCapability.authorizationGrantSha256 !==
      plan.consent.consentEvidenceRefSha256
  ) {
    fail("plan consent evidence is not bound to the signed Twilio capability");
  }
  const result = Object.freeze({
    status: "twilio-operator-inputs-validated",
    scenarioId: contract.scenarioId,
    authorization: execution.authorization,
    execution,
    plan,
    blockers: BLOCKERS,
  });
  validatedPreflights.add(result);
  return result;
}

/** Refuse effect execution until every deployed evidence capability exists. */
export function assertTwilioOperatorCanaryExecutable(
  preflight: TwilioOperatorPreflight,
): never {
  if (!validatedPreflights.has(preflight)) {
    fail("execution requires the exact validated Twilio preflight result");
  }
  fail(
    `execution refused; unresolved blockers: ${preflight.blockers
      .map((blocker) => blocker.code)
      .join(", ")}`,
  );
}

function requireValidatedPreflight(preflight: TwilioOperatorPreflight): void {
  if (!validatedPreflights.has(preflight)) {
    fail(
      "receipt collection requires the exact validated Twilio preflight result",
    );
  }
}

function signaturePayload(requestUrl: string, params: URLSearchParams): string {
  const seen = new Set<string>();
  const entries = [...params.entries()];
  for (const [key] of entries) {
    if (seen.has(key)) {
      fail(`Twilio ingress form duplicates parameter ${key}`);
    }
    seen.add(key);
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${requestUrl}${entries.map(([key, value]) => `${key}${value}`).join("")}`;
}

function validTwilioSignature(input: {
  authToken: string;
  requestUrl: string;
  params: URLSearchParams;
  signature: string;
}): boolean {
  const expected = createHmac("sha1", input.authToken)
    .update(signaturePayload(input.requestUrl, input.params))
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(input.signature, "base64");
  } catch {
    // error-policy:J3 malformed signatures are explicit invalid input.
    return false;
  }
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

/**
 * Verify a raw form-encoded Twilio confirmation webhook against its public URL
 * and primary Auth Token. The returned receipt remains unsigned source data.
 */
export function collectTwilioAuthenticatedIngress(input: {
  preflight: TwilioOperatorPreflight;
  accountSid: string;
  authToken: string;
  requestUrl: string;
  rawFormBody: string;
  twilioSignature: string;
  receivedAt?: Date;
}): TwilioAuthenticatedIngressReceipt {
  requireValidatedPreflight(input.preflight);
  if (input.accountSid !== input.preflight.plan.accountSid) {
    fail("ingress account SID does not match the validated plan");
  }
  if (input.authToken.length < 20)
    fail("Twilio Auth Token is missing or invalid");
  const requestUrl = parseHttpsUrl(input.requestUrl, "requestUrl");
  if (requestUrl !== input.preflight.plan.confirmationIngressUrl) {
    fail("ingress URL does not match the exact validated public callback URL");
  }
  if (Buffer.byteLength(input.rawFormBody) > MAX_INGRESS_BYTES) {
    fail("Twilio ingress form exceeds the byte limit");
  }
  const params = new URLSearchParams(input.rawFormBody);
  if (
    !validTwilioSignature({
      authToken: input.authToken,
      requestUrl,
      params,
      signature: input.twilioSignature,
    })
  ) {
    fail("Twilio ingress signature is invalid");
  }
  const accountSid = matching(
    params.get("AccountSid"),
    "ingress.AccountSid",
    ACCOUNT_SID_PATTERN,
    "a Twilio Account SID",
  );
  const messageSid = matching(
    params.get("MessageSid"),
    "ingress.MessageSid",
    MESSAGE_SID_PATTERN,
    "a Twilio Message SID",
  );
  const fromE164 = matching(
    params.get("From"),
    "ingress.From",
    E164_PATTERN,
    "an E.164 number",
  );
  const toE164 = matching(
    params.get("To"),
    "ingress.To",
    E164_PATTERN,
    "an E.164 number",
  );
  const body = requiredString(params.get("Body"), "ingress.Body");
  if (
    accountSid !== input.preflight.plan.accountSid ||
    fromE164 !== input.preflight.plan.toE164 ||
    toE164 !== input.preflight.plan.fromE164 ||
    body !== input.preflight.plan.exactConfirmationBody
  ) {
    fail(
      "Twilio ingress does not match the exact account, reverse route, and confirmation",
    );
  }
  return Object.freeze({
    schema: "eliza.twilio-provider-canary-authenticated-ingress.v1",
    receivedAtIso: (input.receivedAt ?? new Date()).toISOString(),
    requestUrl,
    accountSid,
    messageSid,
    fromE164,
    toE164,
    bodySha256: sha256(body),
    rawFormSha256: sha256(input.rawFormBody),
    signatureValidated: true,
    qualificationClaimed: false,
  });
}

async function readTwilioJson(input: {
  preflight: TwilioOperatorPreflight;
  resourceSid: string;
  authToken: string;
  fetchImpl: TwilioFetch;
}): Promise<{ value: Record<string, unknown>; rawResponseSha256: string }> {
  requireValidatedPreflight(input.preflight);
  if (input.authToken.length < 20)
    fail("Twilio Auth Token is missing or invalid");
  const sidPattern =
    input.preflight.plan.channel === "sms"
      ? MESSAGE_SID_PATTERN
      : CALL_SID_PATTERN;
  const resourceSid = matching(
    input.resourceSid,
    "resourceSid",
    sidPattern,
    `a Twilio ${input.preflight.plan.channel === "sms" ? "Message" : "Call"} SID`,
  );
  const resource =
    input.preflight.plan.channel === "sms" ? "Messages" : "Calls";
  const url = new URL(
    `/2010-04-01/Accounts/${input.preflight.plan.accountSid}/${resource}/${resourceSid}.json`,
    TWILIO_API_ORIGIN,
  );
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(
          `${input.preflight.plan.accountSid}:${input.authToken}`,
        ).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // error-policy:J2 preserve provider transport context without exposing credentials.
    throw new Error(
      "twilio provider-canary operator Twilio REST readback failed",
      { cause: error },
    );
  }
  if (!response.ok)
    fail(`Twilio REST readback returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail("Twilio REST readback response exceeds the byte limit");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
    fail("Twilio REST readback response exceeds the byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J2 preserve malformed provider-response context.
    throw new Error(
      "twilio provider-canary operator Twilio REST readback returned invalid JSON",
      { cause: error },
    );
  }
  return {
    value: record(parsed, "Twilio REST response"),
    rawResponseSha256: sha256(raw),
  };
}

/** Fetch an exact Message or Call resource without mutating provider state. */
export async function collectTwilioRawStatusReadback(input: {
  preflight: TwilioOperatorPreflight;
  resourceSid: string;
  accountSid: string;
  authToken: string;
  fetchImpl?: TwilioFetch;
  collectedAt?: Date;
}): Promise<TwilioRawStatusReceipt> {
  requireValidatedPreflight(input.preflight);
  if (input.accountSid !== input.preflight.plan.accountSid) {
    fail("readback account SID does not match the validated plan");
  }
  const { value, rawResponseSha256 } = await readTwilioJson({
    preflight: input.preflight,
    resourceSid: input.resourceSid,
    authToken: input.authToken,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const sidPattern =
    input.preflight.plan.channel === "sms"
      ? MESSAGE_SID_PATTERN
      : CALL_SID_PATTERN;
  const resourceSid = matching(
    value.sid,
    "Twilio REST response.sid",
    sidPattern,
    "the expected Twilio resource SID",
  );
  const accountSid = matching(
    value.account_sid,
    "Twilio REST response.account_sid",
    ACCOUNT_SID_PATTERN,
    "a Twilio Account SID",
  );
  const fromE164 = matching(
    value.from,
    "Twilio REST response.from",
    E164_PATTERN,
    "an E.164 number",
  );
  const toE164 = matching(
    value.to,
    "Twilio REST response.to",
    E164_PATTERN,
    "an E.164 number",
  );
  const direction = requiredString(
    value.direction,
    "Twilio REST response.direction",
  );
  const status = requiredString(value.status, "Twilio REST response.status");
  if (
    resourceSid !== input.resourceSid ||
    accountSid !== input.preflight.plan.accountSid ||
    fromE164 !== input.preflight.plan.fromE164 ||
    toE164 !== input.preflight.plan.toE164 ||
    direction !== "outbound-api"
  ) {
    fail(
      "Twilio REST response does not match the exact resource, account, and route",
    );
  }
  let payloadSha256: string | null = null;
  if (input.preflight.plan.channel === "sms") {
    const body = requiredString(value.body, "Twilio REST response.body");
    if (body !== input.preflight.plan.expectedPayload) {
      fail("Twilio Message body does not match the signed operation input");
    }
    payloadSha256 = sha256(body);
  }
  return Object.freeze({
    schema: "eliza.twilio-provider-canary-raw-status.v1",
    collectedAtIso: (input.collectedAt ?? new Date()).toISOString(),
    channel: input.preflight.plan.channel,
    resourceSid,
    accountSid,
    fromE164,
    toE164,
    direction: "outbound-api",
    status,
    payloadSha256,
    rawResponseSha256,
    qualificationClaimed: false,
  });
}
