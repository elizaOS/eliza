/**
 * Defines the fail-closed operator boundary for the BlueBubbles iMessage
 * canary. It verifies the signed chat and message operation before contacting
 * an authenticated BlueBubbles server and accepts only externally collected,
 * unsigned receipts for deployed ingress, readback, replay, probes, and traces.
 */

import { createHash } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import type { ProviderOperationRawBinding } from "./operation-binding.ts";
import { validateProviderOperationRawBinding } from "./operation-binding.ts";
import {
  type AuthorizedProviderCanaryExecutionPreflight,
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import {
  assertRawReceiptChronology,
  bindValidatedFailureProbeExecutions,
  buildProviderReplayBinding,
  type DeployedTrajectoryRunMaterial,
  type ProviderReplayBinding,
  type ValidatedProviderFailureProbeExecution,
  verifyDeployedTrajectoryRun,
} from "./raw-controller-contracts.ts";
import type { VerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

export const BLUEBUBBLES_OPERATOR_PLAN_SCHEMA =
  "eliza.bluebubbles-provider-canary-operator-plan.v1" as const;
export const BLUEBUBBLES_RAW_RECEIPT_SCHEMA =
  "eliza.bluebubbles-provider-canary-raw-receipt.v1" as const;

const SCENARIO_ID = "provider.bluebubbles-imessage.confirmed-send" as const;
const OPERATION_KIND = "bluebubbles.message-send" as const;
const SERVER_INFO_PATH = "/api/v1/server/info";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CHAT_GUID_PATTERN = /^(?:iMessage|SMS|RCS);(?:-|\+);[^;\r\n]+$/;
const MESSAGE_GUID_PATTERN = /^[^\s\r\n]{1,512}$/;
const validatedPreflights = new WeakSet<object>();
const authenticatedBoundaries = new WeakSet<object>();

type BlueBubblesRawOperation = Extract<
  ProviderOperationRawBinding,
  { kind: typeof OPERATION_KIND }
>;

export interface BlueBubblesOperatorPlan {
  schema: typeof BLUEBUBBLES_OPERATOR_PLAN_SCHEMA;
  scenarioId: typeof SCENARIO_ID;
  accountId: string;
  connectionRefSha256: string;
  serverOrigin: string;
  runNonce: string;
  chatGuid: string;
  expectedText: string;
  replyToMessageGuid: null;
}

export interface BlueBubblesOperatorPreflight {
  status: "bluebubbles-operator-inputs-validated";
  scenarioId: typeof SCENARIO_ID;
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: BlueBubblesOperatorPlan;
  operation: BlueBubblesRawOperation;
  failureProbeExecutions: readonly ValidatedProviderFailureProbeExecution[];
}

export interface BlueBubblesBoundaryReceipt {
  schema: "eliza.bluebubbles-provider-canary-boundary.v1";
  accountId: string;
  connectionRefSha256: string;
  serverOrigin: string;
  serverVersion: string;
  osVersion: string;
  privateApiEnabled: boolean;
  helperConnected: boolean;
  checkedAtIso: string;
  rawResponseSha256: string;
  qualificationClaimed: false;
}

export interface BlueBubblesIngressReceipt {
  requestId: string;
  acceptedAtIso: string;
  scenarioId: typeof SCENARIO_ID;
  runNonce: string;
}

export interface BlueBubblesReadbackReceipt {
  messageGuid: string;
  chatGuid: string;
  textSha256: string;
  isFromMe: true;
  threadOriginatorGuid: null;
  observedAtIso: string;
  rawProviderResponseSha256: string;
  qualificationClaimed: false;
}

export interface BlueBubblesReplayReceipt {
  binding: ProviderReplayBinding;
  replayRequestId: string;
  observedAtIso: string;
  duplicateEffectCount: 0;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface BlueBubblesFailureProbeReceipt {
  probeId: string;
  failureClass: "authorization-denied" | "provider-rejected";
  observedAtIso: string;
  statusCode: number;
  errorCodeSha256: string;
  requestPayloadSha256: string;
  scopeSha256: string;
  authorizationGrantSha256: string;
  responsePayloadSha256: string;
  providerRequestIdSha256: string | null;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export type BlueBubblesTrajectoryReceipt = VerifiedScenarioTrajectorySet;

export interface BlueBubblesRawReceipt {
  schema: typeof BLUEBUBBLES_RAW_RECEIPT_SCHEMA;
  scenarioId: typeof SCENARIO_ID;
  operationKind: typeof OPERATION_KIND;
  collectedAtIso: string;
  boundary: BlueBubblesBoundaryReceipt;
  ingress: BlueBubblesIngressReceipt;
  readback: BlueBubblesReadbackReceipt;
  replay: BlueBubblesReplayReceipt;
  failureProbes: readonly BlueBubblesFailureProbeReceipt[];
  trajectory: BlueBubblesTrajectoryReceipt;
  qualificationClaimed: false;
}

export interface BlueBubblesExternalCapabilities {
  sendAuthenticatedIngress(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    operation: BlueBubblesRawOperation;
  }): Promise<unknown>;
  collectIndependentReadback(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    operation: BlueBubblesRawOperation;
    ingressRequestId: string;
  }): Promise<unknown>;
  replayAuthenticatedIngress(input: {
    binding: Readonly<ProviderReplayBinding>;
  }): Promise<unknown>;
  executeIndependentFailureProbes(input: {
    scenarioId: typeof SCENARIO_ID;
    operation: BlueBubblesRawOperation;
    probes: readonly ValidatedProviderFailureProbeExecution[];
  }): Promise<unknown>;
  exportDeployedTrajectory(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    ingressRequestId: string;
  }): Promise<DeployedTrajectoryRunMaterial>;
}

export type BlueBubblesFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function fail(message: string): never {
  throw new Error(`bluebubbles provider-canary operator ${message}`);
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
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail(`${path}.${key} must be an enumerable data property`);
    }
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

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!SHA256_PATTERN.test(candidate)) fail(`${path} must be a SHA-256 digest`);
  return candidate;
}

