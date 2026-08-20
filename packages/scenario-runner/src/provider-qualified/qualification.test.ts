/**
 * Adversarially verifies cryptographic observer binding and fail-closed
 * qualification derivation. Tests sign real Ed25519 payload bytes while all
 * provider records remain data-only fixtures for this pure decision module.
 */

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign as signPayload,
} from "node:crypto";
import { resolve } from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type {
  ProviderEffectObservation,
  ProviderNoEffectObservation,
  ScenarioEvidenceObserverProvenance,
} from "../types.ts";
import {
  canonicalSha256,
  createProviderQualificationManifest,
  type ProviderRunBindings,
} from "./manifest.ts";
import {
  type DeriveProviderQualificationInput,
  deriveProviderQualification,
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  type ProviderQualificationManifestSignature,
  providerEvidenceSigningBytes,
  providerManifestSigningBytes,
  providerObserverKeyId,
  runnerResultSha256,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
  type SignedProviderObserverEvidence,
  type SignedSemanticJudgeEvidence,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";
import type { VerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function scenario(): ScenarioDefinition {
  return {
    id: "calendar.provider.create",
    title: "Create a provider calendar event",
    domain: "calendar",
    lane: "live-only",
    executionProfile: "provider-qualified",
    evidenceScope: "provider-certification",
    isolation: "per-scenario",
    turns: [
      {
        name: "real ingress",
        kind: "message",
        text: "Create the school pickup event.",
        responseJudge: {
          rubric: "The response accurately states the verified outcome.",
          minimumScore: 0.9,
        },
      },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: "calendar-create",
        observerId: "calendar-observer",
        provider: "google-calendar",
        connectorProvider: "google",
        accountId: "parent-account",
        operation: "event-create",
      },
      {
        type: "judgeRubric",
        name: "no-fabrication",
        rubric: "No provider success is claimed without an accepted receipt.",
        minimumScore: 0.9,
      },
    ],
  };
}

function bindings(
  judgeKeyId: string,
  observerKeyId = hash("observer-key"),
  manifestAuthorityKeyId = hash("manifest-authority-key"),
): ProviderRunBindings {
  const accountRefSha256 = hash("parent-account");
  const connectionRefSha256 = hash("connection");
  return {
    runId: "run-1",
    runNonce: "n".repeat(64),
    repositorySha: "a".repeat(40),
    deploymentSha: "b".repeat(64),
    trust: {
      manifestAuthorityKeyId,
      observerSigners: [
        {
          observerId: "calendar-observer",
          keyId: observerKeyId,
        },
      ],
    },
    target: {
      principalRefSha256: hash("principal"),
      roomRefSha256: hash("room"),
      operation: {
        schema: "eliza.provider-operation-binding.v1",
        kind: "google-calendar.event-create",
        providerTargetRefSha256: hash("provider-target"),
        operationInputSha256: hash("operation-input"),
      },
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "openai",
      actingModel: "gpt-5",
      judgeProvider: "independent-evaluator",
      judgeModel: "judge-model-v1",
      judgeKeyId,
    },
    connectors: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        environment: "provider-sandbox",
      },
    ],
    ingress: {
      kind: "provider-webhook",
      provider: "google",
      channel: "google-chat",
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: hash("principal"),
      roomRefSha256: hash("room"),
      endpointOriginSha256: hash("https://ingress.example.test"),
    },
    capabilities: [
      {
        provider: "google",
        accountRefSha256,
        connectionRefSha256,
        capability: "event-create",
        authorizationGrantSha256: hash("grant"),
      },
    ],
    observationContracts: [
      {
        contractId: "calendar-create",
        kind: "provider-effect",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "provider-sandbox",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 5 * 60_000,
        provider: "google-calendar",
        operation: "event-create",
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
    failureProbes: [
      {
        probeId: "calendar-auth-denied",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "provider-sandbox",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "authorization-denied",
        requestPayloadSha256: hash("auth-denied-request"),
        expectedStatusCode: 403,
        expectedErrorCodeSha256: hash("insufficient-scope"),
        scopeSha256: hash("calendar-failure-scope"),
        authorizationGrantSha256: hash("denied-grant"),
        maxObservationAgeMs: 5 * 60_000,
      },
      {
        probeId: "calendar-provider-rejected",
        observerId: "calendar-observer",
        sourceKind: "provider-api",
        system: "google-calendar",
        environment: "provider-sandbox",
        provider: "google-calendar",
        connectorProvider: "google",
        accountRefSha256,
        connectionRefSha256,
        operation: "event-create",
        failureClass: "provider-rejected",
        requestPayloadSha256: hash("provider-rejected-request"),
        expectedStatusCode: 400,
        expectedErrorCodeSha256: hash("invalid-event"),
        scopeSha256: hash("calendar-failure-scope"),
        authorizationGrantSha256: hash("grant"),
        maxObservationAgeMs: 5 * 60_000,
      },
    ],
  };
}

function fixture(): DeriveProviderQualificationInput & {
  manifestAuthorityPrivateKey: KeyObject;
  observerPrivateKey: KeyObject;
  semanticPrivateKey: KeyObject;
} {
  const manifestAuthorityKeyPair = generateKeyPairSync("ed25519");
  const observerKeyPair = generateKeyPairSync("ed25519");
  const semanticKeyPair = generateKeyPairSync("ed25519");
  const observerPublicKeyPem = observerKeyPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const semanticPublicKeyPem = semanticKeyPair.publicKey.export({
    type: "spki",
    format: "pem",
  });
  const manifestAuthorityPublicKeyPem =
    manifestAuthorityKeyPair.publicKey.export({
      type: "spki",
      format: "pem",
    });
  const scenarioDefinition = scenario();
  const manifest = createProviderQualificationManifest({
    scenario: scenarioDefinition,
    bindings: bindings(
      providerObserverKeyId(semanticPublicKeyPem),
      providerObserverKeyId(observerPublicKeyPem),
      providerObserverKeyId(manifestAuthorityPublicKeyPem),
    ),
  });
  const manifestSignature: ProviderQualificationManifestSignature = {
    keyId: providerObserverKeyId(manifestAuthorityPublicKeyPem),
    manifestSha256: manifest.manifestSha256,
    signature: signPayload(
      null,
      providerManifestSigningBytes(manifest),
      manifestAuthorityKeyPair.privateKey,
    ).toString("base64url"),
  };
  const trajectorySha256 = hash("trajectory bytes");
  const stageSha256 = hash("canonical stage");
  const trajectories: VerifiedScenarioTrajectorySet = {
    runId: manifest.run.runId,
    scenarioId: manifest.scenario.id,
    scenarioStartedAtIso: "2026-05-23T00:00:00.000Z",
    scenarioEndedAtIso: "2026-05-23T00:01:00.000Z",
    runDirectoryRealPath: resolve("run", "provider-1"),
    verifiedAtIso: "2026-05-23T00:01:05.000Z",
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
            environment: "provider-sandbox",
          },
        },
        stages: [
          {
            stageId: "stage-calendar-create",
            kind: "tool",
            sha256: stageSha256,
            startedAtIso: "2026-05-23T00:00:20.000Z",
            endedAtIso: "2026-05-23T00:00:30.000Z",
          },
        ],
      },
    ],
  };
  trajectories.setSha256 = canonicalSha256(
    trajectories.trajectories.map((trajectory) => ({
      artifact: trajectory.artifact,
      stages: trajectory.stages,
    })),
    "verifiedTrajectories",
  );
  const observer: ScenarioEvidenceObserverProvenance = {
    observerId: "calendar-observer",
    kind: "provider-api",
    implementation: "calendar-readback-adapter",
    version: "1.0.0",
    environment: "provider-sandbox",
    configurationSha256: hash("observer config"),
  };
  const observation: ProviderEffectObservation = {
    observationId: "effect-1",
    kind: "provider-effect",
    observedAtIso: "2026-05-23T00:01:05.000Z",
    observerId: observer.observerId,
    source: {
      kind: "provider-api",
      system: "google-calendar",
      environment: "provider-sandbox",
      recordIdSha256: hash("provider-record"),
      accountRefSha256: hash("parent-account"),
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
    accountRefSha256: hash("parent-account"),
    requestSha256: hash("provider request"),
    responseSha256: hash("provider response"),
    providerReceiptIdSha256: hash("provider receipt"),
    readbackSha256: hash("provider readback"),
  };
  const finalChecks = manifest.scenario.finalChecks.map((check) => ({
    definitionSha256: check.definitionSha256,
    status: "passed" as const,
  }));
  const payload: ProviderObserverEvidencePayload = {
    schema: PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
    manifestSha256: manifest.manifestSha256,
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    scenarioId: manifest.scenario.id,
    scenarioStartedAtIso: "2026-05-23T00:00:00.000Z",
    scenarioEndedAtIso: "2026-05-23T00:01:00.000Z",
    trajectoryVerifiedAtIso: trajectories.verifiedAtIso,
    signedAtIso: "2026-05-23T00:01:10.000Z",
    trajectorySetSha256: trajectories.setSha256,
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
        accountRefSha256: hash("parent-account"),
        connectionRefSha256: hash("connection"),
        authorizationGrantSha256s: [hash("grant")],
        operation: manifest.target.operation,
      },
    ],
    failureProbeObservations: manifest.requiredFailureProbes.map((probe) => ({
      probeId: probe.probeId,
      observedAtIso: "2026-05-23T00:01:06.000Z",
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
  const signedEvidence: SignedProviderObserverEvidence = {
    keyId: providerObserverKeyId(observerPublicKeyPem),
    payload,
    signature: signPayload(
      null,
      providerEvidenceSigningBytes(payload),
      observerKeyPair.privateKey,
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
    signedAtIso: "2026-05-23T00:01:12.000Z",
    trajectorySetSha256: trajectories.setSha256,
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
  const signedSemanticEvidence: SignedSemanticJudgeEvidence = {
    keyId: providerObserverKeyId(semanticPublicKeyPem),
    payload: semanticPayload,
    signature: signPayload(
      null,
      semanticEvidenceSigningBytes(semanticPayload),
      semanticKeyPair.privateKey,
    ).toString("base64url"),
  };
  return {
    scenarioDefinition,
    manifest,
    manifestSignature,
    pinnedManifestAuthorityPublicKeysPem: [manifestAuthorityPublicKeyPem],
    trajectories,
    signedEvidence,
    pinnedObserverPublicKeysPem: [observerPublicKeyPem],
    signedSemanticEvidence,
    pinnedSemanticJudgePublicKeysPem: [semanticPublicKeyPem],
    scenarioStatus: "passed",
    finalChecks,
    nowIso: "2026-05-23T00:01:20.000Z",
    manifestAuthorityPrivateKey: manifestAuthorityKeyPair.privateKey,
    observerPrivateKey: observerKeyPair.privateKey,
    semanticPrivateKey: semanticKeyPair.privateKey,
  };
}

function resignManifest(
  input: DeriveProviderQualificationInput & {
    manifestAuthorityPrivateKey: KeyObject;
  },
): void {
  input.manifestSignature.manifestSha256 = input.manifest.manifestSha256;
  input.manifestSignature.signature = signPayload(
    null,
    providerManifestSigningBytes(input.manifest),
    input.manifestAuthorityPrivateKey,
  ).toString("base64url");
}

function resignProvider(
  input: DeriveProviderQualificationInput & {
    observerPrivateKey: KeyObject;
  },
): void {
  input.signedEvidence.signature = signPayload(
    null,
    providerEvidenceSigningBytes(input.signedEvidence.payload),
    input.observerPrivateKey,
  ).toString("base64url");
}

function resignSemantic(
  input: DeriveProviderQualificationInput & {
    semanticPrivateKey: KeyObject;
  },
): void {
  input.signedSemanticEvidence.signature = signPayload(
    null,
    semanticEvidenceSigningBytes(input.signedSemanticEvidence.payload),
    input.semanticPrivateKey,
  ).toString("base64url");
}

function noEffectFixture(): ReturnType<typeof fixture> {
  const input = fixture();
  const definition = scenario();
  definition.finalChecks = [
    {
      type: "providerNoEffectObserved",
      name: "calendar-no-effect",
      observerId: "calendar-observer",
      provider: "google-calendar",
      connectorProvider: "google",
      accountId: "parent-account",
      intervalCoversScenario: true,
    },
    definition.finalChecks?.[1] as NonNullable<
      ScenarioDefinition["finalChecks"]
    >[number],
  ];
  const noEffectBindings = bindings(
    input.signedSemanticEvidence.keyId,
    input.signedEvidence.keyId,
    input.manifestSignature.keyId,
  );
  noEffectBindings.observationContracts = [
    {
      contractId: "calendar-no-effect",
      kind: "provider-no-effect",
      observerId: "calendar-observer",
      sourceKind: "provider-api",
      system: "google-calendar",
      environment: "provider-sandbox",
      connectorProvider: "google",
      accountRefSha256: hash("parent-account"),
      connectionRefSha256: hash("connection"),
      requiredCount: 1,
      maxObservationAgeMs: 5 * 60_000,
      provider: "google-calendar",
      effectKinds: ["event-create"],
      scopeSha256: hash("calendar-window"),
      intervalCoverage: "full-scenario",
    },
  ];
  const manifest = createProviderQualificationManifest({
    scenario: definition,
    bindings: noEffectBindings,
  });
  input.scenarioDefinition = definition;
  input.manifest = manifest;
  resignManifest(input);
  const prior = input.signedEvidence.payload
    .observations[0] as ProviderEffectObservation;
  const observation: ProviderNoEffectObservation = {
    observationId: "no-effect-1",
    kind: "provider-no-effect",
    observedAtIso: "2026-05-23T00:01:05.000Z",
    observerId: prior.observerId,
    source: {
      ...prior.source,
      kind: "provider-api",
    },
    payloadSha256: hash("no-effect-payload"),
    trajectoryRefs: prior.trajectoryRefs,
    provider: "google-calendar",
    accountRefSha256: hash("parent-account"),
    effectKinds: ["event-create"],
    scopeSha256: hash("calendar-window"),
    beforeSnapshotSha256: hash("unchanged-calendar"),
    afterSnapshotSha256: hash("unchanged-calendar"),
    observationStartedAtIso: "2026-05-23T00:00:00.000Z",
    observationEndedAtIso: "2026-05-23T00:01:05.000Z",
  };
  input.finalChecks = manifest.scenario.finalChecks.map((check) => ({
    definitionSha256: check.definitionSha256,
    status: "passed",
  }));
  Object.assign(input.signedEvidence.payload, {
    manifestSha256: manifest.manifestSha256,
    observations: [observation],
    connectorBindings: [
      {
        observationId: observation.observationId,
        provider: "google",
        accountRefSha256: hash("parent-account"),
        connectionRefSha256: hash("connection"),
        authorizationGrantSha256s: [hash("grant")],
        operation: manifest.target.operation,
      },
    ],
    stageReferences: [
      {
        ...input.signedEvidence.payload.stageReferences[0],
        observationId: observation.observationId,
      },
    ],
    providerEffectAssurances: [],
    runnerResultSha256: runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks: input.finalChecks,
    }),
  });
  Object.assign(input.signedSemanticEvidence.payload, {
    manifestSha256: manifest.manifestSha256,
    verdicts: manifest.scenario.semanticCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      rubricSha256: criterion.rubricSha256,
      status: "passed" as const,
      score: 0.95,
      requestSha256: hash(`request:${criterion.criterionId}`),
      responseSha256: hash(`response:${criterion.criterionId}`),
    })),
  });
  resignProvider(input);
  resignSemantic(input);
  return input;
}

