/**
 * Exercises the provider-qualified public aggregation entry by driving its
 * exported canonical-JSON hashing, key-id derivation, signing-bytes, runner
 * digest, and trajectory-set validation contracts with real node:crypto keys;
 * no module or network dependency is mocked.
 */

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
  type LocalFinalCheckResult,
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  runnerResultSha256,
  type SemanticJudgeEvidencePayload,
  semanticEvidenceSigningBytes,
  type VerifiedScenarioTrajectorySet,
  validateVerifiedScenarioTrajectorySet,
} from "./index.ts";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const ISO = {
  scenarioEndedAtIso: "2026-08-24T12:00:00.000Z",
  trajectoryVerifiedAtIso: "2026-08-24T12:00:05.000Z",
  signedAtIso: "2026-08-24T12:00:10.000Z",
};

function semanticPayload(): SemanticJudgeEvidencePayload {
  return {
    schema: "eliza.provider-qualified-semantic-evidence.v1",
    manifestSha256: sha256Hex("manifest"),
    runId: "run-provider-001",
    runNonce: "a".repeat(64),
    scenarioId: "calendar.provider.create",
    scenarioEndedAtIso: ISO.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: ISO.trajectoryVerifiedAtIso,
    signedAtIso: ISO.signedAtIso,
    trajectorySetSha256: sha256Hex("trajectory-set"),
    actingAdapter: "eliza-runtime",
    actingProvider: "openai",
    actingModel: "gpt-5",
    judgeProvider: "independent-evaluator",
    judgeModel: "judge-model-v1",
    verdicts: [
      {
        criterionId: "turn:0:authenticated parent request",
        rubricSha256: sha256Hex("rubric"),
        status: "passed",
        score: 0.9,
        requestSha256: sha256Hex("request"),
        responseSha256: sha256Hex("response"),
      },
    ],
  };
}

function observerPayload(): ProviderObserverEvidencePayload {
  return {
    schema: "eliza.provider-qualified-observer-evidence.v1",
    manifestSha256: sha256Hex("manifest"),
    runId: "run-provider-001",
    runNonce: "a".repeat(64),
    scenarioId: "calendar.provider.create",
    scenarioStartedAtIso: "2026-08-24T11:59:00.000Z",
    scenarioEndedAtIso: ISO.scenarioEndedAtIso,
    trajectoryVerifiedAtIso: ISO.trajectoryVerifiedAtIso,
    signedAtIso: ISO.signedAtIso,
    trajectorySetSha256: sha256Hex("trajectory-set"),
    runnerResultSha256: sha256Hex("runner-result"),
    observerProvenance: [
      {
        observerId: "calendar-observer",
        kind: "provider-api",
        implementation: "google-calendar-observer",
        version: "1",
        environment: "provider-sandbox",
        configurationSha256: sha256Hex("configuration"),
      },
    ],
    observations: [],
    connectorBindings: [],
    stageReferences: [],
    providerEffectAssurances: [],
  };
}

function ed25519PemPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}

function verifiedTrajectorySet(): VerifiedScenarioTrajectorySet {
  const stage = {
    stageId: "turn-0",
    kind: "message",
    sha256: sha256Hex("stage-bytes"),
    startedAtIso: "2026-08-24T11:59:30.000Z",
    endedAtIso: "2026-08-24T11:59:40.000Z",
  };
  const trajectories: VerifiedScenarioTrajectorySet["trajectories"] = [
    {
      artifact: {
        trajectoryId: "trajectory-a",
        relativePath: "trajectories/trajectory-a.json",
        sha256: sha256Hex("artifact-a-bytes"),
        recorder: {
          implementation: "@elizaos/core/trajectory-recorder",
          version: "1",
          environment: "ci",
        },
      },
      stages: [stage],
    },
  ];
  return {
    runId: "run-provider-001",
    scenarioId: "calendar.provider.create",
    scenarioStartedAtIso: "2026-08-24T11:59:00.000Z",
    scenarioEndedAtIso: ISO.scenarioEndedAtIso,
    runDirectoryRealPath: path.join(tmpdir(), "provider-qualified-index-run"),
    verifiedAtIso: ISO.trajectoryVerifiedAtIso,
    setSha256: canonicalSha256(
      trajectories.map((trajectory) => ({
        artifact: trajectory.artifact,
        stages: trajectory.stages,
      })),
      "verifiedTrajectories",
    ),
    trajectories,
  };
}

