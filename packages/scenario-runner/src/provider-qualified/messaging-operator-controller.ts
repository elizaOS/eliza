/**
 * Defines the fail-closed external operator boundary for Signal, Telegram,
 * WhatsApp, and X direct-message canaries. It validates signed operation and
 * probe material before invoking production capabilities and returns only
 * unsigned, non-qualifying receipts for later independent evidence signing.
 */

import { createHash } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
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

export const MESSAGING_OPERATOR_PLAN_SCHEMA =
  "eliza.messaging-provider-canary-operator-plan.v1" as const;
export const MESSAGING_RAW_RECEIPT_SCHEMA =
  "eliza.messaging-provider-canary-raw-receipt.v1" as const;

export type MessagingCanaryKind =
  | "signal.message-send"
  | "telegram.message-send"
  | "whatsapp.message-send"
  | "x.direct-message-send";

type MessagingRawOperation = Extract<
  ProviderOperationRawBinding,
  { kind: MessagingCanaryKind }
>;

const CONTRACT_BY_KIND = Object.freeze({
  "signal.message-send": {
    scenarioId: "provider.signal.confirmed-send",
    connectorProvider: "signal",
    requiredCapability: "signal.message.send",
  },
  "telegram.message-send": {
    scenarioId: "provider.telegram.confirmed-send",
    connectorProvider: "telegram",
    requiredCapability: "telegram.message.send",
  },
  "whatsapp.message-send": {
    scenarioId: "provider.whatsapp.confirmed-send",
    connectorProvider: "whatsapp",
    requiredCapability: "whatsapp.message.send",
  },
  "x.direct-message-send": {
    scenarioId: "provider.x-dm.confirmed-send",
    connectorProvider: "x",
    requiredCapability: "x.direct-message.send",
  },
} as const satisfies Record<
  MessagingCanaryKind,
  {
    scenarioId: string;
    connectorProvider: string;
    requiredCapability: string;
  }
>);

const KIND_SET = new Set<string>(Object.keys(CONTRACT_BY_KIND));
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const validatedPreflights = new WeakSet<object>();

export interface MessagingOperatorPlan {
  schema: typeof MESSAGING_OPERATOR_PLAN_SCHEMA;
  scenarioId: (typeof CONTRACT_BY_KIND)[MessagingCanaryKind]["scenarioId"];
  operationKind: MessagingCanaryKind;
  accountId: string;
  connectionRefSha256: string;
  runNonce: string;
}

export interface MessagingOperatorPreflight {
  status: "messaging-operator-inputs-validated";
  scenarioId: MessagingOperatorPlan["scenarioId"];
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: MessagingOperatorPlan;
  operation: MessagingRawOperation;
  failureProbeExecutions: readonly ValidatedProviderFailureProbeExecution[];
}

export interface MessagingCredentialReceipt {
  accountId: string;
  connectionRefSha256: string;
  grantedCapabilities: readonly string[];
  checkedAtIso: string;
}

export interface MessagingIngressReceipt {
  requestId: string;
  acceptedAtIso: string;
  scenarioId: string;
  runNonce: string;
  providerTargetRefSha256: string;
  operationInputSha256: string;
}

export interface MessagingReadbackReceipt {
  providerMessageId: string;
  observedAtIso: string;
  providerPayloadSha256: string;
  providerTargetRefSha256: string;
  operationInputSha256: string;
  providerAccepted: true;
}