function iso(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!candidate.includes("T") || !Number.isFinite(Date.parse(candidate))) {
    fail(`${path} must be an ISO timestamp`);
  }
  return new Date(candidate).toISOString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

function serverOrigin(value: unknown): string {
  const raw = string(value, "plan.serverOrigin");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J3 malformed server locations are rejected before network access.
    throw new Error(
      "bluebubbles provider-canary operator plan.serverOrigin must be a URL",
      { cause: error },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    fail(
      "plan.serverOrigin must be an HTTPS origin without credentials or path",
    );
  }
  return url.origin;
}

function chatGuid(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!CHAT_GUID_PATTERN.test(candidate)) {
    fail(`${path} must be a canonical BlueBubbles chat GUID`);
  }
  return candidate;
}

function parsePlan(value: unknown): BlueBubblesOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "scenarioId",
    "accountId",
    "connectionRefSha256",
    "serverOrigin",
    "runNonce",
    "chatGuid",
    "expectedText",
    "replyToMessageGuid",
  ]);
  if (plan.schema !== BLUEBUBBLES_OPERATOR_PLAN_SCHEMA)
    fail("plan.schema is unsupported");
  if (plan.scenarioId !== SCENARIO_ID) fail("plan.scenarioId is unsupported");
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce)) {
    fail("plan.runNonce must be 32-128 unpadded base64url characters");
  }
  if (plan.replyToMessageGuid !== null) {
    fail("plan.replyToMessageGuid must be null for this canary");
  }
  return Object.freeze({
    schema: BLUEBUBBLES_OPERATOR_PLAN_SCHEMA,
    scenarioId: SCENARIO_ID,
    accountId: string(plan.accountId, "plan.accountId"),
    connectionRefSha256: hash(
      plan.connectionRefSha256,
      "plan.connectionRefSha256",
    ),
    serverOrigin: serverOrigin(plan.serverOrigin),
    runNonce,
    chatGuid: chatGuid(plan.chatGuid, "plan.chatGuid"),
    expectedText: string(plan.expectedText, "plan.expectedText"),
    replyToMessageGuid: null,
  });
}

