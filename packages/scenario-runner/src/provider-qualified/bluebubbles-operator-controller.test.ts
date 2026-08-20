/**
 * Exercises the BlueBubbles operator with real Ed25519 authorization and
 * deterministic external capability receipts. HTTP is mocked only at the
 * authenticated provider boundary; no message is sent or treated as evidence.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it, vi } from "vitest";
import scenario from "../../../test/scenarios/provider-qualified/provider.bluebubbles-imessage.confirmed-send.scenario.ts";
import {
  authenticateBlueBubblesBoundary,
  type BlueBubblesExternalCapabilities,
  type BlueBubblesOperatorPlan,
  collectBlueBubblesAuthenticatedMessageReadback,
  dispatchBlueBubblesBoundOperation,
  executeBlueBubblesOperatorCanary,
  preflightBlueBubblesOperatorCanary,
} from "./bluebubbles-operator-controller.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const accountId = "operator-bluebubbles-canary-account";
const accountRefSha256 = hash(accountId);
const connectionRefSha256 = hash("operator-bluebubbles-connection");
const runNonce = "b".repeat(64);
const chatGuid = "iMessage;-;+15551230001";
const text = "iMessage provider canary delivery";
const operationInput = { text, replyToMessageGuid: null } as const;
const providerTarget = { chatGuid };
const failureProbeMaterials = [
  {
    probeId: "bluebubbles-authorization-denied",
    requestPayload: { chatGuid, text },
    expectedErrorCode: "authentication-failed",
    scope: { accountId, chatGuid },
    authorizationGrant: { grant: "invalid-bluebubbles-password" },
  },
  {
    probeId: "bluebubbles-provider-rejected",
    requestPayload: { chatGuid: "iMessage;-;invalid", text },
    expectedErrorCode: "invalid-chat",
    scope: { accountId, chatGuid },
    authorizationGrant: { grant: "operator-owned-canary-chat" },
  },
] as const;

function plan(): BlueBubblesOperatorPlan {
  return {
    schema: "eliza.bluebubbles-provider-canary-operator-plan.v1",
    scenarioId: "provider.bluebubbles-imessage.confirmed-send",
    accountId,
    connectionRefSha256,
    serverOrigin: "https://bluebubbles.example.test",
    runNonce,
    chatGuid,
    expectedText: text,
    replyToMessageGuid: null,
  };
}

function fixture() {
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const [authorizationDenied, providerRejected] = failureProbeMaterials.map(
    createProviderFailureProbeHashBinding,
  );
  const principalRefSha256 = hash("bluebubbles-human-operator");
  const roomRefSha256 = hash(chatGuid);
  const grantSha256 = hash("operator-owned-canary-chat-grant");
  const bindings: ProviderRunBindings = {
    runId: "bluebubbles-operator-run-001",
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "c".repeat(64),
    trust: {
      manifestAuthorityKeyId: providerObserverKeyId(publicKeyPem),
      observerSigners: [
        {
          observerId: "bluebubbles-provider-observer",
          keyId: hash("independent-bluebubbles-provider-observer"),
        },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "bluebubbles.message-send",
        providerTarget,
        operationInput,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "live-acting-provider",
      actingModel: "live-acting-model",
      judgeProvider: "independent-judge-provider",
      judgeModel: "independent-judge-model",
      judgeKeyId: hash("independent-judge-key"),
    },
    connectors: [
      {
        provider: "bluebubbles",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "bluebubbles",
      channel: "imessage-webhook",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://agent.example.test"),
    },
    capabilities: [
      {
        provider: "bluebubbles",
        accountRefSha256,
        connectionRefSha256,
        capability: "message-send",
        authorizationGrantSha256: grantSha256,
      },
    ],
    observationContracts: [
      {
        contractId: "bluebubbles-canary-message-send",
        kind: "provider-effect",
        observerId: "bluebubbles-provider-observer",
        sourceKind: "provider-api",
        system: "bluebubbles",
        environment: "operator-canary",
        connectorProvider: "bluebubbles",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "bluebubbles",
        operation: "message-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: "bluebubbles-provider-observer",
        sourceKind: "provider-api",
        system: "bluebubbles",
        environment: "operator-canary",
        provider: "bluebubbles",
        connectorProvider: "bluebubbles",
        accountRefSha256,
        connectionRefSha256,
        operation: "message-send",
        failureClass: "authorization-denied",
        requestPayloadSha256: authorizationDenied.requestPayloadSha256,
        expectedStatusCode: 401,
        expectedErrorCodeSha256: authorizationDenied.expectedErrorCodeSha256,
        scopeSha256: authorizationDenied.scopeSha256,
        authorizationGrantSha256: authorizationDenied.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: providerRejected.probeId,
        observerId: "bluebubbles-provider-observer",
        sourceKind: "provider-api",
        system: "bluebubbles",
        environment: "operator-canary",
        provider: "bluebubbles",
        connectorProvider: "bluebubbles",
        accountRefSha256,
        connectionRefSha256,
        operation: "message-send",
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
  return {
    scenario: scenario as ScenarioDefinition,
    authorization: authorizeProviderCanary({
      scenario,
      bindings,
      manifestAuthorityPrivateKey: authority.privateKey,
    }),
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget,
    operationInput,
    failureProbes: failureProbeMaterials,
    plan: plan(),
  };
}

async function boundary(
  preflight: ReturnType<typeof preflightBlueBubblesOperatorCanary>,
) {
  return authenticateBlueBubblesBoundary({
    preflight,
    serverPassword: "a-long-dedicated-server-password",
    checkedAt: new Date("2026-08-20T12:00:00.000Z"),
    fetchImpl: async (request) => {
      const url = new URL(String(request));
      expect(url.origin).toBe(preflight.plan.serverOrigin);
      expect(url.pathname).toBe("/api/v1/server/info");
      expect(url.searchParams.get("password")).toBe(
        "a-long-dedicated-server-password",
      );
      return Response.json({
        status: 200,
        data: {
          server_version: "1.9.9",
          os_version: "15.6",
          private_api: false,
          helper_connected: true,
        },
      });
    },
  });
}

function capabilities(
  overrides: Partial<BlueBubblesExternalCapabilities> = {},
): BlueBubblesExternalCapabilities {
  const state = hash("provider-state-after-one-message");
  const [authorizationDenied, providerRejected] = failureProbeMaterials.map(
    createProviderFailureProbeHashBinding,
  );
  return {
    sendAuthenticatedIngress: vi.fn(async () => ({
      requestId: "ingress-request-1",
      acceptedAtIso: "2026-08-20T12:00:01.000Z",
      scenarioId: "provider.bluebubbles-imessage.confirmed-send",
      runNonce,
    })),
    collectIndependentReadback: vi.fn(async () => ({
      messageGuid: "message-guid-1",
      chatGuid,
      text,
      isFromMe: true,
      threadOriginatorGuid: null,
      observedAtIso: "2026-08-20T12:00:02.000Z",
      rawProviderResponseSha256: hash("raw-provider-readback"),
      qualificationClaimed: false,
    })),
    replayAuthenticatedIngress: vi.fn(async () => ({
      replayRequestId: "replay-request-1",
      observedAtIso: "2026-08-20T12:00:03.000Z",
      duplicateEffectCount: 0,
      providerStateBeforeSha256: state,
      providerStateAfterSha256: state,
    })),
    executeIndependentFailureProbes: vi.fn(async () => [
      {
        probeId: authorizationDenied.probeId,
        failureClass: "authorization-denied",
        observedAtIso: "2026-08-20T12:00:04.000Z",
        statusCode: 401,
        errorCodeSha256: authorizationDenied.expectedErrorCodeSha256,
        providerRequestIdSha256: null,
        providerStateBeforeSha256: state,
        providerStateAfterSha256: state,
      },
      {
        probeId: providerRejected.probeId,
        failureClass: "provider-rejected",
        observedAtIso: "2026-08-20T12:00:05.000Z",
        statusCode: 400,
        errorCodeSha256: providerRejected.expectedErrorCodeSha256,
        providerRequestIdSha256: hash("provider-request-1"),
        providerStateBeforeSha256: state,
        providerStateAfterSha256: state,
      },
    ]),
    exportDeployedTrajectory: vi.fn(async () => ({
      exportId: "trajectory-export-1",
      exportedAtIso: "2026-08-20T12:00:06.000Z",
      trajectoryCount: 1,
      exportSha256: hash("deployed-trajectory"),
    })),
    ...overrides,
  };
}

describe("BlueBubbles provider-canary operator", () => {
  it("binds the exact signed chat, text, reply mode, account, and connection", () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    expect(preflight.operation).toEqual({
      kind: "bluebubbles.message-send",
      providerTarget,
      operationInput,
    });
    for (const changed of [
      { ...plan(), chatGuid: "iMessage;-;+15551239999" },
      { ...plan(), expectedText: "tampered" },
      { ...plan(), connectionRefSha256: hash("other") },
      { ...plan(), pretendQualified: true },
    ]) {
      expect(() =>
        preflightBlueBubblesOperatorCanary({ ...fixture(), plan: changed }),
      ).toThrow();
    }
  });

  it("authenticates the actual server-info boundary without retaining the password", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const receipt = await boundary(preflight);
    expect(receipt).toMatchObject({
      serverOrigin: "https://bluebubbles.example.test",
      serverVersion: "1.9.9",
      helperConnected: true,
      qualificationClaimed: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("server-password");
  });

  it("refuses missing evidence capabilities before authenticated ingress", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const authenticated = await boundary(preflight);
    const all = capabilities();
    const send = all.sendAuthenticatedIngress as ReturnType<typeof vi.fn>;
    const { collectIndependentReadback: _missing, ...incomplete } = all;
    await expect(
      executeBlueBubblesOperatorCanary({
        preflight,
        boundary: authenticated,
        capabilities: incomplete as BlueBubblesExternalCapabilities,
      }),
    ).rejects.toThrow(/collectIndependentReadback.*required|closed shape/);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns only correlated unsigned source receipts", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const result = await executeBlueBubblesOperatorCanary({
      preflight,
      boundary: await boundary(preflight),
      capabilities: capabilities(),
      now: () => Date.parse("2026-08-20T12:00:07.000Z"),
    });
    expect(result).toMatchObject({
      schema: "eliza.bluebubbles-provider-canary-raw-receipt.v1",
      operationKind: "bluebubbles.message-send",
      qualificationClaimed: false,
      readback: { chatGuid, isFromMe: true, threadOriginatorGuid: null },
    });
  });

  it("reads the exact outgoing message from the authenticated provider API", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const receipt = await collectBlueBubblesAuthenticatedMessageReadback({
      preflight,
      messageGuid: "message-guid-1",
      serverPassword: "a-long-dedicated-server-password",
      observedAt: new Date("2026-08-20T12:00:02.000Z"),
      fetchImpl: async (request) => {
        const url = new URL(String(request));
        expect(url.pathname).toBe("/api/v1/message/message-guid-1");
        expect(url.searchParams.get("with")).toBe("chats");
        expect(url.searchParams.get("password")).toBe(
          "a-long-dedicated-server-password",
        );
        return Response.json({
          status: 200,
          data: {
            guid: "message-guid-1",
            text,
            isFromMe: true,
            threadOriginatorGuid: null,
            chats: [{ guid: chatGuid }],
          },
        });
      },
    });
    expect(receipt).toMatchObject({
      messageGuid: "message-guid-1",
      chatGuid,
      qualificationClaimed: false,
    });
  });

  it("rejects observer, replay, and failure-probe drift", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const authenticated = await boundary(preflight);
    await expect(
      executeBlueBubblesOperatorCanary({
        preflight,
        boundary: authenticated,
        capabilities: capabilities({
          collectIndependentReadback: async () => ({
            messageGuid: "message-guid-1",
            chatGuid,
            text: "different",
            isFromMe: true,
            threadOriginatorGuid: null,
            observedAtIso: "2026-08-20T12:00:02.000Z",
            rawProviderResponseSha256: hash("raw"),
            qualificationClaimed: false,
          }),
        }),
      }),
    ).rejects.toThrow(/readback does not match/);
    await expect(
      executeBlueBubblesOperatorCanary({
        preflight,
        boundary: authenticated,
        capabilities: capabilities({
          replayAuthenticatedIngress: async () => ({
            replayRequestId: "replay-request-1",
            observedAtIso: "2026-08-20T12:00:03.000Z",
            duplicateEffectCount: 1,
            providerStateBeforeSha256: hash("before"),
            providerStateAfterSha256: hash("after"),
          }),
        }),
      }),
    ).rejects.toThrow(/duplicate provider effect/);
    await expect(
      executeBlueBubblesOperatorCanary({
        preflight,
        boundary: authenticated,
        capabilities: capabilities({
          executeIndependentFailureProbes: async () => [],
        }),
      }),
    ).rejects.toThrow(/count does not match/);
  });

  it("maps only the validated production sendMessage method shape", async () => {
    const preflight = preflightBlueBubblesOperatorCanary(fixture());
    const sendMessage = vi.fn(async () => ({
      guid: "message-guid-1",
      status: "sent",
      dateCreated: 1,
      text,
    }));
    const result = await dispatchBlueBubblesBoundOperation({
      preflight,
      service: { sendMessage },
    });
    expect(sendMessage).toHaveBeenCalledWith(chatGuid, text, undefined);
    expect(result).toMatchObject({
      messageGuid: "message-guid-1",
      qualificationClaimed: false,
    });
  });

  it("does not load the competing native iMessage connector", () => {
    expect(scenario.requires?.plugins).toContain("@elizaos/plugin-bluebubbles");
    expect(scenario.requires?.plugins).not.toContain(
      "@elizaos/plugin-imessage",
    );
  });
});