export interface MessagingReplayReceipt {
  binding: ProviderReplayBinding;
  replayRequestId: string;
  observedAtIso: string;
  duplicateEffectCount: 0;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface MessagingFailureProbeReceipt {
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

export type MessagingTrajectoryReceipt = VerifiedScenarioTrajectorySet;

export interface MessagingRawReceipt {
  schema: typeof MESSAGING_RAW_RECEIPT_SCHEMA;
  scenarioId: MessagingOperatorPlan["scenarioId"];
  operationKind: MessagingCanaryKind;
  collectedAtIso: string;
  credential: MessagingCredentialReceipt;
  ingress: MessagingIngressReceipt;
  readback: MessagingReadbackReceipt;
  replay: MessagingReplayReceipt;
  failureProbes: readonly MessagingFailureProbeReceipt[];
  trajectory: MessagingTrajectoryReceipt;
  qualificationClaimed: false;
}

/** Production boundaries supplied by the protected provider environment. */
export interface MessagingExternalCapabilities {
  assertCredentialReady(input: {
    connectorProvider: string;
    accountId: string;
    requiredCapability: string;
  }): Promise<unknown>;
  sendAuthenticatedIngress(input: {
    scenarioId: string;
    runNonce: string;
    operation: MessagingRawOperation;
  }): Promise<unknown>;
  exportDeployedTrajectory(input: {
    scenarioId: string;
    runNonce: string;
    ingressRequestId: string;
  }): Promise<DeployedTrajectoryRunMaterial>;
  collectAuthenticatedProviderReadback(input: {
    scenarioId: string;
    operation: MessagingRawOperation;
    ingressRequestId: string;
  }): Promise<unknown>;
  replayAuthenticatedIngress(input: {
    binding: Readonly<ProviderReplayBinding>;
  }): Promise<unknown>;
  executeIndependentFailureProbes(input: {
    scenarioId: string;
    operation: MessagingRawOperation;
    probes: readonly ValidatedProviderFailureProbeExecution[];
  }): Promise<unknown>;
}

function fail(message: string): never {
  throw new Error(`messaging provider-canary operator ${message}`);
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
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    fail(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!HASH_PATTERN.test(candidate)) fail(`${path} must be lowercase SHA-256`);
  return candidate;
}

function iso(value: unknown, path: string): string {
  const candidate = string(value, path);
  if (!Number.isFinite(Date.parse(candidate)))
    fail(`${path} must be an ISO timestamp`);
  return new Date(candidate).toISOString();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    fail(`${path} must be a positive safe integer`);
  }
  return Number(value);
}

function parsePlan(value: unknown): MessagingOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "scenarioId",
    "operationKind",
    "accountId",
    "connectionRefSha256",
    "runNonce",
  ]);
  if (plan.schema !== MESSAGING_OPERATOR_PLAN_SCHEMA)
    fail("plan.schema is unsupported");
  if (
    typeof plan.operationKind !== "string" ||
    !KIND_SET.has(plan.operationKind)
  ) {
    fail("plan.operationKind is unsupported");
  }
  const operationKind = plan.operationKind as MessagingCanaryKind;
  const contract = CONTRACT_BY_KIND[operationKind];
  if (plan.scenarioId !== contract.scenarioId) {
    fail("plan scenario does not match its operation kind");
  }
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce)) {
    fail("plan.runNonce must be 32-128 unpadded base64url characters");
  }
  return Object.freeze({
    schema: MESSAGING_OPERATOR_PLAN_SCHEMA,
    scenarioId: contract.scenarioId,
    operationKind,
    accountId: string(plan.accountId, "plan.accountId"),
    connectionRefSha256: hash(
      plan.connectionRefSha256,
      "plan.connectionRefSha256",
    ),
    runNonce,
  });
}

/** Validate authorization plus exact target, input, and probe material offline. */
export function preflightMessagingOperatorCanary(input: {
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
}): MessagingOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== plan.scenarioId)
    fail("scenario does not match the operator plan");
  const operation = validateProviderOperationRawBinding({
    kind: plan.operationKind,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
  }) as MessagingRawOperation;
  const execution = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: plan.operationKind,
    providerTarget: operation.providerTarget,
    operationInput: operation.operationInput,
    failureProbes: input.failureProbes,
  });
  if (execution.authorization.manifest.run.nonce !== plan.runNonce) {
    fail("plan run nonce does not match the signed manifest");
  }
  const contract = CONTRACT_BY_KIND[plan.operationKind];
  const connector = execution.authorization.manifest.connectors.find(
    (candidate) => candidate.provider === contract.connectorProvider,
  );
  if (!connector)
    fail(
      `signed manifest does not bind the ${contract.connectorProvider} connector`,
    );
  if (connector.connectionRefSha256 !== plan.connectionRefSha256) {
    fail("plan connection does not match the signed connector");
  }
  const accountRefSha256 = createHash("sha256")
    .update(plan.accountId)
    .digest("hex");
  if (connector.accountRefSha256 !== accountRefSha256) {
    fail("plan accountId does not match the signed account reference");
  }
  const result = Object.freeze({
    status: "messaging-operator-inputs-validated",
    scenarioId: plan.scenarioId,
    authorization: execution.authorization,
    execution,
    plan,
    operation,
    failureProbeExecutions: bindValidatedFailureProbeExecutions({
      materials: input.failureProbes,
      bindings: execution.failureProbeBindings,
    }),
  }) satisfies MessagingOperatorPreflight;
  validatedPreflights.add(result);
  return result;
}

function parseCapabilities(value: unknown): MessagingExternalCapabilities {
  const capabilities = record(value, "capabilities");
  const keys = [
    "assertCredentialReady",
    "sendAuthenticatedIngress",
    "exportDeployedTrajectory",
    "collectAuthenticatedProviderReadback",
    "replayAuthenticatedIngress",
    "executeIndependentFailureProbes",
  ] as const;
  exactKeys(capabilities, "capabilities", keys);
  for (const key of keys) {
    if (typeof capabilities[key] !== "function")
      fail(`capabilities.${key} is required`);
  }
  return capabilities as unknown as MessagingExternalCapabilities;
}

