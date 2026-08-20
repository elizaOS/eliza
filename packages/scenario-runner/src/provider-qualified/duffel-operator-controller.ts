/**
 * Defines the fail-closed operator boundary for the approval-gated Duffel hold
 * canary. It validates signed hold-only material before sandbox access, starts
 * the no-effect observer before proposal ingress, correlates both owner turns
 * to one immutable approval, and emits unsigned raw receipts only.
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

export const DUFFEL_OPERATOR_PLAN_SCHEMA =
  "eliza.duffel-provider-canary-operator-plan.v1" as const;
export const DUFFEL_RAW_RECEIPT_SCHEMA =
  "eliza.duffel-provider-canary-raw-receipt.v1" as const;

type DuffelRawOperation = Extract<
  ProviderOperationRawBinding,
  { kind: "duffel.booking-hold-create" }
>;

const SCENARIO_ID = "provider.duffel-travel.booking" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const validatedPreflights = new WeakSet<object>();

export interface DuffelOperatorPlan {
  schema: typeof DUFFEL_OPERATOR_PLAN_SCHEMA;
  scenarioId: typeof SCENARIO_ID;
  environment: "sandbox";
  accountId: string;
  connectionRefSha256: string;
  ownerPrincipalRefSha256: string;
  runNonce: string;
}

export interface DuffelOperatorPreflight {
  status: "duffel-operator-inputs-validated";
  scenarioId: typeof SCENARIO_ID;
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: DuffelOperatorPlan;
  operation: DuffelRawOperation;
  approvalPayloadSha256: string;
  noEffectScopeSha256: string;
}

export interface DuffelSandboxCredentialReceipt {
  accountId: string;
  connectionRefSha256: string;
  environment: "sandbox";
  liveMode: false;
  readWrite: true;
  checkedAtIso: string;
}

export interface DuffelApprovalTurnReceipt {
  requestId: string;
  acceptedAtIso: string;
  authenticatedPrincipalRefSha256: string;
  approvalIdSha256: string;
  approvalPayloadSha256: string;
  state: "pending" | "done";
  approvedAtIso: string | null;
  doneAtIso: string | null;
  providerOrderId: string | null;
}

export interface DuffelPreapprovalNoEffectReceipt {
  scopeSha256: string;
  observationStartedAtIso: string;
  observationEndedAtIso: string;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
  orderCreateCount: 0;
  paymentCreateCount: 0;
}

export interface DuffelSandboxReadbackReceipt {
  orderId: string;
  observedAtIso: string;
  liveMode: false;
  providerAccepted: true;
  orderType: "hold";
  offerId: string;
  totalCents: number;
  currency: string;
  passengerIds: readonly string[];
  awaitingPayment: true;
  paymentCount: 0;
  calendarMutationCount: 0;
  providerPayloadSha256: string;
}

export interface DuffelReplayReceipt {
  replayRequestId: string;
  observedAtIso: string;
  duplicateOrderCount: 0;
  duplicatePaymentCount: 0;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface DuffelFailureProbeReceipt {
  probeId: string;
  failureClass: "authorization-denied" | "provider-rejected";
  observedAtIso: string;
  statusCode: number;
  errorCodeSha256: string;
  providerRequestIdSha256: string | null;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface DuffelTrajectoryExportReceipt {
  exportId: string;
  exportedAtIso: string;
  trajectoryCount: number;
  exportSha256: string;
}

export interface DuffelRawReceipt {
  schema: typeof DUFFEL_RAW_RECEIPT_SCHEMA;
  scenarioId: typeof SCENARIO_ID;
  collectedAtIso: string;
  credential: DuffelSandboxCredentialReceipt;
  proposal: DuffelApprovalTurnReceipt;
  preapprovalNoEffect: DuffelPreapprovalNoEffectReceipt;
  approval: DuffelApprovalTurnReceipt;
  readback: DuffelSandboxReadbackReceipt;
  replay: DuffelReplayReceipt;
  failureProbes: readonly DuffelFailureProbeReceipt[];
  trajectory: DuffelTrajectoryExportReceipt;
  qualificationClaimed: false;
}

export interface DuffelPreapprovalObserverSession {
  complete(input: {
    proposalRequestId: string;
    approvalIdSha256: string;
    approvalPayloadSha256: string;
  }): Promise<unknown>;
}

export interface DuffelExternalCapabilities {
  assertSandboxCredentialReady(input: {
    accountId: string;
    connectionRefSha256: string;
  }): Promise<unknown>;
  beginPreapprovalNoEffectObservation(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    scopeSha256: string;
    operation: DuffelRawOperation;
  }): Promise<DuffelPreapprovalObserverSession>;
  sendAuthenticatedProposalIngress(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    operation: DuffelRawOperation;
    approvalPayloadSha256: string;
  }): Promise<unknown>;
  sendAuthenticatedApprovalIngress(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    approvalIdSha256: string;
    approvalPayloadSha256: string;
  }): Promise<unknown>;
  collectSandboxReadback(input: {
    operation: DuffelRawOperation;
    orderId: string;
  }): Promise<unknown>;
  replayAuthenticatedApproval(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    approvalRequestId: string;
    approvalIdSha256: string;
  }): Promise<unknown>;
  executeIndependentFailureProbes(input: {
    operation: DuffelRawOperation;
    probeIds: readonly string[];
  }): Promise<unknown>;
  exportDeployedTrajectory(input: {
    scenarioId: typeof SCENARIO_ID;
    runNonce: string;
    proposalRequestId: string;
    approvalRequestId: string;
  }): Promise<unknown>;
}

function fail(message: string): never {
  throw new Error(`duffel provider-canary operator ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
  const milliseconds = Date.parse(candidate);
  if (!candidate.includes("T") || !Number.isFinite(milliseconds)) {
    fail(`${path} must be an ISO timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

function parsePlan(value: unknown): DuffelOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "scenarioId",
    "environment",
    "accountId",
    "connectionRefSha256",
    "ownerPrincipalRefSha256",
    "runNonce",
  ]);
  if (
    plan.schema !== DUFFEL_OPERATOR_PLAN_SCHEMA ||
    plan.scenarioId !== SCENARIO_ID ||
    plan.environment !== "sandbox"
  ) {
    fail("plan must target the supported Duffel sandbox canary");
  }
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce)) {
    fail("plan.runNonce must be 32-128 unpadded base64url characters");
  }
  return Object.freeze({
    schema: DUFFEL_OPERATOR_PLAN_SCHEMA,
    scenarioId: SCENARIO_ID,
    environment: "sandbox",
    accountId: string(plan.accountId, "plan.accountId"),
    connectionRefSha256: hash(
      plan.connectionRefSha256,
      "plan.connectionRefSha256",
    ),
    ownerPrincipalRefSha256: hash(
      plan.ownerPrincipalRefSha256,
      "plan.ownerPrincipalRefSha256",
    ),
    runNonce,
  });
}

/** Validate authorization, exact hold material, price, and probe payloads offline. */
export function preflightDuffelOperatorCanary(input: {
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
}): DuffelOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== SCENARIO_ID) fail("scenario does not match plan");
  const operation = validateProviderOperationRawBinding({
    kind: "duffel.booking-hold-create",
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
  }) as DuffelRawOperation;
  if (
    operation.operationInput.orderType !== "hold" ||
    operation.operationInput.calendarSync.enabled !== false
  ) {
    fail("operation must remain hold-only with calendar sync disabled");
  }
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: operation.kind,
    providerTarget: operation.providerTarget,
    operationInput: operation.operationInput,
    failureProbes: input.failureProbes,
  });
  const manifest = execution.authorization.manifest;
  const connector = manifest.connectors.find(
    (candidate) => candidate.provider === "duffel",
  );
  if (!connector) {
    fail("signed manifest must bind the Duffel sandbox connector");
  }
  if (connector.environment !== "sandbox") {
    fail("signed manifest must bind the Duffel sandbox connector");
  }
  if (
    connector.connectionRefSha256 !== plan.connectionRefSha256 ||
    connector.accountRefSha256 !==
      createHash("sha256").update(plan.accountId).digest("hex")
  ) {
    fail("plan account or connection does not match signed connector");
  }
  if (
    manifest.run.nonce !== plan.runNonce ||
    manifest.target.principalRefSha256 !== plan.ownerPrincipalRefSha256 ||
    manifest.ingress.authenticatedPrincipalRefSha256 !==
      plan.ownerPrincipalRefSha256
  ) {
    fail("plan owner or run identity does not match signed manifest");
  }
  const noEffect = manifest.requiredObservations.filter(
    (contract) => contract.kind === "provider-no-effect",
  );
  if (
    noEffect.length !== 1 ||
    noEffect[0]?.provider !== "duffel" ||
    noEffect[0].intervalCoverage !== "before-referenced-stage" ||
    !noEffect[0].effectKinds.includes("booking-order-create") ||
    !noEffect[0].effectKinds.includes("payment-create")
  ) {
    fail(
      "manifest must bind one stage-bounded Duffel order/payment no-effect contract",
    );
  }
  const approvalPayloadSha256 = canonicalSha256(
    canonicalJsonValue(
      {
        action: "book_travel",
        kind: "flight",
        provider: "duffel",
        offerId: operation.providerTarget.offerId,
        orderType: operation.operationInput.orderType,
        totalCents: operation.operationInput.totalCents,
        currency: operation.operationInput.currency,
        passengers: operation.operationInput.passengers,
        calendarSync: operation.operationInput.calendarSync,
      },
      "duffelApprovalPayload",
    ),
    "duffelApprovalPayload",
  );
  const result = Object.freeze({
    status: "duffel-operator-inputs-validated",
    scenarioId: SCENARIO_ID,
    authorization: execution.authorization,
    execution,
    plan,
    operation,
    approvalPayloadSha256,
    noEffectScopeSha256: noEffect[0].scopeSha256,
  }) satisfies DuffelOperatorPreflight;
  validatedPreflights.add(result);
  return result;
}