describe("deriveProviderQualification", () => {
  it("derives publishable qualification without claiming exactly-once", () => {
    const input = fixture();
    const decision = deriveProviderQualification(input);

    expect(decision.qualification).toEqual({
      status: "qualified",
      publishable: true,
      reasons: [],
    });
    expect(decision.matchedObservationContracts).toEqual([
      { observationId: "effect-1", contractId: "calendar-create" },
    ]);
    expect(decision.guarantees).toEqual({
      providerAuthorizationVerified: true,
      providerFailurePathsVerified: true,
      providerAcceptanceVerified: true,
      providerReadbackVerified: true,
      providerIdempotencyVerified: true,
      exactlyOnce: false,
    });
  });

  it("rejects a correctly signed hand-built manifest that omits required protocol bindings", () => {
    const input = fixture();
    const handBuilt = structuredClone(input.manifest);
    handBuilt.trust.observerSigners = [] as never;
    handBuilt.connectors = [] as never;
    handBuilt.capabilities = [] as never;
    handBuilt.requiredObservations = [] as never;
    handBuilt.scenario.finalChecks = [];
    handBuilt.scenario.semanticCriteria = [] as never;
    const { manifestSha256: _oldHash, ...core } = handBuilt;
    handBuilt.manifestSha256 = canonicalSha256(core, "manifest");
    input.manifest = handBuilt;
    resignManifest(input);

    expect(() => deriveProviderQualification(input)).toThrow(
      /observerSigners.*at least one observer signer/,
    );
  });

  it("rejects a valid signed manifest paired with a substituted authored scenario", () => {
    const input = fixture();
    input.scenarioDefinition.turns[0].text =
      "Delete the connected calendar instead.";

    expect(() => deriveProviderQualification(input)).toThrow(
      /does not exactly match the canonical manifest/,
    );
  });

  it("rejects a correctly signed empty fabricated trajectory set before qualification", () => {
    const input = fixture();
    (
      input.trajectories as unknown as {
        trajectories: unknown[];
      }
    ).trajectories = [];
    input.trajectories.setSha256 = canonicalSha256([], "verifiedTrajectories");
    input.signedEvidence.payload.trajectorySetSha256 =
      input.trajectories.setSha256;
    input.signedSemanticEvidence.payload.trajectorySetSha256 =
      input.trajectories.setSha256;
    resignProvider(input);
    resignSemantic(input);

    expect(() => deriveProviderQualification(input)).toThrow(
      /trajectories\.trajectories must be non-empty/,
    );
  });

  it("rejects forged, unpinned, and stale signatures", () => {
    const forgedManifest = fixture();
    forgedManifest.manifestSignature.signature = "forged";
    expect(
      deriveProviderQualification(forgedManifest).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "manifest-signature:invalid-or-unpinned",
      ]),
    });

    const forged = fixture();
    const forgedObservation = forged.signedEvidence.payload
      .observations[0] as ProviderEffectObservation;
    forgedObservation.responseSha256 = hash("forged response");
    expect(deriveProviderQualification(forged).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-signature:invalid-or-unpinned",
      ]),
    });

    const unpinned = fixture();
    const other = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    unpinned.pinnedObserverPublicKeysPem = [other];
    expect(deriveProviderQualification(unpinned).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-signature:invalid-or-unpinned",
      ]),
    });

    const stale = fixture();
    stale.nowIso = "2026-05-23T01:01:20.000Z";
    expect(deriveProviderQualification(stale).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining(["observer-signature:stale-or-future"]),
    });
  });

  it("rejects unknown protocol fields instead of signing caller qualification", () => {
    const input = fixture();
    Object.assign(input.signedEvidence.payload, {
      qualification: { status: "qualified", publishable: true },
    });
    resignProvider(input);
    expect(() => deriveProviderQualification(input)).toThrow(/closed protocol/);
  });

  it("rejects legacy observer evidence without exact operation binding", () => {
    const input = fixture();
    input.signedEvidence.payload.schema =
      "eliza.provider-qualified-observer-evidence.v1" as typeof input.signedEvidence.payload.schema;
    expect(() => deriveProviderQualification(input)).toThrow(
      /signedEvidence\.payload\.schema is unsupported/,
    );
  });

  it("rejects provider-assurance toJSON substitution before signature verification", () => {
    const input = fixture();
    const signedPayload = structuredClone(input.signedEvidence.payload);
    signedPayload.providerEffectAssurances[0].providerAccepted = false;
    input.signedEvidence.signature = signPayload(
      null,
      providerEvidenceSigningBytes(signedPayload),
      input.observerPrivateKey,
    ).toString("base64url");
    Object.defineProperty(
      input.signedEvidence.payload.providerEffectAssurances[0],
      "toJSON",
      {
        enumerable: false,
        value: () => signedPayload.providerEffectAssurances[0],
      },
    );

    expect(() => deriveProviderQualification(input)).toThrow(
      /toJSON.*non-enumerable/,
    );
  });

  it("rejects semantic-verdict toJSON substitution before signature verification", () => {
    const input = fixture();
    const signedPayload = structuredClone(input.signedSemanticEvidence.payload);
    signedPayload.verdicts[0].status = "failed";
    signedPayload.verdicts[0].score = 0;
    input.signedSemanticEvidence.signature = signPayload(
      null,
      semanticEvidenceSigningBytes(signedPayload),
      input.semanticPrivateKey,
    ).toString("base64url");
    Object.defineProperty(
      input.signedSemanticEvidence.payload.verdicts[0],
      "toJSON",
      {
        enumerable: false,
        value: () => signedPayload.verdicts[0],
      },
    );

    expect(() => deriveProviderQualification(input)).toThrow(
      /toJSON.*non-enumerable/,
    );
  });

  it("rejects observer pins and provenance absent from the authorized manifest", () => {
    const extraPin = fixture();
    const secondObserverKey = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    extraPin.pinnedObserverPublicKeysPem = [
      extraPin.pinnedObserverPublicKeysPem[0],
      secondObserverKey,
    ];
    expect(deriveProviderQualification(extraPin).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-signature:manifest-pin-mismatch",
      ]),
    });

    const extraProvenance = fixture();
    extraProvenance.signedEvidence.payload.observerProvenance = [
      ...extraProvenance.signedEvidence.payload.observerProvenance,
      {
        ...extraProvenance.signedEvidence.payload.observerProvenance[0],
        observerId: "unbound-observer",
      },
    ];
    resignProvider(extraProvenance);
    expect(
      deriveProviderQualification(extraProvenance).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-provenance:manifest-multiset-mismatch",
        "observer-provenance:unbound-observer:signer-mismatch",
      ]),
    });
  });

  it("rejects a rehashed observer-pin swap without operator authorization", () => {
    const input = fixture();
    const attacker = generateKeyPairSync("ed25519");
    const attackerPublicKeyPem = attacker.publicKey.export({
      type: "spki",
      format: "pem",
    });
    const attackerKeyId = providerObserverKeyId(attackerPublicKeyPem);
    const changedManifest = structuredClone(input.manifest);
    changedManifest.trust.observerSigners[0].keyId = attackerKeyId;
    const { manifestSha256: _oldHash, ...manifestCore } = changedManifest;
    changedManifest.manifestSha256 = canonicalSha256(manifestCore, "manifest");
    input.manifest = changedManifest;
    input.manifestSignature.manifestSha256 = changedManifest.manifestSha256;
    input.pinnedObserverPublicKeysPem = [attackerPublicKeyPem];
    input.signedEvidence.keyId = attackerKeyId;
    input.signedEvidence.payload.manifestSha256 =
      changedManifest.manifestSha256;
    input.signedEvidence.signature = signPayload(
      null,
      providerEvidenceSigningBytes(input.signedEvidence.payload),
      attacker.privateKey,
    ).toString("base64url");
    input.signedSemanticEvidence.payload.manifestSha256 =
      changedManifest.manifestSha256;
    resignSemantic(input);

    expect(deriveProviderQualification(input).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "manifest-signature:invalid-or-unpinned",
      ]),
    });
  });

  it("rejects non-Ed25519 trust keys", () => {
    const input = fixture();
    const rsaPublicKeyPem = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey.export({ type: "spki", format: "pem" });
    input.pinnedObserverPublicKeysPem = [rsaPublicKeyPem];

    expect(() => deriveProviderQualification(input)).toThrow(/Ed25519/);
  });

  it("rejects run, nonce, manifest, and trajectory correlation substitutions", () => {
    const input = fixture();
    input.signedEvidence.payload.runNonce = "x".repeat(64);
    input.signedEvidence.payload.trajectorySetSha256 = hash("other set");
    resignProvider(input);
    expect(deriveProviderQualification(input).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-correlation:mismatch",
        "trajectory-set:correlation-mismatch",
      ]),
    });
  });

  it("rejects observations and observer signatures captured before final state", () => {
    const earlyEffect = fixture();
    earlyEffect.signedEvidence.payload.observations[0].observedAtIso =
      "2026-05-23T00:00:40.000Z";
    resignProvider(earlyEffect);
    expect(
      deriveProviderQualification(earlyEffect).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:stale-or-outside-run",
      ]),
    });

    const earlySignature = fixture();
    earlySignature.signedEvidence.payload.signedAtIso =
      "2026-05-23T00:00:50.000Z";
    resignProvider(earlySignature);
    expect(
      deriveProviderQualification(earlySignature).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observer-signature:before-final-state",
      ]),
    });
  });

  it("requires trajectory verification and semantic signing after scenario end", () => {
    const earlyTrajectory = fixture();
    earlyTrajectory.trajectories.verifiedAtIso = "2026-05-23T00:00:50.000Z";
    expect(
      deriveProviderQualification(earlyTrajectory).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "trajectory-verification:before-scenario-end",
      ]),
    });

    const earlySemantic = fixture();
    earlySemantic.signedSemanticEvidence.payload.signedAtIso =
      "2026-05-23T00:00:50.000Z";
    resignSemantic(earlySemantic);
    expect(
      deriveProviderQualification(earlySemantic).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "semantic-signature:before-final-state",
      ]),
    });
  });

  it("requires no-effect interval completion before observation and signing", () => {
    const observedTooEarly = noEffectFixture();
    const earlyObservation = observedTooEarly.signedEvidence.payload
      .observations[0] as ProviderNoEffectObservation;
    earlyObservation.observationEndedAtIso = "2026-05-23T00:01:20.000Z";
    observedTooEarly.signedEvidence.payload.signedAtIso =
      "2026-05-23T00:01:25.000Z";
    observedTooEarly.nowIso = "2026-05-23T00:01:30.000Z";
    resignProvider(observedTooEarly);
    expect(
      deriveProviderQualification(observedTooEarly).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:no-effect-1:observed-before-interval-end",
      ]),
    });

    const incomplete = noEffectFixture();
    const incompleteObservation = incomplete.signedEvidence.payload
      .observations[0] as ProviderNoEffectObservation;
    incompleteObservation.observationEndedAtIso = "2026-05-23T00:00:50.000Z";
    resignProvider(incomplete);
    expect(deriveProviderQualification(incomplete).qualification).toMatchObject(
      {
        status: "unqualified",
        reasons: expect.arrayContaining([
          "observation:no-effect-1:interval-gap",
        ]),
      },
    );
  });

  it("requires the exact observation multiset and bound connector account", () => {
    const extra = fixture();
    extra.signedEvidence.payload.observations = [
      ...extra.signedEvidence.payload.observations,
      {
        ...extra.signedEvidence.payload.observations[0],
        observationId: "effect-extra",
      },
    ];
    resignProvider(extra);
    expect(deriveProviderQualification(extra).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining(["observation:exact-multiset-mismatch"]),
    });

    const crossed = fixture();
    const crossedObservation = crossed.signedEvidence.payload
      .observations[0] as ProviderEffectObservation;
    crossedObservation.accountRefSha256 = hash("another-account");
    crossedObservation.source.accountRefSha256 = hash("another-account");
    resignProvider(crossed);
    expect(deriveProviderQualification(crossed).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining(["observation:exact-multiset-mismatch"]),
    });

    const wrongConnection = fixture();
    wrongConnection.signedEvidence.payload.connectorBindings[0].connectionRefSha256 =
      hash("another-connection");
    resignProvider(wrongConnection);
    expect(
      deriveProviderQualification(wrongConnection).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:connector-mismatch",
      ]),
    });

    const wrongAuthorization = fixture();
    wrongAuthorization.signedEvidence.payload.connectorBindings[0].authorizationGrantSha256s =
      [hash("another-grant")];
    resignProvider(wrongAuthorization);
    const wrongAuthorizationDecision =
      deriveProviderQualification(wrongAuthorization);
    expect(wrongAuthorizationDecision.qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:authorization-grant-mismatch",
      ]),
    });
    expect(
      wrongAuthorizationDecision.guarantees.providerAuthorizationVerified,
    ).toBe(false);

    const duplicateAuthorization = fixture();
    duplicateAuthorization.signedEvidence.payload.connectorBindings[0].authorizationGrantSha256s =
      [hash("grant"), hash("grant")];
    resignProvider(duplicateAuthorization);
    expect(() => deriveProviderQualification(duplicateAuthorization)).toThrow(
      /authorizationGrantSha256s must be unique and lexicographically sorted/,
    );

    const wrongTarget = fixture();
    wrongTarget.signedEvidence.payload.connectorBindings[0].operation = {
      ...wrongTarget.signedEvidence.payload.connectorBindings[0].operation,
      providerTargetRefSha256: hash("another-provider-target"),
    };
    resignProvider(wrongTarget);
    expect(
      deriveProviderQualification(wrongTarget).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:connector-mismatch",
      ]),
    });

    const wrongInput = fixture();
    wrongInput.signedEvidence.payload.connectorBindings[0].operation = {
      ...wrongInput.signedEvidence.payload.connectorBindings[0].operation,
      operationInputSha256: hash("another-operation-input"),
    };
    resignProvider(wrongInput);
    expect(deriveProviderQualification(wrongInput).qualification).toMatchObject(
      {
        status: "unqualified",
        reasons: expect.arrayContaining([
          "observation:effect-1:connector-mismatch",
        ]),
      },
    );
  });

  it("requires exact authorization-denied and provider-rejected no-effect probes", () => {
    const missing = fixture();
    missing.signedEvidence.payload.failureProbeObservations =
      missing.signedEvidence.payload.failureProbeObservations.slice(0, 1);
    resignProvider(missing);
    const missingDecision = deriveProviderQualification(missing);
    expect(missingDecision.qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "failure-probe:exact-multiset-mismatch",
      ]),
    });
    expect(missingDecision.guarantees.providerFailurePathsVerified).toBe(false);

    const substituted = fixture();
    substituted.signedEvidence.payload.failureProbeObservations[0].responseStatusCode = 401;
    resignProvider(substituted);
    expect(
      deriveProviderQualification(substituted).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "failure-probe:calendar-auth-denied:contract-mismatch",
      ]),
    });

    const changedState = fixture();
    changedState.signedEvidence.payload.failureProbeObservations[1].afterSnapshotSha256 =
      hash("provider-state-changed");
    resignProvider(changedState);
    expect(
      deriveProviderQualification(changedState).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "failure-probe:calendar-provider-rejected:provider-effect-observed",
      ]),
    });

    const deniedReachedProvider = fixture();
    deniedReachedProvider.signedEvidence.payload.failureProbeObservations[0].providerRequestIdSha256 =
      hash("unexpected-provider-request");
    resignProvider(deniedReachedProvider);
    expect(() => deriveProviderQualification(deniedReachedProvider)).toThrow(
      /must be null for authorization denial/,
    );

    const rejectedDidNotReachProvider = fixture();
    rejectedDidNotReachProvider.signedEvidence.payload.failureProbeObservations[1].providerRequestIdSha256 =
      null;
    resignProvider(rejectedDidNotReachProvider);
    expect(() =>
      deriveProviderQualification(rejectedDidNotReachProvider),
    ).toThrow(/providerRequestIdSha256 must be a non-empty string/);
  });

  it("rejects whole-trajectory and stage-level reference substitution", () => {
    const trajectoryMismatch = fixture();
    trajectoryMismatch.signedEvidence.payload.observations[0].trajectoryRefs[0].sha256 =
      hash("other trajectory");
    resignProvider(trajectoryMismatch);
    expect(
      deriveProviderQualification(trajectoryMismatch).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:trajectory-hash-mismatch",
      ]),
    });

    const stageMismatch = fixture();
    stageMismatch.signedEvidence.payload.stageReferences[0].stageSha256 =
      hash("other stage");
    resignProvider(stageMismatch);
    expect(
      deriveProviderQualification(stageMismatch).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining(["signed-stage-reference:hash-mismatch"]),
    });
  });

  it("requires provider acceptance, readback, and idempotency independently", () => {
    const acceptance = fixture();
    acceptance.signedEvidence.payload.providerEffectAssurances[0].providerAccepted = false;
    resignProvider(acceptance);
    expect(deriveProviderQualification(acceptance).qualification).toMatchObject(
      {
        status: "unqualified",
        reasons: expect.arrayContaining([
          "observation:effect-1:acceptance-unverified",
        ]),
      },
    );

    const readback = fixture();
    readback.signedEvidence.payload.providerEffectAssurances[0].readbackVerified = false;
    resignProvider(readback);
    expect(deriveProviderQualification(readback).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:readback-unverified",
      ]),
    });

    const idempotency = fixture();
    idempotency.signedEvidence.payload.providerEffectAssurances[0].idempotency =
      { mode: "unsupported", replayVerified: false };
    resignProvider(idempotency);
    expect(
      deriveProviderQualification(idempotency).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "observation:effect-1:idempotency-unverified",
      ]),
    });
  });

  it.each([
    [
      "failed scenario",
      (input: DeriveProviderQualificationInput) => {
        input.scenarioStatus = "failed";
      },
      "scenario-status:failed",
    ],
    [
      "skipped check",
      (input: DeriveProviderQualificationInput) => {
        input.finalChecks[0].status = "skipped";
      },
      "skipped",
    ],
  ] as const)("rejects %s", (_label, mutate, reasonFragment) => {
    const input = fixture();
    mutate(input);
    const decision = deriveProviderQualification(input);
    expect(decision.qualification.status).toBe("unqualified");
    expect(
      decision.qualification.reasons.some((reason) =>
        reason.includes(reasonFragment),
      ),
    ).toBe(true);
  });

  it("rejects fabricated or non-passing semantic verdicts", () => {
    const unsigned = fixture();
    unsigned.signedSemanticEvidence.payload.verdicts[0].score = 1;
    expect(deriveProviderQualification(unsigned).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "semantic-signature:invalid-or-unpinned",
      ]),
    });

    const unknown = fixture();
    unknown.signedSemanticEvidence.payload.verdicts[0].status = "unknown";
    resignSemantic(unknown);
    expect(deriveProviderQualification(unknown).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        expect.stringContaining("semantic-verdict:"),
      ]),
    });
  });

  it("rejects reuse of the provider observer key as the semantic judge key", () => {
    const input = fixture();
    const observerPublicKey = input.pinnedObserverPublicKeysPem[0];
    input.pinnedSemanticJudgePublicKeysPem = [observerPublicKey];
    input.signedSemanticEvidence.keyId =
      providerObserverKeyId(observerPublicKey);
    input.signedSemanticEvidence.signature = signPayload(
      null,
      semanticEvidenceSigningBytes(input.signedSemanticEvidence.payload),
      input.observerPrivateKey,
    ).toString("base64url");

    expect(deriveProviderQualification(input).qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "semantic-signature:key-not-independent",
        "semantic-identity:mismatch",
      ]),
    });
  });

  it("binds local status and exact final-check outcomes into observer evidence", () => {
    const changedStatus = fixture();
    changedStatus.scenarioStatus = "failed";
    const statusDecision = deriveProviderQualification(changedStatus);
    expect(statusDecision.qualification).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining([
        "runner-result:signed-digest-mismatch",
        "scenario-status:failed",
      ]),
    });

    const changedCheck = fixture();
    changedCheck.finalChecks[0].status = "skipped";
    expect(
      deriveProviderQualification(changedCheck).qualification,
    ).toMatchObject({
      status: "unqualified",
      reasons: expect.arrayContaining(["runner-result:signed-digest-mismatch"]),
    });
  });

  it("rejects oversized signed evidence before observation matching", () => {
    const input = fixture();
    input.signedEvidence.payload.observations = Array.from(
      { length: 257 },
      (_, index) => ({
        ...input.signedEvidence.payload.observations[0],
        observationId: `effect-${index}`,
      }),
    );
    expect(() => deriveProviderQualification(input)).toThrow(
      /observations cannot exceed 256 items/,
    );
  });

  it.each([
    [
      "non-array observations",
      (input: DeriveProviderQualificationInput) => {
        (
          input.signedEvidence.payload as unknown as Record<string, unknown>
        ).observations = null;
      },
      /observations must be an array/,
    ],
    [
      "non-object source",
      (input: DeriveProviderQualificationInput) => {
        (
          input.signedEvidence.payload.observations[0] as unknown as Record<
            string,
            unknown
          >
        ).source = null;
      },
      /source must be an object/,
    ],
    [
      "invalid observation timestamp",
      (input: DeriveProviderQualificationInput) => {
        input.signedEvidence.payload.observations[0].observedAtIso =
          "not-a-timestamp";
      },
      /observedAtIso must be an ISO-8601 timestamp/,
    ],
    [
      "invalid stage hash",
      (input: DeriveProviderQualificationInput) => {
        input.signedEvidence.payload.stageReferences[0].stageSha256 = "bad";
      },
      /stageSha256 must be a lowercase SHA-256 digest/,
    ],
    [
      "non-array semantic verdicts",
      (input: DeriveProviderQualificationInput) => {
        (
          input.signedSemanticEvidence.payload as unknown as Record<
            string,
            unknown
          >
        ).verdicts = null;
      },
      /verdicts must be an array/,
    ],
  ] as const)(
    "fails closed on malformed signed %s",
    (_label, mutate, pattern) => {
      const input = fixture();
      mutate(input);
      expect(() => deriveProviderQualification(input)).toThrow(pattern);
    },
  );
});