function parseCredential(
  value: unknown,
  preflight: MessagingOperatorPreflight,
): MessagingCredentialReceipt {
  const receipt = record(value, "credentialReceipt");
  exactKeys(receipt, "credentialReceipt", [
    "accountId",
    "connectionRefSha256",
    "grantedCapabilities",
    "checkedAtIso",
  ]);
  if (
    receipt.accountId !== preflight.plan.accountId ||
    receipt.connectionRefSha256 !== preflight.plan.connectionRefSha256
  ) {
    fail("credential receipt does not match the signed account and connection");
  }
  const required =
    CONTRACT_BY_KIND[preflight.plan.operationKind].requiredCapability;
  if (
    !Array.isArray(receipt.grantedCapabilities) ||
    !receipt.grantedCapabilities.every((item) => typeof item === "string") ||
    !receipt.grantedCapabilities.includes(required)
  ) {
    fail("credential receipt does not grant the required provider capability");
  }
  return Object.freeze({
    accountId: preflight.plan.accountId,
    connectionRefSha256: preflight.plan.connectionRefSha256,
    grantedCapabilities: Object.freeze([...receipt.grantedCapabilities]),
    checkedAtIso: iso(receipt.checkedAtIso, "credentialReceipt.checkedAtIso"),
  });
}

function requireOperationHashes(
  receipt: Record<string, unknown>,
  preflight: MessagingOperatorPreflight,
  path: string,
): void {
  if (
    receipt.providerTargetRefSha256 !==
      preflight.execution.targetBinding.providerTargetRefSha256 ||
    receipt.operationInputSha256 !==
      preflight.execution.targetBinding.operationInputSha256
  ) {
    fail(
      `${path} does not correlate to the signed provider target and operation input`,
    );
  }
}

function parseIngress(
  value: unknown,
  preflight: MessagingOperatorPreflight,
): MessagingIngressReceipt {
  const receipt = record(value, "ingressReceipt");
  exactKeys(receipt, "ingressReceipt", [
    "requestId",
    "acceptedAtIso",
    "scenarioId",
    "runNonce",
    "providerTargetRefSha256",
    "operationInputSha256",
  ]);
  if (
    receipt.scenarioId !== preflight.scenarioId ||
    receipt.runNonce !== preflight.plan.runNonce
  ) {
    fail("authenticated ingress receipt does not correlate to the signed run");
  }
  requireOperationHashes(receipt, preflight, "authenticated ingress receipt");
  return Object.freeze({
    requestId: string(receipt.requestId, "ingressReceipt.requestId"),
    acceptedAtIso: iso(receipt.acceptedAtIso, "ingressReceipt.acceptedAtIso"),
    scenarioId: preflight.scenarioId,
    runNonce: preflight.plan.runNonce,
    providerTargetRefSha256:
      preflight.execution.targetBinding.providerTargetRefSha256,
    operationInputSha256:
      preflight.execution.targetBinding.operationInputSha256,
  });
}

function parseReadback(
  value: unknown,
  preflight: MessagingOperatorPreflight,
): MessagingReadbackReceipt {
  const receipt = record(value, "readbackReceipt");
  exactKeys(receipt, "readbackReceipt", [
    "providerMessageId",
    "observedAtIso",
    "providerPayloadSha256",
    "providerTargetRefSha256",
    "operationInputSha256",
    "providerAccepted",
  ]);
  if (receipt.providerAccepted !== true)
    fail("provider readback was not accepted");
  requireOperationHashes(receipt, preflight, "provider readback receipt");
  return Object.freeze({
    providerMessageId: string(
      receipt.providerMessageId,
      "readbackReceipt.providerMessageId",
    ),
    observedAtIso: iso(receipt.observedAtIso, "readbackReceipt.observedAtIso"),
    providerPayloadSha256: hash(
      receipt.providerPayloadSha256,
      "readbackReceipt.providerPayloadSha256",
    ),
    providerTargetRefSha256:
      preflight.execution.targetBinding.providerTargetRefSha256,
    operationInputSha256:
      preflight.execution.targetBinding.operationInputSha256,
    providerAccepted: true,
  });
}