function parseCapabilities(value: unknown): DuffelExternalCapabilities {
  const capabilities = record(value, "capabilities");
  const keys = [
    "assertSandboxCredentialReady",
    "beginPreapprovalNoEffectObservation",
    "sendAuthenticatedProposalIngress",
    "sendAuthenticatedApprovalIngress",
    "collectSandboxReadback",
    "replayAuthenticatedApproval",
    "executeIndependentFailureProbes",
    "exportDeployedTrajectory",
  ] as const;
  exactKeys(capabilities, "capabilities", keys);
  for (const key of keys) {
    if (typeof capabilities[key] !== "function") {
      fail(`capabilities.${key} is required`);
    }
  }
  return capabilities as unknown as DuffelExternalCapabilities;
}

function parseCredential(
  value: unknown,
  preflight: DuffelOperatorPreflight,
): DuffelSandboxCredentialReceipt {
  const receipt = record(value, "credentialReceipt");
  exactKeys(receipt, "credentialReceipt", [
    "accountId",
    "connectionRefSha256",
    "environment",
    "liveMode",
    "readWrite",
    "checkedAtIso",
  ]);
  if (
    receipt.accountId !== preflight.plan.accountId ||
    receipt.connectionRefSha256 !== preflight.plan.connectionRefSha256 ||
    receipt.environment !== "sandbox" ||
    receipt.liveMode !== false ||
    receipt.readWrite !== true
  ) {
    fail("credential receipt is not the exact writable sandbox account");
  }
  return Object.freeze({
    accountId: preflight.plan.accountId,
    connectionRefSha256: preflight.plan.connectionRefSha256,
    environment: "sandbox",
    liveMode: false,
    readWrite: true,
    checkedAtIso: iso(receipt.checkedAtIso, "credentialReceipt.checkedAtIso"),
  });
}

