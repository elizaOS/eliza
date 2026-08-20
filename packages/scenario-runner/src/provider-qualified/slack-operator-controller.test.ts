/**
 * Exercises the Slack operator boundary with real Ed25519 authorization and
 * deterministic Web API responses; raw receipts never become qualification.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import slackScenario from "../../../test/scenarios/provider-qualified/provider.slack.confirmed-send.scenario.ts";
import {
  createDeployedCanaryContractDescriptor,
  type DeployedCanaryCapabilities,
} from "./deployed-capability-contract.ts";
import { canonicalSha256, type ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";
import {
  assertSlackOperatorCanaryExecutable,
  collectSlackRawReadback,
  preflightSlackOperatorCanary,
  type SlackOperatorPlan,
} from "./slack-operator-controller.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const teamId = "T123ABCDEF";
const channelId = "C123ABCDEF";
const humanId = "U123HUMAN1";
const botUserId = "U123BOT001";
const observerUserId = "U123OBS001";
const runNonce = "s".repeat(64);
const effectContent = "Slack provider canary delivery";
const ingressContent = `Execute the Slack canary. canary-nonce:${runNonce}`;
const providerTarget = { teamId, channelId, threadTs: null } as const;
const operationInput = { text: effectContent, attachments: [] } as const;

function failureProbeMaterials() {
  return [
    {
      probeId: "slack-authorization-denied",
      requestPayload: { channelId, text: "denied" },
      expectedErrorCode: "missing-scope",
      scope: { teamId, channelId },
      authorizationGrant: { grant: "denied-slack-grant" },
    },
    {
      probeId: "slack-provider-rejected",
      requestPayload: { channelId: "CINVALID", text: "rejected" },
      expectedErrorCode: "channel-not-found",
      scope: { teamId, channelId },
      authorizationGrant: { grant: "slack-message-send" },
    },
  ] as const;
}

function plan(
  deploymentEvidence: SlackOperatorPlan["deploymentEvidence"],
): SlackOperatorPlan {
  return {
    schema: "eliza.slack-provider-canary-operator-plan.v1",
    slackApiOrigin: "https://slack.com",
    teamId,
    channelId,
    humanOperatorUserId: humanId,
    agentBotUserId: botUserId,
    observerUserId,
    runNonce,
    expectedHumanIngressContent: ingressContent,
    expectedProviderEffectContent: effectContent,
    poll: { intervalMs: 60_000, timeoutMs: 60_000 },
    deploymentEvidence,
  };
}

function fixture() {
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const accountRefSha256 = hash("operator-slack-canary-account");
  const connectionRefSha256 = hash("operator-slack-canary-connection");
  const principalRefSha256 = hash(humanId);
  const roomRefSha256 = hash(channelId);
  const [authorizationDenied, providerRejected] = failureProbeMaterials().map(
    createProviderFailureProbeHashBinding,
  );
  const bindings: ProviderRunBindings = {
    runId: "slack-operator-run-001",
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: providerObserverKeyId(publicKeyPem),
      observerSigners: [
        {
          observerId: "slack-provider-observer",
          keyId: hash("slack-observer"),
        },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "slack.message-send",
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
        provider: "slack",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "slack",
      channel: "slack-events-api",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://deployed-agent.example.test"),
    },
    capabilities: [
      {
        provider: "slack",
        accountRefSha256,
        connectionRefSha256,
        capability: "message-send",
        authorizationGrantSha256: hash("slack-message-send"),
      },
    ],
    observationContracts: [
      {
        contractId: "slack-canary-message-send",
        kind: "provider-effect",
        observerId: "slack-provider-observer",
        sourceKind: "provider-api",
        system: "slack",
        environment: "operator-canary",
        connectorProvider: "slack",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "slack",
        operation: "message-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: "slack-provider-observer",
        sourceKind: "provider-api",
        system: "slack",
        environment: "operator-canary",
        provider: "slack",
        connectorProvider: "slack",
        accountRefSha256,
        connectionRefSha256,
        operation: "message-send",
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
        observerId: "slack-provider-observer",
        sourceKind: "provider-api",
        system: "slack",
        environment: "operator-canary",
        provider: "slack",
        connectorProvider: "slack",
        accountRefSha256,
        connectionRefSha256,
        operation: "message-send",
        failureClass: "provider-rejected",
        requestPayloadSha256: providerRejected.requestPayloadSha256,
        expectedStatusCode: 404,
        expectedErrorCodeSha256: providerRejected.expectedErrorCodeSha256,
        scopeSha256: providerRejected.scopeSha256,
        authorizationGrantSha256: providerRejected.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
  const authorization = authorizeProviderCanary({
    scenario: slackScenario,
    bindings,
    manifestAuthorityPrivateKey: authority.privateKey,
  });
  const deploymentEvidence = createDeployedCanaryContractDescriptor({
    scenarioId: slackScenario.id,
    runId: bindings.runId,
    deploymentSha256: bindings.deploymentSha,
    ingressEndpoint:
      "https://deployed-agent.example.test/provider-canary/v1/ingress",
    ingressEndpointOriginSha256: bindings.ingress.endpointOriginSha256,
    operationBindingSha256: canonicalSha256(
      bindings.target.operation,
      "operationBinding",
    ),
    failureProbeBindingsSha256: canonicalSha256(
      [authorizationDenied, providerRejected],
      "failureProbeBindings",
    ),
    trajectoryEnvironment: "operator-canary",
    reconciliationOwnerRefSha256: hash("slack-reconciliation-owner"),
  });
  return {
    scenario: slackScenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget,
    operationInput,
    failureProbes: failureProbeMaterials(),
    plan: plan(deploymentEvidence),
  };
}

function capabilities(): DeployedCanaryCapabilities {
  return {
    authenticateIngress: vi.fn(),
    retrieveTrajectoryMaterial: vi.fn(),
    replayAuthenticatedIngress: vi.fn(),
    executeFailureProbe: vi.fn(),
    cleanupOrReconcile: vi.fn(),
  } as unknown as DeployedCanaryCapabilities;
}

function slackMessage(input: {
  ts: string;
  user: string;
  text: string;
  botId?: string;
}) {
  return {
    type: "message",
    ts: input.ts,
    user: input.user,
    text: input.text,
    ...(input.botId ? { bot_id: input.botId } : {}),
  };
}

describe("Slack provider-canary operator", () => {
  it("validates signed private material and requires every executable seam", () => {
    const preflight = preflightSlackOperatorCanary(fixture());
    expect(preflight.status).toBe("slack-operator-inputs-validated");
    expect(preflight.blockers).toEqual([]);
    expect(() => assertSlackOperatorCanaryExecutable(preflight, {})).toThrow(
      /closed executable shape/,
    );
    const deployed = capabilities();
    expect(
      assertSlackOperatorCanaryExecutable(preflight, deployed)
        .authenticateIngress,
    ).toBe(deployed.authenticateIngress);
  });

  it("rejects target drift, shared observer identity, and unknown plan fields", () => {
    const input = fixture();
    expect(() =>
      preflightSlackOperatorCanary({
        ...input,
        plan: { ...input.plan, channelId: "C999ABCDEF" },
      }),
    ).toThrow(/target does not match/);
    expect(() =>
      preflightSlackOperatorCanary({
        ...input,
        plan: { ...input.plan, observerUserId: botUserId },
      }),
    ).toThrow(/must be distinct/);
    expect(() =>
      preflightSlackOperatorCanary({
        ...input,
        plan: { ...input.plan, pretendReady: true },
      }),
    ).toThrow(/closed shape/);
  });

  it("binds observer auth to the workspace and collects exact later bot effect", async () => {
    const preflight = preflightSlackOperatorCanary(fixture());
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer xoxp-observer-token-1234567890",
        );
        if (url.pathname.endsWith("/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: teamId,
              user_id: observerUserId,
              url: "https://canary.slack.com/",
            }),
            { status: 200 },
          );
        }
        expect(url.pathname).toBe("/api/conversations.history");
        expect(url.searchParams.get("channel")).toBe(channelId);
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              slackMessage({
                ts: "1787191201.000002",
                user: botUserId,
                botId: "B123BOT001",
                text: effectContent,
              }),
              slackMessage({
                ts: "1787191200.000001",
                user: humanId,
                text: ingressContent,
              }),
            ],
          }),
          { status: 200 },
        );
      },
    );
    const readback = await collectSlackRawReadback({
      preflight,
      observerToken: "xoxp-observer-token-1234567890",
      fetchImpl,
      now: () => Date.parse("2026-08-20T10:00:02.000Z"),
    });
    expect(readback.qualificationClaimed).toBe(false);
    expect(readback.observerIdentity).toEqual({
      teamId,
      observerUserId,
      url: "https://canary.slack.com/",
    });
    expect(readback.providerEffect.textSha256).toBe(hash(effectContent));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects an observer token bound to another workspace before history", async () => {
    const preflight = preflightSlackOperatorCanary(fixture());
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            team_id: "T999ABCDEF",
            user_id: observerUserId,
            url: "https://wrong.slack.com/",
          }),
        ),
    );
    await expect(
      collectSlackRawReadback({
        preflight,
        observerToken: "xoxp-observer-token-1234567890",
        fetchImpl,
      }),
    ).rejects.toThrow(/observer token identity does not match/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not accept same-time or human-authored provider effects", async () => {
    const preflight = preflightSlackOperatorCanary(fixture());
    let clock = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/auth.test")) {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: teamId,
            user_id: observerUserId,
            url: "https://canary.slack.com/",
          }),
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            slackMessage({
              ts: "1787191200.000001",
              user: humanId,
              botId: "B123BOT001",
              text: effectContent,
            }),
            slackMessage({
              ts: "1787191200.000001",
              user: humanId,
              text: ingressContent,
            }),
          ],
        }),
      );
    });
    await expect(
      collectSlackRawReadback({
        preflight,
        observerToken: "xoxp-observer-token-1234567890",
        fetchImpl,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toThrow(/timed out waiting/);
  });
});