describe("canonical JSON helpers exported from the public entry", () => {
  it("encodes object keys in sorted order regardless of construction order", () => {
    expect(canonicalJson({ z: null, b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1,"z":null}',
    );
    expect(canonicalSha256({ b: 1, a: 2 })).toBe(
      canonicalSha256({ a: 2, b: 1 }),
    );
  });

  it("rejects cyclic references and non-finite numbers instead of encoding them", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    expect(() => canonicalJsonValue(cyclic)).toThrow(/cyclic/);
    expect(() => canonicalJsonValue(Number.NaN)).toThrow(/non-finite/);
  });
});

describe("runnerResultSha256", () => {
  const checks: LocalFinalCheckResult[] = [
    { definitionSha256: sha256Hex("check-b"), status: "passed" },
    { definitionSha256: sha256Hex("check-a"), status: "failed" },
    { definitionSha256: sha256Hex("check-a"), status: "passed" },
  ];

  it("produces a stable digest for empty and single-element final-check lists", () => {
    const empty = runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks: [],
    });
    expect(empty).toMatch(/^[a-f0-9]{64}$/);
    expect(
      runnerResultSha256({ scenarioStatus: "passed", finalChecks: [] }),
    ).toBe(empty);
    const single = runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks: [checks[0]],
    });
    expect(single).toMatch(/^[a-f0-9]{64}$/);
    expect(single).not.toBe(empty);
  });

  it("is independent of input order even when definition digests tie", () => {
    const baseline = runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks: checks,
    });
    const reordered = [...checks].reverse();
    expect(
      runnerResultSha256({ scenarioStatus: "passed", finalChecks: reordered }),
    ).toBe(baseline);
  });

  it("changes when the local scenario status changes", () => {
    const passed = runnerResultSha256({
      scenarioStatus: "passed",
      finalChecks: checks,
    });
    expect(
      runnerResultSha256({ scenarioStatus: "failed", finalChecks: checks }),
    ).not.toBe(passed);
  });
});

describe("providerObserverKeyId", () => {
  it("derives a deterministic SPKI digest that differs per Ed25519 key", () => {
    const first = ed25519PemPair();
    const second = ed25519PemPair();
    const keyId = providerObserverKeyId(first.publicKeyPem);
    expect(keyId).toMatch(/^[a-f0-9]{64}$/);
    expect(providerObserverKeyId(first.publicKeyPem)).toBe(keyId);
    expect(providerObserverKeyId(second.publicKeyPem)).not.toBe(keyId);
  });

  it("rejects inputs without an SPKI public key block", () => {
    expect(() => providerObserverKeyId("deadbeef")).toThrow(
      /must contain an SPKI public key/,
    );
  });

  it("rejects non-Ed25519 public keys", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => providerObserverKeyId(rsaPem)).toThrow(/Ed25519/);
  });
});