function parseTurn(
  value: unknown,
  path: string,
  preflight: DuffelOperatorPreflight,
  expectedState: "pending" | "done",
): DuffelApprovalTurnReceipt {
  const receipt = record(value, path);
  exactKeys(receipt, path, [
    "requestId",
    "acceptedAtIso",
    "authenticatedPrincipalRefSha256",
    "approvalIdSha256",
    "approvalPayloadSha256",
    "state",
    "approvedAtIso",
    "doneAtIso",
    "providerOrderId",
  ]);
  if (
    receipt.authenticatedPrincipalRefSha256 !==
      preflight.plan.ownerPrincipalRefSha256 ||
    receipt.approvalPayloadSha256 !== preflight.approvalPayloadSha256 ||
    receipt.state !== expectedState
  ) {
    fail(`${path} does not match the signed owner, payload, or expected state`);
  }
  const pending = expectedState === "pending";
  if (
    pending
      ? receipt.approvedAtIso !== null ||
        receipt.doneAtIso !== null ||
        receipt.providerOrderId !== null
      : receipt.approvedAtIso === null ||
        receipt.doneAtIso === null ||
        receipt.providerOrderId === null
  ) {
    fail(`${path} has an invalid approval lifecycle shape`);
  }
  return Object.freeze({
    requestId: string(receipt.requestId, `${path}.requestId`),
    acceptedAtIso: iso(receipt.acceptedAtIso, `${path}.acceptedAtIso`),
    authenticatedPrincipalRefSha256: preflight.plan.ownerPrincipalRefSha256,
    approvalIdSha256: hash(
      receipt.approvalIdSha256,
      `${path}.approvalIdSha256`,
    ),
    approvalPayloadSha256: preflight.approvalPayloadSha256,
    state: expectedState,
    approvedAtIso:
      receipt.approvedAtIso === null
        ? null
        : iso(receipt.approvedAtIso, `${path}.approvedAtIso`),
    doneAtIso:
      receipt.doneAtIso === null
        ? null
        : iso(receipt.doneAtIso, `${path}.doneAtIso`),
    providerOrderId:
      receipt.providerOrderId === null
        ? null
        : string(receipt.providerOrderId, `${path}.providerOrderId`),
  });
}

