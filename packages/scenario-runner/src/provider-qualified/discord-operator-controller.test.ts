/**
 * Exercises the Discord operator boundary with real Ed25519 authorization and
 * deterministic Discord REST responses; no provider effect is simulated as a
 * qualification result.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import discordScenario from "../../../test/scenarios/provider-qualified/provider.discord.confirmed-send.scenario.ts";
import {
  assertDiscordOperatorCanaryExecutable,
  collectDiscordRawReadback,
  type DiscordOperatorPlan,
  type DiscordOperatorPreflight,
  preflightDiscordOperatorCanary,
} from "./discord-operator-controller.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const guildId = "123456789012345678";
const channelId = "223456789012345678";
const humanId = "323456789012345678";
const botId = "423456789012345678";
const runNonce = "n".repeat(64);
const providerEffectContent = "Discord provider canary delivery";
const humanIngressContent = `Please execute the Discord canary now. canary-nonce:${runNonce}`;
const providerTarget = { guildId, channelId };
const operationInput = {
  text: providerEffectContent,
  attachments: [],
} as const;

function failureProbeMaterials() {
  return [
    {
      probeId: "discord-authorization-denied",
      requestPayload: { channelId, text: "denied" },
      expectedErrorCode: "missing-permission",
      scope: { guildId, channelId },
      authorizationGrant: { grant: "denied-discord-grant" },
    },
    {
      probeId: "discord-provider-rejected",
      requestPayload: { channelId: "invalid", text: "rejected" },
      expectedErrorCode: "unknown-channel",
      scope: { guildId, channelId },
      authorizationGrant: { grant: "discord-message-send" },
    },
  ] as const;
}

function plan(): DiscordOperatorPlan {
  return {
    schema: "eliza.discord-provider-canary-operator-plan.v1",
    discordApiOrigin: "https://discord.com",
    guildId,
    channelId,
    humanOperatorUserId: humanId,
    agentBotUserId: botId,
    runNonce,
    expectedHumanIngressContent: humanIngressContent,
    expectedProviderEffectContent: providerEffectContent,
    poll: { intervalMs: 250, timeoutMs: 1_000 },
    deploymentEvidence: {
      trajectoryRetrieval: null,
      authenticatedEventReplay: null,
      independentFailureProbeExecutor: null,
    },
  };
}

function fixture() {
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const authorityKeyId = providerObserverKeyId(publicKeyPem);
  const accountRefSha256 = hash("operator-discord-canary-account");
  const connectionRefSha256 = hash("operator-discord-canary-connection");
  const principalRefSha256 = hash(humanId);
  const roomRefSha256 = hash(channelId);
  const [authorizationDenied, providerRejected] = failureProbeMaterials().map(
    createProviderFailureProbeHashBinding,
  );
  const bindings: ProviderRunBindings = {
    runId: "discord-operator-run-001",
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: authorityKeyId,
      observerSigners: [
        {
          observerId: "discord-provider-observer",
          keyId: hash("independent-discord-observer"),
        },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "discord.message-send",
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
        provider: "discord",
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "discord",
      channel: "discord-gateway",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://deployed-agent.example.test"),
    },
    capabilities: [
      {
        provider: "discord",
        accountRefSha256,
        connectionRefSha256,
        capability: "message-send",
        authorizationGrantSha256: hash("discord-message-send"),
      },
    ],
    observationContracts: [
      {
        contractId: "discord-canary-message-send",
        kind: "provider-effect",
        observerId: "discord-provider-observer",
        sourceKind: "provider-api",
        system: "discord",
        environment: "operator-canary",
        connectorProvider: "discord",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "discord",
        operation: "message-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: "discord-provider-observer",
        sourceKind: "provider-api",
        system: "discord",
        environment: "operator-canary",
        provider: "discord",
        connectorProvider: "discord",
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
        observerId: "discord-provider-observer",
        sourceKind: "provider-api",
        system: "discord",
        environment: "operator-canary",
        provider: "discord",
        connectorProvider: "discord",
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
    scenario: discordScenario,
    bindings,
    manifestAuthorityPrivateKey: authority.privateKey,
  });
  return {
    scenario: discordScenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget,
    operationInput,
    failureProbes: failureProbeMaterials(),
    plan: plan(),
  };
}

function discordMessage(input: {
  id: string;
  authorId: string;
  bot: boolean;
  content: string;
  timestamp: string;
}) {
  return {
    id: input.id,
    channel_id: channelId,
    guild_id: guildId,
    author: { id: input.authorId, bot: input.bot },
    content: input.content,
    timestamp: input.timestamp,
  };
}

describe("Discord provider-canary operator", () => {
  it("validates all signed private material and reports exact execution blockers", () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    expect(preflight.status).toBe("discord-operator-inputs-validated");
    expect(preflight.blockers.map(({ code }) => code)).toEqual([
      "deployed-trajectory-retrieval-unavailable",
      "authenticated-event-replay-unavailable",
      "independent-failure-probe-executor-unavailable",
    ]);
    expect(() => assertDiscordOperatorCanaryExecutable(preflight)).toThrow(
      /execution refused.*deployed-trajectory-retrieval-unavailable/,
    );
  });

  it("rejects plan drift and unknown fields before any network request", () => {
    const input = fixture();
    expect(() =>
      preflightDiscordOperatorCanary({
        ...input,
        plan: { ...input.plan, channelId: "523456789012345678" },
      }),
    ).toThrow(/target does not match/);
    expect(() =>
      preflightDiscordOperatorCanary({
        ...input,
        plan: { ...input.plan, pretendReady: true },
      }),
    ).toThrow(/closed shape/);
  });

  it("collects exact human ingress and later bot effect from Discord REST", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bot secret-discord-token-value",
        );
        return new Response(
          JSON.stringify([
            discordMessage({
              id: "723456789012345678",
              authorId: botId,
              bot: true,
              content: providerEffectContent,
              timestamp: "2026-08-19T18:00:01.000Z",
            }),
            discordMessage({
              id: "623456789012345678",
              authorId: humanId,
              bot: false,
              content: humanIngressContent,
              timestamp: "2026-08-19T18:00:00.000Z",
            }),
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const readback = await collectDiscordRawReadback({
      preflight,
      discordBotToken: "secret-discord-token-value",
      fetchImpl,
      now: () => Date.parse("2026-08-19T18:00:02.000Z"),
    });
    expect(readback.qualificationClaimed).toBe(false);
    expect(readback.humanIngress.author).toEqual({ id: humanId, bot: false });
    expect(readback.providerEffect.author).toEqual({ id: botId, bot: true });
    expect(readback.providerEffect.contentSha256).toBe(
      hash(providerEffectContent),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not accept a bot-authored message as human ingress", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    let clock = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            discordMessage({
              id: "823456789012345678",
              authorId: humanId,
              bot: true,
              content: humanIngressContent,
              timestamp: "2026-08-19T18:00:00.000Z",
            }),
          ]),
          { status: 200 },
        ),
    );
    await expect(
      collectDiscordRawReadback({
        preflight,
        discordBotToken: "secret-discord-token-value",
        fetchImpl,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toThrow(/timed out waiting for the exact human-authored ingress/);
  });

  it("fails closed on missing credentials before calling Discord", async () => {
    const fetchImpl = vi.fn();
    await expect(
      collectDiscordRawReadback({
        preflight: preflightDiscordOperatorCanary(fixture()),
        discordBotToken: "",
        fetchImpl,
      }),
    ).rejects.toThrow(/discordBotToken is missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a structurally forged preflight before calling Discord", async () => {
    const fetchImpl = vi.fn();
    const genuine = preflightDiscordOperatorCanary(fixture());
    await expect(
      collectDiscordRawReadback({
        preflight: { ...genuine } as DiscordOperatorPreflight,
        discordBotToken: "secret-discord-token-value",
        fetchImpl,
      }),
    ).rejects.toThrow(/requires the exact result of preflight/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
