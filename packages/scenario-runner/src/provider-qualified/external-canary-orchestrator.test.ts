/**
 * Verifies the external canary coordinator fails closed around real operator
 * authorization while provider-facing collaborators remain deterministic test
 * doubles; no test output is accepted as qualification evidence.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type {
  ProviderEffectObservation,
  ScenarioEvidenceObserverProvenance,
  ScenarioReport,
} from "../types.ts";
import {
  type ExternalProviderCanaryCapabilities,
  executeExternalProviderCanary,
} from "./external-canary-orchestrator.ts";
import { canonicalSha256, type ProviderRunBindings } from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import {
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  runnerResultSha256,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";
import { reverifyProviderQualificationArtifact } from "./qualification-artifact.ts";
import type { VerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

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

function bindings(
  authorityKeyId: string,
  observerKeyId: string,
  judgeKeyId: string,
): ProviderRunBindings {
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
        { observerId: "calendar-observer", keyId: observerKeyId },
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
      judgeKeyId,
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
  const authorityPair = generateKeyPairSync("ed25519");
  const observerPair = generateKeyPairSync("ed25519");
  const semanticPair = generateKeyPairSync("ed25519");
  const authorityPublicKeyPem = authorityPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const observerPublicKeyPem = observerPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const semanticPublicKeyPem = semanticPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const authorization = authorizeProviderCanary({
    scenario: definition,
    bindings: bindings(
      providerObserverKeyId(authorityPublicKeyPem),
      providerObserverKeyId(observerPublicKeyPem),
      providerObserverKeyId(semanticPublicKeyPem),
    ),
    manifestAuthorityPrivateKey: authorityPair.privateKey,
  });
  const manifest = authorization.manifest;
  const events: string[] = [];
  const finalChecks = manifest.scenario.finalChecks.map((check) => ({
    definitionSha256: check.definitionSha256,
    status: "passed" as const,
  }));
  const report: ScenarioReport = {
    id: definition.id,
    title: definition.title,
    domain: definition.domain,
    tags: [],
    status: "passed",
    durationMs: 60_000,
    turns: [],
    finalChecks: manifest.scenario.finalChecks.map((check) => ({
      label: check.type,
      type: check.type,
      status: "passed",
      detail: "independently verified",
    })),
    actionsCalled: [],
    failedAssertions: [],
    providerName: "live-provider",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    evidence: {
      schemaVersion: 1,
      executionProfile: "provider-qualified",
      qualification: {
        status: "unqualified",
        publishable: false,
        reasons: ["external-controller-decision:pending"],
      },
      observerProvenance: [],
      trajectoryHashes: [],
      observations: [],
    },
  };
  const trajectorySha256 = hash("trajectory bytes");
  const stageSha256 = hash("canonical stage");
  const trajectories: VerifiedScenarioTrajectorySet = {
    scenarioId: definition.id,
    runId: manifest.run.runId,
    scenarioStartedAtIso: "2026-08-20T17:00:00.000Z",
    scenarioEndedAtIso: "2026-08-20T17:01:00.000Z",
    runDirectoryRealPath: "/private/operator/run-1",
    verifiedAtIso: "2026-08-20T17:01:05.000Z",
    setSha256: "0".repeat(64),
    trajectories: [
      {
        artifact: {
          trajectoryId: "trajectory-1",
          relativePath: "trajectories/agent/trajectory-1.json",
          sha256: trajectorySha256,
          recorder: {
            implementation: "@elizaos/core/trajectory-recorder",
            version: "1",
            environment: "operator-canary",
          },
        },
        stages: [
          {
            stageId: "stage-calendar-create",
            kind: "tool",
            sha256: stageSha256,
            startedAtIso: "2026-08-20T17:00:20.000Z",
            endedAtIso: "2026-08-20T17:00:30.000Z",
            tool: {
              name: "CALENDAR",
              argsSha256: hash("calendar tool args"),
              resultSha256: hash("calendar tool result"),
              success: true,
            },
          },
        ],
      },
    ],
  };
  const trajectorySetSha256 = canonicalSha256(
    trajectories.trajectories.map((trajectory) => ({
      artifact: trajectory.artifact,
      stages: trajectory.stages,
    })),
    "verifiedTrajectories",
  );
  trajectories.setSha256 = trajectorySetSha256;
  const observer: ScenarioEvidenceObserverProvenance = {
    observerId: "calendar-observer",
    kind: "provider-api",
    implementation: "calendar-readback-adapter",
    version: "1.0.0",
    environment: "operator-canary",
    configurationSha256: hash("observer config"),
  };
  const observation: ProviderEffectObservation = {
    observationId: "effect-1",
    kind: "provider-effect",
    observedAtIso: "2026-08-20T17:01:05.000Z",
    observerId: observer.observerId,
    source: {
      kind: "provider-api",
      system: "google-calendar",
      environment: "operator-canary",
      recordIdSha256: hash("provider-record"),
      accountRefSha256: hash("operator-calendar-account"),
    },
    payloadSha256: hash("observation payload"),
    trajectoryRefs: [
      {
        trajectoryId: "trajectory-1",
        stageId: "stage-calendar-create",
        sha256: trajectorySha256,
      },
    ],
    provider: "google-calendar",
    operation: "event-create",
    accountRefSha256: hash("operator-calendar-account"),
    requestSha256: hash("provider request"),
    responseSha256: hash("provider response"),
    providerReceiptIdSha256: hash("provider receipt"),
    readbackSha256: hash("provider readback"),
  };
  const observerPayload: ProviderObserverEvidencePayload = {
    schema: PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
    manifestSha256: manifest.manifestSha256,
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    scenarioId: manifest.scenario.id,
    scenarioStartedAtIso: trajectories.scenarioStartedAtIso,
    scenarioEndedAtIso: trajectories.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: trajectories.verifiedAtIso,
    signedAtIso: "2026-08-20T17:01:10.000Z",
    trajectorySetSha256,
    runnerResultSha256: runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks,
    }),
    observerProvenance: [observer],
    observations: [observation],
    connectorBindings: [
      {
        observationId: observation.observationId,
        provider: "google",
        accountRefSha256: hash("operator-calendar-account"),
        connectionRefSha256: hash("operator-calendar-connection"),
        authorizationGrantSha256s: [hash("calendar-write-grant")],
        operation: manifest.target.operation,
      },
    ],
    failureProbeObservations: manifest.requiredFailureProbes.map((probe) => ({
      probeId: probe.probeId,
      observedAtIso: "2026-08-20T17:01:06.000Z",
      observerId: probe.observerId,
      sourceKind: probe.sourceKind,
      system: probe.system,
      environment: probe.environment,
      provider: probe.provider,
      connectorProvider: probe.connectorProvider,
      accountRefSha256: probe.accountRefSha256,
      connectionRefSha256: probe.connectionRefSha256,
      operation: probe.operation,
      failureClass: probe.failureClass,
      requestPayloadSha256: probe.requestPayloadSha256,
      responseSha256: hash(`response:${probe.probeId}`),
      providerRequestIdSha256:
        probe.failureClass === "provider-rejected"
          ? hash(`provider-request:${probe.probeId}`)
          : null,
      responseStatusCode: probe.expectedStatusCode,
      errorCodeSha256: probe.expectedErrorCodeSha256,
      scopeSha256: probe.scopeSha256,
      beforeSnapshotSha256: hash(`unchanged:${probe.probeId}`),
      afterSnapshotSha256: hash(`unchanged:${probe.probeId}`),
      authorizationGrantSha256: probe.authorizationGrantSha256,
    })),
    stageReferences: [
      {
        observationId: observation.observationId,
        trajectoryId: "trajectory-1",
        stageId: "stage-calendar-create",
        stageSha256,
      },
    ],
    providerEffectAssurances: [
      {
        observationId: observation.observationId,
        providerAccepted: true,
        readbackVerified: true,
        idempotency: {
          mode: "provider-key",
          keySha256: hash("idempotency key"),
          replayVerified: true,
        },
      },
    ],
  };
  const observerEvidence = {
    keyId: providerObserverKeyId(observerPublicKeyPem),
    payload: observerPayload,
    signature: signPayload(
      null,
      providerEvidenceSigningBytes(observerPayload),
      observerPair.privateKey,
    ).toString("base64url"),
  };
  const semanticPayload: SemanticJudgeEvidencePayload = {
    schema: SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
    manifestSha256: manifest.manifestSha256,
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    scenarioId: manifest.scenario.id,
    scenarioEndedAtIso: trajectories.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: trajectories.verifiedAtIso,
    signedAtIso: "2026-08-20T17:01:12.000Z",
    trajectorySetSha256,
    actingAdapter: manifest.models.actingAdapter,
    actingProvider: manifest.models.actingProvider,
    actingModel: manifest.models.actingModel,
    judgeProvider: manifest.models.judgeProvider,
    judgeModel: manifest.models.judgeModel,
    verdicts: manifest.scenario.semanticCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      rubricSha256: criterion.rubricSha256,
      status: "passed",
      score: 0.95,
      requestSha256: hash(`request:${criterion.criterionId}`),
      responseSha256: hash(`response:${criterion.criterionId}`),
    })),
  };
  const semanticEvidence = {
    keyId: providerObserverKeyId(semanticPublicKeyPem),
    payload: semanticPayload,
    signature: signPayload(
      null,
      semanticEvidenceSigningBytes(semanticPayload),
      semanticPair.privateKey,
    ).toString("base64url"),
  };
  const capabilities = {
    observer: {
      async begin() {
        events.push("observer.begin");
        return {
          async complete() {
            events.push("observer.complete");
            return observerEvidence;
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
        return trajectories;
      },
    },
    semanticJudge: {
      async judge() {
        events.push("semanticJudge.judge");
        return semanticEvidence;
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
      pinnedManifestAuthorityPublicKeysPem: [authorityPublicKeyPem] as const,
      operationKind: "google-calendar.event-create" as const,
      providerTarget,
      operationInput,
      failureProbes,
      pinnedObserverPublicKeysPem: [observerPublicKeyPem] as const,
      pinnedSemanticJudgePublicKeysPem: [semanticPublicKeyPem] as const,
      capabilities,
      now: () => new Date("2026-08-20T17:01:20.000Z"),
    },
    capabilities,
    events,
    observerEvidence,
  };
}

describe("external provider canary orchestration", () => {
  it("publishes one genuinely qualified and reverified artifact after cleanup", async () => {
    const test = harness();
    let cleanupArtifactSha256: string | undefined;
    (
      test.capabilities.cleanup as ExternalProviderCanaryCapabilities["cleanup"]
    ).cleanup = async ({ artifact }) => {
      test.events.push("cleanup.cleanup");
      cleanupArtifactSha256 = artifact?.artifactSha256;
    };
    const result = await executeExternalProviderCanary(test.input);

    expect(result.completedStages).toEqual([
      "authorization-validated",
      "observer-started",
      "ingress-completed",
      "trajectories-verified",
      "observer-evidence-completed",
      "semantic-judgment-completed",
      "artifact-reverified",
      "cleanup-completed",
      "published",
    ]);
    expect(test.events).toEqual([
      "observer.begin",
      "ingress.execute",
      "trajectories.verify",
      "observer.complete",
      "semanticJudge.judge",
      "cleanup.cleanup",
      "publisher.publish",
    ]);
    expect(
      test.events.filter((event) => event === "publisher.publish"),
    ).toHaveLength(1);
    expect(result.artifact.decision.qualification).toEqual({
      status: "qualified",
      publishable: true,
      reasons: [],
    });
    expect(result.artifact.qualifiedReport?.status).toBe("passed");
    expect(cleanupArtifactSha256).toBe(result.artifact.artifactSha256);
    expect(() =>
      reverifyProviderQualificationArtifact(result.artifact),
    ).not.toThrow();
  });

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
    let receivedArtifact = true;
    (
      test.capabilities.cleanup as ExternalProviderCanaryCapabilities["cleanup"]
    ).cleanup = async ({ artifact }) => {
      test.events.push("cleanup.cleanup");
      receivedArtifact = artifact !== undefined;
    };
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
    expect(receivedArtifact).toBe(false);
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