function parseNoEffect(
  value: unknown,
  preflight: DuffelOperatorPreflight,
): DuffelPreapprovalNoEffectReceipt {
  const receipt = record(value, "preapprovalNoEffectReceipt");
  exactKeys(receipt, "preapprovalNoEffectReceipt", [
    "scopeSha256",
    "observationStartedAtIso",
    "observationEndedAtIso",
    "providerStateBeforeSha256",
    "providerStateAfterSha256",
    "orderCreateCount",
    "paymentCreateCount",
  ]);
  const before = hash(
    receipt.providerStateBeforeSha256,
    "preapprovalNoEffectReceipt.providerStateBeforeSha256",
  );
  const after = hash(
    receipt.providerStateAfterSha256,
    "preapprovalNoEffectReceipt.providerStateAfterSha256",
  );
  if (
    receipt.scopeSha256 !== preflight.noEffectScopeSha256 ||
    before !== after ||
    receipt.orderCreateCount !== 0 ||
    receipt.paymentCreateCount !== 0
  ) {
    fail("preapproval observer detected an effect or mismatched scope");
  }
  const observationStartedAtIso = iso(
    receipt.observationStartedAtIso,
    "preapprovalNoEffectReceipt.observationStartedAtIso",
  );
  const observationEndedAtIso = iso(
    receipt.observationEndedAtIso,
    "preapprovalNoEffectReceipt.observationEndedAtIso",
  );
  if (Date.parse(observationStartedAtIso) > Date.parse(observationEndedAtIso)) {
    fail("preapproval observation interval is reversed");
  }
  return Object.freeze({
    scopeSha256: preflight.noEffectScopeSha256,
    observationStartedAtIso,
    observationEndedAtIso,
    providerStateBeforeSha256: before,
    providerStateAfterSha256: after,
    orderCreateCount: 0,
    paymentCreateCount: 0,
  });
}

function parseReadback(
  value: unknown,
  preflight: DuffelOperatorPreflight,
  orderId: string,
): DuffelSandboxReadbackReceipt {
  const receipt = record(value, "readbackReceipt");
  exactKeys(receipt, "readbackReceipt", [
    "orderId",
    "observedAtIso",
    "liveMode",
    "providerAccepted",
    "orderType",
    "offerId",
    "totalCents",
    "currency",
    "passengerIds",
    "awaitingPayment",
    "paymentCount",
    "calendarMutationCount",
    "providerPayloadSha256",
  ]);
  const operation = preflight.operation;
  const expectedPassengerIds = operation.operationInput.passengers.map(
    (passenger) => passenger.offerPassengerId,
  );
  if (
    receipt.orderId !== orderId ||
    receipt.liveMode !== false ||
    receipt.providerAccepted !== true ||
    receipt.orderType !== "hold" ||
    receipt.offerId !== operation.providerTarget.offerId ||
    receipt.totalCents !== operation.operationInput.totalCents ||
    receipt.currency !== operation.operationInput.currency ||
    !Array.isArray(receipt.passengerIds) ||
    receipt.passengerIds.length !== expectedPassengerIds.length ||
    receipt.passengerIds.some(
      (id, index) => id !== expectedPassengerIds[index],
    ) ||
    receipt.awaitingPayment !== true ||
    receipt.paymentCount !== 0 ||
    receipt.calendarMutationCount !== 0
  ) {
    fail("sandbox readback does not match the approved payment-free hold");
  }
  return Object.freeze({
    orderId,
    observedAtIso: iso(receipt.observedAtIso, "readbackReceipt.observedAtIso"),
    liveMode: false,
    providerAccepted: true,
    orderType: "hold",
    offerId: operation.providerTarget.offerId,
    totalCents: operation.operationInput.totalCents,
    currency: operation.operationInput.currency,
    passengerIds: Object.freeze([...expectedPassengerIds]),
    awaitingPayment: true,
    paymentCount: 0,
    calendarMutationCount: 0,
    providerPayloadSha256: hash(
      receipt.providerPayloadSha256,
      "readbackReceipt.providerPayloadSha256",
    ),
  });
}

