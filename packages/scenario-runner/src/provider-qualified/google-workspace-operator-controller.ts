/**
 * Defines the fail-closed operator boundary for Gmail, Google Calendar, and
 * Google Drive/Sheets provider canaries. Signed raw operation material is
 * validated before any external capability runs; collected receipts remain
 * unsigned source material and never claim qualification.
 */

import { createHash } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import type {
  ProviderOperationInputByKind,
  ProviderOperationRawBinding,
  ProviderOperationTargetByKind,
} from "./operation-binding.ts";
import { validateProviderOperationRawBinding } from "./operation-binding.ts";
import {
  type AuthorizedProviderCanaryExecutionPreflight,
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";

export const GOOGLE_WORKSPACE_OPERATOR_PLAN_SCHEMA =
  "eliza.google-workspace-provider-canary-operator-plan.v1" as const;
export const GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA =
  "eliza.google-workspace-provider-canary-raw-receipt.v1" as const;

export type GoogleWorkspaceCanaryKind =
  | "gmail.email-send"
  | "google-calendar.event-create"
  | "google-sheets.spreadsheet-create";

type GoogleRawOperation = Extract<
  ProviderOperationRawBinding,
  { kind: GoogleWorkspaceCanaryKind }
>;

const SCENARIO_BY_KIND = Object.freeze({
  "gmail.email-send": "provider.gmail.confirmed-send",
  "google-calendar.event-create": "provider.google-calendar.create",
  "google-sheets.spreadsheet-create": "provider.google-sheets.create",
} as const satisfies Record<GoogleWorkspaceCanaryKind, string>);

const CAPABILITY_BY_KIND = Object.freeze({
  "gmail.email-send": "gmail.send",
  "google-calendar.event-create": "calendar.write",
  "google-sheets.spreadsheet-create": "drive.write",
} as const satisfies Record<GoogleWorkspaceCanaryKind, string>);

const GOOGLE_KIND_SET = new Set<string>(Object.keys(SCENARIO_BY_KIND));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const validatedPreflights = new WeakSet<object>();

export interface GoogleWorkspaceOperatorPlan {
  schema: typeof GOOGLE_WORKSPACE_OPERATOR_PLAN_SCHEMA;
  scenarioId: (typeof SCENARIO_BY_KIND)[GoogleWorkspaceCanaryKind];
  operationKind: GoogleWorkspaceCanaryKind;
  accountId: string;
  connectionRefSha256: string;
  runNonce: string;
}

export interface GoogleWorkspaceOperatorPreflight {
  status: "google-workspace-operator-inputs-validated";
  scenarioId: GoogleWorkspaceOperatorPlan["scenarioId"];
  authorization: ProviderCanaryAuthorization;
  execution: AuthorizedProviderCanaryExecutionPreflight;
  plan: GoogleWorkspaceOperatorPlan;
  operation: GoogleRawOperation;
}

export interface GoogleCredentialReceipt {
  accountId: string;
  connectionRefSha256: string;
  grantedCapabilities: readonly string[];
  checkedAtIso: string;
}

export interface GoogleAuthenticatedIngressReceipt {
  requestId: string;
  acceptedAtIso: string;
  scenarioId: string;
  runNonce: string;
}

export interface GoogleProviderReadbackReceipt {
  providerResourceId: string;
  observedAtIso: string;
  providerPayloadSha256: string;
  providerAccepted: true;
}

export interface GoogleReplayReceipt {
  replayRequestId: string;
  observedAtIso: string;
  duplicateEffectCount: 0;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface GoogleFailureProbeReceipt {
  probeId: string;
  failureClass: "authorization-denied" | "provider-rejected";
  observedAtIso: string;
  statusCode: number;
  errorCodeSha256: string;
  providerRequestIdSha256: string | null;
  providerStateBeforeSha256: string;
  providerStateAfterSha256: string;
}

export interface GoogleTrajectoryExportReceipt {
  exportId: string;
  exportedAtIso: string;
  trajectoryCount: number;
  exportSha256: string;
}

export interface GoogleWorkspaceRawReceipt {
  schema: typeof GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA;
  scenarioId: GoogleWorkspaceOperatorPlan["scenarioId"];
  operationKind: GoogleWorkspaceCanaryKind;
  collectedAtIso: string;
  credential: GoogleCredentialReceipt;
  ingress: GoogleAuthenticatedIngressReceipt;
  readback: GoogleProviderReadbackReceipt;
  replay: GoogleReplayReceipt;
  failureProbes: readonly GoogleFailureProbeReceipt[];
  trajectory: GoogleTrajectoryExportReceipt;
  qualificationClaimed: false;
}

export interface GoogleWorkspaceExternalCapabilities {
  assertCredentialReady(input: {
    accountId: string;
    requiredCapability: string;
  }): Promise<unknown>;
  sendAuthenticatedIngress(input: {
    scenarioId: string;
    runNonce: string;
    operation: GoogleRawOperation;
  }): Promise<unknown>;
  exportDeployedTrajectory(input: {
    scenarioId: string;
    runNonce: string;
    ingressRequestId: string;
  }): Promise<unknown>;
  collectIndependentReadback(input: {
    scenarioId: string;
    operation: GoogleRawOperation;
    ingressRequestId: string;
  }): Promise<unknown>;
  replayAuthenticatedIngress(input: {
    scenarioId: string;
    runNonce: string;
    ingressRequestId: string;
  }): Promise<unknown>;
  executeIndependentFailureProbes(input: {
    scenarioId: string;
    operation: GoogleRawOperation;
    probeIds: readonly string[];
  }): Promise<unknown>;
}

/** The exact mutation methods exposed by `GoogleWorkspaceService`. */
export interface GoogleWorkspaceProductionOperationService {
  sendGmailMessage(input: {
    accountId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    bodyText: string;
  }): Promise<unknown>;
  createEvent(input: {
    accountId: string;
    calendarId: string;
    title: string;
    start: string;
    end: string;
    timeZone: string;
    attendees: [];
    location?: string;
    description?: string;
    createMeetLink: false;
    sendUpdates: "none";
    recurrence: [];
    idempotencyKey: string;
  }): Promise<unknown>;
  createDriveFile(input: {
    accountId: string;
    parentFolderId: string;
    name: string;
    mimeType: "application/vnd.google-apps.spreadsheet";
  }): Promise<unknown>;
}

function fail(message: string): never {
  throw new Error(`google workspace provider-canary operator ${message}`);
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

function scenarioForKind(kind: GoogleWorkspaceCanaryKind): string {
  return SCENARIO_BY_KIND[kind];
}

function parsePlan(value: unknown): GoogleWorkspaceOperatorPlan {
  const plan = record(value, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "scenarioId",
    "operationKind",
    "accountId",
    "connectionRefSha256",
    "runNonce",
  ]);
  if (plan.schema !== GOOGLE_WORKSPACE_OPERATOR_PLAN_SCHEMA) {
    fail("plan.schema is unsupported");
  }
  const operationKind = string(plan.operationKind, "plan.operationKind");
  if (!GOOGLE_KIND_SET.has(operationKind)) {
    fail("plan.operationKind is not a Google Workspace canary operation");
  }
  const kind = operationKind as GoogleWorkspaceCanaryKind;
  const scenarioId = string(plan.scenarioId, "plan.scenarioId");
  if (scenarioId !== scenarioForKind(kind)) {
    fail("plan scenario and operation kind do not match");
  }
  const runNonce = string(plan.runNonce, "plan.runNonce");
  if (!NONCE_PATTERN.test(runNonce)) {
    fail("plan.runNonce must be 32-128 unpadded base64url characters");
  }
  return Object.freeze({
    schema: GOOGLE_WORKSPACE_OPERATOR_PLAN_SCHEMA,
    scenarioId: scenarioId as GoogleWorkspaceOperatorPlan["scenarioId"],
    operationKind: kind,
    accountId: string(plan.accountId, "plan.accountId"),
    connectionRefSha256: hash(
      plan.connectionRefSha256,
      "plan.connectionRefSha256",
    ),
    runNonce,
  });
}

/** Validate signed authorization and every raw mutation/probe input offline. */
export function preflightGoogleWorkspaceOperatorCanary(input: {
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
}): GoogleWorkspaceOperatorPreflight {
  const plan = parsePlan(input.plan);
  if (input.scenario.id !== plan.scenarioId) {
    fail("scenario does not match the operator plan");
  }
  const operation = validateProviderOperationRawBinding({
    kind: plan.operationKind,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
  }) as GoogleRawOperation;
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
  const connector = execution.authorization.manifest.connectors.find(
    (candidate) => candidate.provider === "google",
  );
  if (!connector) fail("signed manifest does not bind a Google connector");
  if (connector.connectionRefSha256 !== plan.connectionRefSha256) {
    fail("plan connection does not match the signed Google connector");
  }
  const expectedAccountHash = createHash("sha256")
    .update(plan.accountId)
    .digest("hex");
  if (connector.accountRefSha256 !== expectedAccountHash) {
    fail("plan accountId does not match the signed Google account reference");
  }
  const result = Object.freeze({
    status: "google-workspace-operator-inputs-validated",
    scenarioId: plan.scenarioId,
    authorization: execution.authorization,
    execution,
    plan,
    operation,
  }) satisfies GoogleWorkspaceOperatorPreflight;
  validatedPreflights.add(result);
  return result;
}

function parseCapabilities(
  value: unknown,
): GoogleWorkspaceExternalCapabilities {
  const capabilities = record(value, "capabilities");
  const keys = [
    "assertCredentialReady",
    "sendAuthenticatedIngress",
    "exportDeployedTrajectory",
    "collectIndependentReadback",
    "replayAuthenticatedIngress",
    "executeIndependentFailureProbes",
  ] as const;
  exactKeys(capabilities, "capabilities", keys);
  for (const key of keys) {
    if (typeof capabilities[key] !== "function") {
      fail(`capabilities.${key} is required`);
    }
  }
  return capabilities as unknown as GoogleWorkspaceExternalCapabilities;
}

function parseCredential(
  value: unknown,
  preflight: GoogleWorkspaceOperatorPreflight,
) {
  const receipt = record(value, "credentialReceipt");
  exactKeys(receipt, "credentialReceipt", [
    "accountId",
    "connectionRefSha256",
    "grantedCapabilities",
    "checkedAtIso",
  ]);
  if (receipt.accountId !== preflight.plan.accountId) {
    fail("credential receipt account does not match the signed plan");
  }
  if (receipt.connectionRefSha256 !== preflight.plan.connectionRefSha256) {
    fail("credential receipt connection does not match the signed plan");
  }
  if (
    !Array.isArray(receipt.grantedCapabilities) ||
    !receipt.grantedCapabilities.every((item) => typeof item === "string") ||
    !receipt.grantedCapabilities.includes(
      CAPABILITY_BY_KIND[preflight.plan.operationKind],
    )
  ) {
    fail("credential receipt does not grant the required Google capability");
  }
  return Object.freeze({
    accountId: preflight.plan.accountId,
    connectionRefSha256: preflight.plan.connectionRefSha256,
    grantedCapabilities: Object.freeze([...receipt.grantedCapabilities]),
    checkedAtIso: iso(receipt.checkedAtIso, "credentialReceipt.checkedAtIso"),
  });
}

function parseIngress(
  value: unknown,
  preflight: GoogleWorkspaceOperatorPreflight,
) {
  const receipt = record(value, "ingressReceipt");
  exactKeys(receipt, "ingressReceipt", [
    "requestId",
    "acceptedAtIso",
    "scenarioId",
    "runNonce",
  ]);
  if (
    receipt.scenarioId !== preflight.scenarioId ||
    receipt.runNonce !== preflight.plan.runNonce
  ) {
    fail("authenticated ingress receipt does not correlate to the signed run");
  }
  return Object.freeze({
    requestId: string(receipt.requestId, "ingressReceipt.requestId"),
    acceptedAtIso: iso(receipt.acceptedAtIso, "ingressReceipt.acceptedAtIso"),
    scenarioId: preflight.scenarioId,
    runNonce: preflight.plan.runNonce,
  });
}

function parseReadback(value: unknown): GoogleProviderReadbackReceipt {
  const receipt = record(value, "readbackReceipt");
  exactKeys(receipt, "readbackReceipt", [
    "providerResourceId",
    "observedAtIso",
    "providerPayloadSha256",
    "providerAccepted",
  ]);
  if (receipt.providerAccepted !== true)
    fail("provider readback was not accepted");
  return Object.freeze({
    providerResourceId: string(
      receipt.providerResourceId,
      "readbackReceipt.providerResourceId",
    ),
    observedAtIso: iso(receipt.observedAtIso, "readbackReceipt.observedAtIso"),
    providerPayloadSha256: hash(
      receipt.providerPayloadSha256,
      "readbackReceipt.providerPayloadSha256",
    ),
    providerAccepted: true,
  });
}

function parseReplay(value: unknown): GoogleReplayReceipt {
  const receipt = record(value, "replayReceipt");
  exactKeys(receipt, "replayReceipt", [
    "replayRequestId",
    "observedAtIso",
    "duplicateEffectCount",
    "providerStateBeforeSha256",
    "providerStateAfterSha256",
  ]);
  if (receipt.duplicateEffectCount !== 0) {
    fail("authenticated replay produced a duplicate provider effect");
  }
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
  preflight: GoogleWorkspaceOperatorPreflight,
): readonly GoogleFailureProbeReceipt[] {
  if (!Array.isArray(value)) fail("failureProbeReceipts must be an array");
  const expected = preflight.authorization.manifest.requiredFailureProbes;
  if (value.length !== expected.length) {
    fail("failure probe receipt count does not match the signed manifest");
  }
  const seenProbeIds = new Set<string>();
  const parsed = Object.freeze(
    value.map((item, index) => {
      const receipt = record(item, `failureProbeReceipts[${index}]`);
      exactKeys(receipt, `failureProbeReceipts[${index}]`, [
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
      if (!contract || receipt.failureClass !== contract.failureClass) {
        fail(`failureProbeReceipts[${index}] does not match a signed probe`);
      }
      if (seenProbeIds.has(contract.probeId)) {
        fail(`failureProbeReceipts[${index}] duplicates a signed probe`);
      }
      seenProbeIds.add(contract.probeId);
      if (receipt.statusCode !== contract.expectedStatusCode) {
        fail(
          `failureProbeReceipts[${index}] status does not match the signed probe`,
        );
      }
      const before = hash(
        receipt.providerStateBeforeSha256,
        `failureProbeReceipts[${index}].providerStateBeforeSha256`,
      );
      const after = hash(
        receipt.providerStateAfterSha256,
        `failureProbeReceipts[${index}].providerStateAfterSha256`,
      );
      if (before !== after)
        fail(`failureProbeReceipts[${index}] changed provider state`);
      const providerRequestIdSha256 =
        receipt.providerRequestIdSha256 === null
          ? null
          : hash(
              receipt.providerRequestIdSha256,
              `failureProbeReceipts[${index}].providerRequestIdSha256`,
            );
      if (
        (contract.failureClass === "authorization-denied" &&
          providerRequestIdSha256 !== null) ||
        (contract.failureClass === "provider-rejected" &&
          providerRequestIdSha256 === null)
      ) {
        fail(
          `failureProbeReceipts[${index}] has invalid provider request correlation`,
        );
      }
      const errorCodeSha256 = hash(
        receipt.errorCodeSha256,
        `failureProbeReceipts[${index}].errorCodeSha256`,
      );
      if (errorCodeSha256 !== contract.expectedErrorCodeSha256) {
        fail(
          `failureProbeReceipts[${index}] error does not match the signed probe`,
        );
      }
      return Object.freeze({
        probeId: contract.probeId,
        failureClass: contract.failureClass,
        observedAtIso: iso(
          receipt.observedAtIso,
          `failureProbeReceipts[${index}].observedAtIso`,
        ),
        statusCode: positiveInteger(
          receipt.statusCode,
          `failureProbeReceipts[${index}].statusCode`,
        ),
        errorCodeSha256,
        providerRequestIdSha256,
        providerStateBeforeSha256: before,
        providerStateAfterSha256: after,
      });
    }),
  );
  if (seenProbeIds.size !== expected.length) {
    fail("failure probe receipts do not cover every signed probe exactly once");
  }
  return parsed;
}

function parseTrajectory(value: unknown): GoogleTrajectoryExportReceipt {
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

/**
 * Drive one externally hosted canary and collect raw unsigned receipts. Every
 * capability is validated before the first callback, preventing a partial run
 * when credentials or an evidence boundary are missing.
 */
export async function executeGoogleWorkspaceOperatorCanary(input: {
  preflight: GoogleWorkspaceOperatorPreflight;
  capabilities: GoogleWorkspaceExternalCapabilities;
  now?: () => number;
}): Promise<GoogleWorkspaceRawReceipt> {
  if (!validatedPreflights.has(input.preflight)) {
    fail(
      "execution requires the exact result of preflightGoogleWorkspaceOperatorCanary",
    );
  }
  const capabilities = parseCapabilities(input.capabilities);
  const requiredCapability =
    CAPABILITY_BY_KIND[input.preflight.plan.operationKind];
  const credential = parseCredential(
    await capabilities.assertCredentialReady({
      accountId: input.preflight.plan.accountId,
      requiredCapability,
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
    await capabilities.collectIndependentReadback({
      scenarioId: input.preflight.scenarioId,
      operation: input.preflight.operation,
      ingressRequestId: ingress.requestId,
    }),
  );
  const replay = parseReplay(
    await capabilities.replayAuthenticatedIngress({
      scenarioId: input.preflight.scenarioId,
      runNonce: input.preflight.plan.runNonce,
      ingressRequestId: ingress.requestId,
    }),
  );
  const failureProbes = parseFailureProbes(
    await capabilities.executeIndependentFailureProbes({
      scenarioId: input.preflight.scenarioId,
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
      scenarioId: input.preflight.scenarioId,
      runNonce: input.preflight.plan.runNonce,
      ingressRequestId: ingress.requestId,
    }),
  );
  return Object.freeze({
    schema: GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA,
    scenarioId: input.preflight.scenarioId,
    operationKind: input.preflight.plan.operationKind,
    collectedAtIso: new Date((input.now ?? Date.now)()).toISOString(),
    credential,
    ingress,
    readback,
    replay,
    failureProbes,
    trajectory,
    qualificationClaimed: false,
  });
}

export interface GoogleWorkspaceRawMutationReceipt {
  operationKind: GoogleWorkspaceCanaryKind;
  providerResourceId: string;
  rawResultSha256: string;
  qualificationClaimed: false;
}

/**
 * Adapt a validated operation to the real `GoogleWorkspaceService` mutation
 * methods. This helper belongs behind authenticated deployed ingress; invoking
 * it directly is not provider qualification and returns only an unsigned hash.
 */
export async function dispatchGoogleWorkspaceBoundOperation(input: {
  preflight: GoogleWorkspaceOperatorPreflight;
  credentialReceipt: unknown;
  service: GoogleWorkspaceProductionOperationService;
}): Promise<GoogleWorkspaceRawMutationReceipt> {
  if (!validatedPreflights.has(input.preflight)) {
    fail("dispatch requires the exact validated Google Workspace preflight");
  }
  parseCredential(input.credentialReceipt, input.preflight);
  const { accountId, operationKind } = input.preflight.plan;
  const target = input.preflight.operation.providerTarget as never;
  const operation = input.preflight.operation.operationInput as never;
  let result: unknown;
  if (operationKind === "gmail.email-send") {
    const typedTarget =
      target as ProviderOperationTargetByKind["gmail.email-send"];
    const typedInput =
      operation as ProviderOperationInputByKind["gmail.email-send"];
    result = await input.service.sendGmailMessage({
      accountId,
      to: [typedTarget.recipientEmail],
      cc: typedInput.cc,
      bcc: typedInput.bcc,
      subject: typedInput.subject,
      bodyText: typedInput.bodyText,
    });
  } else if (operationKind === "google-calendar.event-create") {
    const typedTarget =
      target as ProviderOperationTargetByKind["google-calendar.event-create"];
    const typedInput =
      operation as ProviderOperationInputByKind["google-calendar.event-create"];
    result = await input.service.createEvent({
      accountId,
      calendarId: typedTarget.calendarId,
      title: typedInput.title,
      start: typedInput.start,
      end: typedInput.end,
      timeZone: typedInput.timeZone,
      attendees: typedInput.attendees,
      createMeetLink: typedInput.createMeetLink,
      sendUpdates: typedInput.sendUpdates,
      recurrence: typedInput.recurrence,
      idempotencyKey: typedInput.idempotencyKey,
    });
  } else {
    const typedTarget =
      target as ProviderOperationTargetByKind["google-sheets.spreadsheet-create"];
    const typedInput =
      operation as ProviderOperationInputByKind["google-sheets.spreadsheet-create"];
    result = await input.service.createDriveFile({
      accountId,
      parentFolderId: typedTarget.parentFolderId,
      name: typedInput.name,
      mimeType: typedInput.mimeType,
    });
  }
  const normalized = record(
    canonicalJsonValue(result, "googleWorkspaceMutationResult"),
    "googleWorkspaceMutationResult",
  );
  const providerResourceId = string(
    normalized.messageId ?? normalized.id,
    "googleWorkspaceMutationResult provider resource id",
  );
  return Object.freeze({
    operationKind,
    providerResourceId,
    rawResultSha256: canonicalSha256(
      normalized,
      "googleWorkspaceMutationResult",
    ),
    qualificationClaimed: false,
  });
}