describe("evidence signing bytes exported from the public entry", () => {
  it("signs semantic evidence over canonical bytes and detects tampering", () => {
    const payload = semanticPayload();
    const bytes = semanticEvidenceSigningBytes(payload);
    const reordered = {
      verdicts: [
        {
          responseSha256: payload.verdicts[0].responseSha256,
          requestSha256: payload.verdicts[0].requestSha256,
          score: payload.verdicts[0].score,
          status: payload.verdicts[0].status,
          rubricSha256: payload.verdicts[0].rubricSha256,
          criterionId: payload.verdicts[0].criterionId,
        },
      ],
      judgeModel: payload.judgeModel,
      judgeProvider: payload.judgeProvider,
      actingModel: payload.actingModel,
      actingProvider: payload.actingProvider,
      actingAdapter: payload.actingAdapter,
      trajectorySetSha256: payload.trajectorySetSha256,
      signedAtIso: payload.signedAtIso,
      trajectoryVerifiedAtIso: payload.trajectoryVerifiedAtIso,
      scenarioEndedAtIso: payload.scenarioEndedAtIso,
      scenarioId: payload.scenarioId,
      runNonce: payload.runNonce,
      runId: payload.runId,
      manifestSha256: payload.manifestSha256,
      schema: payload.schema,
    };
    expect(semanticEvidenceSigningBytes(reordered)).toEqual(bytes);

    const { publicKeyPem, privateKeyPem } = ed25519PemPair();
    const signature = sign(null, bytes, privateKeyPem);
    expect(verify(null, bytes, publicKeyPem, signature)).toBe(true);

    const tampered = structuredClone(payload);
    tampered.verdicts[0].score = 0.4;
    expect(
      verify(
        null,
        semanticEvidenceSigningBytes(tampered),
        publicKeyPem,
        signature,
      ),
    ).toBe(false);
  });

  it("binds observer evidence to exact bytes so substituted payloads fail verification", () => {
    const payload = observerPayload();
    const bytes = providerEvidenceSigningBytes(payload);
    const { publicKeyPem, privateKeyPem } = ed25519PemPair();
    const signature = sign(null, bytes, privateKeyPem);

    const substituted = structuredClone(payload);
    substituted.runnerResultSha256 = sha256Hex("attacker-result");
    expect(
      verify(
        null,
        providerEvidenceSigningBytes(substituted),
        publicKeyPem,
        signature,
      ),
    ).toBe(false);
    expect(verify(null, bytes, publicKeyPem, signature)).toBe(true);
  });
});

describe("validateVerifiedScenarioTrajectorySet", () => {
  it("accepts a set whose claimed digest matches the recomputed trajectory contents", () => {
    const set = verifiedTrajectorySet();
    const validated = validateVerifiedScenarioTrajectorySet(set);
    expect(validated).toEqual(set);
    expect(validated.setSha256).toBe(set.setSha256);
    expect(validated.trajectories[0].stages[0]).toEqual({
      stageId: "turn-0",
      kind: "message",
      sha256: sha256Hex("stage-bytes"),
      startedAtIso: "2026-08-24T11:59:30.000Z",
      endedAtIso: "2026-08-24T11:59:40.000Z",
    });
  });

  it("rejects stage substitutions that invalidate the claimed set digest", () => {
    const set = verifiedTrajectorySet();
    set.trajectories[0].stages[0].sha256 = sha256Hex("substituted-stage");
    expect(() => validateVerifiedScenarioTrajectorySet(set)).toThrow(
      /setSha256 does not match/,
    );
  });

  it("requires verifier trajectoryId order across the set", () => {
    const set = verifiedTrajectorySet();
    const second = structuredClone(set.trajectories[0]);
    second.artifact.trajectoryId = "trajectory-b";
    second.artifact.relativePath = "trajectories/trajectory-b.json";
    second.artifact.sha256 = sha256Hex("artifact-b-bytes");
    set.trajectories = [second, ...set.trajectories];
    set.setSha256 = canonicalSha256(
      set.trajectories.map((trajectory) => ({
        artifact: trajectory.artifact,
        stages: trajectory.stages,
      })),
      "verifiedTrajectories",
    );
    expect(() => validateVerifiedScenarioTrajectorySet(set)).toThrow(
      /verifier trajectoryId order/,
    );
  });

  it("rejects traversal paths outside trajectories/", () => {
    const set = verifiedTrajectorySet();
    set.trajectories[0].artifact.relativePath =
      "trajectories/../escaped-artifact.json";
    expect(() => validateVerifiedScenarioTrajectorySet(set)).toThrow(
      /traversal/,
    );
  });

  it("requires an empty-free set and canonical UTC timestamps", () => {
    const empty = verifiedTrajectorySet();
    (empty as unknown as { trajectories: unknown[] }).trajectories = [];
    expect(() => validateVerifiedScenarioTrajectorySet(empty)).toThrow(
      /must be non-empty/,
    );

    const skewed = verifiedTrajectorySet();
    skewed.scenarioEndedAtIso = "2026-08-24T12:00:00Z";
    expect(() => validateVerifiedScenarioTrajectorySet(skewed)).toThrow(
      /canonical UTC ISO-8601 form/,
    );
  });
});