/** Validate the signed chat, text, reply mode, account, and connection offline. */
export function preflightBlueBubblesOperatorCanary(input: {
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
}): BlueBubblesOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== SCENARIO_ID)
    fail("scenario does not match the operator plan");
  const operation = validateProviderOperationRawBinding({
    kind: OPERATION_KIND,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
  }) as BlueBubblesRawOperation;
  if (
    operation.providerTarget.chatGuid !== plan.chatGuid ||
    operation.operationInput.text !== plan.expectedText ||
    operation.operationInput.replyToMessageGuid !== plan.replyToMessageGuid
  ) {
    fail("plan chat, text, or reply input does not match the signed operation");
  }
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: OPERATION_KIND,
    providerTarget: operation.providerTarget,
    operationInput: operation.operationInput,
    failureProbes: input.failureProbes,
  });
  if (execution.authorization.manifest.run.nonce !== plan.runNonce) {
    fail("plan run nonce does not match the signed manifest");
  }
  const connector = execution.authorization.manifest.connectors.find(
    (candidate) => candidate.provider === "bluebubbles",
  );
  if (!connector) fail("signed manifest does not bind a BlueBubbles connector");
  if (connector.connectionRefSha256 !== plan.connectionRefSha256) {
    fail("plan connection does not match the signed BlueBubbles connector");
  }
  if (
    connector.accountRefSha256 !==
    createHash("sha256").update(plan.accountId).digest("hex")
  ) {
    fail(
      "plan accountId does not match the signed BlueBubbles account reference",
    );
  }
  const result = Object.freeze({
    status: "bluebubbles-operator-inputs-validated",
    scenarioId: SCENARIO_ID,
    authorization: execution.authorization,
    execution,
    plan,
    operation,
    failureProbeExecutions: bindValidatedFailureProbeExecutions({
      materials: input.failureProbes,
      bindings: execution.failureProbeBindings,
    }),
  }) satisfies BlueBubblesOperatorPreflight;
  validatedPreflights.add(result);
  return result;
}

function requirePreflight(preflight: BlueBubblesOperatorPreflight): void {
  if (!validatedPreflights.has(preflight)) {
    fail(
      "execution requires the exact result of preflightBlueBubblesOperatorCanary",
    );
  }
}

