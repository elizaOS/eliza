/**
 * Exercises the dormant staging Gateway reconciler with injected Railway,
 * GitHub, artifact, journal, and clock harnesses so every mutation boundary can
 * be proven fail-closed without contacting a live provider.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  deploymentReceiptSemanticDigest,
  GitHubReceiptArtifactClient,
  RailwayCliClient,
  reconcileGatewayWebhook,
  main as reconcileMain,
  restorationIdDigest,
  validatePlanBundle,
  validateReceiptArtifactAttestation,
  verifySourcePreMutationSnapshot,
  writeReconcileFailureAnnotation,
  writeReconcileWarningAnnotation,
} from "../gateway-webhook-reconcile.mjs";
import {
  providerDeploymentIdDigest,
  RedactedActionError,
} from "../gateway-webhook-transaction-journal.mjs";

const priorId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-000000000002";
const restorationOne = "00000000-0000-4000-8000-000000000003";
const restorationTwo = "00000000-0000-4000-8000-000000000004";
const sourceSha = "a".repeat(40);
const planDigest = "b".repeat(64);
const openRecordId = "c".repeat(64);
const snapshotId = "snapshot_prior_123";
const scope = {
  projectId: "project",
  environmentId: "environment",
  serviceId: "service",
  serviceName: "gateway-webhook-stg",
};
const expectedMessage = `gateway-webhook ${sourceSha} (staging) run:101:1 nonce:${"d".repeat(32)}`;

type SourceRunFixture = {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  updated_at: string;
};

type ReceiptArtifactFixture = {
  artifact: {
    id: number;
    name: string;
    digest: string;
    expired: boolean;
    expires_at: string;
    workflow_run: { id: number; head_sha: string };
  };
  sourceRun: SourceRunFixture;
  archiveBytes: Buffer;
};

function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureCrc32(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function singleFileZip(name: string, bytes: Buffer) {
  const nameBytes = Buffer.from(name, "utf8");
  const checksum = fixtureCrc32(bytes);
  const compressed = deflateRawSync(bytes);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, eocd]);
}

function deployment(
  id: string,
  status = "SUCCESS",
  snapshot = snapshotId,
  message: string | null = null,
) {
  return {
    id,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    serviceId: scope.serviceId,
    snapshotId: snapshot,
    status,
    deploymentStopped: false,
    meta: message === null ? {} : { commitMessage: message },
  };
}

function historyRow(value: ReturnType<typeof deployment>, createdAt: string) {
  return {
    id: value.id,
    createdAt,
    status: value.status,
    meta: value.meta,
  };
}

const config = {
  repository: "elizaOS/eliza",
  environment: "staging",
  sourceSha,
  sourceRunId: "101",
  sourceRunAttempt: "1",
  recoveryRunId: "202",
  recoveryRunAttempt: "1",
  recoverySha: "e".repeat(40),
  openRecordId,
  planArtifactId: "303",
  planArtifactDigest: planDigest,
  receiptArtifactId: null as string | null,
  receiptArtifactDigest: null as string | null,
  sourceDeployCompletedEpoch: 1_700_000_000,
  scope,
  receipt: null as null | Record<string, unknown>,
};

function sourceRunFixture(): SourceRunFixture {
  return {
    id: Number(config.sourceRunId),
    run_attempt: Number(config.sourceRunAttempt),
    head_sha: sourceSha,
    head_branch: "develop",
    head_repository: { full_name: config.repository },
    path: ".github/workflows/deploy-gateway-webhook.yml",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    // GitHub's exact-attempt endpoint returns this field as null even when the
    // run is completed; updated_at is the live terminal attempt timestamp.
    completed_at: null,
    updated_at: new Date(
      config.sourceDeployCompletedEpoch * 1_000,
    ).toISOString(),
  };
}

function bundle(extraBaseline: ReturnType<typeof historyRow>[] = []) {
  const baseline = [
    ...extraBaseline,
    historyRow(deployment(priorId), "2026-09-03T00:00:00Z"),
  ];
  const priorActive = {
    data: {
      serviceInstance: {
        environmentId: scope.environmentId,
        serviceId: scope.serviceId,
        serviceName: scope.serviceName,
        activeDeployments: [deployment(priorId)],
      },
    },
  };
  const baselineBytes = Buffer.from(JSON.stringify(baseline), "utf8");
  const priorActiveBytes = Buffer.from(JSON.stringify(priorActive), "utf8");
  const plan = {
    version: 1,
    repository: config.repository,
    environment: "staging",
    sourceSha,
    workflowRunId: config.sourceRunId,
    workflowRunAttempt: config.sourceRunAttempt,
    railwayProjectId: scope.projectId,
    railwayEnvironmentId: scope.environmentId,
    railwayServiceId: scope.serviceId,
    railwayServiceName: scope.serviceName,
    priorActiveDeploymentId: priorId,
    priorSnapshotId: snapshotId,
    deploymentNonce: "d".repeat(32),
    expectedDeploymentMessage: expectedMessage,
    deploymentBaselineSha256: digest(baselineBytes),
    priorActiveDeploymentsSha256: digest(priorActiveBytes),
  };
  const planBytes = Buffer.from(JSON.stringify(plan), "utf8");
  const files = [
    ["deployment-baseline.json", baselineBytes],
    ["prior-active-deployments.json", priorActiveBytes],
    ["rollback-plan.json", planBytes],
  ] as const;
  const journalPlaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      files: files.map(([name, bytes]) => ({
        name,
        sha256: digest(bytes),
        content: bytes.toString("base64"),
      })),
    }),
    "utf8",
  );
  return {
    plan,
    baseline,
    priorActive,
    digests: {
      baseline: digest(baselineBytes),
      priorActive: digest(priorActiveBytes),
      journalPlanPlaintext: digest(journalPlaintext),
    },
  };
}

function createHarness(
  options: {
    candidateStatus?: string;
    active?: string;
    receipt?: boolean;
    rollback?: (ordinal: number) => Promise<boolean>;
    authority?: (call: number) => Promise<void>;
    observe?: (status: string, id: string | null) => Promise<void>;
    onSleep?: (monotonicNow: number) => Promise<void> | void;
    artifactAttestation?: (
      attestation: ReceiptArtifactFixture,
    ) => Promise<ReceiptArtifactFixture>;
    omitDeploymentStopped?: boolean;
    scopeAttestation?: () => Promise<void>;
    sourceRunRead?: (
      call: number,
      sourceRun: SourceRunFixture,
    ) => Promise<SourceRunFixture> | SourceRunFixture;
  } = {},
) {
  let now = Date.parse("2026-09-03T00:30:00Z");
  let monotonicNow = 0;
  let authoritativeReceipt: Record<string, unknown> | null = null;
  let authoritativeArtifact: ReceiptArtifactFixture | null = null;
  if (options.receipt) {
    config.receiptArtifactId = "404";
    authoritativeReceipt = {
      sourceSha,
      environment: "staging",
      deploymentId: candidateId,
      service: scope.serviceName,
      workflowRunId: config.sourceRunId,
      workflowRunAttempt: config.sourceRunAttempt,
      expectedDeploymentMessage: expectedMessage,
      rollbackPlanArtifactId: config.planArtifactId,
      rollbackPlanArtifactDigest: config.planArtifactDigest,
      openCommentId: config.openRecordId,
      telegramIdentity: "credential-attested",
      telegramProviderWebhookSecret: "requires-ingress-proof",
      telegramProviderSmoke: "unproven",
      reminderAuthorityReadiness: "attested",
      redisBackend: "distributed",
      credentialProof: "9".repeat(64),
    };
    const receiptBytes = Buffer.from(
      JSON.stringify(authoritativeReceipt),
      "utf8",
    );
    const archiveBytes = singleFileZip(
      "gateway-webhook-deployment.json",
      receiptBytes,
    );
    config.receiptArtifactDigest = digest(archiveBytes);
    authoritativeArtifact = {
      artifact: {
        id: Number(config.receiptArtifactId),
        name: `gateway-webhook-deployment-staging-${sourceSha}-${config.sourceRunId}-${config.sourceRunAttempt}`,
        digest: `sha256:${config.receiptArtifactDigest}`,
        expired: false,
        expires_at: "2026-10-03T00:00:00Z",
        workflow_run: { id: Number(config.sourceRunId), head_sha: sourceSha },
      },
      sourceRun: sourceRunFixture(),
      archiveBytes,
    };
    config.receipt = structuredClone(authoritativeReceipt);
  } else {
    config.receiptArtifactId = null;
    config.receiptArtifactDigest = null;
    config.receipt = null;
  }
  const exact = new Map<string, ReturnType<typeof deployment>>();
  exact.set(priorId, deployment(priorId));
  if (options.candidateStatus) {
    exact.set(
      candidateId,
      deployment(
        candidateId,
        options.candidateStatus,
        "snapshot_candidate",
        expectedMessage,
      ),
    );
  }
  const history = [historyRow(exact.get(priorId)!, "2026-09-03T00:00:00Z")];
  if (exact.has(candidateId)) {
    history.unshift(
      historyRow(exact.get(candidateId)!, "2026-09-03T00:10:00Z"),
    );
  }
  let activeId = options.active ?? priorId;
  let activeOverride: ReturnType<typeof deployment> | null = null;
  const state: any = {
    status: "open",
    open: {
      repository: config.repository,
      environment: "staging",
      sourceSha,
      sourceRunId: config.sourceRunId,
      sourceRunAttempt: config.sourceRunAttempt,
      commentId: openRecordId,
      planArtifactName: `gateway-webhook-rollback-plan-staging-${config.sourceRunId}-${config.sourceRunAttempt}`,
      planArtifactId: config.planArtifactId,
      planArtifactDigest: config.planArtifactDigest,
      journalPlanPlaintextSha256: bundle().digests.journalPlanPlaintext,
    },
    rollbackIntents: [],
    rollbackObservations: [],
    rollbackIntentCreatedAts: [],
    rollbackIntent: null,
    rollbackObservation: null,
  };
  let rollbackCalls = 0;
  let authorityCalls = 0;
  let railwayReadCalls = 0;
  let artifactAttestationCalls = 0;
  let scopeAttestationCalls = 0;
  let sourceRunReadCalls = 0;
  let intentFailure: Error | null = null;
  let authorityFailure: Error | null = null;
  let intentAlreadyPublished = false;
  const logicalId = (ordinal: number, kind: string) =>
    (kind === "intent" ? String(ordinal) : String(ordinal + 4)).repeat(64);
  const providerDeployment = (value: ReturnType<typeof deployment>) => {
    if (!options.omitDeploymentStopped) return { ...value };
    const { deploymentStopped: _deploymentStopped, ...incomplete } = value;
    return incomplete;
  };
  const dependencies = {
    sourceRun: {
      read: async () => {
        sourceRunReadCalls += 1;
        const sourceRun = sourceRunFixture();
        return options.sourceRunRead
          ? options.sourceRunRead(sourceRunReadCalls, sourceRun)
          : sourceRun;
      },
    },
    railway: {
      listDeployments: async () => {
        railwayReadCalls += 1;
        return history.map((row) => ({ ...row }));
      },
      getDeployment: async (id: string) => {
        railwayReadCalls += 1;
        return providerDeployment(exact.get(id)!);
      },
      getActiveDeployments: async () => {
        railwayReadCalls += 1;
        return [providerDeployment(activeOverride ?? exact.get(activeId)!)];
      },
      assertExactStagingScope: async () => {
        scopeAttestationCalls += 1;
        if (options.scopeAttestation) await options.scopeAttestation();
      },
      rollback: async () => {
        rollbackCalls += 1;
        if (options.rollback) return options.rollback(rollbackCalls);
        return true;
      },
    },
    artifacts: {
      attestReceipt: async () => {
        artifactAttestationCalls += 1;
        if (!authoritativeArtifact) {
          throw new Error("unexpected receipt artifact attestation");
        }
        const value = {
          ...structuredClone(authoritativeArtifact),
          archiveBytes: Buffer.from(authoritativeArtifact.archiveBytes),
        };
        if (options.artifactAttestation) {
          return options.artifactAttestation(value);
        }
        return value;
      },
    },
    authority: {
      assertCurrentDevelop: async () => {
        authorityCalls += 1;
        if (options.authority) await options.authority(authorityCalls);
        if (authorityFailure) throw authorityFailure;
      },
    },
    journal: {
      read: async () => structuredClone(state),
      restoreCandidate: async () => candidateId,
      ensureIntent: async (
        _candidate: string,
        _message: string,
        providerDeploymentIdWatermarkSha256 = [
          providerDeploymentIdDigest(candidateId),
        ],
        providerActiveTopologySha256 = "7".repeat(64),
      ) => {
        if (intentFailure) throw intentFailure;
        const ordinal = state.rollbackIntents.length + 1;
        const intent = {
          ordinal,
          commentId: logicalId(ordinal, "intent"),
          candidateDeploymentIdSha256: "1".repeat(64),
          expectedDeploymentMessageSha256: "2".repeat(64),
          providerActiveTopologySha256,
          providerDeploymentIdWatermarkSha256,
        };
        state.rollbackIntents.push(intent);
        state.rollbackIntent = intent;
        state.rollbackIntentCreatedAts.push(new Date(now).toISOString());
        return { ...intent, newlyPublished: !intentAlreadyPublished };
      },
      observe: async (
        status: string,
        id: string | null,
        refineOrdinal: number | null = null,
      ) => {
        if (options.observe) await options.observe(status, id);
        const ordinal = refineOrdinal ?? state.rollbackIntents.length;
        const observation = {
          ordinal,
          commentId: logicalId(ordinal, "observation"),
          restorationIdSha256: id === null ? null : restorationIdDigest(id),
          status,
        };
        if (refineOrdinal === null)
          state.rollbackObservations.push(observation);
        else state.rollbackObservations[refineOrdinal - 1] = observation;
        state.rollbackObservation = state.rollbackObservations.at(-1) ?? null;
        return observation;
      },
    },
    monotonicNow: () => monotonicNow,
    wallNow: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
      monotonicNow += milliseconds;
      if (options.onSleep) await options.onSleep(monotonicNow);
    },
    warn: () => {},
  };
  const addRestoration = (id: string, status: string, createdAt: string) => {
    const value = deployment(id, status);
    exact.set(id, value);
    history.unshift(historyRow(value, createdAt));
    if (["SUCCESS", "SLEEPING"].includes(status)) activeId = id;
  };
  const addCandidate = (status: string, createdAt: string) => {
    const value = deployment(
      candidateId,
      status,
      "snapshot_candidate",
      expectedMessage,
    );
    exact.set(candidateId, value);
    history.unshift(historyRow(value, createdAt));
  };
  const setDeploymentStatus = (id: string, status: string) => {
    const value = exact.get(id);
    const row = history.find((candidate) => candidate.id === id);
    if (!value || !row) throw new Error(`unknown test deployment ${id}`);
    exact.set(id, { ...value, status });
    row.status = status;
  };
  return {
    state,
    dependencies,
    addCandidate,
    addRestoration,
    setDeploymentStatus,
    addHistory: (value: ReturnType<typeof deployment>, createdAt: string) => {
      exact.set(value.id, value);
      history.push(historyRow(value, createdAt));
    },
    setActive: (id: string) => {
      activeId = id;
      activeOverride = null;
    },
    setActiveOverride: (value: ReturnType<typeof deployment>) => {
      activeOverride = value;
    },
    setIntentFailure: (error: Error) => {
      intentFailure = error;
    },
    setAuthorityFailure: (error: Error) => {
      authorityFailure = error;
    },
    setIntentAlreadyPublished: (value: boolean) => {
      intentAlreadyPublished = value;
    },
    rollbackCalls: () => rollbackCalls,
    authorityCalls: () => authorityCalls,
    railwayReadCalls: () => railwayReadCalls,
    artifactAttestationCalls: () => artifactAttestationCalls,
    scopeAttestationCalls: () => scopeAttestationCalls,
    sourceRunReadCalls: () => sourceRunReadCalls,
    now: () => now,
    monotonicNow: () => monotonicNow,
    advanceNow: (milliseconds: number) => {
      now += milliseconds;
      monotonicNow += milliseconds;
    },
    skewWallClock: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("Gateway webhook Railway reconciler", () => {
  test("rejects a nonterminal deployment in the immutable baseline", async () => {
    const pendingId = "00000000-0000-4000-8000-000000000005";
    const pending = historyRow(
      deployment(pendingId, "BUILDING"),
      "2026-09-03T00:00:01Z",
    );
    const planBundle = await bundle([pending]);

    expect(() => validatePlanBundle(config, planBundle)).toThrow(
      "immutable Railway baseline contains a nonterminal deployment",
    );
  });

  test("refuses pre-upload history id or status drift before provider mutation", async () => {
    const oldId = "00000000-0000-4000-8000-000000000005";
    const planBundle = await bundle([
      historyRow(deployment(oldId, "FAILED"), "2026-09-02T00:00:00Z"),
    ]);
    const baselineRows = planBundle.baseline.map((row) => ({ ...row }));
    const lateId = "00000000-0000-4000-8000-000000000006";
    let rollbackCalls = 0;
    let scans = 0;
    const stable = await verifySourcePreMutationSnapshot(config, planBundle, {
      railway: {
        listDeployments: async () => {
          scans += 1;
          return scans === 1 ? baselineRows : [...baselineRows].reverse();
        },
        getActiveDeployments: async () => [deployment(priorId)],
        rollback: async () => {
          rollbackCalls += 1;
          return true;
        },
      },
      sleep: async () => {},
    });
    expect(stable.deploymentCount).toBe(baselineRows.length);
    expect(rollbackCalls).toBe(0);

    scans = 0;
    await expect(
      verifySourcePreMutationSnapshot(config, planBundle, {
        railway: {
          listDeployments: async () => {
            scans += 1;
            return scans === 1
              ? baselineRows
              : [
                  ...baselineRows,
                  historyRow(
                    deployment(lateId, "QUEUED"),
                    "2026-09-03T00:00:01Z",
                  ),
                ];
          },
          getActiveDeployments: async () => [deployment(priorId)],
          rollback: async () => {
            rollbackCalls += 1;
            return true;
          },
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      "Railway deployment history changed after the immutable baseline",
    );
    expect(rollbackCalls).toBe(0);

    scans = 0;
    await expect(
      verifySourcePreMutationSnapshot(config, planBundle, {
        railway: {
          listDeployments: async () => {
            scans += 1;
            return scans === 1
              ? baselineRows
              : baselineRows.map((row) =>
                  row.id === priorId ? { ...row, status: "DEPLOYING" } : row,
                );
          },
          getActiveDeployments: async () => [deployment(priorId)],
          rollback: async () => {
            rollbackCalls += 1;
            return true;
          },
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      "pre-upload Railway deployment history contains a nonterminal row",
    );
    expect(rollbackCalls).toBe(0);
  });

  test("dispatches the workflow source-baseline verification command", async () => {
    const planBundle = await bundle();
    let output = "";
    const result = await reconcileMain(
      {
        EXPECTED_SERVICE_NAME: scope.serviceName,
        GITHUB_REPOSITORY: config.repository,
        GITHUB_RUN_ATTEMPT: config.sourceRunAttempt,
        GITHUB_RUN_ID: config.sourceRunId,
        GITHUB_SHA: config.sourceSha,
        RAILWAY_ENVIRONMENT_ID: scope.environmentId,
        RAILWAY_PROJECT_ID: scope.projectId,
        RAILWAY_SERVICE_ID: scope.serviceId,
        RUNNER_TEMP: "/unused-in-injected-command-test",
        TARGET_ENVIRONMENT: "staging",
      },
      ["verify-source-baseline"],
      {
        bundle: planBundle,
        railway: {
          listDeployments: async () =>
            planBundle.baseline.map((row) => ({ ...row })),
          getActiveDeployments: async () => [deployment(priorId)],
        },
        sleep: async () => {},
        stdout: {
          write: (value: string) => {
            output += value;
          },
        },
      },
    );
    expect(result).toEqual({
      deploymentCount: 1,
      priorActiveDeploymentIdSha256: providerDeploymentIdDigest(priorId),
    });
    expect(JSON.parse(output)).toEqual(result);
    expect(output).not.toContain(priorId);
  });

  test("requires provider metadata in the immutable prior-active proof", async () => {
    const planBundle = await bundle();
    delete planBundle.priorActive.data.serviceInstance.activeDeployments[0]
      .meta;

    expect(() => validatePlanBundle(config, planBundle)).toThrow(
      "Railway deployment readback is malformed or outside the exact scope",
    );
  });

  test("rejects array metadata at both immutable provider boundaries", async () => {
    const priorMetaArray = await bundle();
    priorMetaArray.priorActive.data.serviceInstance.activeDeployments[0].meta =
      [];
    expect(() => validatePlanBundle(config, priorMetaArray)).toThrow(
      "Railway deployment readback is malformed or outside the exact scope",
    );

    const malformedHistory = historyRow(
      deployment(restorationOne, "FAILED"),
      "2026-09-02T00:00:00Z",
    );
    malformedHistory.meta = [];
    expect(() =>
      validatePlanBundle(config, bundle([malformedHistory])),
    ).toThrow("Railway deployment-history row is malformed");
  });

  test("rejects malformed errors in the immutable prior-active proof", async () => {
    const planBundle = await bundle();
    const malformedBundle = {
      ...planBundle,
      priorActive: {
        ...planBundle.priorActive,
        errors: { message: "provider rejected readback" },
      },
    };

    expect(() => validatePlanBundle(config, malformedBundle)).toThrow(
      "immutable prior-active proof is malformed",
    );
  });

  test("rejects duplicate keys in the raw immutable prior-active artifact", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gateway-reconcile-plan-"));
    try {
      const directory = join(temp, "gateway-webhook-rollback-plan");
      await mkdir(directory);
      const planBundle = await bundle();
      await Promise.all([
        writeFile(
          join(directory, "deployment-baseline.json"),
          JSON.stringify(planBundle.baseline),
        ),
        writeFile(
          join(directory, "rollback-plan.json"),
          JSON.stringify(planBundle.plan),
        ),
        writeFile(
          join(directory, "prior-active-deployments.json"),
          `{"errors":[{"message":"provider denied readback"}],"\\u0065rrors":[],"data":${JSON.stringify(planBundle.priorActive.data)}}`,
        ),
      ]);

      await expect(
        reconcileMain({ RUNNER_TEMP: temp }, ["verify-source-baseline"], {}),
      ).rejects.toThrow("immutable prior-active proof is not strict JSON");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test("classifies Railway sleeping and removing states without poisoning history", async () => {
    const sleepingId = "00000000-0000-4000-8000-000000000005";
    const oldSleeping = deployment(sleepingId, "SLEEPING");
    const oldSleepingRow = historyRow(oldSleeping, "2026-09-02T00:00:00Z");
    const historical = createHarness();
    historical.addHistory(oldSleeping, oldSleepingRow.createdAt);
    const historicalBundle = await bundle([oldSleepingRow]);
    historical.state.open.journalPlanPlaintextSha256 =
      historicalBundle.digests.journalPlanPlaintext;
    const result = await reconcileGatewayWebhook(
      { ...config },
      historicalBundle,
      historical.dependencies,
    );
    expect(result.result).toBe("baseline-preserved-no-candidate");
    expect(historical.rollbackCalls()).toBe(0);

    const sleepingCandidate = createHarness({
      candidateStatus: "SLEEPING",
      active: candidateId,
      receipt: true,
    });
    const preserved = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      sleepingCandidate.dependencies,
    );
    expect(preserved.result).toBe("candidate-proven");
    expect(sleepingCandidate.rollbackCalls()).toBe(0);

    const removingCandidate = createHarness({
      candidateStatus: "REMOVING",
      active: priorId,
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        removingCandidate.dependencies,
      ),
    ).rejects.toThrow("nonterminal");
    expect(removingCandidate.rollbackCalls()).toBe(0);

    let sleepingRestoration: ReturnType<typeof createHarness>;
    sleepingRestoration = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        sleepingRestoration.addRestoration(
          restorationOne,
          "SLEEPING",
          "2026-09-03T00:20:00Z",
        );
        return true;
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        sleepingRestoration.dependencies,
      ),
    ).rejects.toThrow("one rollback effect was durably observed");
    expect(sleepingRestoration.state.rollbackObservations[0]?.status).toBe(
      "SLEEPING",
    );
    expect(sleepingRestoration.rollbackCalls()).toBe(1);
    sleepingRestoration.setDeploymentStatus(restorationOne, "SUCCESS");
    const restored = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      sleepingRestoration.dependencies,
    );
    expect(restored.result).toBe("prior-snapshot-restored");
    expect(sleepingRestoration.rollbackCalls()).toBe(1);

    let wakingRestoration: ReturnType<typeof createHarness>;
    wakingRestoration = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        wakingRestoration.addRestoration(
          restorationOne,
          "SUCCESS",
          "2026-09-03T00:20:00Z",
        );
        return true;
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        wakingRestoration.dependencies,
      ),
    ).rejects.toThrow("one rollback effect was durably observed");
    wakingRestoration.setDeploymentStatus(restorationOne, "SLEEPING");
    const sleepingAgain = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      wakingRestoration.dependencies,
    );
    expect(sleepingAgain.result).toBe("prior-snapshot-restored");
    expect(wakingRestoration.rollbackCalls()).toBe(1);
  });

  test("adopts only an exact receipt-bound sole candidate", async () => {
    const harness = createHarness({
      candidateStatus: "SUCCESS",
      active: candidateId,
      receipt: true,
    });
    const authoritativeReceipt = structuredClone(config.receipt);
    const result = await reconcileGatewayWebhook(
      {
        ...config,
        receipt: { ...config.receipt, credentialProof: "0".repeat(64) },
      },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("candidate-proven");
    expect(result.rollbackAttempts).toEqual([]);
    expect(result.receiptSemanticDigest).toBe(
      deploymentReceiptSemanticDigest(authoritativeReceipt),
    );
    expect(harness.artifactAttestationCalls()).toBe(1);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("binds the acted-on plan artifact and exact semantic manifest to the authenticated OPEN before Railway reads", async () => {
    const mutations = [
      (open: Record<string, unknown>) => {
        open.planArtifactId = "304";
      },
      (open: Record<string, unknown>) => {
        open.planArtifactDigest = "e".repeat(64);
      },
      (open: Record<string, unknown>) => {
        open.journalPlanPlaintextSha256 = "f".repeat(64);
      },
    ];
    for (const mutate of mutations) {
      const harness = createHarness();
      mutate(harness.state.open);
      await expect(
        reconcileGatewayWebhook(
          { ...config },
          await bundle(),
          harness.dependencies,
        ),
      ).rejects.toThrow(
        "durable journal no longer binds the exact staging transaction",
      );
      expect(harness.railwayReadCalls()).toBe(0);
      expect(harness.rollbackCalls()).toBe(0);
    }
  });

  test("requires every exact terminal source-attempt field before Railway reads", async () => {
    const corruptions: Array<(sourceRun: SourceRunFixture) => void> = [
      (sourceRun) => {
        sourceRun.id += 1;
      },
      (sourceRun) => {
        sourceRun.run_attempt += 1;
      },
      (sourceRun) => {
        sourceRun.head_sha = "b".repeat(40);
      },
      (sourceRun) => {
        sourceRun.head_branch = "main";
      },
      (sourceRun) => {
        sourceRun.head_repository.full_name = "other/repository";
      },
      (sourceRun) => {
        sourceRun.path = ".github/workflows/other.yml";
      },
      (sourceRun) => {
        sourceRun.event = "push";
      },
      (sourceRun) => {
        sourceRun.status = "in_progress";
        sourceRun.conclusion = null;
      },
      (sourceRun) => {
        sourceRun.conclusion = "stale";
      },
      (sourceRun) => {
        sourceRun.updated_at = new Date(
          (config.sourceDeployCompletedEpoch + 1) * 1_000,
        ).toISOString();
      },
    ];
    for (const corrupt of corruptions) {
      const harness = createHarness({
        sourceRunRead: (_call, sourceRun) => {
          corrupt(sourceRun);
          return sourceRun;
        },
      });
      await expect(
        reconcileGatewayWebhook(
          { ...config },
          await bundle(),
          harness.dependencies,
        ),
      ).rejects.toThrow(
        "exact source workflow attempt is not durably terminal",
      );
      expect(harness.sourceRunReadCalls()).toBe(1);
      expect(harness.railwayReadCalls()).toBe(0);
      expect(harness.rollbackCalls()).toBe(0);
    }
  });

  test("rejects counterfeit local candidate receipts unless every authoritative artifact boundary verifies", async () => {
    const corruptions: Array<(value: ReceiptArtifactFixture) => void> = [
      (attestation) => {
        attestation.artifact.name = "counterfeit";
      },
      (attestation) => {
        attestation.artifact.expired = true;
      },
      (attestation) => {
        attestation.artifact.expires_at = "2026-09-02T00:00:00Z";
      },
      (attestation) => {
        attestation.sourceRun.run_attempt = 2;
      },
      (attestation) => {
        attestation.sourceRun.status = "in_progress";
        attestation.sourceRun.conclusion = null;
      },
      (attestation) => {
        attestation.archiveBytes[0] ^= 0xff;
      },
    ];
    for (const corrupt of corruptions) {
      const harness = createHarness({
        candidateStatus: "SUCCESS",
        active: candidateId,
        receipt: true,
        artifactAttestation: async (attestation) => {
          corrupt(attestation);
          return attestation;
        },
      });
      const counterfeit = {
        ...config,
        receipt: { ...config.receipt, deploymentId: candidateId },
      };
      await expect(
        reconcileGatewayWebhook(
          counterfeit,
          await bundle(),
          harness.dependencies,
        ),
      ).rejects.toThrow("deployment receipt artifact");
      expect(harness.railwayReadCalls()).toBe(0);
      expect(harness.rollbackCalls()).toBe(0);
    }
  });

  test("closes no-candidate only after exhaustive stable prior proof", async () => {
    const harness = createHarness();
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("baseline-preserved-no-candidate");
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("waits a full monotonic source horizon despite wall-clock skew", async () => {
    let harness: ReturnType<typeof createHarness>;
    let added = false;
    harness = createHarness({
      onSleep: (elapsed) => {
        if (!added && elapsed >= 590_000) {
          added = true;
          harness.addCandidate("BUILDING", "2026-09-03T00:00:00Z");
        }
      },
    });
    harness.skewWallClock(10 * 60 * 1_000);
    const startedAt = harness.monotonicNow();
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("nonterminal");
    expect(harness.monotonicNow() - startedAt).toBeGreaterThanOrEqual(600_000);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("leaves a nonterminal candidate OPEN without cancel, remove, or rollback", async () => {
    const harness = createHarness({
      candidateStatus: "BUILDING",
      active: priorId,
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("nonterminal");
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(0);
  });

  test("never mutates when the durable intent append or head guard fails", async () => {
    const appendFailure = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    appendFailure.setIntentFailure(new Error("seal failed"));
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        appendFailure.dependencies,
      ),
    ).rejects.toThrow("seal failed");
    expect(appendFailure.rollbackCalls()).toBe(0);

    const headFailure = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    headFailure.setAuthorityFailure(new Error("develop advanced"));
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        headFailure.dependencies,
      ),
    ).rejects.toThrow("develop advanced");
    expect(headFailure.rollbackCalls()).toBe(0);
  });

  test("never mutates when a provider deployment omits deploymentStopped", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      omitDeploymentStopped: true,
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow(
      "Railway deployment readback is malformed or outside the exact scope",
    );
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("never mutates when a baseline deployment becomes nonterminal", async () => {
    const oldFailed = deployment(restorationOne, "FAILED");
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    harness.addHistory(oldFailed, "2026-09-02T00:00:00Z");
    harness.setDeploymentStatus(restorationOne, "REMOVING");
    const planBundle = await bundle([
      historyRow(oldFailed, "2026-09-02T00:00:00Z"),
    ]);
    harness.state.open.journalPlanPlaintextSha256 =
      planBundle.digests.journalPlanPlaintext;
    await expect(
      reconcileGatewayWebhook({ ...config }, planBundle, harness.dependencies),
    ).rejects.toThrow(
      "complete Railway baseline contains a nonterminal deployment",
    );
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(0);
  });

  test("never replays an ordinal whose deterministic intent was already published", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    harness.setIntentAlreadyPublished(true);
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("will not be replayed");
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("rechecks current develop immediately before the Railway rollback", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      authority: async (call) => {
        if (call === 3) throw new Error("develop advanced after preflight");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("develop advanced after preflight");
    expect(harness.authorityCalls()).toBe(3);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("rechecks the exact terminal source attempt immediately before the Railway rollback", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      sourceRunRead: (call, sourceRun) =>
        call === 1
          ? sourceRun
          : { ...sourceRun, status: "in_progress", conclusion: null },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("exact source workflow attempt is not durably terminal");
    expect(harness.sourceRunReadCalls()).toBe(2);
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("re-attests the project-token environment and service mapping immediately before rollback", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      scopeAttestation: async () => {
        throw new Error("Railway environment mapping changed");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("Railway environment mapping changed");
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.scopeAttestationCalls()).toBe(1);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("rechecks develop after the asynchronous Railway scope attestation", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      scopeAttestation: async () => {
        harness.setAuthorityFailure(
          new Error("develop advanced during Railway attestation"),
        );
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("develop advanced during Railway attestation");
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.scopeAttestationCalls()).toBe(1);
    expect(harness.authorityCalls()).toBe(2);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("rechecks the provider watermark after asynchronous scope attestation", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      scopeAttestation: async () => {
        harness.addRestoration(
          restorationOne,
          "SUCCESS",
          "2026-09-03T00:39:59Z",
        );
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("outside the durable provider watermark");
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.scopeAttestationCalls()).toBe(1);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("rejects an active deployment absent from the exhaustive history", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    harness.setActiveOverride(
      deployment(restorationTwo, "SUCCESS", "snapshot_unknown", "unattributed"),
    );
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("absent from or unattributed");
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(0);
  });

  test("does not mutate when active topology changes after the intent", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      authority: async (call) => {
        if (call === 1) harness.setActive(priorId);
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("active topology changed");
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(1);

    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-preserved");
    expect(result.rollbackAttempts).toEqual([
      {
        ordinal: 1,
        restorationDeploymentId: null,
        status: "AMBIGUOUS",
      },
    ]);
    expect(harness.rollbackCalls()).toBe(0);
  });

  test("does not call Railway after preflight consumed the intent settlement runway", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      authority: async (call) => {
        if (call === 2) harness.advanceNow(61_000);
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("too old for a full provider-settlement runway");
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(1);
  });

  test("leaves a full settlement horizon after a call at the runway boundary", async () => {
    let harness: ReturnType<typeof createHarness>;
    let effectAt = 0;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      authority: async (call) => {
        if (call === 2) harness.advanceNow(60_000);
      },
      rollback: async () => {
        harness.advanceNow(30_000);
        effectAt = harness.now();
        harness.addRestoration(
          restorationOne,
          "SUCCESS",
          new Date(effectAt).toISOString(),
        );
        throw new Error("response lost after the timeout boundary");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    expect(harness.rollbackCalls()).toBe(1);

    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.now() - effectAt).toBeGreaterThanOrEqual(600_000);
  });

  test("recovers a lost rollback acknowledgement without replaying its intent", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        harness.addRestoration(
          restorationOne,
          "SUCCESS",
          "2026-09-03T00:45:00Z",
        );
        throw new Error("response lost");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.state.rollbackObservations).toHaveLength(0);

    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
    expect(harness.rollbackCalls()).toBe(1);
    expect(result.rollbackAttempts).toEqual([
      {
        ordinal: 1,
        restorationDeploymentId: restorationOne,
        status: "SUCCESS",
      },
    ]);
  });

  test("attributes a lost acknowledgement by provider watermark despite negative clock skew", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        harness.addRestoration(
          restorationOne,
          "SUCCESS",
          "2026-09-03T00:39:59Z",
        );
        throw new Error("response lost across skewed provider clocks");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    harness.skewWallClock(-10 * 60 * 1_000);
    const resumedAt = harness.monotonicNow();
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.monotonicNow() - resumedAt).toBeGreaterThanOrEqual(690_000);
  });

  test("does not let positive wall-clock skew shorten intent settlement", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw new Error("acknowledgement remains invisible");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    harness.skewWallClock(10 * 60 * 1_000);
    const resumedAt = harness.monotonicNow();
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.monotonicNow() - resumedAt).toBeGreaterThanOrEqual(690_000);
  });

  test("refines a late R1 observation and closes without issuing R2", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw new Error("R1 acknowledgement lost");
      },
      observe: async (status) => {
        if (status === "AMBIGUOUS") {
          harness.addRestoration(
            restorationOne,
            "SUCCESS",
            "2026-09-03T00:39:59Z",
          );
        }
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(harness.state.rollbackObservations).toHaveLength(1);
    expect(harness.state.rollbackObservations[0].status).toBe("SUCCESS");
  });

  test("keeps delayed R1 and acknowledged R2 unresolved when their effects cannot be attributed", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async (ordinal) => {
        if (ordinal === 1) throw new Error("R1 acknowledgement lost");
        harness.addRestoration(
          restorationTwo,
          "FAILED",
          "2026-09-03T00:50:00Z",
        );
        return true;
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(harness.rollbackCalls()).toBe(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);

    harness.addRestoration(restorationOne, "SUCCESS", "2026-09-03T00:55:00Z");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow(
      "one durable rollback intent maps to multiple Railway restorations",
    );
    expect(harness.rollbackCalls()).toBe(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);
  });

  test("keeps multiple late restorations fail-closed without another effect", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw new Error("R1 acknowledgement lost");
      },
      observe: async (status) => {
        if (status === "AMBIGUOUS") {
          harness.addRestoration(
            restorationOne,
            "SUCCESS",
            "2026-09-03T00:45:00Z",
          );
          harness.addRestoration(
            restorationTwo,
            "FAILED",
            "2026-09-03T00:46:00Z",
          );
        }
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("more restorations than durable rollback intents");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(1);
  });

  test("never issues R2 when R1 appears between the R2 intent and call", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw new Error("R1 acknowledgement lost");
      },
      authority: async (call) => {
        if (call === 4) {
          harness.addRestoration(
            restorationOne,
            "SUCCESS",
            "2026-09-03T00:39:59Z",
          );
        }
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("outside the durable provider watermark");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(2);
  });

  test("never attributes a sole post-acknowledgement restoration to R2 while R1 is ambiguous", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async (ordinal) => {
        if (ordinal === 1) throw new Error("R1 acknowledgement lost");
        harness.addRestoration(
          restorationOne,
          "SUCCESS",
          "2026-09-03T00:55:00Z",
        );
        return true;
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);

    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.state.rollbackObservations).toHaveLength(1);
  });

  test("keeps a restoration first visible at the R2 settlement boundary unattributed", async () => {
    let harness: ReturnType<typeof createHarness>;
    let r2AcknowledgedAt: number | null = null;
    let restorationInjected = false;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async (ordinal) => {
        if (ordinal === 1) throw new Error("R1 acknowledgement lost");
        r2AcknowledgedAt = harness.monotonicNow();
        return true;
      },
      onSleep: (monotonicNow) => {
        if (
          r2AcknowledgedAt !== null &&
          !restorationInjected &&
          monotonicNow - r2AcknowledgedAt >= 690_000
        ) {
          restorationInjected = true;
          harness.addRestoration(
            restorationOne,
            "FAILED",
            "2026-09-03T01:00:00Z",
          );
        }
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(restorationInjected).toBe(true);
    const observedR2AcknowledgedAt = r2AcknowledgedAt;
    expect(observedR2AcknowledgedAt).not.toBeNull();
    expect(
      harness.monotonicNow() -
        (observedR2AcknowledgedAt ?? Number.POSITIVE_INFINITY),
    ).toBeGreaterThanOrEqual(690_000);
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);
  });

  test("a crash after R1 intent never reuses R1 or guesses which intent caused an effect", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        harness.addRestoration(
          restorationTwo,
          "SUCCESS",
          "2026-09-03T00:50:00Z",
        );
        return true;
      },
    });
    harness.setAuthorityFailure(new Error("runner lost before provider call"));
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("runner lost");
    expect(harness.rollbackCalls()).toBe(0);
    expect(harness.state.rollbackIntents).toHaveLength(1);

    harness.setAuthorityFailure(null as unknown as Error);
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("could refine an earlier ambiguous rollback ordinal");
    expect(harness.rollbackCalls()).toBe(1);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS"]);
  });

  test("records failed R1, issues unique R2, and never permits R3", async () => {
    let harness: ReturnType<typeof createHarness>;
    harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async (ordinal) => {
        if (ordinal === 1) {
          harness.addRestoration(
            restorationOne,
            "FAILED",
            "2026-09-03T00:40:00Z",
          );
          return true;
        }
        harness.addRestoration(
          restorationTwo,
          "SUCCESS",
          "2026-09-03T00:50:00Z",
        );
        return true;
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("fresh authorized run");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(1);
    expect(
      harness.state.rollbackObservations.map((value: any) => value.status),
    ).toEqual(["FAILED"]);
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("fresh authorized run");
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    expect(
      harness.state.rollbackObservations.map((value: any) => value.status),
    ).toEqual(["FAILED", "SUCCESS"]);
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
  });

  test("two ambiguous attempts remain OPEN and no later schedule can issue R3", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw new Error("response lost");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("both durable Railway rollback attempts");
    expect(harness.rollbackCalls()).toBe(2);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    expect(
      harness.state.rollbackObservations.map((value: any) => value.status),
    ).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
  });

  test("a successful observation is mutation-final even when active proof regresses", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
    });
    harness.addRestoration(restorationOne, "SUCCESS", "2026-09-03T00:45:00Z");
    await harness.dependencies.journal.ensureIntent(
      candidateId,
      expectedMessage,
    );
    await harness.dependencies.journal.observe("SUCCESS", restorationOne);
    harness.setActive(candidateId);
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("sole stable immutable prior snapshot");
    expect(harness.rollbackCalls()).toBe(0);
  });
});

describe("Railway GraphQL adapter", () => {
  test("follows every Relay cursor without trusting provider ordering", async () => {
    const calls: any[] = [];
    const execute = async (_command: string, args: string[]) => {
      const variables = JSON.parse(args[3]);
      calls.push(variables);
      const nodes =
        variables.after === null
          ? [
              historyRow(
                deployment(
                  candidateId,
                  "FAILED",
                  "snapshot_candidate",
                  expectedMessage,
                ),
                "2026-09-03T00:10:00Z",
              ),
            ]
          : [historyRow(deployment(priorId), "2026-09-03T00:00:00Z")];
      return {
        stdout: JSON.stringify({
          data: {
            deployments: {
              edges: nodes.map((node) => ({ node })),
              pageInfo: {
                hasNextPage: variables.after === null,
                endCursor: variables.after === null ? "next" : null,
              },
            },
          },
        }),
      };
    };
    const client = new RailwayCliClient({
      scope,
      environment: { RAILWAY_TOKEN: "environment-project-token" },
      execute: execute as any,
    });
    const rows = await client.listDeployments();
    expect(rows.map((row) => row.id)).toEqual([candidateId, priorId]);
    expect(calls.map((call) => call.after)).toEqual([null, "next"]);
  });

  test("uses the live Boolean rollback contract with a least-privilege token", async () => {
    let document = "";
    let childEnvironment: Record<string, string> = {};
    const execute = async (_command: string, args: string[], options: any) => {
      document = args[1];
      childEnvironment = options.env;
      return {
        stdout: JSON.stringify({
          errors: [],
          data: { deploymentRollback: true },
        }),
      };
    };
    const client = new RailwayCliClient({
      scope,
      environment: {
        PATH: "/fixture/bin",
        RAILWAY_TOKEN: "railway-only",
        GITHUB_TOKEN: "must-not-leak",
        GATEWAY_JOURNAL_AUTH_KEY: "must-not-leak",
      },
      execute: execute as any,
    });
    expect(await client.rollback(priorId)).toBe(true);
    expect(document).toContain("deploymentRollback(id: $id)");
    expect(document).not.toContain("deploymentRollback(id: $id) {");
    expect(childEnvironment).toEqual({
      PATH: "/fixture/bin",
      RAILWAY_TOKEN: "railway-only",
    });
  });

  test("rejects a false or malformed Railway rollback acknowledgement", async () => {
    for (const deploymentRollback of [false, null, { id: restorationOne }]) {
      const client = new RailwayCliClient({
        scope,
        environment: { RAILWAY_TOKEN: "environment-project-token" },
        execute: (async () => ({
          stdout: JSON.stringify({ data: { deploymentRollback } }),
        })) as any,
      });
      await expect(client.rollback(priorId)).rejects.toThrow(
        "did not return an authoritative true acknowledgement",
      );
    }
  });

  test("rejects malformed Railway GraphQL envelopes before consuming data", async () => {
    for (const payload of [
      {
        errors: { message: "provider rejected rollback" },
        data: { deploymentRollback: true },
      },
      { errors: null, data: { deploymentRollback: true } },
      { errors: [null], data: { deploymentRollback: true } },
      { data: null },
      { data: [] },
      { data: "deploymentRollback" },
    ]) {
      const client = new RailwayCliClient({
        scope,
        environment: { RAILWAY_TOKEN: "environment-project-token" },
        execute: (async () => ({ stdout: JSON.stringify(payload) })) as any,
      });
      await expect(client.rollback(priorId)).rejects.toThrow(
        "Railway GraphQL request did not return a valid success envelope",
      );
    }
  });

  test("rejects duplicate keys in raw Railway GraphQL output", async () => {
    for (const stdout of [
      `{"errors":[{"message":"provider denied rollback"}],"errors":[],"data":{"deploymentRollback":true}}`,
      `{"errors":[],"data":null,"data":{"deploymentRollback":true}}`,
      `{"\\u0065rrors":[{"message":"provider denied rollback"}],"errors":[],"data":{"deploymentRollback":true}}`,
    ]) {
      const client = new RailwayCliClient({
        scope,
        environment: { RAILWAY_TOKEN: "environment-project-token" },
        execute: (async () => ({ stdout })) as any,
      });
      await expect(client.rollback(priorId)).rejects.toThrow(
        "Railway returned non-strict GraphQL JSON output",
      );
    }
  });

  test("requires an environment-scoped project token and exact staging resource names", async () => {
    let document = "";
    const execute = async (_command: string, args: string[]) => {
      document = args[1];
      return {
        stdout: JSON.stringify({
          data: {
            projectToken: {
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            project: {
              id: scope.projectId,
              environments: {
                edges: [{ node: { id: scope.environmentId, name: "staging" } }],
              },
              services: {
                edges: [
                  { node: { id: scope.serviceId, name: scope.serviceName } },
                ],
              },
            },
          },
        }),
      };
    };
    const client = new RailwayCliClient({
      scope,
      environment: { RAILWAY_TOKEN: "environment-project-token" },
      execute: execute as any,
    });
    await expect(client.assertExactStagingScope()).resolves.toEqual({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      environmentName: "staging",
      serviceId: scope.serviceId,
      serviceName: scope.serviceName,
    });
    expect(document).toContain("projectToken { projectId environmentId }");

    const wrongService = new RailwayCliClient({
      scope,
      environment: { RAILWAY_TOKEN: "environment-project-token" },
      execute: (async () => ({
        stdout: JSON.stringify({
          data: {
            projectToken: {
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            project: {
              id: scope.projectId,
              environments: {
                edges: [{ node: { id: scope.environmentId, name: "staging" } }],
              },
              services: {
                edges: [
                  { node: { id: scope.serviceId, name: "production-gateway" } },
                ],
              },
            },
          },
        }),
      })) as any,
    });
    await expect(wrongService.assertExactStagingScope()).rejects.toThrow(
      "outside exact staging scope",
    );

    let unscopedCalls = 0;
    const unscoped = new RailwayCliClient({
      scope,
      execute: (async () => {
        unscopedCalls += 1;
        return { stdout: "{}" };
      }) as any,
    });
    await expect(unscoped.assertExactStagingScope()).rejects.toThrow(
      "environment-scoped Railway project token is missing",
    );
    expect(unscopedCalls).toBe(0);
  });
});

describe("GitHub deployment receipt artifact adapter", () => {
  test("downloads and binds exact archive bytes from the authoritative source attempt", async () => {
    const harness = createHarness({ receipt: true });
    const fixture = await harness.dependencies.artifacts.attestReceipt();
    const api = {
      request: async (_method: string, endpoint: string) =>
        endpoint.includes("/artifacts/") ? fixture.artifact : fixture.sourceRun,
    };
    const client = new GitHubReceiptArtifactClient({
      api,
      token: "github-token",
      repository: config.repository,
      fetchImpl: async () =>
        new Response(fixture.archiveBytes, {
          status: 200,
          headers: { "content-length": String(fixture.archiveBytes.length) },
        }),
    });
    const attestation = await client.attestReceipt(config);
    const validated = validateReceiptArtifactAttestation(
      config,
      attestation,
      Date.parse("2026-09-03T00:30:00Z"),
    );
    expect(validated.receipt).toEqual(config.receipt);
    expect(validated.receiptBytesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validated.receiptSemanticDigest).toBe(
      deploymentReceiptSemanticDigest(config.receipt),
    );
  });

  test("rejects duplicate keys in the authoritative receipt bytes", async () => {
    const harness = createHarness({ receipt: true });
    const fixture = await harness.dependencies.artifacts.attestReceipt();
    const serialized = JSON.stringify(config.receipt);
    const receiptBytes = Buffer.from(
      `{"sourceSha":"${sourceSha}",${serialized.slice(1)}`,
      "utf8",
    );
    const archiveBytes = singleFileZip(
      "gateway-webhook-deployment.json",
      receiptBytes,
    );
    const receiptArtifactDigest = digest(archiveBytes);

    expect(() =>
      validateReceiptArtifactAttestation(
        { ...config, receiptArtifactDigest },
        {
          ...fixture,
          artifact: {
            ...fixture.artifact,
            digest: `sha256:${receiptArtifactDigest}`,
          },
          archiveBytes,
        },
        Date.parse("2026-09-03T00:30:00Z"),
      ),
    ).toThrow("authoritative deployment receipt is not strict JSON");
  });
});

describe("Gateway webhook reconcile Actions annotations", () => {
  test("redacts provider exception metadata and encodes one safe annotation", () => {
    const canaries = [
      "fake-secret-reconcile-canary",
      "987654321-resource-id",
      '{"httpBody":"private"}',
      "line one\r\n::error::injected-command",
    ];
    const providerError = Object.assign(new Error(canaries.join(" ")), {
      argv: ["railway", "--environment", canaries[1]],
      body: canaries[2],
      resourceId: canaries[1],
      stderr: canaries[3],
    });
    let output = "";
    writeReconcileFailureAnnotation(
      { write: (value: string) => (output += value) },
      providerError,
    );

    expect(output).toBe(
      "::error::gateway-webhook-reconcile failure-class=external-dependency-failure\n",
    );
    for (const canary of canaries) expect(output).not.toContain(canary);
    expect(output.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  test("rejects untrusted warning data instead of forming another command", () => {
    const injected = "fake-secret-warning%\r\n::error::forged-provider-message";
    let output = "";
    writeReconcileWarningAnnotation(
      { write: (value: string) => (output += value) },
      injected,
    );

    expect(output).toBe(
      "::warning::gateway-webhook-reconcile failure-class=external-dependency-failure\n",
    );
    expect(output).not.toContain(injected);
    expect(output).not.toContain("forged-provider-message");
    expect(output.slice(0, -1)).not.toMatch(/[\r\n]/);
  });

  test("replaces a Railway process error before propagating it", async () => {
    const processCanary =
      "fake-secret-process\r\n::error::stderr-body-resource-778899";
    const client = new RailwayCliClient({
      scope,
      execute: async () => {
        throw Object.assign(new Error(processCanary), {
          argv: ["railway", "api", "--variables", processCanary],
          body: processCanary,
          resourceId: "778899",
          stderr: processCanary,
        });
      },
    });
    let caught: unknown;
    try {
      await client.listDeployments();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RedactedActionError);
    if (!(caught instanceof RedactedActionError)) {
      throw new Error("expected a classified Railway CLI failure");
    }
    expect(caught.message).toBe("Railway CLI request failed");
    expect(caught.diagnosticClass).toBe("railway-cli-request-failure");
    const propagated = `${caught.name}\n${caught.message}\n${caught.stack ?? ""}\n${JSON.stringify(caught)}`;
    expect(propagated).not.toContain(processCanary);
    expect(propagated).not.toContain("778899");

    let output = "";
    writeReconcileFailureAnnotation(
      { write: (value: string) => (output += value) },
      caught,
    );
    expect(output).toBe(
      "::error::gateway-webhook-reconcile failure-class=railway-cli-request-failure\n",
    );
  });

  test("classifies a lost rollback acknowledgement without exception data", async () => {
    const canary =
      "fake-secret-rollback\r\n::warning::provider-body-and-resource-id";
    const warnings: string[] = [];
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        throw Object.assign(new Error(canary), {
          body: canary,
          resourceId: "1122334455",
          stderr: canary,
        });
      },
    });
    harness.dependencies.warn = (diagnosticClass: string) => {
      warnings.push(diagnosticClass);
    };

    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("acknowledgement is unresolved");
    expect(warnings).toEqual(["rollback-acknowledgement-unresolved"]);
    expect(warnings.join("\n")).not.toContain(canary);
    expect(warnings.join("\n")).not.toContain("1122334455");
  });
});