function parseReplay(value: unknown): DuffelReplayReceipt {
  const receipt = record(value, "replayReceipt");
  exactKeys(receipt, "replayReceipt", [
    "replayRequestId",
    "observedAtIso",
    "duplicateOrderCount",
    "duplicatePaymentCount",
    "providerStateBeforeSha256",
    "providerStateAfterSha256",
  ]);
  const before = hash(
    receipt.providerStateBeforeSha256,
    "replayReceipt.providerStateBeforeSha256",
  );
  const after = hash(
    receipt.providerStateAfterSha256,
    "replayReceipt.providerStateAfterSha256",
  );
  if (
    receipt.duplicateOrderCount !== 0 ||
    receipt.duplicatePaymentCount !== 0 ||
    before !== after
  ) {
    fail("authenticated replay changed Duffel state");
  }
  return Object.freeze({
    replayRequestId: string(
      receipt.replayRequestId,
      "replayReceipt.replayRequestId",
    ),
    observedAtIso: iso(receipt.observedAtIso, "replayReceipt.observedAtIso"),
    duplicateOrderCount: 0,
    duplicatePaymentCount: 0,
    providerStateBeforeSha256: before,
    providerStateAfterSha256: after,
  });
}

function parseFailureProbes(
  value: unknown,
  preflight: DuffelOperatorPreflight,
): readonly DuffelFailureProbeReceipt[] {
  if (!Array.isArray(value)) fail("failureProbeReceipts must be an array");
  const expected = preflight.authorization.manifest.requiredFailureProbes;
  if (value.length !== expected.length)
    fail("failure probe count does not match manifest");
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
      "providerRequestIdSha256",
      "providerStateBeforeSha256",
      "providerStateAfterSha256",
    ]);
    const contract = expected.find(
      (probe) => probe.probeId === receipt.probeId,
    );
    if (
      !contract ||
      seen.has(contract.probeId) ||
      receipt.failureClass !== contract.failureClass ||
      receipt.statusCode !== contract.expectedStatusCode ||
      receipt.errorCodeSha256 !== contract.expectedErrorCodeSha256
    ) {
      fail(`${path} does not match one signed failure probe`);
    }
    seen.add(contract.probeId);
    const before = hash(
      receipt.providerStateBeforeSha256,
      `${path}.providerStateBeforeSha256`,
    );
    const after = hash(
      receipt.providerStateAfterSha256,
      `${path}.providerStateAfterSha256`,
    );
    const providerRequestIdSha256 =
      receipt.providerRequestIdSha256 === null
        ? null
        : hash(
            receipt.providerRequestIdSha256,
            `${path}.providerRequestIdSha256`,
          );
    if (
      before !== after ||
      (contract.failureClass === "authorization-denied"
        ? providerRequestIdSha256 !== null
        : providerRequestIdSha256 === null)
    ) {
      fail(`${path} changed state or has invalid provider correlation`);
    }
    return Object.freeze({
      probeId: contract.probeId,
      failureClass: contract.failureClass,
      observedAtIso: iso(receipt.observedAtIso, `${path}.observedAtIso`),
      statusCode: positiveInteger(receipt.statusCode, `${path}.statusCode`),
      errorCodeSha256: contract.expectedErrorCodeSha256,
      providerRequestIdSha256,
      providerStateBeforeSha256: before,
      providerStateAfterSha256: after,
    });
  });
  if (seen.size !== expected.length)
    fail("failure probes do not cover manifest exactly once");
  return Object.freeze(parsed);
}

function parseTrajectory(value: unknown): DuffelTrajectoryExportReceipt {
  const receipt = record(value, "trajectoryReceipt");
  exactKeys(receipt, "trajectoryReceipt", [
    "exportId",
    "exportedAtIso",
    "trajectoryCount",
    "exportSha256",
  ]);
  return Object.freeze({
    exportId: string(receipt.exportId, "trajectoryReceipt.exportId"),
    exportedAtIso: iso(
      receipt.exportedAtIso,
      "trajectoryReceipt.exportedAtIso",
    ),
    trajectoryCount: positiveInteger(
      receipt.trajectoryCount,
      "trajectoryReceipt.trajectoryCount",
    ),
    exportSha256: hash(receipt.exportSha256, "trajectoryReceipt.exportSha256"),
  });
}