function parseReplay(
  value: unknown,
  expectedBinding: Readonly<ProviderReplayBinding>,
): MessagingReplayReceipt {
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
  preflight: MessagingOperatorPreflight,
): readonly MessagingFailureProbeReceipt[] {
  if (!Array.isArray(value)) fail("failureProbeReceipts must be an array");
  const expected = preflight.authorization.manifest.requiredFailureProbes;
  if (value.length !== expected.length)
    fail("failure probe receipt count does not match the signed manifest");
  const seen = new Set<string>();
  const receipts = value.map((item, index) => {
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
    if (!contract || receipt.failureClass !== contract.failureClass)
      fail(`${path} does not match a signed probe`);
    if (seen.has(contract.probeId)) fail(`${path} duplicates a signed probe`);
    seen.add(contract.probeId);
    if (receipt.statusCode !== contract.expectedStatusCode)
      fail(`${path} status does not match the signed probe`);
    const before = hash(
      receipt.providerStateBeforeSha256,
      `${path}.providerStateBeforeSha256`,
    );
    const after = hash(
      receipt.providerStateAfterSha256,
      `${path}.providerStateAfterSha256`,
    );
    if (before !== after) fail(`${path} changed provider state`);
    const requestHash =
      receipt.providerRequestIdSha256 === null
        ? null
        : hash(
            receipt.providerRequestIdSha256,
            `${path}.providerRequestIdSha256`,
          );
    if (
      (contract.failureClass === "authorization-denied" &&
        requestHash !== null) ||
      (contract.failureClass === "provider-rejected" && requestHash === null)
    ) {
      fail(`${path} has invalid provider request correlation`);
    }
    const errorHash = hash(receipt.errorCodeSha256, `${path}.errorCodeSha256`);
    if (errorHash !== contract.expectedErrorCodeSha256)
      fail(`${path} error does not match the signed probe`);
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
      errorCodeSha256: errorHash,
      requestPayloadSha256,
      scopeSha256,
      authorizationGrantSha256,
      responsePayloadSha256,
      providerRequestIdSha256: requestHash,
      providerStateBeforeSha256: before,
      providerStateAfterSha256: after,
    });
  });
  if (seen.size !== expected.length)
    fail("failure probe receipts do not cover every signed probe exactly once");
  return Object.freeze(receipts);
}

/**
 * Drive the protected production seams in evidence-preserving order. All six
 * capability functions are checked before credential access or ingress.
 */
export async function executeMessagingOperatorCanary(input: {
  preflight: MessagingOperatorPreflight;
  capabilities: MessagingExternalCapabilities;
  now?: () => number;
}): Promise<MessagingRawReceipt> {
  if (!validatedPreflights.has(input.preflight)) {
    fail(
      "execution requires the exact result of preflightMessagingOperatorCanary",
    );
  }
  const capabilities = parseCapabilities(input.capabilities);
  const contract = CONTRACT_BY_KIND[input.preflight.plan.operationKind];
  const credential = parseCredential(
    await capabilities.assertCredentialReady({
      connectorProvider: contract.connectorProvider,
      accountId: input.preflight.plan.accountId,
      requiredCapability: contract.requiredCapability,
    }),
    input.preflight,
  );
  const ingress = parseIngress(
    await capabilities.sendAuthenticatedIngress({
      scenarioId: input.preflight.scenarioId,
      runNonce: input.preflight.plan.runNonce,
      operation: input.preflight.operation,
    }),
    input.preflight,
  );
  const readback = parseReadback(
    await capabilities.collectAuthenticatedProviderReadback({
      scenarioId: input.preflight.scenarioId,
      operation: input.preflight.operation,
      ingressRequestId: ingress.requestId,
    }),
    input.preflight,
  );
  const replayBinding = buildProviderReplayBinding({
    scenarioId: input.preflight.scenarioId,
    runId: input.preflight.authorization.manifest.run.runId,
    runNonce: input.preflight.plan.runNonce,
    ingressRequestId: ingress.requestId,
    providerEventId: readback.providerMessageId,
    effectSha256: readback.providerPayloadSha256,
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
      scenarioId: input.preflight.scenarioId,
      operation: input.preflight.operation,
      probes: input.preflight.failureProbeExecutions,
    }),
    input.preflight,
  );
  const trajectoryMaterial = await capabilities.exportDeployedTrajectory({
    scenarioId: input.preflight.scenarioId,
    runNonce: input.preflight.plan.runNonce,
    ingressRequestId: ingress.requestId,
  });
  const collectedAtMs = (input.now ?? Date.now)();
  const trajectory = verifyDeployedTrajectoryRun({
    material: trajectoryMaterial,
    expectedRunId: input.preflight.authorization.manifest.run.runId,
    expectedScenarioId: input.preflight.scenarioId,
    now: new Date(collectedAtMs),
  });
  assertRawReceiptChronology({
    timestamps: [
      credential.checkedAtIso,
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
    schema: MESSAGING_RAW_RECEIPT_SCHEMA,
    scenarioId: input.preflight.scenarioId,
    operationKind: input.preflight.plan.operationKind,
    collectedAtIso: new Date(collectedAtMs).toISOString(),
    credential,
    ingress,
    readback,
    replay,
    failureProbes,
    trajectory,
    qualificationClaimed: false,
  });
}
