/**
 * Exercises the Discord operator boundary with real Ed25519 authorization and
 * deterministic Discord REST responses; no provider effect is simulated as a
 * qualification result.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import discordScenario from "../../../test/scenarios/provider-qualified/provider.discord.confirmed-send.scenario.ts";
import {
  createDeployedCanaryContractDescriptor,
  type DeployedCanaryCapabilities,
  executeDeployedCanaryContract,
} from "./deployed-capability-contract.ts";
import {
  assertDiscordOperatorCanaryExecutable,
  collectDiscordRawReadback,
  type DiscordOperatorPlan,
  type DiscordOperatorPreflight,
  preflightDiscordOperatorCanary,
} from "./discord-operator-controller.ts";
import { canonicalSha256, type ProviderRunBindings } from "./manifest.ts";
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
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

function plan(
  deploymentEvidence: DiscordOperatorPlan["deploymentEvidence"],
): DiscordOperatorPlan {
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
    deploymentEvidence,
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
  const deploymentEvidence = createDeployedCanaryContractDescriptor({
    scenarioId: discordScenario.id,
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
    reconciliationOwnerRefSha256: hash("discord-reconciliation-owner"),
  });
  return {
    scenario: discordScenario,
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
  it("validates all signed private material and requires every executable seam", () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    expect(preflight.status).toBe("discord-operator-inputs-validated");
    expect(preflight.blockers).toEqual([]);
    expect(() => assertDiscordOperatorCanaryExecutable(preflight, {})).toThrow(
      /closed executable shape/,
    );
    const deployed = capabilities();
    expect(
      assertDiscordOperatorCanaryExecutable(preflight, deployed)
        .authenticateIngress,
    ).toBe(deployed.authenticateIngress);
    let getterInvoked = false;
    const accessorCapabilities = {
      get authenticateIngress() {
        getterInvoked = true;
        return vi.fn();
      },
      retrieveTrajectoryMaterial: vi.fn(),
      replayAuthenticatedIngress: vi.fn(),
      executeFailureProbe: vi.fn(),
      cleanupOrReconcile: vi.fn(),
    };
    expect(() =>
      assertDiscordOperatorCanaryExecutable(preflight, accessorCapabilities),
    ).toThrow(/closed executable shape/);
    expect(getterInvoked).toBe(false);
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
    expect(() =>
      preflightDiscordOperatorCanary({
        ...input,
        plan: {
          ...input.plan,
          deploymentEvidence: {
            ...input.plan.deploymentEvidence,
            runId: "substituted-run",
          },
        },
      }),
    ).toThrow(/scenario or run/);
    const {
      schema: _schema,
      descriptorSha256: _descriptorSha256,
      capabilitySet: _capabilitySet,
      capabilitySetSha256: _capabilitySetSha256,
      ...descriptorInput
    } = input.plan.deploymentEvidence;
    expect(() =>
      preflightDiscordOperatorCanary({
        ...input,
        plan: {
          ...input.plan,
          deploymentEvidence: createDeployedCanaryContractDescriptor({
            ...descriptorInput,
            ingressEndpoint:
              "https://deployed-agent.example.test/operator-selected/path?run=1",
          }),
        },
      }),
    ).toThrow(/canonical .* path without a query/);
  });

  it("collects exact human ingress and later bot effect from Discord REST", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    const fetchImpl = vi.fn(
      async (request: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bot secret-discord-token-value",
        );
        const url = String(request);
        if (url.endsWith("/api/v10/users/@me")) {
          return new Response(JSON.stringify({ id: botId, bot: true }), {
            status: 200,
          });
        }
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
    expect(readback.observerIdentity).toMatchObject({
      userId: botId,
      bot: true,
    });
    expect(readback.humanIngress.author).toEqual({ id: humanId, bot: false });
    expect(readback.providerEffect.author).toEqual({ id: botId, bot: true });
    expect(readback.providerEffect.contentSha256).toBe(
      hash(providerEffectContent),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("executes a complete deployed seam and verifies real trajectory bytes", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    const runDir = mkdtempSync(path.join(tmpdir(), "discord-deployed-canary-"));
    temporaryRoots.push(runDir);
    const trajectoryDirectory = path.join(runDir, "trajectories", "agent");
    mkdirSync(trajectoryDirectory, { recursive: true });
    const now = Date.now();
    const startedAtIso = new Date(now - 1_000).toISOString();
    const endedAtIso = new Date(now).toISOString();
    const relativePath = "trajectories/agent/discord-trajectory.json";
    writeFileSync(
      path.join(runDir, ...relativePath.split("/")),
      `${JSON.stringify({
        trajectoryId: "discord-trajectory",
        agentId: "agent",
        runId: preflight.execution.authorization.manifest.run.runId,
        scenarioId: discordScenario.id,
        rootMessage: { id: "discord-ingress", text: humanIngressContent },
        startedAt: now - 900,
        endedAt: now - 100,
        status: "finished",
        stages: [
          {
            stageId: "discord-send",
            kind: "tool",
            startedAt: now - 800,
            endedAt: now - 200,
            latencyMs: 600,
            tool: {
              name: "SEND_DISCORD_MESSAGE",
              args: operationInput,
              result: { accepted: true },
              success: true,
              durationMs: 600,
            },
          },
        ],
        metrics: {
          totalLatencyMs: 800,
          totalPromptTokens: 10,
          totalCompletionTokens: 5,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalCostUsd: 0.001,
          plannerIterations: 1,
          toolCallsExecuted: 1,
          toolCallFailures: 0,
          toolSearchCount: 0,
          evaluatorFailures: 0,
          finalDecision: "FINISH",
        },
      })}\n`,
    );
    const ingressRequestSha256 = hash(humanIngressContent);
    const correlationId = "discord-correlation-001";
    let probeOrdinal = 0;
    const deployed: DeployedCanaryCapabilities = {
      authenticateIngress: vi.fn(async (binding) => ({
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        manifestSha256: binding.manifestSha256,
        ingressEndpointOriginSha256:
          preflight.plan.deploymentEvidence.ingressEndpointOriginSha256,
        ingressRequestSha256: binding.ingressRequestSha256,
        operationBindingSha256: binding.operationBindingSha256,
        authenticationProofSha256: hash("discord-authenticated-ingress-proof"),
        correlationId,
        acceptedAtIso: new Date(now - 950).toISOString(),
        authenticated: true as const,
      })),
      retrieveTrajectoryMaterial: vi.fn(async ({ binding }) => ({
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        correlationId,
        runDir,
        expectedRelativePaths: [relativePath],
        scenarioStartedAtIso: startedAtIso,
        scenarioEndedAtIso: endedAtIso,
        environment: "operator-canary",
      })),
      replayAuthenticatedIngress: vi.fn(async ({ binding }) => ({
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        originalCorrelationId: correlationId,
        replayCorrelationId: "discord-replay-001",
        ingressRequestSha256: binding.ingressRequestSha256,
        operationBindingSha256: binding.operationBindingSha256,
        effectCountBefore: 1,
        effectCountAfter: 1,
        replayObservedAtIso: new Date(now + 20_000).toISOString(),
        authenticated: true as const,
        noAdditionalEffect: true as const,
      })),
      executeFailureProbe: vi.fn(async ({ binding, probe, contract }) => ({
        ...probe,
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        failureProbeBindingsSha256: binding.failureProbeBindingsSha256,
        failureProbeContractSha256: canonicalSha256(
          contract,
          `failureProbeContract.${probe.probeId}`,
        ),
        failureClass: contract.failureClass,
        expectedStatusCode: contract.expectedStatusCode,
        observedAtIso: new Date(
          now + 30_000 + probeOrdinal++ * 10_000,
        ).toISOString(),
        expectedFailureObserved: true as const,
        providerEffectCountBefore: 1,
        providerEffectCountAfter: 1,
      })),
      cleanupOrReconcile: vi.fn(async ({ binding }) => ({
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        correlationId,
        reconciliationOwnerRefSha256:
          preflight.plan.deploymentEvidence.reconciliationOwnerRefSha256,
        status: "cleaned" as const,
        completedAtIso: new Date(now + 50_000).toISOString(),
      })),
    };
    let nowCalls = 0;
    const result = await executeDeployedCanaryContract({
      descriptor: preflight.plan.deploymentEvidence,
      execution: preflight.execution,
      capabilities: assertDiscordOperatorCanaryExecutable(preflight, deployed),
      ingressRequestSha256,
      now: () => new Date(now + nowCalls++ * 10_000),
    });
    expect(result.trajectories.trajectories).toHaveLength(1);
    expect(result.failureProbes).toHaveLength(2);
    expect(result.replay.noAdditionalEffect).toBe(true);
    expect(result.cleanup.status).toBe("cleaned");
    expect(result.qualificationClaimed).toBe(false);
    expect(nowCalls).toBeGreaterThanOrEqual(6);

    const reconciliation = vi.fn(async ({ binding }) => ({
      descriptorSha256: binding.descriptorSha256,
      scenarioId: binding.scenarioId,
      runId: binding.runId,
      correlationId,
      reconciliationOwnerRefSha256:
        preflight.plan.deploymentEvidence.reconciliationOwnerRefSha256,
      status: "reconciliation-required" as const,
      reconciliationRefSha256: hash("discord-reconciliation-ticket-001"),
      recordedAtIso: new Date(now + 50_000).toISOString(),
    }));
    const tamperedReplay: DeployedCanaryCapabilities = {
      ...deployed,
      replayAuthenticatedIngress: vi.fn(async ({ binding }) => ({
        descriptorSha256: binding.descriptorSha256,
        scenarioId: binding.scenarioId,
        runId: binding.runId,
        originalCorrelationId: correlationId,
        replayCorrelationId: "discord-replay-002",
        ingressRequestSha256: hash("substituted-request"),
        operationBindingSha256: binding.operationBindingSha256,
        effectCountBefore: 1,
        effectCountAfter: 1,
        replayObservedAtIso: new Date(now).toISOString(),
        authenticated: true as const,
        noAdditionalEffect: true as const,
      })),
      cleanupOrReconcile: reconciliation,
    };
    await expect(
      executeDeployedCanaryContract({
        descriptor: preflight.plan.deploymentEvidence,
        execution: preflight.execution,
        capabilities: tamperedReplay,
        ingressRequestSha256,
        now: () => new Date(now + 60_000),
      }),
    ).rejects.toThrow(/replay receipt does not prove/);
    expect(reconciliation).toHaveBeenCalledOnce();

    const reconciliationOnly = vi.fn(async ({ binding }) => ({
      descriptorSha256: binding.descriptorSha256,
      scenarioId: binding.scenarioId,
      runId: binding.runId,
      correlationId,
      reconciliationOwnerRefSha256:
        preflight.plan.deploymentEvidence.reconciliationOwnerRefSha256,
      status: "reconciliation-required" as const,
      reconciliationRefSha256: hash("discord-reconciliation-ticket-002"),
      recordedAtIso: new Date(now + 50_000).toISOString(),
    }));
    probeOrdinal = 0;
    await expect(
      executeDeployedCanaryContract({
        descriptor: preflight.plan.deploymentEvidence,
        execution: preflight.execution,
        capabilities: {
          ...deployed,
          cleanupOrReconcile: reconciliationOnly,
        },
        ingressRequestSha256,
        now: () => new Date(now + 60_000),
      }),
    ).rejects.toThrow(/requires reconciliation/);
    expect(reconciliationOnly).toHaveBeenCalledOnce();
  });

  it("does not accept a bot-authored message as human ingress", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    let clock = 0;
    const fetchImpl = vi.fn(
      async (request: string | URL | Request) =>
        new Response(
          String(request).endsWith("/api/v10/users/@me")
            ? JSON.stringify({ id: botId, bot: true })
            : JSON.stringify([
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

  it("requires the provider effect to occur strictly after human ingress", async () => {
    const preflight = preflightDiscordOperatorCanary(fixture());
    let clock = 0;
    const fetchImpl = vi.fn(
      async (request: string | URL | Request) =>
        new Response(
          String(request).endsWith("/api/v10/users/@me")
            ? JSON.stringify({ id: botId, bot: true })
            : JSON.stringify([
                discordMessage({
                  id: "923456789012345678",
                  authorId: botId,
                  bot: true,
                  content: providerEffectContent,
                  timestamp: "2026-08-19T18:00:00.000Z",
                }),
                discordMessage({
                  id: "623456789012345678",
                  authorId: humanId,
                  bot: false,
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
    ).rejects.toThrow(
      /timed out waiting for the exact human-authored ingress and later bot-authored provider effect/,
    );
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

  it("rejects a credential for a different Discord bot before channel readback", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "993456789012345678", bot: true }), {
          status: 200,
        }),
    );
    await expect(
      collectDiscordRawReadback({
        preflight: preflightDiscordOperatorCanary(fixture()),
        discordBotToken: "secret-discord-token-value",
        fetchImpl,
      }),
    ).rejects.toThrow(/credential does not match the bound agent bot/);
    expect(fetchImpl).toHaveBeenCalledOnce();
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
