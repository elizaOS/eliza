/**
 * Revalidates portable provider-controller receipts after a process boundary.
 * These checks deliberately repeat the controller's acceptance contract so a
 * nested mutation cannot become trusted merely because its outer object was
 * canonicalized and hashed by the coordinator.
 */

import { createHash } from "node:crypto";
import {
  BLUEBUBBLES_RAW_RECEIPT_SCHEMA,
  type BlueBubblesRawReceipt,
} from "./bluebubbles-operator-controller.ts";
import type { ProviderCanaryScenarioId } from "./canary-catalog.ts";
import type { DeployedCompositeRawControllerMaterial } from "./controller-orchestrator-bridge.ts";
import type { VerifiedDeployedCanaryExecution } from "./deployed-capability-contract.ts";
import {
  DUFFEL_RAW_RECEIPT_SCHEMA,
  type DuffelRawReceipt,
} from "./duffel-operator-controller.ts";
import {
  GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA,
  type GoogleWorkspaceRawReceipt,
} from "./google-workspace-operator-controller.ts";
import {
  canonicalJsonValue,
  canonicalSha256,
  type ProviderFailureProbeContract,
  type ProviderQualificationManifest,
} from "./manifest.ts";
import {
  MESSAGING_RAW_RECEIPT_SCHEMA,
  type MessagingRawReceipt,
} from "./messaging-operator-controller.ts";
import {
  type ProviderOperationKind,
  validateProviderOperationRawBinding,
} from "./operation-binding.ts";
import type {
  ProviderFailureProbeHashBinding,
  ProviderFailureProbeMaterial,
} from "./operator-authorization.ts";
import { createProviderFailureProbeHashBinding } from "./operator-authorization.ts";
import {
  assertRawReceiptChronology,
  buildProviderReplayBinding,
} from "./raw-controller-contracts.ts";
import { validateVerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

const HASH = /^[a-f0-9]{64}$/;
const DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA =
  "eliza.provider-canary-deployed-composite-raw-material.v1";
const DISCORD_ID = /^\d{17,20}$/;
const SLACK_TEAM = /^T[A-Z0-9]{5,}$/;
const SLACK_CHANNEL = /^[CDG][A-Z0-9]{5,}$/;
const SLACK_USER = /^[UW][A-Z0-9]{5,}$/;
const SLACK_BOT = /^B[A-Z0-9]{5,}$/;
const SLACK_TS = /^\d{10,16}\.\d{6}$/;
const TWILIO_ACCOUNT = /^AC[a-fA-F0-9]{32}$/;
const TWILIO_MESSAGE = /^SM[a-fA-F0-9]{32}$/;
const TWILIO_CALL = /^CA[a-fA-F0-9]{32}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const REQUIRED_RAW_CAPABILITY = Object.freeze({
  "gmail.email-send": "gmail.send",
  "google-calendar.event-create": "calendar.write",
  "google-sheets.spreadsheet-create": "drive.write",
  "signal.message-send": "signal.message.send",
  "telegram.message-send": "telegram.message.send",
  "whatsapp.message-send": "whatsapp.message.send",
  "x.direct-message-send": "x.direct-message.send",
} as const);

export interface PortableRawReceiptReverificationInput {
  value: unknown;
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  manifest: ProviderQualificationManifest;
  providerTarget: unknown;
  operationInput: unknown;
  failureProbeMaterials: readonly ProviderFailureProbeMaterial[];
  failureProbeBindings: readonly ProviderFailureProbeHashBinding[];
  now: Date;
}

function fail(message: string): never {
  throw new Error(`portable provider raw-receipt verifier ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    fail(`${path} must be a plain data object`);
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

function exact(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const item = record(value, path);
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(item, key));
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${path} violates the closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
  return item;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function matching(value: unknown, path: string, pattern: RegExp): string {
  const candidate = string(value, path);
  if (!pattern.test(candidate)) fail(`${path} has an invalid format`);
  return candidate;
}

function hash(value: unknown, path: string): string {
  return matching(value, path, HASH);
}

function iso(value: unknown, path: string): string {
  const candidate = string(value, path);
  const timestamp = Date.parse(candidate);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== candidate
  ) {
    fail(`${path} must be a canonical UTC ISO-8601 timestamp`);
  }
  return candidate;
}

function nonnegative(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(`${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function operation(input: PortableRawReceiptReverificationInput) {
  const normalized = validateProviderOperationRawBinding({
    kind: input.operationKind,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
  });
  if (
    input.manifest.scenario.id !== input.scenarioId ||
    input.manifest.run.runId.length === 0 ||
    input.manifest.run.nonce.length === 0 ||
    input.manifest.target.operation.kind !== input.operationKind
  ) {
    fail("authoritative scenario, run, or operation correlation is invalid");
  }
  if (
    input.failureProbeMaterials.length !== input.failureProbeBindings.length ||
    input.failureProbeMaterials.some((material, index) => {
      const actual = createProviderFailureProbeHashBinding(material);
      const expected = input.failureProbeBindings[index];
      return (
        expected === undefined ||
        Object.entries(actual).some(
          ([key, value]) =>
            expected[key as keyof ProviderFailureProbeHashBinding] !== value,
        )
      );
    })
  ) {
    fail(
      "raw failure-probe material does not match its authoritative hash binding",
    );
  }
  return normalized;
}

function connector(
  input: PortableRawReceiptReverificationInput,
  provider: string,
) {
  const found = input.manifest.connectors.find(
    (item) => item.provider === provider,
  );
  if (!found) fail(`manifest does not bind the ${provider} connector`);
  return found;
}

function accountMatches(
  accountId: unknown,
  expectedHash: string,
  path: string,
): string {
  const account = string(accountId, path);
  if (createHash("sha256").update(account).digest("hex") !== expectedHash) {
    fail(`${path} does not match the manifest account reference`);
  }
  return account;
}

function verifyTrajectory(
  value: unknown,
  input: PortableRawReceiptReverificationInput,
) {
  const trajectory = validateVerifiedScenarioTrajectorySet(value);
  if (
    trajectory.runId !== input.manifest.run.runId ||
    trajectory.scenarioId !== input.scenarioId
  ) {
    fail("trajectory set is correlated to another run or scenario");
  }
  return trajectory;
}

function verifyReplay(input: {
  value: unknown;
  expected: ReturnType<typeof buildProviderReplayBinding>;
  path?: string;
  duplicateFields: readonly string[];
}): string {
  const path = input.path ?? "receipt.replay";
  const receipt = record(input.value, path);
  const keys = [
    "binding",
    "replayRequestId",
    "observedAtIso",
    ...input.duplicateFields,
    "providerStateBeforeSha256",
    "providerStateAfterSha256",
  ];
  exact(receipt, path, keys);
  const binding = exact(
    receipt.binding,
    `${path}.binding`,
    Object.keys(input.expected),
  );
  for (const [key, expected] of Object.entries(input.expected)) {
    if (binding[key] !== expected) fail(`${path}.binding.${key} mismatch`);
  }
  for (const field of input.duplicateFields) {
    if (receipt[field] !== 0) fail(`${path}.${field} must be zero`);
  }
  string(receipt.replayRequestId, `${path}.replayRequestId`);
  const before = hash(
    receipt.providerStateBeforeSha256,
    `${path}.providerStateBeforeSha256`,
  );
  const after = hash(
    receipt.providerStateAfterSha256,
    `${path}.providerStateAfterSha256`,
  );
  if (before !== after) fail(`${path} changed provider state`);
  return iso(receipt.observedAtIso, `${path}.observedAtIso`);
}

function verifyFailureProbes(
  value: unknown,
  input: PortableRawReceiptReverificationInput,
): readonly string[] {
  if (!Array.isArray(value)) fail("receipt.failureProbes must be an array");
  const contracts = input.manifest.requiredFailureProbes;
  if (
    value.length !== contracts.length ||
    input.failureProbeBindings.length !== contracts.length ||
    input.failureProbeMaterials.length !== contracts.length
  ) {
    fail("failure-probe cardinality differs from the authoritative contract");
  }
  return value.map((raw, index) => {
    const path = `receipt.failureProbes[${index}]`;
    const receipt = exact(raw, path, [
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
    const contract = contracts[index];
    const binding = input.failureProbeBindings[index];
    const material = input.failureProbeMaterials[index];
    if (
      !contract ||
      !binding ||
      !material ||
      receipt.probeId !== contract.probeId ||
      binding.probeId !== contract.probeId ||
      material.probeId !== contract.probeId ||
      receipt.failureClass !== contract.failureClass ||
      receipt.statusCode !== contract.expectedStatusCode ||
      receipt.errorCodeSha256 !== contract.expectedErrorCodeSha256
    ) {
      fail(`${path} does not match the ordered signed failure-probe contract`);
    }
    for (const field of [
      "requestPayloadSha256",
      "scopeSha256",
      "authorizationGrantSha256",
    ] as const) {
      if (
        receipt[field] !== binding[field] ||
        receipt[field] !== contract[field]
      ) {
        fail(`${path}.${field} does not match the signed probe material`);
      }
      hash(receipt[field], `${path}.${field}`);
    }
    hash(receipt.errorCodeSha256, `${path}.errorCodeSha256`);
    hash(receipt.responsePayloadSha256, `${path}.responsePayloadSha256`);
    const requestId = receipt.providerRequestIdSha256;
    if (
      contract.failureClass === "authorization-denied"
        ? requestId !== null
        : requestId === null
    ) {
      fail(
        `${path}.providerRequestIdSha256 violates the failure-class boundary`,
      );
    }
    if (requestId !== null) hash(requestId, `${path}.providerRequestIdSha256`);
    const before = hash(
      receipt.providerStateBeforeSha256,
      `${path}.providerStateBeforeSha256`,
    );
    const after = hash(
      receipt.providerStateAfterSha256,
      `${path}.providerStateAfterSha256`,
    );
    if (before !== after) fail(`${path} changed provider state`);
    return iso(receipt.observedAtIso, `${path}.observedAtIso`);
  });
}

function verifyCommonChronology(input: {
  timestamps: readonly [string, string, ...string[]];
  trajectory: ReturnType<typeof validateVerifiedScenarioTrajectorySet>;
  collectedAtIso: unknown;
  now: Date;
}): string {
  if (!Number.isFinite(input.now.getTime()))
    fail("verification clock is invalid");
  const collectedAtIso = iso(input.collectedAtIso, "receipt.collectedAtIso");
  const collectedAt = Date.parse(collectedAtIso);
  if (Math.abs(collectedAt - input.now.getTime()) > 15 * 60_000) {
    fail("receipt collection time is stale or future-dated");
  }
  assertRawReceiptChronology({
    timestamps: input.timestamps,
    collectedAtMs: collectedAt,
  });
  assertRawReceiptChronology({
    timestamps: [
      input.trajectory.scenarioStartedAtIso,
      input.trajectory.scenarioEndedAtIso,
      input.trajectory.verifiedAtIso,
    ],
    collectedAtMs: collectedAt,
  });
  return collectedAtIso;
}

function verifyGoogleOrMessaging(
  raw: Record<string, unknown>,
  input: PortableRawReceiptReverificationInput,
  family: "google" | "messaging",
): GoogleWorkspaceRawReceipt | MessagingRawReceipt {
  exact(raw, "receipt", [
    "schema",
    "scenarioId",
    "operationKind",
    "collectedAtIso",
    "credential",
    "ingress",
    "readback",
    "replay",
    "failureProbes",
    "trajectory",
    "qualificationClaimed",
  ]);
  const op = operation(input);
  const expectedSchema =
    family === "google"
      ? GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA
      : MESSAGING_RAW_RECEIPT_SCHEMA;
  if (
    raw.schema !== expectedSchema ||
    raw.scenarioId !== input.scenarioId ||
    raw.operationKind !== input.operationKind ||
    raw.qualificationClaimed !== false
  )
    fail("receipt header does not match the canonical controller contract");
  const provider =
    family === "google" ? "google" : input.operationKind.split(".")[0];
  const boundConnector = connector(input, provider);
  const credential = exact(raw.credential, "receipt.credential", [
    "accountId",
    "connectionRefSha256",
    "grantedCapabilities",
    "checkedAtIso",
  ]);
  accountMatches(
    credential.accountId,
    boundConnector.accountRefSha256,
    "receipt.credential.accountId",
  );
  if (credential.connectionRefSha256 !== boundConnector.connectionRefSha256) {
    fail("credential connection does not match the manifest connector");
  }
  hash(
    credential.connectionRefSha256,
    "receipt.credential.connectionRefSha256",
  );
  if (
    !Array.isArray(credential.grantedCapabilities) ||
    credential.grantedCapabilities.length === 0 ||
    !credential.grantedCapabilities.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  )
    fail("credential capability set is invalid");
  const requiredCapability =
    REQUIRED_RAW_CAPABILITY[
      input.operationKind as keyof typeof REQUIRED_RAW_CAPABILITY
    ];
  if (
    requiredCapability !== undefined &&
    !credential.grantedCapabilities.includes(requiredCapability)
  ) {
    fail("credential capability set lacks the exact operation grant");
  }
  const ingressKeys =
    family === "messaging"
      ? [
          "requestId",
          "acceptedAtIso",
          "scenarioId",
          "runNonce",
          "providerTargetRefSha256",
          "operationInputSha256",
        ]
      : ["requestId", "acceptedAtIso", "scenarioId", "runNonce"];
  const ingress = exact(raw.ingress, "receipt.ingress", ingressKeys);
  const requestId = string(ingress.requestId, "receipt.ingress.requestId");
  if (
    ingress.scenarioId !== input.scenarioId ||
    ingress.runNonce !== input.manifest.run.nonce
  ) {
    fail("ingress is correlated to another authorized run");
  }
  if (
    family === "messaging" &&
    (ingress.providerTargetRefSha256 !==
      input.manifest.target.operation.providerTargetRefSha256 ||
      ingress.operationInputSha256 !==
        input.manifest.target.operation.operationInputSha256)
  )
    fail("messaging ingress operation hashes do not match the manifest");
  const readbackKeys =
    family === "messaging"
      ? [
          "providerMessageId",
          "observedAtIso",
          "providerPayloadSha256",
          "providerTargetRefSha256",
          "operationInputSha256",
          "providerAccepted",
        ]
      : [
          "providerResourceId",
          "observedAtIso",
          "providerPayloadSha256",
          "providerAccepted",
        ];
  const readback = exact(raw.readback, "receipt.readback", readbackKeys);
  const eventId = string(
    family === "messaging"
      ? readback.providerMessageId
      : readback.providerResourceId,
    "receipt.readback.providerResourceId",
  );
  if (readback.providerAccepted !== true)
    fail("provider readback was not accepted");
  const effectSha256 = hash(
    readback.providerPayloadSha256,
    "receipt.readback.providerPayloadSha256",
  );
  if (
    family === "messaging" &&
    (readback.providerTargetRefSha256 !==
      input.manifest.target.operation.providerTargetRefSha256 ||
      readback.operationInputSha256 !==
        input.manifest.target.operation.operationInputSha256)
  )
    fail("messaging readback operation hashes do not match the manifest");
  const replayAt = verifyReplay({
    value: raw.replay,
    expected: buildProviderReplayBinding({
      scenarioId: input.scenarioId,
      runId: input.manifest.run.runId,
      runNonce: input.manifest.run.nonce,
      ingressRequestId: requestId,
      providerEventId: eventId,
      effectSha256,
      operation: op,
    }),
    duplicateFields: ["duplicateEffectCount"],
  });
  const probeTimes = verifyFailureProbes(raw.failureProbes, input);
  const trajectory = verifyTrajectory(raw.trajectory, input);
  verifyCommonChronology({
    timestamps: [
      iso(credential.checkedAtIso, "receipt.credential.checkedAtIso"),
      iso(ingress.acceptedAtIso, "receipt.ingress.acceptedAtIso"),
      iso(readback.observedAtIso, "receipt.readback.observedAtIso"),
      replayAt,
      ...probeTimes,
    ],
    trajectory,
    collectedAtIso: raw.collectedAtIso,
    now: input.now,
  });
  return canonicalJsonValue(raw, "portableRawReceipt") as unknown as
    | GoogleWorkspaceRawReceipt
    | MessagingRawReceipt;
}

function verifyBlueBubbles(
  raw: Record<string, unknown>,
  input: PortableRawReceiptReverificationInput,
): BlueBubblesRawReceipt {
  exact(raw, "receipt", [
    "schema",
    "scenarioId",
    "operationKind",
    "collectedAtIso",
    "boundary",
    "ingress",
    "readback",
    "replay",
    "failureProbes",
    "trajectory",
    "qualificationClaimed",
  ]);
  const op = operation(input);
  if (
    raw.schema !== BLUEBUBBLES_RAW_RECEIPT_SCHEMA ||
    raw.scenarioId !== input.scenarioId ||
    raw.operationKind !== input.operationKind ||
    raw.qualificationClaimed !== false
  )
    fail("BlueBubbles receipt header mismatch");
  const boundConnector = connector(input, "bluebubbles");
  const boundary = exact(raw.boundary, "receipt.boundary", [
    "schema",
    "accountId",
    "connectionRefSha256",
    "serverOrigin",
    "serverVersion",
    "osVersion",
    "privateApiEnabled",
    "helperConnected",
    "checkedAtIso",
    "rawResponseSha256",
    "qualificationClaimed",
  ]);
  if (
    boundary.schema !== "eliza.bluebubbles-provider-canary-boundary.v1" ||
    boundary.connectionRefSha256 !== boundConnector.connectionRefSha256 ||
    boundary.qualificationClaimed !== false ||
    typeof boundary.privateApiEnabled !== "boolean" ||
    typeof boundary.helperConnected !== "boolean"
  )
    fail("BlueBubbles boundary is invalid");
  accountMatches(
    boundary.accountId,
    boundConnector.accountRefSha256,
    "receipt.boundary.accountId",
  );
  const origin = string(boundary.serverOrigin, "receipt.boundary.serverOrigin");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    fail("BlueBubbles server origin is invalid");
  }
  if (parsedOrigin.origin !== origin || parsedOrigin.protocol !== "https:") {
    fail("BlueBubbles server origin is not an exact HTTPS origin");
  }
  string(boundary.serverVersion, "receipt.boundary.serverVersion");
  string(boundary.osVersion, "receipt.boundary.osVersion");
  hash(boundary.rawResponseSha256, "receipt.boundary.rawResponseSha256");
  const ingress = exact(raw.ingress, "receipt.ingress", [
    "requestId",
    "acceptedAtIso",
    "scenarioId",
    "runNonce",
  ]);
  const requestId = string(ingress.requestId, "receipt.ingress.requestId");
  if (
    ingress.scenarioId !== input.scenarioId ||
    ingress.runNonce !== input.manifest.run.nonce
  )
    fail("BlueBubbles ingress correlation mismatch");
  const readback = exact(raw.readback, "receipt.readback", [
    "messageGuid",
    "chatGuid",
    "textSha256",
    "isFromMe",
    "threadOriginatorGuid",
    "observedAtIso",
    "rawProviderResponseSha256",
    "qualificationClaimed",
  ]);
  const typedOp = op as Extract<
    typeof op,
    { kind: "bluebubbles.message-send" }
  >;
  if (
    readback.chatGuid !== typedOp.providerTarget.chatGuid ||
    readback.textSha256 !==
      createHash("sha256").update(typedOp.operationInput.text).digest("hex") ||
    readback.isFromMe !== true ||
    readback.threadOriginatorGuid !== null ||
    readback.qualificationClaimed !== false
  )
    fail("BlueBubbles readback does not match the signed operation");
  const eventId = string(readback.messageGuid, "receipt.readback.messageGuid");
  const effect = hash(
    readback.rawProviderResponseSha256,
    "receipt.readback.rawProviderResponseSha256",
  );
  const replayAt = verifyReplay({
    value: raw.replay,
    expected: buildProviderReplayBinding({
      scenarioId: input.scenarioId,
      runId: input.manifest.run.runId,
      runNonce: input.manifest.run.nonce,
      ingressRequestId: requestId,
      providerEventId: eventId,
      effectSha256: effect,
      operation: op,
    }),
    duplicateFields: ["duplicateEffectCount"],
  });
  const probeTimes = verifyFailureProbes(raw.failureProbes, input);
  const trajectory = verifyTrajectory(raw.trajectory, input);
  verifyCommonChronology({
    timestamps: [
      iso(boundary.checkedAtIso, "receipt.boundary.checkedAtIso"),
      iso(ingress.acceptedAtIso, "receipt.ingress.acceptedAtIso"),
      iso(readback.observedAtIso, "receipt.readback.observedAtIso"),
      replayAt,
      ...probeTimes,
    ],
    trajectory,
    collectedAtIso: raw.collectedAtIso,
    now: input.now,
  });
  return canonicalJsonValue(
    raw,
    "portableRawReceipt",
  ) as unknown as BlueBubblesRawReceipt;
}

function verifyDuffel(
  raw: Record<string, unknown>,
  input: PortableRawReceiptReverificationInput,
): DuffelRawReceipt {
  exact(raw, "receipt", [
    "schema",
    "scenarioId",
    "collectedAtIso",
    "credential",
    "proposal",
    "preapprovalNoEffect",
    "approval",
    "readback",
    "replay",
    "failureProbes",
    "trajectory",
    "qualificationClaimed",
  ]);
  const op = operation(input) as Extract<
    ReturnType<typeof operation>,
    { kind: "duffel.booking-hold-create" }
  >;
  if (
    raw.schema !== DUFFEL_RAW_RECEIPT_SCHEMA ||
    raw.scenarioId !== input.scenarioId ||
    raw.qualificationClaimed !== false
  )
    fail("Duffel receipt header mismatch");
  const boundConnector = connector(input, "duffel");
  if (boundConnector.environment !== "sandbox")
    fail("Duffel connector is not sandbox-bound");
  const credential = exact(raw.credential, "receipt.credential", [
    "accountId",
    "connectionRefSha256",
    "environment",
    "liveMode",
    "readWrite",
    "checkedAtIso",
  ]);
  accountMatches(
    credential.accountId,
    boundConnector.accountRefSha256,
    "receipt.credential.accountId",
  );
  if (
    credential.connectionRefSha256 !== boundConnector.connectionRefSha256 ||
    credential.environment !== "sandbox" ||
    credential.liveMode !== false ||
    credential.readWrite !== true
  )
    fail("Duffel credential is not the exact writable sandbox binding");
  const approvalPayloadSha256 = canonicalSha256(
    canonicalJsonValue(
      {
        action: "book_travel",
        kind: "flight",
        provider: "duffel",
        offerId: op.providerTarget.offerId,
        orderType: op.operationInput.orderType,
        totalCents: op.operationInput.totalCents,
        currency: op.operationInput.currency,
        passengers: op.operationInput.passengers,
        calendarSync: op.operationInput.calendarSync,
      },
      "duffelApprovalPayload",
    ),
    "duffelApprovalPayload",
  );
  const turn = (value: unknown, path: string, state: "pending" | "done") => {
    const receipt = exact(value, path, [
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
        input.manifest.target.principalRefSha256 ||
      receipt.approvalPayloadSha256 !== approvalPayloadSha256 ||
      receipt.state !== state
    )
      fail(`${path} approval binding mismatch`);
    const pending = state === "pending";
    if (
      pending
        ? receipt.approvedAtIso !== null ||
          receipt.doneAtIso !== null ||
          receipt.providerOrderId !== null
        : receipt.approvedAtIso === null ||
          receipt.doneAtIso === null ||
          receipt.providerOrderId === null
    )
      fail(`${path} lifecycle shape is invalid`);
    return {
      requestId: string(receipt.requestId, `${path}.requestId`),
      acceptedAtIso: iso(receipt.acceptedAtIso, `${path}.acceptedAtIso`),
      approvalIdSha256: hash(
        receipt.approvalIdSha256,
        `${path}.approvalIdSha256`,
      ),
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
    };
  };
  const proposal = turn(raw.proposal, "receipt.proposal", "pending");
  const approval = turn(raw.approval, "receipt.approval", "done");
  if (
    proposal.approvalIdSha256 !== approval.approvalIdSha256 ||
    proposal.requestId === approval.requestId
  )
    fail(
      "Duffel approval turns are not one immutable, distinct-request lifecycle",
    );
  const noEffect = exact(
    raw.preapprovalNoEffect,
    "receipt.preapprovalNoEffect",
    [
      "scopeSha256",
      "observationStartedAtIso",
      "observationEndedAtIso",
      "providerStateBeforeSha256",
      "providerStateAfterSha256",
      "orderCreateCount",
      "paymentCreateCount",
    ],
  );
  const noEffectContracts = input.manifest.requiredObservations.filter(
    (item): item is Extract<typeof item, { kind: "provider-no-effect" }> =>
      item.kind === "provider-no-effect" && item.provider === "duffel",
  );
  if (
    noEffectContracts.length !== 1 ||
    noEffect.scopeSha256 !== noEffectContracts[0]?.scopeSha256 ||
    noEffect.orderCreateCount !== 0 ||
    noEffect.paymentCreateCount !== 0 ||
    hash(
      noEffect.providerStateBeforeSha256,
      "receipt.preapprovalNoEffect.providerStateBeforeSha256",
    ) !==
      hash(
        noEffect.providerStateAfterSha256,
        "receipt.preapprovalNoEffect.providerStateAfterSha256",
      )
  )
    fail("Duffel preapproval no-effect proof is invalid");
  const observationStart = iso(
    noEffect.observationStartedAtIso,
    "receipt.preapprovalNoEffect.observationStartedAtIso",
  );
  const observationEnd = iso(
    noEffect.observationEndedAtIso,
    "receipt.preapprovalNoEffect.observationEndedAtIso",
  );
  if (
    Date.parse(observationStart) > Date.parse(proposal.acceptedAtIso) ||
    Date.parse(observationEnd) < Date.parse(proposal.acceptedAtIso) ||
    Date.parse(observationEnd) > Date.parse(approval.acceptedAtIso)
  )
    fail(
      "Duffel preapproval observation does not bound only the proposal phase",
    );
  const readback = exact(raw.readback, "receipt.readback", [
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
  const expectedPassengers = op.operationInput.passengers.map(
    (item) => item.offerPassengerId,
  );
  if (
    readback.orderId !== approval.providerOrderId ||
    readback.liveMode !== false ||
    readback.providerAccepted !== true ||
    readback.orderType !== "hold" ||
    readback.offerId !== op.providerTarget.offerId ||
    readback.totalCents !== op.operationInput.totalCents ||
    readback.currency !== op.operationInput.currency ||
    !Array.isArray(readback.passengerIds) ||
    readback.passengerIds.length !== expectedPassengers.length ||
    readback.passengerIds.some(
      (item, index) => item !== expectedPassengers[index],
    ) ||
    readback.awaitingPayment !== true ||
    readback.paymentCount !== 0 ||
    readback.calendarMutationCount !== 0
  )
    fail("Duffel readback does not match the payment-free signed hold");
  const readbackAt = iso(
    readback.observedAtIso,
    "receipt.readback.observedAtIso",
  );
  const effect = hash(
    readback.providerPayloadSha256,
    "receipt.readback.providerPayloadSha256",
  );
  const replayAt = verifyReplay({
    value: raw.replay,
    expected: buildProviderReplayBinding({
      scenarioId: input.scenarioId,
      runId: input.manifest.run.runId,
      runNonce: input.manifest.run.nonce,
      ingressRequestId: approval.requestId,
      providerEventId: string(readback.orderId, "receipt.readback.orderId"),
      effectSha256: effect,
      operation: op,
    }),
    duplicateFields: ["duplicateOrderCount", "duplicatePaymentCount"],
  });
  const probeTimes = verifyFailureProbes(raw.failureProbes, input);
  const trajectory = verifyTrajectory(raw.trajectory, input);
  verifyCommonChronology({
    timestamps: [
      iso(credential.checkedAtIso, "receipt.credential.checkedAtIso"),
      proposal.acceptedAtIso,
      observationEnd,
      approval.acceptedAtIso,
      approval.approvedAtIso as string,
      approval.doneAtIso as string,
      readbackAt,
      replayAt,
      ...probeTimes,
    ],
    trajectory,
    collectedAtIso: raw.collectedAtIso,
    now: input.now,
  });
  return canonicalJsonValue(
    raw,
    "portableRawReceipt",
  ) as unknown as DuffelRawReceipt;
}

function verifyDeployedFailureProbe(input: {
  value: unknown;
  index: number;
  binding: ProviderFailureProbeHashBinding;
  contract: ProviderFailureProbeContract;
  base: {
    descriptorSha256: string;
    scenarioId: string;
    runId: string;
    failureProbeBindingsSha256: string;
  };
}): string {
  const path = `receipt.deployedExecution.failureProbes[${input.index}]`;
  const receipt = exact(input.value, path, [
    "probeId",
    "requestPayloadSha256",
    "expectedErrorCodeSha256",
    "scopeSha256",
    "authorizationGrantSha256",
    "descriptorSha256",
    "scenarioId",
    "runId",
    "failureProbeBindingsSha256",
    "failureProbeContractSha256",
    "failureClass",
    "expectedStatusCode",
    "observedAtIso",
    "expectedFailureObserved",
    "providerEffectCountBefore",
    "providerEffectCountAfter",
  ]);
  for (const key of [
    "descriptorSha256",
    "scenarioId",
    "runId",
    "failureProbeBindingsSha256",
  ] as const)
    if (receipt[key] !== input.base[key])
      fail(`${path}.${key} correlation mismatch`);
  for (const key of [
    "probeId",
    "requestPayloadSha256",
    "expectedErrorCodeSha256",
    "scopeSha256",
    "authorizationGrantSha256",
  ] as const)
    if (receipt[key] !== input.binding[key])
      fail(`${path}.${key} binding mismatch`);
  if (
    receipt.failureProbeContractSha256 !==
      canonicalSha256(
        input.contract,
        `failureProbeContract.${input.contract.probeId}`,
      ) ||
    receipt.failureClass !== input.contract.failureClass ||
    receipt.expectedStatusCode !== input.contract.expectedStatusCode ||
    receipt.expectedFailureObserved !== true
  )
    fail(`${path} signed contract mismatch`);
  const before = nonnegative(
    receipt.providerEffectCountBefore,
    `${path}.providerEffectCountBefore`,
  );
  const after = nonnegative(
    receipt.providerEffectCountAfter,
    `${path}.providerEffectCountAfter`,
  );
  if (before !== after) fail(`${path} changed provider effect count`);
  return iso(receipt.observedAtIso, `${path}.observedAtIso`);
}

/** Reverify a portable deployed execution without trusting the producing process. */
export function reverifyVerifiedDeployedCanaryExecution(
  input: PortableRawReceiptReverificationInput & { value: unknown },
): VerifiedDeployedCanaryExecution {
  const execution = exact(input.value, "receipt.deployedExecution", [
    "binding",
    "ingress",
    "trajectories",
    "replay",
    "failureProbes",
    "cleanup",
    "qualificationClaimed",
  ]);
  if (execution.qualificationClaimed !== false)
    fail("deployed execution claimed qualification");
  operation(input);
  const binding = exact(
    execution.binding,
    "receipt.deployedExecution.binding",
    [
      "descriptorSha256",
      "scenarioId",
      "runId",
      "manifestSha256",
      "ingressEndpoint",
      "ingressRequestSha256",
      "operationBindingSha256",
      "failureProbeBindingsSha256",
    ],
  );
  const descriptorSha256 = hash(
    binding.descriptorSha256,
    "receipt.deployedExecution.binding.descriptorSha256",
  );
  const operationBindingSha256 = canonicalSha256(
    input.manifest.target.operation,
    "operationBinding",
  );
  const failureProbeBindingsSha256 = canonicalSha256(
    input.failureProbeBindings,
    "failureProbeBindings",
  );
  if (
    binding.scenarioId !== input.scenarioId ||
    binding.runId !== input.manifest.run.runId ||
    binding.manifestSha256 !== input.manifest.manifestSha256 ||
    binding.operationBindingSha256 !== operationBindingSha256 ||
    binding.failureProbeBindingsSha256 !== failureProbeBindingsSha256
  )
    fail("deployed execution binding is cross-run or cross-operation");
  hash(
    binding.ingressRequestSha256,
    "receipt.deployedExecution.binding.ingressRequestSha256",
  );
  let endpoint: URL;
  try {
    endpoint = new URL(
      string(
        binding.ingressEndpoint,
        "receipt.deployedExecution.binding.ingressEndpoint",
      ),
    );
  } catch {
    fail("deployed ingress endpoint is invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    createHash("sha256").update(endpoint.origin).digest("hex") !==
      input.manifest.ingress.endpointOriginSha256
  )
    fail("deployed ingress endpoint does not match the manifest origin");
  const ingress = exact(
    execution.ingress,
    "receipt.deployedExecution.ingress",
    [
      "descriptorSha256",
      "scenarioId",
      "runId",
      "manifestSha256",
      "ingressEndpointOriginSha256",
      "ingressRequestSha256",
      "operationBindingSha256",
      "authenticationProofSha256",
      "correlationId",
      "acceptedAtIso",
      "authenticated",
    ],
  );
  for (const key of [
    "descriptorSha256",
    "scenarioId",
    "runId",
    "manifestSha256",
    "ingressRequestSha256",
    "operationBindingSha256",
  ] as const)
    if (ingress[key] !== binding[key]) fail(`deployed ingress ${key} mismatch`);
  if (
    ingress.ingressEndpointOriginSha256 !==
      input.manifest.ingress.endpointOriginSha256 ||
    ingress.authenticated !== true
  )
    fail("deployed ingress authentication/origin proof mismatch");
  hash(
    ingress.authenticationProofSha256,
    "receipt.deployedExecution.ingress.authenticationProofSha256",
  );
  const correlationId = string(
    ingress.correlationId,
    "receipt.deployedExecution.ingress.correlationId",
  );
  const acceptedAt = iso(
    ingress.acceptedAtIso,
    "receipt.deployedExecution.ingress.acceptedAtIso",
  );
  const trajectories = verifyTrajectory(execution.trajectories, input);
  if (
    Date.parse(acceptedAt) < Date.parse(trajectories.scenarioStartedAtIso) ||
    Date.parse(acceptedAt) > Date.parse(trajectories.scenarioEndedAtIso)
  )
    fail("deployed trajectory interval does not contain ingress");
  const replay = exact(execution.replay, "receipt.deployedExecution.replay", [
    "descriptorSha256",
    "scenarioId",
    "runId",
    "originalCorrelationId",
    "replayCorrelationId",
    "ingressRequestSha256",
    "operationBindingSha256",
    "effectCountBefore",
    "effectCountAfter",
    "replayObservedAtIso",
    "authenticated",
    "noAdditionalEffect",
  ]);
  for (const key of [
    "descriptorSha256",
    "scenarioId",
    "runId",
    "ingressRequestSha256",
    "operationBindingSha256",
  ] as const)
    if (replay[key] !== binding[key]) fail(`deployed replay ${key} mismatch`);
  if (
    replay.originalCorrelationId !== correlationId ||
    replay.replayCorrelationId === correlationId ||
    replay.authenticated !== true ||
    replay.noAdditionalEffect !== true ||
    nonnegative(
      replay.effectCountBefore,
      "receipt.deployedExecution.replay.effectCountBefore",
    ) !==
      nonnegative(
        replay.effectCountAfter,
        "receipt.deployedExecution.replay.effectCountAfter",
      )
  )
    fail("deployed replay does not prove authenticated no-effect replay");
  string(
    replay.replayCorrelationId,
    "receipt.deployedExecution.replay.replayCorrelationId",
  );
  const replayAt = iso(
    replay.replayObservedAtIso,
    "receipt.deployedExecution.replay.replayObservedAtIso",
  );
  if (Date.parse(replayAt) < Date.parse(trajectories.scenarioEndedAtIso))
    fail("deployed replay predates the original trajectory");
  if (
    !Array.isArray(execution.failureProbes) ||
    execution.failureProbes.length !== input.failureProbeBindings.length ||
    execution.failureProbes.length !==
      input.manifest.requiredFailureProbes.length
  )
    fail("deployed failure-probe cardinality mismatch");
  const probeTimes = execution.failureProbes.map((receipt, index) =>
    verifyDeployedFailureProbe({
      value: receipt,
      index,
      binding: input.failureProbeBindings[
        index
      ] as ProviderFailureProbeHashBinding,
      contract: input.manifest.requiredFailureProbes[
        index
      ] as ProviderFailureProbeContract,
      base: {
        descriptorSha256,
        scenarioId: input.scenarioId,
        runId: input.manifest.run.runId,
        failureProbeBindingsSha256,
      },
    }),
  );
  const cleanup = exact(
    execution.cleanup,
    "receipt.deployedExecution.cleanup",
    [
      "descriptorSha256",
      "scenarioId",
      "runId",
      "correlationId",
      "reconciliationOwnerRefSha256",
      "status",
      "completedAtIso",
    ],
  );
  if (
    cleanup.descriptorSha256 !== descriptorSha256 ||
    cleanup.scenarioId !== input.scenarioId ||
    cleanup.runId !== input.manifest.run.runId ||
    cleanup.correlationId !== correlationId ||
    cleanup.status !== "cleaned"
  )
    fail("deployed cleanup is incomplete or cross-run");
  hash(
    cleanup.reconciliationOwnerRefSha256,
    "receipt.deployedExecution.cleanup.reconciliationOwnerRefSha256",
  );
  const cleanupAt = iso(
    cleanup.completedAtIso,
    "receipt.deployedExecution.cleanup.completedAtIso",
  );
  assertRawReceiptChronology({
    timestamps: [
      trajectories.scenarioStartedAtIso,
      acceptedAt,
      trajectories.scenarioEndedAtIso,
      trajectories.verifiedAtIso,
      replayAt,
      ...probeTimes,
      cleanupAt,
    ],
    collectedAtMs: input.now.getTime(),
  });
  return canonicalJsonValue(
    execution,
    "portableDeployedExecution",
  ) as unknown as VerifiedDeployedCanaryExecution;
}

function verifyCompositeReadback(
  value: unknown,
  input: PortableRawReceiptReverificationInput,
  family: "discord" | "slack" | "twilio",
): void {
  const op = operation(input);
  if (family === "twilio") {
    const raw = exact(value, "receipt.providerReadback", [
      "schema",
      "collectedAtIso",
      "channel",
      "resourceSid",
      "accountSid",
      "fromE164",
      "toE164",
      "direction",
      "status",
      "providerAccepted",
      "payloadSha256",
      "rawResponseSha256",
      "qualificationClaimed",
    ]);
    const sms = input.operationKind === "twilio.sms-send";
    const typed = op as Extract<
      typeof op,
      { kind: "twilio.sms-send" | "twilio.call-create" }
    >;
    if (
      raw.schema !== "eliza.twilio-provider-canary-raw-status.v1" ||
      raw.channel !== (sms ? "sms" : "voice") ||
      !matching(
        raw.resourceSid,
        "receipt.providerReadback.resourceSid",
        sms ? TWILIO_MESSAGE : TWILIO_CALL,
      ) ||
      !matching(
        raw.accountSid,
        "receipt.providerReadback.accountSid",
        TWILIO_ACCOUNT,
      ) ||
      raw.fromE164 !== typed.providerTarget.fromE164 ||
      raw.toE164 !== typed.providerTarget.toE164 ||
      !E164.test(String(raw.fromE164)) ||
      !E164.test(String(raw.toE164)) ||
      raw.direction !== "outbound-api" ||
      raw.status !== (sms ? "delivered" : "completed") ||
      raw.providerAccepted !== true ||
      raw.qualificationClaimed !== false
    )
      fail(
        "Twilio composite readback does not match the signed completed operation",
      );
    const payload = sms
      ? createHash("sha256")
          .update((typed.operationInput as { body: string }).body)
          .digest("hex")
      : null;
    if (raw.payloadSha256 !== payload)
      fail("Twilio composite readback payload mismatch");
    hash(raw.rawResponseSha256, "receipt.providerReadback.rawResponseSha256");
    iso(raw.collectedAtIso, "receipt.providerReadback.collectedAtIso");
    return;
  }
  const keys =
    family === "discord"
      ? [
          "schema",
          "collectedAtIso",
          "channelId",
          "observerIdentity",
          "humanIngress",
          "providerEffect",
          "qualificationClaimed",
        ]
      : [
          "schema",
          "collectedAtIso",
          "teamId",
          "channelId",
          "observerIdentity",
          "humanIngress",
          "providerEffect",
          "qualificationClaimed",
        ];
  const raw = exact(value, "receipt.providerReadback", keys);
  const typed = op as Extract<
    typeof op,
    { kind: "discord.message-send" | "slack.message-send" }
  >;
  if (
    raw.channelId !== typed.providerTarget.channelId ||
    raw.qualificationClaimed !== false ||
    raw.schema !== `eliza.${family}-provider-canary-raw-readback.v1`
  )
    fail(`${family} composite readback header/target mismatch`);
  iso(raw.collectedAtIso, "receipt.providerReadback.collectedAtIso");
  if (family === "discord") {
    const identity = exact(
      raw.observerIdentity,
      "receipt.providerReadback.observerIdentity",
      ["userId", "bot", "rawResponseSha256"],
    );
    matching(
      identity.userId,
      "receipt.providerReadback.observerIdentity.userId",
      DISCORD_ID,
    );
    if (identity.bot !== true) fail("Discord observer is not a bot identity");
    hash(
      identity.rawResponseSha256,
      "receipt.providerReadback.observerIdentity.rawResponseSha256",
    );
    const message = (value: unknown, path: string, bot: boolean) => {
      const item = exact(value, path, [
        "messageId",
        "channelId",
        "guildId",
        "author",
        "timestamp",
        "content",
        "contentSha256",
      ]);
      const author = exact(item.author, `${path}.author`, ["id", "bot"]);
      matching(item.messageId, `${path}.messageId`, DISCORD_ID);
      matching(author.id, `${path}.author.id`, DISCORD_ID);
      if (
        author.bot !== bot ||
        item.channelId !== typed.providerTarget.channelId ||
        (item.guildId !== null && !DISCORD_ID.test(String(item.guildId))) ||
        item.contentSha256 !==
          createHash("sha256")
            .update(string(item.content, `${path}.content`))
            .digest("hex")
      )
        fail(`${path} is invalid`);
      return {
        id: item.messageId,
        at: iso(item.timestamp, `${path}.timestamp`),
        content: item.content,
      };
    };
    const human = message(
      raw.humanIngress,
      "receipt.providerReadback.humanIngress",
      false,
    );
    const effect = message(
      raw.providerEffect,
      "receipt.providerReadback.providerEffect",
      true,
    );
    if (
      human.id === effect.id ||
      Date.parse(effect.at) <= Date.parse(human.at) ||
      effect.content !== (typed.operationInput as { text: string }).text
    )
      fail("Discord provider effect is not a later exact signed message");
  } else {
    const identity = exact(
      raw.observerIdentity,
      "receipt.providerReadback.observerIdentity",
      ["teamId", "observerUserId", "url"],
    );
    if (identity.teamId !== raw.teamId)
      fail("Slack observer workspace mismatch");
    matching(raw.teamId, "receipt.providerReadback.teamId", SLACK_TEAM);
    matching(
      raw.channelId,
      "receipt.providerReadback.channelId",
      SLACK_CHANNEL,
    );
    matching(
      identity.observerUserId,
      "receipt.providerReadback.observerIdentity.observerUserId",
      SLACK_USER,
    );
    string(identity.url, "receipt.providerReadback.observerIdentity.url");
    const message = (value: unknown, path: string, bot: boolean) => {
      const item = exact(value, path, [
        "timestamp",
        "userId",
        "botId",
        "text",
        "textSha256",
      ]);
      matching(item.timestamp, `${path}.timestamp`, SLACK_TS);
      matching(item.userId, `${path}.userId`, SLACK_USER);
      if (
        bot
          ? item.botId === null || !SLACK_BOT.test(String(item.botId))
          : item.botId !== null
      )
        fail(`${path}.botId is invalid`);
      const text = string(item.text, `${path}.text`);
      if (item.textSha256 !== createHash("sha256").update(text).digest("hex"))
        fail(`${path}.textSha256 mismatch`);
      return { at: item.timestamp as string, text };
    };
    const human = message(
      raw.humanIngress,
      "receipt.providerReadback.humanIngress",
      false,
    );
    const effect = message(
      raw.providerEffect,
      "receipt.providerReadback.providerEffect",
      true,
    );
    if (
      Number(effect.at) <= Number(human.at) ||
      effect.text !== (typed.operationInput as { text: string }).text
    )
      fail("Slack provider effect is not a later exact signed message");
  }
}

function verifyComposite(
  raw: Record<string, unknown>,
  input: PortableRawReceiptReverificationInput,
): DeployedCompositeRawControllerMaterial {
  exact(raw, "receipt", [
    "schema",
    "scenarioId",
    "operationKind",
    "controllerFamily",
    "deployedExecution",
    "providerReadback",
    "qualificationClaimed",
  ]);
  const expectedFamily = input.operationKind.startsWith("twilio.")
    ? "twilio"
    : input.operationKind.split(".")[0];
  if (
    raw.schema !== DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA ||
    raw.scenarioId !== input.scenarioId ||
    raw.operationKind !== input.operationKind ||
    raw.controllerFamily !== expectedFamily ||
    raw.qualificationClaimed !== false
  )
    fail("deployed composite header mismatch");
  reverifyVerifiedDeployedCanaryExecution({
    ...input,
    value: raw.deployedExecution,
  });
  verifyCompositeReadback(
    raw.providerReadback,
    input,
    expectedFamily as "discord" | "slack" | "twilio",
  );
  return canonicalJsonValue(
    raw,
    "portableRawReceipt",
  ) as unknown as DeployedCompositeRawControllerMaterial;
}

/** Reverify one complete raw-controller family before hashing or signing. */
export function reverifyPortableRawControllerMaterial(
  input: PortableRawReceiptReverificationInput,
):
  | BlueBubblesRawReceipt
  | DuffelRawReceipt
  | GoogleWorkspaceRawReceipt
  | MessagingRawReceipt
  | DeployedCompositeRawControllerMaterial {
  record(input.value, "receipt");
  const raw = input.value as Record<string, unknown>;
  switch (raw.schema) {
    case BLUEBUBBLES_RAW_RECEIPT_SCHEMA:
      return verifyBlueBubbles(raw, input);
    case DUFFEL_RAW_RECEIPT_SCHEMA:
      return verifyDuffel(raw, input);
    case GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA:
      return verifyGoogleOrMessaging(
        raw,
        input,
        "google",
      ) as GoogleWorkspaceRawReceipt;
    case MESSAGING_RAW_RECEIPT_SCHEMA:
      return verifyGoogleOrMessaging(
        raw,
        input,
        "messaging",
      ) as MessagingRawReceipt;
    case DEPLOYED_COMPOSITE_RAW_MATERIAL_SCHEMA:
      return verifyComposite(raw, input);
    default:
      fail("receipt schema is unsupported");
  }
}
