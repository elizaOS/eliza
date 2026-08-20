/**
 * Exercises the controller bridge through the real generic orchestrator and
 * qualifier. Provider/controller/signer services are deterministic remote
 * doubles; their output is never represented as live provider evidence.
 */

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signPayload,
} from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type {
  ProviderEffectObservation,
  ScenarioEvidenceObserverProvenance,
  ScenarioReport,
} from "../types.ts";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  createProviderControllerOrchestratorBridge,
  PROVIDER_CLEANUP_PROOF_SCHEMA,
  PROVIDER_CONTROLLER_BRIDGE_CONTRACTS,
  type ProviderCleanupProofPayload,
} from "./controller-orchestrator-bridge.ts";
import { validateOperatorOwnedProviderCapabilities } from "./external-canary-cli.ts";
import { executeExternalProviderCanary } from "./external-canary-orchestrator.ts";
import {
  GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA,
  type GoogleWorkspaceRawReceipt,
} from "./google-workspace-operator-controller.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
  type ProviderRunBindings,
} from "./manifest.ts";
import {
  authorizeProviderCanary,
  createProviderCanaryTargetBinding,
  createProviderFailureProbeHashBinding,
} from "./operator-authorization.ts";
import {
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  type SemanticJudgeEvidencePayload,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";
import { verifyDeployedTrajectoryRun } from "./raw-controller-contracts.ts";
import { createRawControllerTrajectoryMaterial } from "./raw-controller-test-fixtures.ts";
import {
  type RemoteEvidenceSignerPin,
  type RemoteEvidenceSignerRole,
  remoteEvidenceSignerIdentitySha256,
} from "./remote-evidence-signer-client.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const baseMs = Date.now();
const iso = (offsetMs: number): string =>
  new Date(baseMs + offsetMs).toISOString();
const trajectoryNow = new Date(baseMs + 5_000);
const fixedNow = new Date(baseMs + 20_000);
const providerTarget = { calendarId: "canary-calendar" };
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
  idempotencyKey: "calendar-canary-bridge-001",
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

function signerPin(input: {
  role: RemoteEvidenceSignerRole;
  endpoint: string;
  organizationId: string;
  publicKeyPem: string;
}): RemoteEvidenceSignerPin {
  const keyId = providerObserverKeyId(input.publicKeyPem);
  return Object.freeze({
    ...input,
    keyId,
    serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
      role: input.role,
      endpoint: input.endpoint,
      organizationId: input.organizationId,
      keyId,
    }),
  });
}