/** Execute the sandbox canary and collect raw material without claiming qualification. */
export async function executeDuffelOperatorCanary(input: {
  preflight: DuffelOperatorPreflight;
  capabilities: DuffelExternalCapabilities;
  now?: () => number;
}): Promise<DuffelRawReceipt> {
  if (!validatedPreflights.has(input.preflight)) {
    fail("execution requires the exact Duffel preflight result");
  }
  const capabilities = parseCapabilities(input.capabilities);
  const credential = parseCredential(
    await capabilities.assertSandboxCredentialReady({
      accountId: input.preflight.plan.accountId,
      connectionRefSha256: input.preflight.plan.connectionRefSha256,
    }),
    input.preflight,
  );
  const observer = await capabilities.beginPreapprovalNoEffectObservation({
    scenarioId: SCENARIO_ID,
    runNonce: input.preflight.plan.runNonce,
    scopeSha256: input.preflight.noEffectScopeSha256,
    operation: input.preflight.operation,
  });
  if (typeof observer?.complete !== "function")
    fail("preapproval observer complete is required");
  const proposal = parseTurn(
    await capabilities.sendAuthenticatedProposalIngress({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      operation: input.preflight.operation,
      approvalPayloadSha256: input.preflight.approvalPayloadSha256,
    }),
    "proposalReceipt",
    input.preflight,
    "pending",
  );
  const preapprovalNoEffect = parseNoEffect(
    await observer.complete({
      proposalRequestId: proposal.requestId,
      approvalIdSha256: proposal.approvalIdSha256,
      approvalPayloadSha256: proposal.approvalPayloadSha256,
    }),
    input.preflight,
  );
  if (
    Date.parse(preapprovalNoEffect.observationStartedAtIso) >
      Date.parse(proposal.acceptedAtIso) ||
    Date.parse(preapprovalNoEffect.observationEndedAtIso) <
      Date.parse(proposal.acceptedAtIso)
  ) {
    fail("preapproval observer did not cover proposal ingress");
  }
  const approval = parseTurn(
    await capabilities.sendAuthenticatedApprovalIngress({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      approvalIdSha256: proposal.approvalIdSha256,
      approvalPayloadSha256: proposal.approvalPayloadSha256,
    }),
    "approvalReceipt",
    input.preflight,
    "done",
  );
  if (
    approval.approvalIdSha256 !== proposal.approvalIdSha256 ||
    approval.approvalPayloadSha256 !== proposal.approvalPayloadSha256 ||
    approval.requestId === proposal.requestId ||
    Date.parse(approval.acceptedAtIso) <=
      Date.parse(preapprovalNoEffect.observationEndedAtIso) ||
    Date.parse(approval.approvedAtIso as string) <
      Date.parse(approval.acceptedAtIso) ||
    Date.parse(approval.doneAtIso as string) <
      Date.parse(approval.approvedAtIso as string)
  ) {
    fail(
      "approval turn is not a later correlated lifecycle for the same request",
    );
  }
  const readback = parseReadback(
    await capabilities.collectSandboxReadback({
      operation: input.preflight.operation,
      orderId: approval.providerOrderId as string,
    }),
    input.preflight,
    approval.providerOrderId as string,
  );
  const replay = parseReplay(
    await capabilities.replayAuthenticatedApproval({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      approvalRequestId: approval.requestId,
      approvalIdSha256: approval.approvalIdSha256,
    }),
  );
  const failureProbes = parseFailureProbes(
    await capabilities.executeIndependentFailureProbes({
      operation: input.preflight.operation,
      probeIds:
        input.preflight.authorization.manifest.requiredFailureProbes.map(
          (probe) => probe.probeId,
        ),
    }),
    input.preflight,
  );
  const trajectory = parseTrajectory(
    await capabilities.exportDeployedTrajectory({
      scenarioId: SCENARIO_ID,
      runNonce: input.preflight.plan.runNonce,
      proposalRequestId: proposal.requestId,
      approvalRequestId: approval.requestId,
    }),
  );
  return Object.freeze({
    schema: DUFFEL_RAW_RECEIPT_SCHEMA,
    scenarioId: SCENARIO_ID,
    collectedAtIso: new Date((input.now ?? Date.now)()).toISOString(),
    credential,
    proposal,
    preapprovalNoEffect,
    approval,
    readback,
    replay,
    failureProbes,
    trajectory,
    qualificationClaimed: false,
  });
}
