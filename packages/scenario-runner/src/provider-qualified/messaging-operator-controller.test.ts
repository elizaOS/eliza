/**
 * Exercises four messaging-provider operator boundaries with real Ed25519
 * manifest authorization and deterministic capability doubles. The doubles
 * prove fail-closed contracts only and are never presented as live evidence.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import signalScenario from "../../../test/scenarios/provider-qualified/provider.signal.confirmed-send.scenario.ts";
import telegramScenario from "../../../test/scenarios/provider-qualified/provider.telegram.confirmed-send.scenario.ts";
import whatsappScenario from "../../../test/scenarios/provider-qualified/provider.whatsapp.confirmed-send.scenario.ts";
import xScenario from "../../../test/scenarios/provider-qualified/provider.x-dm.confirmed-send.scenario.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  executeMessagingOperatorCanary,
  type MessagingCanaryKind,
  type MessagingExternalCapabilities,
  type MessagingOperatorPlan,
  preflightMessagingOperatorCanary,
} from "./messaging-operator-controller.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";
import type { ValidatedProviderFailureProbeExecution } from "./raw-controller-contracts.ts";
import { createRawControllerTrajectoryMaterial } from "./raw-controller-test-fixtures.ts";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const connectionRefSha256 = digest("operator-messaging-connection");
const runNonce = "m".repeat(64);
const baseMs = Date.now();
const timestamp = new Date(baseMs).toISOString();

const CASES = {
  "signal.message-send": {
    scenario: signalScenario,
    connectorProvider: "signal",
    accountId: "operator-signal-canary-account",
    capability: "signal.message.send",
    target: { recipientKind: "direct", channelId: "+14155550101" },
    input: { text: "Signal provider canary delivery" },
  },
  "telegram.message-send": {
    scenario: telegramScenario,
    connectorProvider: "telegram",
    accountId: "operator-telegram-canary-account",
    capability: "telegram.message.send",
    target: { chatId: "123456789", threadId: null },
    input: { text: "Telegram provider canary delivery" },
  },
  "whatsapp.message-send": {
    scenario: whatsappScenario,
    connectorProvider: "whatsapp",
    accountId: "operator-whatsapp-canary-account",
    capability: "whatsapp.message.send",
    target: { transport: "cloud-api", chatId: "+14155550102" },
    input: {
      text: "WhatsApp provider canary delivery",
      replyToMessageId: null,
      attachments: [],
    },
  },
  "x.direct-message-send": {
    scenario: xScenario,
    connectorProvider: "x",
    accountId: "operator-x-canary-account",
    capability: "x.direct-message.send",
    target: { participantId: "1234567890123456789" },
    input: { text: "X provider canary delivery" },
  },
} as const;

type Case = (typeof CASES)[MessagingCanaryKind];

function probeMaterials(kind: MessagingCanaryKind) {
  return [
    {
      probeId: `${kind}-authorization-denied`,
      requestPayload: { operation: kind, effect: "must-not-run" },
      expectedErrorCode: "missing-provider-grant",
      scope: { accountId: CASES[kind].accountId },
      authorizationGrant: { grant: "denied" },
    },
    {
      probeId: `${kind}-provider-rejected`,
      requestPayload: { operation: kind, target: "invalid" },
      expectedErrorCode: "provider-invalid-target",
      scope: { accountId: CASES[kind].accountId },
      authorizationGrant: { grant: CASES[kind].capability },
    },
  ] as const;
}

function fixture(kind: MessagingCanaryKind) {
  const item: Case = CASES[kind];
  const authority = generateKeyPairSync("ed25519");
  const publicKeyPem = authority.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const keyId = providerObserverKeyId(publicKeyPem);
  const accountRefSha256 = digest(item.accountId);
  const principalRefSha256 = digest(`operator-principal:${kind}`);
  const roomRefSha256 = digest(`operator-room:${kind}`);
  const [authorizationDenied, providerRejected] = probeMaterials(kind).map(
    createProviderFailureProbeHashBinding,
  );
  const bindings: ProviderRunBindings = {
    runId: `messaging-operator-${kind.replaceAll(".", "-")}`,
    runNonce,
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: keyId,
      observerSigners: [
        {
          observerId: `${item.connectorProvider}-provider-observer`,
          keyId: digest(`${item.connectorProvider}-observer-key`),
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
      judgeKeyId: digest("independent-messaging-judge-key"),
    },
    connectors: [
      {
        provider: item.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: item.connectorProvider,
      channel: `${item.connectorProvider}-authenticated-ingress`,
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: digest("https://deployed-agent.example.test"),
    },
    capabilities: [
      {
        provider: item.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        capability: "message-send",
        authorizationGrantSha256: digest("message-send"),
      },
    ],
    observationContracts: [
      {
        contractId: `${item.connectorProvider}-canary-message-send`,
        kind: "provider-effect",
        observerId: `${item.connectorProvider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.connectorProvider,
        environment: "operator-canary",
        connectorProvider: item.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: item.connectorProvider,
        operation: "message-send",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authorizationDenied.probeId,
        observerId: `${item.connectorProvider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.connectorProvider,
        environment: "operator-canary",
        provider: item.connectorProvider,
        connectorProvider: item.connectorProvider,
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
        observerId: `${item.connectorProvider}-provider-observer`,
        sourceKind: "provider-api",
        system: item.connectorProvider,
        environment: "operator-canary",
        provider: item.connectorProvider,
        connectorProvider: item.connectorProvider,
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
  const authorization = authorizeProviderCanary({
    scenario: item.scenario,
    bindings,
    manifestAuthorityPrivateKey: authority.privateKey,
  });
  const plan: MessagingOperatorPlan = {
    schema: "eliza.messaging-provider-canary-operator-plan.v1",
    scenarioId: item.scenario.id as MessagingOperatorPlan["scenarioId"],
    operationKind: kind,
    accountId: item.accountId,
    connectionRefSha256,
    runNonce,
  };
  return {
    scenario: item.scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
    providerTarget: item.target,
    operationInput: item.input,
    failureProbes: probeMaterials(kind),
    plan,
  };
}

function preflight(kind: MessagingCanaryKind) {
  return preflightMessagingOperatorCanary(fixture(kind));
}

function capabilities(
  kind: MessagingCanaryKind,
): MessagingExternalCapabilities {
  const item = CASES[kind];
  const state = digest(`${kind}:provider-state`);
  const operation = createProviderCanaryTargetBinding({
    kind,
    providerTarget: item.target,
    operationInput: item.input,
  });
  return {
    assertCredentialReady: vi.fn(async () => ({
      accountId: item.accountId,
      connectionRefSha256,
      grantedCapabilities: [item.capability],
      checkedAtIso: timestamp,
    })),
    sendAuthenticatedIngress: vi.fn(async () => ({
      requestId: `${kind}-ingress`,
      acceptedAtIso: timestamp,
      scenarioId: item.scenario.id,
      runNonce,
      providerTargetRefSha256: operation.providerTargetRefSha256,
      operationInputSha256: operation.operationInputSha256,
    })),
    collectAuthenticatedProviderReadback: vi.fn(async () => ({
      providerMessageId: `${kind}-message-id`,
      observedAtIso: timestamp,
      providerPayloadSha256: digest(`${kind}:provider-payload`),
      providerTargetRefSha256: operation.providerTargetRefSha256,
      operationInputSha256: operation.operationInputSha256,
      providerAccepted: true,
    })),
    replayAuthenticatedIngress: vi.fn(async ({ binding }) => ({
      binding,
      replayRequestId: `${kind}-replay`,
      observedAtIso: timestamp,
      duplicateEffectCount: 0,
      providerStateBeforeSha256: state,
      providerStateAfterSha256: state,
    })),
    executeIndependentFailureProbes: vi.fn(async ({ probes }) =>
      probes.map(
        (execution: ValidatedProviderFailureProbeExecution, index: number) => ({
          ...(() => {
            const { binding } = execution;
            return {
              probeId: binding.probeId,
              failureClass:
                index === 0 ? "authorization-denied" : "provider-rejected",
              observedAtIso: timestamp,
              statusCode: index === 0 ? 403 : 400,
              errorCodeSha256: binding.expectedErrorCodeSha256,
              requestPayloadSha256: binding.requestPayloadSha256,
              scopeSha256: binding.scopeSha256,
              authorizationGrantSha256: binding.authorizationGrantSha256,
              responsePayloadSha256: digest(`${kind}:probe-response:${index}`),
              providerRequestIdSha256:
                index === 0 ? null : digest(`${kind}:provider-rejection`),
              providerStateBeforeSha256: state,
              providerStateAfterSha256: state,
            };
          })(),
        }),
      ),
    ),
    exportDeployedTrajectory: vi.fn(async () =>
      createRawControllerTrajectoryMaterial({
        runId: `messaging-operator-${kind.replaceAll(".", "-")}`,
        scenarioId: item.scenario.id,
        baseMs,
      }),
    ),
  };
}

describe("messaging provider-canary operator", () => {
  it.each(Object.keys(CASES) as MessagingCanaryKind[])(
    "collects a correlated unsigned receipt for %s",
    async (kind) => {
      const pre = preflight(kind);
      const external = capabilities(kind);
      const receipt = await executeMessagingOperatorCanary({
        preflight: pre,
        capabilities: external,
        now: () => Date.parse(timestamp),
      });
      expect(receipt.operationKind).toBe(kind);
      expect(receipt.failureProbes).toHaveLength(2);
      expect(receipt.qualificationClaimed).toBe(false);
      expect(receipt.trajectory.runId).toBe(
        pre.authorization.manifest.run.runId,
      );
      expect(receipt.replay.binding).toMatchObject({
        scenarioId: pre.scenarioId,
        runId: pre.authorization.manifest.run.runId,
        runNonce,
      });
      expect(external.executeIndependentFailureProbes).toHaveBeenCalledWith({
        scenarioId: pre.scenarioId,
        operation: pre.operation,
        probes: pre.failureProbeExecutions,
      });
      expect(external.assertCredentialReady).toHaveBeenCalledTimes(1);
      expect(external.sendAuthenticatedIngress).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a substituted target before any capability can run", () => {
    const input = fixture("telegram.message-send");
    expect(() =>
      preflightMessagingOperatorCanary({
        ...input,
        providerTarget: { chatId: "999999999", threadId: null },
      }),
    ).toThrow(/does not match the signed manifest/);
  });

  it("rejects a substituted failure probe before any capability can run", () => {
    const input = fixture("signal.message-send");
    expect(() =>
      preflightMessagingOperatorCanary({
        ...input,
        failureProbes: [
          { ...input.failureProbes[0], expectedErrorCode: "substituted" },
          input.failureProbes[1],
        ],
      }),
    ).toThrow(/failure probe material does not match/);
  });

  it("requires the exact branded preflight and every capability before credentials", async () => {
    const pre = preflight("whatsapp.message-send");
    const external = capabilities("whatsapp.message-send");
    const missing = { ...external } as Record<string, unknown>;
    delete missing.replayAuthenticatedIngress;
    await expect(
      executeMessagingOperatorCanary({
        preflight: pre,
        capabilities: missing as unknown as MessagingExternalCapabilities,
      }),
    ).rejects.toThrow(/missing=replayAuthenticatedIngress/);
    expect(external.assertCredentialReady).not.toHaveBeenCalled();
    await expect(
      executeMessagingOperatorCanary({
        preflight: { ...pre },
        capabilities: external,
      }),
    ).rejects.toThrow(/exact result of preflight/);
  });

  it("rejects credential scope drift before ingress", async () => {
    const pre = preflight("x.direct-message-send");
    const external = capabilities("x.direct-message-send");
    external.assertCredentialReady = vi.fn(async () => ({
      accountId: CASES["x.direct-message-send"].accountId,
      connectionRefSha256,
      grantedCapabilities: ["x.tweet.write"],
      checkedAtIso: timestamp,
    }));
    await expect(
      executeMessagingOperatorCanary({
        preflight: pre,
        capabilities: external,
      }),
    ).rejects.toThrow(/does not grant the required provider capability/);
    expect(external.sendAuthenticatedIngress).not.toHaveBeenCalled();
  });

  it("rejects ingress or readback substitution", async () => {
    const pre = preflight("signal.message-send");
    const external = capabilities("signal.message-send");
    external.sendAuthenticatedIngress = vi.fn(async () => ({
      requestId: "substituted-ingress",
      acceptedAtIso: timestamp,
      scenarioId: pre.scenarioId,
      runNonce,
      providerTargetRefSha256: digest("wrong-target"),
      operationInputSha256: pre.execution.targetBinding.operationInputSha256,
    }));
    await expect(
      executeMessagingOperatorCanary({
        preflight: pre,
        capabilities: external,
      }),
    ).rejects.toThrow(/does not correlate to the signed provider target/);
    expect(
      external.collectAuthenticatedProviderReadback,
    ).not.toHaveBeenCalled();
  });

  it("rejects replay duplication and failure-probe state mutation", async () => {
    const pre = preflight("telegram.message-send");
    const duplicate = capabilities("telegram.message-send");
    duplicate.replayAuthenticatedIngress = vi.fn(async ({ binding }) => ({
      binding,
      replayRequestId: "duplicate-replay",
      observedAtIso: timestamp,
      duplicateEffectCount: 1,
      providerStateBeforeSha256: digest("state"),
      providerStateAfterSha256: digest("state-plus-one"),
    }));
    await expect(
      executeMessagingOperatorCanary({
        preflight: pre,
        capabilities: duplicate,
      }),
    ).rejects.toThrow(/duplicate provider effect/);

    const mutated = capabilities("telegram.message-send");
    const original = mutated.executeIndependentFailureProbes;
    mutated.executeIndependentFailureProbes = vi.fn(async (input) => {
      const receipts = (await original(input)) as Array<
        Record<string, unknown>
      >;
      return receipts.map((receipt, index) =>
        index === 1
          ? { ...receipt, providerStateAfterSha256: digest("changed") }
          : receipt,
      );
    });
    await expect(
      executeMessagingOperatorCanary({ preflight: pre, capabilities: mutated }),
    ).rejects.toThrow(/changed provider state/);
  });

  it("rejects closed-shape extensions before signed input processing", () => {
    const input = fixture("x.direct-message-send");
    expect(() =>
      preflightMessagingOperatorCanary({
        ...input,
        plan: { ...input.plan, bearerToken: "must-never-be-accepted" },
      }),
    ).toThrow(/violates the closed shape/);
  });
});