function scenario(): ScenarioDefinition {
  return {
    id: "provider.google-calendar.create",
    title: "Google Calendar provider bridge",
    domain: "provider-canary",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    turns: [
      { name: "ingress", kind: "message", text: "Create the canary event." },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "calendar-event-create",
        observerId: "calendar-observer",
        provider: "google-calendar",
        connectorProvider: "google",
        accountId: "calendar-account",
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
  const accountRefSha256 = hash("calendar-account");
  const connectionRefSha256 = hash("calendar-connection");
  const principalRefSha256 = hash("principal");
  const roomRefSha256 = hash("room");
  const [denied, rejected] = failureProbes.map((probe) =>
    createProviderFailureProbeHashBinding(probe),
  );
  return {
    runId: "bridge-run-001",
    runNonce: "r".repeat(64),
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
      judgeProvider: "judge-provider",
      judgeModel: "judge-model",
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
      channel: "calendar",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: principalRefSha256,
      roomRefSha256,
      endpointOriginSha256: hash("https://ingress.example.test"),
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
        probeId: denied.probeId,
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
        requestPayloadSha256: denied.requestPayloadSha256,
        expectedStatusCode: 403,
        expectedErrorCodeSha256: denied.expectedErrorCodeSha256,
        scopeSha256: denied.scopeSha256,
        authorizationGrantSha256: denied.authorizationGrantSha256,
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

describe("provider controller-orchestrator bridge", () => {
  it("maps all 13 canonical canaries and exposes only complete raw contracts", () => {
    expect(Object.keys(PROVIDER_CONTROLLER_BRIDGE_CONTRACTS)).toHaveLength(13);
    expect(Object.keys(PROVIDER_CONTROLLER_BRIDGE_CONTRACTS)).toEqual([
      ...PROVIDER_CANARY_SCENARIO_IDS,
    ]);
    expect(
      Object.values(PROVIDER_CONTROLLER_BRIDGE_CONTRACTS).filter(
        (contract) => contract.availability === "raw-controller-bridgeable",
      ),
    ).toHaveLength(9);
    expect(
      PROVIDER_CONTROLLER_BRIDGE_CONTRACTS["provider.discord.confirmed-send"]
        .availability,
    ).toBe("requires-deployed-composite-adapter");
    expect(
      PROVIDER_CONTROLLER_BRIDGE_CONTRACTS["provider.slack.confirmed-send"]
        .availability,
    ).toBe("requires-deployed-composite-adapter");
    expect(
      PROVIDER_CONTROLLER_BRIDGE_CONTRACTS["provider.twilio-sms.confirmed-send"]
        .availability,
    ).toBe("requires-deployed-composite-adapter");
    expect(
      PROVIDER_CONTROLLER_BRIDGE_CONTRACTS[
        "provider.twilio-voice.confirmed-call"
      ].availability,
    ).toBe("requires-deployed-composite-adapter");
  });

  it("passes one Google raw-controller result through remote signers and the real qualifier", async () => {
    const definition = scenario();
    const authority = generateKeyPairSync("ed25519");
    const observer = generateKeyPairSync("ed25519");
    const judge = generateKeyPairSync("ed25519");
    const cleanup = generateKeyPairSync("ed25519");
    const publicPem = (pair: { publicKey: KeyObject }) =>
      pair.publicKey.export({ type: "spki", format: "pem" });
    const authorityPem = publicPem(authority);
    const observerPem = publicPem(observer);
    const judgePem = publicPem(judge);
    const cleanupPem = publicPem(cleanup);
    const authorization = authorizeProviderCanary({
      scenario: definition,
      bindings: bindings(
        providerObserverKeyId(authorityPem),
        providerObserverKeyId(observerPem),
        providerObserverKeyId(judgePem),
      ),
      manifestAuthorityPrivateKey: authority.privateKey,
    });
    const manifest = authorization.manifest;
    const material = createRawControllerTrajectoryMaterial({
      runId: manifest.run.runId,
      scenarioId: definition.id,
      baseMs,
    });
    const trajectories = verifyDeployedTrajectoryRun({
      material,
      expectedRunId: manifest.run.runId,
      expectedScenarioId: definition.id,
      now: trajectoryNow,
    });
    const report: ScenarioReport = {
      id: definition.id,
      title: definition.title,
      domain: definition.domain,
      tags: [],
      status: "passed",
      durationMs: 5,
      turns: [],
      finalChecks: manifest.scenario.finalChecks.map((check) => ({
        label: check.type,
        type: check.type,
        status: "passed",
        detail: "verified by external evidence",
      })),
      actionsCalled: [],
      failedAssertions: [],
      providerName: "acting-provider",
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
    const rawReceipt: GoogleWorkspaceRawReceipt = {
      schema: GOOGLE_WORKSPACE_RAW_RECEIPT_SCHEMA,
      scenarioId: "provider.google-calendar.create",
      operationKind: "google-calendar.event-create",
      collectedAtIso: iso(10_000),
      credential: {
        accountId: "calendar-account",
        connectionRefSha256: hash("calendar-connection"),
        grantedCapabilities: ["event-create"],
        checkedAtIso: iso(-5),
      },
      ingress: {
        requestId: "request-1",
        acceptedAtIso: iso(-4),
        scenarioId: definition.id,
        runNonce: manifest.run.nonce,
      },
      readback: {
        providerResourceId: "event-1",
        observedAtIso: iso(1_000),
        providerPayloadSha256: hash("provider-payload"),
        providerAccepted: true,
      },
      replay: {
        binding: {
          scenarioId: definition.id,
          runId: manifest.run.runId,
          runNonce: manifest.run.nonce,
          originalIngressRequestIdSha256: hash("request-1"),
          originalProviderEventIdSha256: hash("event-1"),
          originalEffectSha256: hash("provider-payload"),
          operationSha256: canonicalSha256(
            manifest.target.operation,
            "operation",
          ),
        },
        replayRequestId: "replay-1",
        observedAtIso: iso(2_000),
        duplicateEffectCount: 0,
        providerStateBeforeSha256: hash("state"),
        providerStateAfterSha256: hash("state"),
      },
      failureProbes: manifest.requiredFailureProbes.map((probe) => ({
        probeId: probe.probeId,
        failureClass: probe.failureClass,
        observedAtIso: iso(3_000),
        statusCode: probe.expectedStatusCode,
        errorCodeSha256: probe.expectedErrorCodeSha256,
        requestPayloadSha256: probe.requestPayloadSha256,
        scopeSha256: probe.scopeSha256,
        authorizationGrantSha256: probe.authorizationGrantSha256,
        responsePayloadSha256: hash(`response:${probe.probeId}`),
        providerRequestIdSha256:
          probe.failureClass === "provider-rejected"
            ? hash(`request:${probe.probeId}`)
            : null,
        providerStateBeforeSha256: hash(`unchanged:${probe.probeId}`),
        providerStateAfterSha256: hash(`unchanged:${probe.probeId}`),
      })),
      trajectory: trajectories,
      qualificationClaimed: false,
    };
    const observerProvenance: ScenarioEvidenceObserverProvenance = {
      observerId: "calendar-observer",
      kind: "provider-api",
      implementation: "remote-calendar-observer",
      version: "1",
      environment: "operator-canary",
      configurationSha256: hash("observer-configuration"),
    };
    const stage = trajectories.trajectories[0].stages[0];
    const trajectory = trajectories.trajectories[0];
    const observation: ProviderEffectObservation = {
      observationId: "effect-1",
      kind: "provider-effect",
      observedAtIso: iso(5_000),
      observerId: observerProvenance.observerId,
      source: {
        kind: "provider-api",
        system: "google-calendar",
        environment: "operator-canary",
        recordIdSha256: hash("event-1"),
        accountRefSha256: hash("calendar-account"),
      },
      payloadSha256: hash("observation"),
      trajectoryRefs: [
        {
          trajectoryId: trajectory.artifact.trajectoryId,
          stageId: stage.stageId,
          sha256: trajectory.artifact.sha256,
        },
      ],
      provider: "google-calendar",
      operation: "event-create",
      accountRefSha256: hash("calendar-account"),
      requestSha256: hash("request"),
      responseSha256: hash("response"),
      providerReceiptIdSha256: hash("event-1"),
      readbackSha256: hash("readback"),
    };
    let published = false;
    const observerPin = signerPin({
      role: "observer",
      endpoint: "https://observer-signer.example.test/sign",
      organizationId: "observer-signing.example",
      publicKeyPem: observerPem,
    });
    const judgePin = signerPin({
      role: "semantic-judge",
      endpoint: "https://judge-signer.example.test/sign",
      organizationId: "judge-signing.example",
      publicKeyPem: judgePem,
    });
    const bridge = createProviderControllerOrchestratorBridge({
      scenarioId: "provider.google-calendar.create",
      operationKind: "google-calendar.event-create",
      controller: {
        endpointOrigin: "https://controller.example.test",
        controllerFamily: "google-workspace",
        async execute() {
          return {
            rawControllerMaterial: rawReceipt,
            runnerReport: report,
            trajectories,
            cleanupScopeSha256: hash("event-1-cleanup"),
          };
        },
      },
      observer: {
        endpointOrigin: "https://observer.example.test",
        administrativeDomain: "observer.example",
        async beginObservation({ correlation }) {
          return {
            sessionId: "observer-session-1",
            correlationSha256: canonicalSha256(
              correlation,
              "providerBridge.correlation",
            ),
          };
        },
        async complete() {
          return {
            observerProvenance: [observerProvenance],
            observations: [observation],
            connectorBindings: [
              {
                observationId: observation.observationId,
                provider: "google",
                accountRefSha256: hash("calendar-account"),
                connectionRefSha256: hash("calendar-connection"),
                authorizationGrantSha256s: [hash("calendar-write-grant")],
                operation: manifest.target.operation,
              },
            ],
            failureProbeObservations: manifest.requiredFailureProbes.map(
              (probe) => ({
                probeId: probe.probeId,
                observedAtIso: iso(6_000),
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
                    ? hash(`request:${probe.probeId}`)
                    : null,
                responseStatusCode: probe.expectedStatusCode,
                errorCodeSha256: probe.expectedErrorCodeSha256,
                scopeSha256: probe.scopeSha256,
                beforeSnapshotSha256: hash(`unchanged:${probe.probeId}`),
                afterSnapshotSha256: hash(`unchanged:${probe.probeId}`),
                authorizationGrantSha256: probe.authorizationGrantSha256,
              }),
            ),
            stageReferences: [
              {
                observationId: observation.observationId,
                trajectoryId: trajectory.artifact.trajectoryId,
                stageId: stage.stageId,
                stageSha256: stage.sha256,
              },
            ],
            providerEffectAssurances: [
              {
                observationId: observation.observationId,
                providerAccepted: true,
                readbackVerified: true,
                idempotency: {
                  mode: "provider-readback",
                  keySha256: hash("event-idempotency"),
                  replayVerified: true,
                },
              },
            ],
          };
        },
      },
      observerSigner: {
        pin: observerPin,
        async sign(payload: ProviderObserverEvidencePayload) {
          return {
            keyId: observerPin.keyId,
            payload,
            signature: signPayload(
              null,
              providerEvidenceSigningBytes(payload),
              observer.privateKey,
            ).toString("base64url"),
          };
        },
      },
      semanticJudge: {
        async evaluate() {
          return manifest.scenario.semanticCriteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            rubricSha256: criterion.rubricSha256,
            status: "passed",
            score: 0.95,
            requestSha256: hash(`judge-request:${criterion.criterionId}`),
            responseSha256: hash(`judge-response:${criterion.criterionId}`),
          }));
        },
      },
      semanticJudgeSigner: {
        pin: judgePin,
        async sign(payload: SemanticJudgeEvidencePayload) {
          return {
            keyId: judgePin.keyId,
            payload,
            signature: signPayload(
              null,
              semanticEvidenceSigningBytes(payload),
              judge.privateKey,
            ).toString("base64url"),
          };
        },
      },
      cleanup: {
        endpointOrigin: "https://cleanup.example.test",
        administrativeDomain: "operator-cleanup.example",
        keyId: providerObserverKeyId(cleanupPem),
        publicKeyPem: cleanupPem,
        async cleanupAndSign({
          correlation,
          cleanupScopeSha256,
          rawControllerMaterialSha256,
        }) {
          const payload: ProviderCleanupProofPayload = {
            schema: PROVIDER_CLEANUP_PROOF_SCHEMA,
            scenarioId: correlation.scenarioId,
            runId: correlation.runId,
            runNonce: correlation.runNonce,
            manifestSha256: correlation.manifestSha256,
            cleanupScopeSha256,
            rawControllerMaterialSha256,
            disposition: "cleaned",
            completedAtIso: iso(15_000),
          };
          return {
            keyId: providerObserverKeyId(cleanupPem),
            payload,
            signature: signPayload(
              null,
              Buffer.from(
                canonicalJson(canonicalJsonValue(payload, "cleanupProof")),
                "utf8",
              ),
              cleanup.privateKey,
            ).toString("base64url"),
          };
        },
      },
      pinnedObserverPublicKeysPem: [observerPem],
      pinnedSemanticJudgePublicKeysPem: [judgePem],
      pinnedCleanupPublicKeysPem: [cleanupPem],
      now: () => fixedNow,
    });
    const result = await executeExternalProviderCanary({
      scenario: definition,
      authorization,
      pinnedManifestAuthorityPublicKeysPem: [authorityPem],
      operationKind: "google-calendar.event-create",
      providerTarget,
      operationInput,
      failureProbes,
      pinnedObserverPublicKeysPem: [observerPem],
      pinnedSemanticJudgePublicKeysPem: [judgePem],
      capabilities: {
        ...validateOperatorOwnedProviderCapabilities(bridge.capabilities),
        publisher: {
          async publish(artifact) {
            const cleanupProof = bridge.takeVerifiedCleanupProof();
            expect(artifact.decision.qualification.publishable).toBe(true);
            expect(cleanupProof.payload.disposition).toBe("cleaned");
            published = true;
          },
        },
      },
      now: () => fixedNow,
    });

    expect(result.artifact.decision.qualification.publishable).toBe(true);
    expect(result.completedStages.at(-1)).toBe("published");
    expect(published).toBe(true);
  });

  it("rejects wrong operation routing and collocated signers before ingress", () => {
    const key = generateKeyPairSync("ed25519");
    const pem = key.publicKey.export({ type: "spki", format: "pem" });
    const observerPin = signerPin({
      role: "observer",
      endpoint: "https://signer.example.test/sign",
      organizationId: "same.example",
      publicKeyPem: pem,
    });
    const judgePin = signerPin({
      role: "semantic-judge",
      endpoint: "https://signer.example.test/sign",
      organizationId: "same.example",
      publicKeyPem: pem,
    });
    const base = {
      controller: {
        endpointOrigin: "https://controller.example.test",
        controllerFamily: "discord" as const,
        async execute() {
          throw new Error("must not execute");
        },
      },
      observer: {
        endpointOrigin: "https://observer.example.test",
        administrativeDomain: "observer.example",
        async beginObservation() {
          throw new Error("must not execute");
        },
        async complete() {
          throw new Error("must not execute");
        },
      },
      observerSigner: {
        pin: observerPin,
        async sign() {
          throw new Error("must not execute");
        },
      },
      semanticJudge: {
        async evaluate() {
          throw new Error("must not execute");
        },
      },
      semanticJudgeSigner: {
        pin: judgePin,
        async sign() {
          throw new Error("must not execute");
        },
      },
      cleanup: {
        endpointOrigin: "https://cleanup.example.test",
        administrativeDomain: "cleanup.example",
        keyId: providerObserverKeyId(pem),
        publicKeyPem: pem,
        async cleanupAndSign() {
          throw new Error("must not execute");
        },
      },
      pinnedObserverPublicKeysPem: [pem] as const,
      pinnedSemanticJudgePublicKeysPem: [pem] as const,
      pinnedCleanupPublicKeysPem: [pem] as const,
    };
    const signerWithPrivateKey = {
      ...base.observerSigner,
      privateKey: "forbidden-in-process-key-material",
    };
    expect(() =>
      createProviderControllerOrchestratorBridge({
        ...base,
        scenarioId: "provider.discord.confirmed-send",
        operationKind: "slack.message-send",
      }),
    ).toThrow(/operation kind does not match/);
    expect(() =>
      createProviderControllerOrchestratorBridge({
        ...base,
        scenarioId: "provider.google-calendar.create",
        operationKind: "google-calendar.event-create",
        controller: {
          ...base.controller,
          controllerFamily: "google-workspace",
        },
      }),
    ).toThrow(/endpoint origins must be distinct/);
    expect(() =>
      createProviderControllerOrchestratorBridge({
        ...base,
        scenarioId: "provider.google-calendar.create",
        operationKind: "google-calendar.event-create",
        controller: {
          ...base.controller,
          controllerFamily: "google-workspace",
        },
        observerSigner: signerWithPrivateKey,
      }),
    ).toThrow(
      /observerSigner violates the closed capability shape.*privateKey/,
    );
  });
});