async function authenticatedJson(input: {
  preflight: BlueBubblesOperatorPreflight;
  serverPassword: string;
  path: string;
  fetchImpl: BlueBubblesFetch;
}): Promise<{ value: unknown; rawSha256: string }> {
  requirePreflight(input.preflight);
  if (input.serverPassword.length < 16)
    fail("serverPassword must contain at least 16 characters");
  const url = new URL(input.path, input.preflight.plan.serverOrigin);
  url.searchParams.set("password", input.serverPassword);
  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // error-policy:J2 preserve provider transport context without exposing the password.
    throw new Error(
      "bluebubbles provider-canary operator authenticated server request failed",
      { cause: error },
    );
  }
  if (!response.ok)
    fail(`authenticated server request returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail("authenticated server response exceeds the byte limit");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES)
    fail("authenticated server response exceeds the byte limit");
  try {
    return {
      value: JSON.parse(raw),
      rawSha256: createHash("sha256").update(raw).digest("hex"),
    };
  } catch (error) {
    // error-policy:J2 preserve malformed provider-response context.
    throw new Error(
      "bluebubbles provider-canary operator authenticated server returned invalid JSON",
      { cause: error },
    );
  }
}

/** Authenticate against the production server-info endpoint before ingress. */
export async function authenticateBlueBubblesBoundary(input: {
  preflight: BlueBubblesOperatorPreflight;
  serverPassword: string;
  fetchImpl?: BlueBubblesFetch;
  checkedAt?: Date;
}): Promise<BlueBubblesBoundaryReceipt> {
  const response = await authenticatedJson({
    preflight: input.preflight,
    serverPassword: input.serverPassword,
    path: SERVER_INFO_PATH,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const envelope = record(response.value, "serverInfoResponse");
  exactKeys(envelope, "serverInfoResponse", ["status", "data"]);
  if (envelope.status !== 200) {
    fail("serverInfoResponse.status must be 200");
  }
  const data = record(envelope.data, "serverInfoResponse.data");
  for (const key of [
    "server_version",
    "os_version",
    "private_api",
    "helper_connected",
  ] as const) {
    if (!Object.hasOwn(data, key))
      fail(`serverInfoResponse.data.${key} is required`);
  }
  if (
    typeof data.private_api !== "boolean" ||
    typeof data.helper_connected !== "boolean"
  ) {
    fail("server info capability flags must be booleans");
  }
  const receipt = Object.freeze({
    schema: "eliza.bluebubbles-provider-canary-boundary.v1",
    accountId: input.preflight.plan.accountId,
    connectionRefSha256: input.preflight.plan.connectionRefSha256,
    serverOrigin: input.preflight.plan.serverOrigin,
    serverVersion: string(
      data.server_version,
      "serverInfoResponse.data.server_version",
    ),
    osVersion: string(data.os_version, "serverInfoResponse.data.os_version"),
    privateApiEnabled: data.private_api,
    helperConnected: data.helper_connected,
    checkedAtIso: (input.checkedAt ?? new Date()).toISOString(),
    rawResponseSha256: response.rawSha256,
    qualificationClaimed: false,
  }) satisfies BlueBubblesBoundaryReceipt;
  authenticatedBoundaries.add(receipt);
  return receipt;
}

/**
 * Read one exact provider message through BlueBubbles' authenticated message
 * endpoint. An independent observer can use this adapter without loading an
 * Eliza connector or trusting its local memory.
 */
export async function collectBlueBubblesAuthenticatedMessageReadback(input: {
  preflight: BlueBubblesOperatorPreflight;
  messageGuid: string;
  serverPassword: string;
  fetchImpl?: BlueBubblesFetch;
  observedAt?: Date;
}): Promise<BlueBubblesReadbackReceipt> {
  const messageGuid = string(input.messageGuid, "messageGuid");
  if (!MESSAGE_GUID_PATTERN.test(messageGuid)) fail("messageGuid is invalid");
  const path = new URL(
    `/api/v1/message/${encodeURIComponent(messageGuid)}`,
    input.preflight.plan.serverOrigin,
  );
  path.searchParams.set("with", "chats");
  const response = await authenticatedJson({
    preflight: input.preflight,
    serverPassword: input.serverPassword,
    path: `${path.pathname}${path.search}`,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const envelope = record(response.value, "messageReadbackResponse");
  exactKeys(envelope, "messageReadbackResponse", ["status", "data"]);
  if (envelope.status !== 200)
    fail("messageReadbackResponse.status must be 200");
  const data = record(envelope.data, "messageReadbackResponse.data");
  for (const key of [
    "guid",
    "text",
    "isFromMe",
    "threadOriginatorGuid",
    "chats",
  ] as const) {
    if (!Object.hasOwn(data, key))
      fail(`messageReadbackResponse.data.${key} is required`);
  }
  if (!Array.isArray(data.chats))
    fail("messageReadbackResponse.data.chats must be an array");
  const observedChatGuids = data.chats.map((chat, index) =>
    chatGuid(
      record(chat, `messageReadbackResponse.data.chats[${index}]`).guid,
      `messageReadbackResponse.data.chats[${index}].guid`,
    ),
  );
  if (
    data.guid !== messageGuid ||
    data.text !== input.preflight.plan.expectedText ||
    data.isFromMe !== true ||
    data.threadOriginatorGuid !== null ||
    !observedChatGuids.includes(input.preflight.plan.chatGuid)
  ) {
    fail(
      "authenticated message readback does not match the exact signed operation",
    );
  }
  return Object.freeze({
    messageGuid,
    chatGuid: input.preflight.plan.chatGuid,
    textSha256: createHash("sha256")
      .update(input.preflight.plan.expectedText)
      .digest("hex"),
    isFromMe: true,
    threadOriginatorGuid: null,
    observedAtIso: (input.observedAt ?? new Date()).toISOString(),
    rawProviderResponseSha256: response.rawSha256,
    qualificationClaimed: false,
  });
}

function parseCapabilities(value: unknown): BlueBubblesExternalCapabilities {
  const capabilities = record(value, "capabilities");
  const keys = [
    "sendAuthenticatedIngress",
    "collectIndependentReadback",
    "replayAuthenticatedIngress",
    "executeIndependentFailureProbes",
    "exportDeployedTrajectory",
  ] as const;
  exactKeys(capabilities, "capabilities", keys);
  for (const key of keys) {
    if (typeof capabilities[key] !== "function")
      fail(`capabilities.${key} is required`);
  }
  return capabilities as unknown as BlueBubblesExternalCapabilities;
}

function parseIngress(
  value: unknown,
  preflight: BlueBubblesOperatorPreflight,
): BlueBubblesIngressReceipt {
  const receipt = record(value, "ingressReceipt");
  exactKeys(receipt, "ingressReceipt", [
    "requestId",
    "acceptedAtIso",
    "scenarioId",
    "runNonce",
  ]);
  if (
    receipt.scenarioId !== SCENARIO_ID ||
    receipt.runNonce !== preflight.plan.runNonce
  ) {
    fail("authenticated ingress receipt does not correlate to the signed run");
  }
  return Object.freeze({
    requestId: string(receipt.requestId, "ingressReceipt.requestId"),
    acceptedAtIso: iso(receipt.acceptedAtIso, "ingressReceipt.acceptedAtIso"),
    scenarioId: SCENARIO_ID,
    runNonce: preflight.plan.runNonce,
  });
}

function parseReadback(
  value: unknown,
  preflight: BlueBubblesOperatorPreflight,
): BlueBubblesReadbackReceipt {
  const receipt = record(value, "readbackReceipt");
  exactKeys(receipt, "readbackReceipt", [
    "messageGuid",
    "chatGuid",
    "text",
    "isFromMe",
    "threadOriginatorGuid",
    "observedAtIso",
    "rawProviderResponseSha256",
    "qualificationClaimed",
  ]);
  if (
    receipt.chatGuid !== preflight.plan.chatGuid ||
    receipt.text !== preflight.plan.expectedText ||
    receipt.isFromMe !== true ||
    receipt.threadOriginatorGuid !== null ||
    receipt.qualificationClaimed !== false
  ) {
    fail(
      "independent readback does not match the exact signed outgoing message",
    );
  }
  const messageGuid = string(
    receipt.messageGuid,
    "readbackReceipt.messageGuid",
  );
  if (!MESSAGE_GUID_PATTERN.test(messageGuid))
    fail("readbackReceipt.messageGuid is invalid");
  return Object.freeze({
    messageGuid,
    chatGuid: preflight.plan.chatGuid,
    textSha256: createHash("sha256")
      .update(preflight.plan.expectedText)
      .digest("hex"),
    isFromMe: true,
    threadOriginatorGuid: null,
    observedAtIso: iso(receipt.observedAtIso, "readbackReceipt.observedAtIso"),
    rawProviderResponseSha256: hash(
      receipt.rawProviderResponseSha256,
      "readbackReceipt.rawProviderResponseSha256",
    ),
    qualificationClaimed: false,
  });
}

function parseReplay(
  value: unknown,
  expectedBinding: Readonly<ProviderReplayBinding>,
): BlueBubblesReplayReceipt {
  const receipt = record(value, "replayReceipt");
  exactKeys(receipt, "replayReceipt", [
    "replayRequestId",
    "binding",
    "observedAtIso",
    "duplicateEffectCount",
    "providerStateBeforeSha256",
    "providerStateAfterSha256",
  ]);
  const binding = record(receipt.binding, "replayReceipt.binding");
  exactKeys(binding, "replayReceipt.binding", Object.keys(expectedBinding));
  for (const [key, expected] of Object.entries(expectedBinding)) {
    if (binding[key] !== expected)
      fail(`replayReceipt.binding.${key} mismatch`);
  }
  if (receipt.duplicateEffectCount !== 0)
    fail("authenticated replay produced a duplicate provider effect");
  const before = hash(
    receipt.providerStateBeforeSha256,
    "replayReceipt.providerStateBeforeSha256",
  );
  const after = hash(
    receipt.providerStateAfterSha256,
    "replayReceipt.providerStateAfterSha256",
  );
  if (before !== after) fail("authenticated replay changed provider state");
  return Object.freeze({
    binding: expectedBinding,
    replayRequestId: string(
      receipt.replayRequestId,
      "replayReceipt.replayRequestId",
    ),
    observedAtIso: iso(receipt.observedAtIso, "replayReceipt.observedAtIso"),
    duplicateEffectCount: 0,
    providerStateBeforeSha256: before,
    providerStateAfterSha256: after,
  });
}

function parseFailureProbes(
  value: unknown,
  preflight: BlueBubblesOperatorPreflight,
): readonly BlueBubblesFailureProbeReceipt[] {
  if (!Array.isArray(value)) fail("failureProbeReceipts must be an array");
  const expected = preflight.authorization.manifest.requiredFailureProbes;
  if (value.length !== expected.length)
    fail("failure probe receipt count does not match the signed manifest");
  const seen = new Set<string>();
  const parsed = value.map((item, index) => {
    const path = `failureProbeReceipts[${index}]`;
    const receipt = record(item, path);
    exactKeys(receipt, path, [
      "probeId",
      "failureClass",
      "observedAtIso",
      "statusCode",
      "errorCodeSha256",
      "requestPayloadSha256",
      "scopeSha256",
      "authorizationGrantSha256",
      "responsePayloadSha256",
      "providerRequestIdSha256",
      "providerStateBeforeSha256",
      "providerStateAfterSha256",
    ]);
    const contract = expected.find(
      (probe) => probe.probeId === receipt.probeId,
    );
    if (
      !contract ||
      receipt.failureClass !== contract.failureClass ||
      seen.has(contract.probeId)
    )
      fail(`${path} does not uniquely match a signed probe`);
    seen.add(contract.probeId);
    if (receipt.statusCode !== contract.expectedStatusCode)
      fail(`${path}.statusCode does not match the signed probe`);
    const before = hash(
      receipt.providerStateBeforeSha256,
      `${path}.providerStateBeforeSha256`,
    );
    const after = hash(
      receipt.providerStateAfterSha256,
      `${path}.providerStateAfterSha256`,
    );
    if (before !== after) fail(`${path} changed provider state`);
    const providerRequestIdSha256 =
      receipt.providerRequestIdSha256 === null
        ? null
        : hash(
            receipt.providerRequestIdSha256,
            `${path}.providerRequestIdSha256`,
          );
    if (
      (contract.failureClass === "authorization-denied" &&
        providerRequestIdSha256 !== null) ||
      (contract.failureClass === "provider-rejected" &&
        providerRequestIdSha256 === null)
    )
      fail(`${path} has invalid provider request correlation`);
    const errorCodeSha256 = hash(
      receipt.errorCodeSha256,
      `${path}.errorCodeSha256`,
    );
    if (errorCodeSha256 !== contract.expectedErrorCodeSha256)
      fail(`${path}.errorCodeSha256 does not match the signed probe`);
    const requestPayloadSha256 = hash(
      receipt.requestPayloadSha256,
      `${path}.requestPayloadSha256`,
    );
    const scopeSha256 = hash(receipt.scopeSha256, `${path}.scopeSha256`);
    const authorizationGrantSha256 = hash(
      receipt.authorizationGrantSha256,
      `${path}.authorizationGrantSha256`,
    );
    if (
      requestPayloadSha256 !== contract.requestPayloadSha256 ||
      scopeSha256 !== contract.scopeSha256 ||
      authorizationGrantSha256 !== contract.authorizationGrantSha256
    ) {
      fail(`${path} hash bindings do not match the signed probe`);
    }
    const responsePayloadSha256 = hash(
      receipt.responsePayloadSha256,
      `${path}.responsePayloadSha256`,
    );
    return Object.freeze({
      probeId: contract.probeId,
      failureClass: contract.failureClass,
      observedAtIso: iso(receipt.observedAtIso, `${path}.observedAtIso`),
      statusCode: positiveInteger(receipt.statusCode, `${path}.statusCode`),
      errorCodeSha256,
      requestPayloadSha256,
      scopeSha256,
      authorizationGrantSha256,
      responsePayloadSha256,
      providerRequestIdSha256,
      providerStateBeforeSha256: before,
      providerStateAfterSha256: after,
    });
  });
  if (seen.size !== expected.length)
    fail("failure probe receipts do not cover every signed probe exactly once");
  return Object.freeze(parsed);
}

/**
 * Drive deployed ingress only after authenticating the exact server and
 * validating all evidence capabilities. The result is unsigned source data.
 */
export async function executeBlueBubblesOperatorCanary(input: {
  preflight: BlueBubblesOperatorPreflight;
  boundary: BlueBubblesBoundaryReceipt;
  capabilities: BlueBubblesExternalCapabilities;
  now?: () => number;
}): Promise<BlueBubblesRawReceipt> {
  requirePreflight(input.preflight);
  if (!authenticatedBoundaries.has(input.boundary))
    fail(
      "execution requires a boundary receipt returned by authenticateBlueBubblesBoundary",
    );
  if (
    input.boundary.accountId !== input.preflight.plan.accountId ||
    input.boundary.connectionRefSha256 !==
      input.preflight.plan.connectionRefSha256 ||
    input.boundary.serverOrigin !== input.preflight.plan.serverOrigin
  )
    fail("authenticated boundary does not match the signed plan");
  const capabilities = parseCapabilities(input.capabilities);
  const ingress = parseIngress(
    await capabilities.sendAuthenticatedIngress({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      operation: input.preflight.operation,
    }),
    input.preflight,
  );
  const readback = parseReadback(
    await capabilities.collectIndependentReadback({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      operation: input.preflight.operation,
      ingressRequestId: ingress.requestId,
    }),
    input.preflight,
  );
  const replayBinding = buildProviderReplayBinding({
    scenarioId: SCENARIO_ID,
    runId: input.preflight.authorization.manifest.run.runId,
    runNonce: input.preflight.plan.runNonce,
    ingressRequestId: ingress.requestId,
    providerEventId: readback.messageGuid,
    effectSha256: readback.rawProviderResponseSha256,
    operation: input.preflight.operation,
  });
  const replay = parseReplay(
    await capabilities.replayAuthenticatedIngress({
      binding: replayBinding,
    }),
    replayBinding,
  );
  const failureProbes = parseFailureProbes(
    await capabilities.executeIndependentFailureProbes({
      scenarioId: SCENARIO_ID,
      operation: input.preflight.operation,
      probes: input.preflight.failureProbeExecutions,
    }),
    input.preflight,
  );
  const trajectoryMaterial = await capabilities.exportDeployedTrajectory({
    scenarioId: SCENARIO_ID,
    runNonce: input.preflight.plan.runNonce,
    ingressRequestId: ingress.requestId,
  });
  const collectedAtMs = (input.now ?? Date.now)();
  const trajectory = verifyDeployedTrajectoryRun({
    material: trajectoryMaterial,
    expectedRunId: input.preflight.authorization.manifest.run.runId,
    expectedScenarioId: SCENARIO_ID,
    now: new Date(collectedAtMs),
  });
  assertRawReceiptChronology({
    timestamps: [
      input.boundary.checkedAtIso,
      ingress.acceptedAtIso,
      readback.observedAtIso,
      replay.observedAtIso,
      ...failureProbes.map((probe) => probe.observedAtIso),
    ],
    collectedAtMs,
  });
  assertRawReceiptChronology({
    timestamps: [
      trajectory.scenarioStartedAtIso,
      trajectory.scenarioEndedAtIso,
      trajectory.verifiedAtIso,
    ],
    collectedAtMs,
  });
  return Object.freeze({
    schema: BLUEBUBBLES_RAW_RECEIPT_SCHEMA,
    scenarioId: SCENARIO_ID,
    operationKind: OPERATION_KIND,
    collectedAtIso: new Date(collectedAtMs).toISOString(),
    boundary: input.boundary,
    ingress,
    readback,
    replay,
    failureProbes,
    trajectory,
    qualificationClaimed: false,
  });
}

/** Map a validated operation to the production BlueBubbles service method. */
export async function dispatchBlueBubblesBoundOperation(input: {
  preflight: BlueBubblesOperatorPreflight;
  service: {
    sendMessage(
      chatGuid: string,
      text: string,
      selectedMessageGuid?: string,
    ): Promise<unknown>;
  };
}): Promise<{
  messageGuid: string;
  rawResultSha256: string;
  qualificationClaimed: false;
}> {
  requirePreflight(input.preflight);
  const result = await input.service.sendMessage(
    input.preflight.operation.providerTarget.chatGuid,
    input.preflight.operation.operationInput.text,
    undefined,
  );
  const normalized = record(
    canonicalJsonValue(result, "blueBubblesMutationResult"),
    "blueBubblesMutationResult",
  );
  const messageGuid = string(normalized.guid, "blueBubblesMutationResult.guid");
  if (!MESSAGE_GUID_PATTERN.test(messageGuid))
    fail("blueBubblesMutationResult.guid is invalid");
  return Object.freeze({
    messageGuid,
    rawResultSha256: canonicalSha256(normalized, "blueBubblesMutationResult"),
    qualificationClaimed: false,
  });
}
