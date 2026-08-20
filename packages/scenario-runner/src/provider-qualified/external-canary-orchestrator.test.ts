/**
 * Verifies the external canary coordinator fails closed around real operator
 * authorization while provider-facing collaborators remain deterministic test
 * doubles; no test output is accepted as qualification evidence.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type { ScenarioReport } from "../types.ts";
import {
  type ExternalProviderCanaryCapabilities,
  executeExternalProviderCanary,
} from "./external-canary-orchestrator.ts";
import type { ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import { providerObserverKeyId } from "./qualification.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const providerTarget = { calendarId: "operator-canary-calendar" };
const operationInput = {
  title: "Harmless canary event",
  start: "2026-08-20T17:00:00.000Z",
  end: "2026-08-20T17:15:00.000Z",
  timeZone: "UTC",
  attendees: [],
  location: null,
  description: null,
  createMeetLink: false,
  sendUpdates: "none",
  recurrence: [],
  idempotencyKey: "calendar-canary-001",
};
const failureProbes = [
  {
    probeId: "calendar-auth-denied",
    requestPayload: { title: "Denied" },
    expectedErrorCode: "insufficient-scope",
    scope: providerTarget,
    authorizationGrant: { grant: "denied" },
  },
  {
    probeId: "calendar-provider-rejected",
    requestPayload: { title: "Rejected" },
    expectedErrorCode: "invalid-event",
    scope: providerTarget,
    authorizationGrant: { grant: "write" },
  },
] as const;

function scenario(): ScenarioDefinition {
  return {
    id: "provider.calendar.external-orchestration",
    title: "Provider-qualified external calendar orchestration",
    domain: "provider-canary",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    turns: [{ name: "ingress", kind: "message", text: "Create the event." }],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "calendar-event-create",
        observerId: "calendar-observer",
        provider: "google-calendar",
        connectorProvider: "google",
        accountId: "operator-calendar-account",
        operation: "event-create",
        minCount: 1,
      },
      {
        type: "judgeRubric",
        name: "truthful-result",
        rubric: "Success is claimed only when independently observed.",
        minimumScore: 0.9,
      },
    ],
  };
}

function bindings(authorityKeyId: string): ProviderRunBindings {
  const accountRefSha256 = hash("operator-calendar-account");
  const connectionRefSha256 = hash("operator-calendar-connection");
  const principalRefSha256 = hash("operator-principal");
  const roomRefSha256 = hash("operator-room");
  const [authDenied, rejected] = failureProbes.map((probe) =>
    createProviderFailureProbeHashBinding(probe),
  );
  return {
    runId: "operator-run-001",
    runNonce: "n".repeat(64),
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId: authorityKeyId,
      observerSigners: [
        { observerId: "calendar-observer", keyId: hash("observer-key") },
      ],
    },
    target: {
      principalRefSha256,
      roomRefSha256,
      operation: createProviderCanaryTargetBinding({
        kind: "google-calendar.event-create",
        providerTarget,
        operationInput,
      }),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "acting-provider",
      actingModel: "acting-model",
      judgeProvider: "independent-provider",
      judgeModel: "independent-model",
      judgeKeyId: hash("judge-key"),
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
      kind: "provider-api",
      provider: "google",
      channel: "operator-canary",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://canary.example.test"),
    },
    capabilities: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        capability: "event-create",
        authorizationGrantSha256: hash("calendar-write-grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "calendar-event-create",
        kind: "provider-effect",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: "google-calendar",
        operation: "event-create",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: authDenied.probeId,
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "authorization-denied",
        requestPayloadSha256: authDenied.requestPayloadSha256,
        expectedStatusCode: 403,
        expectedErrorCodeSha256: authDenied.expectedErrorCodeSha256,
        scopeSha256: authDenied.scopeSha256,
        authorizationGrantSha256: authDenied.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: rejected.probeId,
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "provider-rejected",
        requestPayloadSha256: rejected.requestPayloadSha256,
        expectedStatusCode: 400,
        expectedErrorCodeSha256: rejected.expectedErrorCodeSha256,
        scopeSha256: rejected.scopeSha256,
        authorizationGrantSha256: rejected.authorizationGrantSha256,
        maxObservationAgeMs: 60_000,
      },
    ],
  };
}

function harness() {
  const definition = scenario();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const authorization = authorizeProviderCanary({
    scenario: definition,
    bindings: bindings(providerObserverKeyId(publicKeyPem)),
    manifestAuthorityPrivateKey: keyPair.privateKey,
  });
  const events: string[] = [];
  const report = { id: definition.id } as ScenarioReport;
  const trajectories = {
    scenarioId: definition.id,
    runId: authorization.manifest.run.runId,
    setSha256: hash("trajectory-set"),
  };
  const observerEvidence = {
    payload: {
      scenarioId: definition.id,
      runId: authorization.manifest.run.runId,
      runNonce: authorization.manifest.run.nonce,
      manifestSha256: authorization.manifest.manifestSha256,
      trajectorySetSha256: trajectories.setSha256,
    },
  };
  const semanticEvidence = { payload: { ...observerEvidence.payload } };
  const capabilities = {
    observer: {
      async begin() {
        events.push("observer.begin");
        return {
          async complete() {
            events.push("observer.complete");
            return observerEvidence as never;
          },
        };
      },
    },
    ingress: {
      async execute() {
        events.push("ingress.execute");
        return { runnerReport: report };
      },
    },
    trajectories: {
      async verify() {
        events.push("trajectories.verify");
        return trajectories as never;
      },
    },
    semanticJudge: {
      async judge() {
        events.push("semanticJudge.judge");
        return semanticEvidence as never;
      },
    },
    cleanup: {
      async cleanup() {
        events.push("cleanup.cleanup");
      },
    },
    publisher: {
      async publish() {
        events.push("publisher.publish");
      },
    },
  } satisfies ExternalProviderCanaryCapabilities;
  return {
    input: {
      scenario: definition,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: [publicKeyPem] as const,
      operationKind: "google-calendar.event-create" as const,
      providerTarget,
      operationInput,
      failureProbes,
      pinnedObserverPublicKeysPem: [publicKeyPem] as const,
      pinnedSemanticJudgePublicKeysPem: [publicKeyPem] as const,
      capabilities,
    },
    capabilities,
    events,
    observerEvidence,
  };
}

describe("external provider canary orchestration", () => {
  it("rejects invalid operator authorization before any external capability", async () => {
    const test = harness();
    const authorization = structuredClone(test.input.authorization);
    authorization.manifestSignature.signature = "A".repeat(86);
    await expect(
      executeExternalProviderCanary({ ...test.input, authorization }),
    ).rejects.toThrow(/signature is invalid|canonical Ed25519 signature/);
    expect(test.events).toEqual([]);
  });

  it("refuses missing capabilities before starting an observer or ingress", async () => {
    const test = harness();
    const capabilities = {
      ...test.capabilities,
      semanticJudge: undefined,
    } as unknown as ExternalProviderCanaryCapabilities;
    await expect(
      executeExternalProviderCanary({ ...test.input, capabilities }),
    ).rejects.toThrow(/semanticJudge\.judge is required before ingress/);
    expect(test.events).toEqual([]);
  });

  it("orders observation before ingress and cleans up a partial failure", async () => {
    const test = harness();
    test.capabilities.trajectories.verify = async () => {
      test.events.push("trajectories.verify");
      throw new Error("trajectory export unavailable");
    };
    await expect(executeExternalProviderCanary(test.input)).rejects.toThrow(
      /trajectory export unavailable/,
    );
    expect(test.events).toEqual([
      "observer.begin",
      "ingress.execute",
      "trajectories.verify",
      "cleanup.cleanup",
    ]);
    expect(test.events).not.toContain("publisher.publish");
  });

  it("rejects cross-run evidence and never publishes it", async () => {
    const test = harness();
    test.observerEvidence.payload.runId = "another-run";
    await expect(executeExternalProviderCanary(test.input)).rejects.toThrow(
      /not correlated to the authorized run/,
    );
    expect(test.events.at(-1)).toBe("cleanup.cleanup");
    expect(test.events).not.toContain("publisher.publish");
  });

  it("withholds publication when cleanup fails after a partial run", async () => {
    const test = harness();
    test.capabilities.ingress.execute = async () => {
      test.events.push("ingress.execute");
      throw new Error("provider rejected ingress");
    };
    test.capabilities.cleanup.cleanup = async () => {
      test.events.push("cleanup.cleanup");
      throw new Error("target teardown failed");
    };
    await expect(executeExternalProviderCanary(test.input)).rejects.toThrow(
      /execution and cleanup failed/,
    );
    expect(test.events).not.toContain("publisher.publish");
  });
});
