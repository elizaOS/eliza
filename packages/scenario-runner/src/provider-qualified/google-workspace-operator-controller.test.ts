/**
 * Exercises the Google Workspace operator boundary with real Ed25519 manifest
 * authorization and deterministic external capability/service doubles; no
 * mocked result is treated as provider qualification.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import gmailScenario from "../../../test/scenarios/provider-qualified/provider.gmail.confirmed-send.scenario.ts";
import calendarScenario from "../../../test/scenarios/provider-qualified/provider.google-calendar.create.scenario.ts";
import sheetsScenario from "../../../test/scenarios/provider-qualified/provider.google-sheets.create.scenario.ts";
import {
  dispatchGoogleWorkspaceBoundOperation,
  executeGoogleWorkspaceOperatorCanary,
  type GoogleWorkspaceCanaryKind,
  type GoogleWorkspaceExternalCapabilities,
  type GoogleWorkspaceOperatorPlan,
  preflightGoogleWorkspaceOperatorCanary,
} from "./google-workspace-operator-controller.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const connectionRefSha256 = digest("operator-google-workspace-connection");
const runNonce = "g".repeat(64);
const timestamp = "2026-08-20T18:00:00.000Z";

const CASES = {
  "gmail.email-send": {
    scenario: gmailScenario,
    provider: "gmail",
    accountId: "operator-gmail-canary-account",
    operation: "email-send",
    contractId: "gmail-canary-email-send",
    capability: "gmail.send",
    target: { recipientEmail: "recipient.canary@example.com" },
    input: {
      subject: "elizaOS provider canary",
      bodyText: "Gmail provider canary delivery",
      cc: [],
      bcc: [],
    },
  },
  "google-calendar.event-create": {
    scenario: calendarScenario,
    provider: "google-calendar",
    accountId: "operator-google-calendar-canary-account",
    operation: "event-create",
    contractId: "google-calendar-canary-event-create",
    capability: "calendar.write",
    target: { calendarId: "operator-canary-calendar@example.com" },
    input: {
      title: "elizaOS provider canary event",
      start: "2026-08-21T10:00:00-07:00",
      end: "2026-08-21T10:15:00-07:00",
      timeZone: "America/Los_Angeles",
      attendees: [],
      location: null,
      description: null,
      createMeetLink: false,
      sendUpdates: "none",
      recurrence: [],
      idempotencyKey: "google-calendar-canary-run-001",
    },
  },
  "google-sheets.spreadsheet-create": {
    scenario: sheetsScenario,
    provider: "google-drive",
    accountId: "operator-google-drive-canary-account",
    operation: "spreadsheet-create",
    contractId: "google-drive-canary-spreadsheet-create",
    capability: "drive.write",
    target: { parentFolderId: "operator-canary-folder-id" },
    input: {
      name: "elizaOS provider canary sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
      content: null,
    },
  },
} as const;

type Case = (typeof CASES)[GoogleWorkspaceCanaryKind];

function probeMaterials(kind: GoogleWorkspaceCanaryKind) {
  const accountId = CASES[kind].accountId;
  return [
    {
      probeId: `${kind}-authorization-denied`,
      requestPayload: { operation: kind, effect: "must-not-run" },
      expectedErrorCode: "missing-google-scope",
      scope: { accountId },
      authorizationGrant: { grant: "denied" },
    },
    {
      probeId: `${kind}-provider-rejected`,
      requestPayload: { operation: kind, target: "invalid" },
      expectedErrorCode: "google-invalid-target",
      scope: { accountId },
      authorizationGrant: { grant: CASES[kind].capability },
    },
  ] as const;
}

function fixture(kind: GoogleWorkspaceCanaryKind) {
  const item: Case = CASES[kind];
  const accountId = item.accountId;
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const keyId = providerObserverKeyId(publicKeyPem);
  const accountRefSha256 = digest(accountId);
  const principalRefSha256 = digest("operator-google-principal");
  const roomRefSha256 = digest(`operator-google-room:${kind}`);
  const probes = probeMaterials(kind);
  const [authorizationDenied, providerRejected] = probes.map(
    createProviderFailureProbeHashBinding,
  );
  const bindings: ProviderRunBindings = {
    runId: `google-operator-${kind.replaceAll(".", "-")}`,
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: keyId,
      observerSigners: [
        {
          observerId: `${item.provider}-provider-observer`,
          keyId: digest(`${item.provider}-independent-observer`),
        },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind,
        providerTarget: item.target,
        operationInput: item.input,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "live-acting-provider",
      actingModel: "live-acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId: digest("independent-google-judge-key"),
    },
    connectors: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "google",
      channel: `${item.provider}-authenticated-ingress`,
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: digest("https://deployed-agent.example.test"),
    },
    capabilities: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        capability: item.operation,
        authorizationGrantSha256: digest(item.operation),
      },
    ],
    observationContracts: [
      {
        contractId: item.contractId,
        kind: "provider-effect",
        observerId: `${item.provider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.provider,
        environment: "operator-canary",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: item.provider,
        operation: item.operation,
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: `${item.provider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.provider,
        environment: "operator-canary",
        provider: item.provider,
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: item.operation,
        failureClass: "authorization-denied",
        requestPayloadSha256: authorizationDenied.requestPayloadSha256,
        expectedStatusCode: 403,
        expectedErrorCodeSha256: authorizationDenied.expectedErrorCodeSha256,
        scopeSha256: authorizationDenied.scopeSha256,
        authorizationGrantSha256: authorizationDenied.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: providerRejected.probeId,
        observerId: `${item.provider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.provider,
        environment: "operator-canary",
        provider: item.provider,
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: item.operation,
        failureClass: "provider-rejected",
        requestPayloadSha256: providerRejected.requestPayloadSha256,
        expectedStatusCode: 400,
        expectedErrorCodeSha256: providerRejected.expectedErrorCodeSha256,
        scopeSha256: providerRejected.scopeSha256,
        authorizationGrantSha256: providerRejected.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
  const authorization = authorizeProviderCanary({
    scenario: item.scenario,
    bindings,
    manifestAuthorityPrivateKey: authority.privateKey,
  });
  const plan: GoogleWorkspaceOperatorPlan = {
    schema: "eliza.google-workspace-provider-canary-operator-plan.v1",
    scenarioId: item.scenario.id as GoogleWorkspaceOperatorPlan["scenarioId"],
    operationKind: kind,
    accountId,
    connectionRefSha256,
    runNonce,
  };
  return {
    scenario: item.scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget: item.target,
    operationInput: item.input,
    failureProbes: probes,
    plan,
  };
}

function preflight(kind: GoogleWorkspaceCanaryKind) {
  return preflightGoogleWorkspaceOperatorCanary(fixture(kind));
}

function capabilities(
  kind: GoogleWorkspaceCanaryKind,
): GoogleWorkspaceExternalCapabilities {
  const item = CASES[kind];
  const accountId = item.accountId;
  const state = digest(`${kind}-provider-state`);
  return {
    assertCredentialReady: vi.fn(async () => ({
      accountId,
      connectionRefSha256,
      grantedCapabilities: [item.capability],
      checkedAtIso: timestamp,
    })),
    sendAuthenticatedIngress: vi.fn(async () => ({
      requestId: `${kind}-ingress-request`,
      acceptedAtIso: timestamp,
      scenarioId: item.scenario.id,
      runNonce,
    })),
    collectIndependentReadback: vi.fn(async () => ({
      providerResourceId: `${kind}-provider-resource`,
      observedAtIso: timestamp,
      providerPayloadSha256: digest(`${kind}-provider-payload`),
      providerAccepted: true,
    })),
    replayAuthenticatedIngress: vi.fn(async () => ({
      replayRequestId: `${kind}-replay-request`,
      observedAtIso: timestamp,
      duplicateEffectCount: 0,
      providerStateBeforeSha256: state,
      providerStateAfterSha256: state,
    })),
    executeIndependentFailureProbes: vi.fn(async () =>
      probeMaterials(kind).map((probe, index) => ({
        probeId: probe.probeId,
        failureClass:
          index === 0 ? "authorization-denied" : "provider-rejected",
        observedAtIso: timestamp,
        statusCode: index === 0 ? 403 : 400,
        errorCodeSha256:
          createProviderFailureProbeHashBinding(probe).expectedErrorCodeSha256,
        providerRequestIdSha256:
          index === 0 ? null : digest(`${kind}-provider-rejection-request`),
        providerStateBeforeSha256: state,
        providerStateAfterSha256: state,
      })),
    ),
    exportDeployedTrajectory: vi.fn(async () => ({
      exportId: `${kind}-trajectory-export`,
      exportedAtIso: timestamp,
      trajectoryCount: 1,
      exportSha256: digest(`${kind}-trajectory`),
    })),
  };
}

describe("Google Workspace provider-canary operator", () => {
  it.each(Object.keys(CASES) as GoogleWorkspaceCanaryKind[])(
    "validates and collects a complete unsigned %s receipt",
    async (kind) => {
      const input = capabilities(kind);
      const receipt = await executeGoogleWorkspaceOperatorCanary({
        preflight: preflight(kind),
        capabilities: input,
        now: () => Date.parse(timestamp),
      });
      expect(receipt.operationKind).toBe(kind);
      expect(receipt.qualificationClaimed).toBe(false);
      expect(receipt.failureProbes).toHaveLength(2);
      expect(input.sendAuthenticatedIngress).toHaveBeenCalledOnce();
      expect(input.collectIndependentReadback).toHaveBeenCalledOnce();
      expect(input.replayAuthenticatedIngress).toHaveBeenCalledOnce();
      expect(input.executeIndependentFailureProbes).toHaveBeenCalledOnce();
      expect(input.exportDeployedTrajectory).toHaveBeenCalledOnce();
    },
  );

  it("rejects signed target drift before any external capability can run", async () => {
    const raw = fixture("gmail.email-send");
    const external = capabilities("gmail.email-send");
    expect(() =>
      preflightGoogleWorkspaceOperatorCanary({
        ...raw,
        providerTarget: { recipientEmail: "different@example.com" },
      }),
    ).toThrow(/provider target or operation input does not match/);
    expect(external.assertCredentialReady).not.toHaveBeenCalled();
  });

  it("requires every evidence capability before checking credentials or ingress", async () => {
    const external = capabilities("gmail.email-send");
    const { exportDeployedTrajectory: _missing, ...incomplete } = external;
    await expect(
      executeGoogleWorkspaceOperatorCanary({
        preflight: preflight("gmail.email-send"),
        capabilities: incomplete as GoogleWorkspaceExternalCapabilities,
      }),
    ).rejects.toThrow(/closed shape.*exportDeployedTrajectory/);
    expect(external.assertCredentialReady).not.toHaveBeenCalled();
    expect(external.sendAuthenticatedIngress).not.toHaveBeenCalled();
  });

  it("fails closed on missing Google scope before authenticated ingress", async () => {
    const external = capabilities("google-calendar.event-create");
    external.assertCredentialReady = vi.fn(async () => ({
      accountId: CASES["google-calendar.event-create"].accountId,
      connectionRefSha256,
      grantedCapabilities: ["calendar.read"],
      checkedAtIso: timestamp,
    }));
    await expect(
      executeGoogleWorkspaceOperatorCanary({
        preflight: preflight("google-calendar.event-create"),
        capabilities: external,
      }),
    ).rejects.toThrow(/does not grant the required Google capability/);
    expect(external.sendAuthenticatedIngress).not.toHaveBeenCalled();
  });

  it("rejects replay state changes instead of claiming idempotency", async () => {
    const external = capabilities("google-sheets.spreadsheet-create");
    external.replayAuthenticatedIngress = vi.fn(async () => ({
      replayRequestId: "unsafe-replay",
      observedAtIso: timestamp,
      duplicateEffectCount: 0,
      providerStateBeforeSha256: digest("before"),
      providerStateAfterSha256: digest("after"),
    }));
    await expect(
      executeGoogleWorkspaceOperatorCanary({
        preflight: preflight("google-sheets.spreadsheet-create"),
        capabilities: external,
      }),
    ).rejects.toThrow(/replay changed provider state/);
  });

  it("refuses direct production dispatch without a matching OAuth capability receipt", async () => {
    const service = {
      sendGmailMessage: vi.fn(),
      createEvent: vi.fn(),
      createDriveFile: vi.fn(),
    };
    await expect(
      dispatchGoogleWorkspaceBoundOperation({
        preflight: preflight("gmail.email-send"),
        credentialReceipt: {
          accountId: CASES["gmail.email-send"].accountId,
          connectionRefSha256,
          grantedCapabilities: ["gmail.read"],
          checkedAtIso: timestamp,
        },
        service,
      }),
    ).rejects.toThrow(/does not grant the required Google capability/);
    expect(service.sendGmailMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["gmail.email-send", "sendGmailMessage", { messageId: "gmail-message-id" }],
    [
      "google-calendar.event-create",
      "createEvent",
      { id: "calendar-event-id" },
    ],
    [
      "google-sheets.spreadsheet-create",
      "createDriveFile",
      { id: "spreadsheet-file-id" },
    ],
  ] as const)(
    "maps %s only to the production %s service boundary",
    async (kind, expectedMethod, result) => {
      const service = {
        sendGmailMessage: vi.fn(async () => result),
        createEvent: vi.fn(async () => result),
        createDriveFile: vi.fn(async () => result),
      };
      const receipt = await dispatchGoogleWorkspaceBoundOperation({
        preflight: preflight(kind),
        credentialReceipt: {
          accountId: CASES[kind].accountId,
          connectionRefSha256,
          grantedCapabilities: [CASES[kind].capability],
          checkedAtIso: timestamp,
        },
        service,
      });
      expect(service[expectedMethod]).toHaveBeenCalledOnce();
      expect(
        Object.entries(service)
          .filter(([method]) => method !== expectedMethod)
          .every(([, mock]) => mock.mock.calls.length === 0),
      ).toBe(true);
      expect(receipt.providerResourceId).toBe(Object.values(result)[0]);
      expect(receipt.qualificationClaimed).toBe(false);
    },
  );
});
