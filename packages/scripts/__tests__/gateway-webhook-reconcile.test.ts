import { describe, expect, test } from "bun:test";

import {
  RailwayCliClient,
  reconcileGatewayWebhook,
  main as reconcileMain,
  restorationIdDigest,
  validatePlanBundle,
  verifySourcePreMutationSnapshot,
} from "../gateway-webhook-reconcile.mjs";
import { providerDeploymentIdDigest } from "../gateway-webhook-transaction-journal.mjs";

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
  receiptArtifactId: "404",
  receiptArtifactDigest: "f".repeat(64),
  sourceDeployCompletedEpoch: 1_700_000_000,
  scope,
  receipt: null as null | Record<string, unknown>,
};

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
  const text = (value: unknown) => JSON.stringify(value);
  const digest = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString(
      "hex",
    );
  };
  return Promise.all([digest(text(baseline)), digest(text(priorActive))]).then(
    ([baselineDigest, priorDigest]) => ({
      plan: {
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
        deploymentBaselineSha256: baselineDigest,
        priorActiveDeploymentsSha256: priorDigest,
      },
      baseline,
      priorActive,
      digests: { baseline: baselineDigest, priorActive: priorDigest },
    }),
  );
}

function createHarness(
  options: {
    candidateStatus?: string;
    active?: string;
    receipt?: boolean;
    rollback?: (ordinal: number) => Promise<string>;
    authority?: (call: number) => Promise<void>;
    observe?: (status: string, id: string | null) => Promise<void>;
    onSleep?: (monotonicNow: number) => Promise<void> | void;
  } = {},
) {
  let now = Date.parse("2026-09-03T00:30:00Z");
  let monotonicNow = 0;
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
    },
    rollbackIntents: [],
    rollbackObservations: [],
    rollbackIntentCreatedAts: [],
    rollbackIntent: null,
    rollbackObservation: null,
  };
  let rollbackCalls = 0;
  let authorityCalls = 0;
  let intentFailure: Error | null = null;
  let authorityFailure: Error | null = null;
  let intentAlreadyPublished = false;
  const logicalId = (ordinal: number, kind: string) =>
    (kind === "intent" ? String(ordinal) : String(ordinal + 4)).repeat(64);
  const dependencies = {
    railway: {
      listDeployments: async () => history.map((row) => ({ ...row })),
      getDeployment: async (id: string) => ({ ...exact.get(id)! }),
      getActiveDeployments: async () => [
        { ...(activeOverride ?? exact.get(activeId)!) },
      ],
      rollback: async () => {
        rollbackCalls += 1;
        if (options.rollback) return options.rollback(rollbackCalls);
        return restorationOne;
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
  if (options.receipt) {
    config.receipt = {
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
  } else {
    config.receipt = null;
  }
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
          return restorationOne;
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
            return restorationOne;
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
            return restorationOne;
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
      priorActiveDeploymentId: priorId,
    });
    expect(JSON.parse(output)).toEqual(result);
  });

  test("requires provider metadata in the immutable prior-active proof", async () => {
    const planBundle = await bundle();
    delete planBundle.priorActive.data.serviceInstance.activeDeployments[0]
      .meta;

    expect(() => validatePlanBundle(config, planBundle)).toThrow(
      "Railway deployment readback is malformed or outside the exact scope",
    );
  });

  test("classifies Railway sleeping and removing states without poisoning history", async () => {
    const sleepingId = "00000000-0000-4000-8000-000000000005";
    const oldSleeping = deployment(sleepingId, "SLEEPING");
    const oldSleepingRow = historyRow(oldSleeping, "2026-09-02T00:00:00Z");
    const historical = createHarness();
    historical.addHistory(oldSleeping, oldSleepingRow.createdAt);
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle([oldSleepingRow]),
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
        return restorationOne;
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
        return restorationOne;
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
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("candidate-proven");
    expect(result.rollbackAttempts).toEqual([]);
    expect(harness.rollbackCalls()).toBe(0);
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
        if (call === 2) throw new Error("develop advanced after preflight");
      },
    });
    await expect(
      reconcileGatewayWebhook(
        { ...config },
        await bundle(),
        harness.dependencies,
      ),
    ).rejects.toThrow("develop advanced after preflight");
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

  test("refines a late R1 after terminal R2 and never emits another effect", async () => {
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
        return restorationTwo;
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
    ).rejects.toThrow("fresh authorized run");
    expect(harness.rollbackCalls()).toBe(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["AMBIGUOUS", "FAILED"]);

    harness.addRestoration(restorationOne, "SUCCESS", "2026-09-03T00:55:00Z");
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
    expect(harness.rollbackCalls()).toBe(2);
    expect(
      harness.state.rollbackObservations.map(
        (observation: { status: string }) => observation.status,
      ),
    ).toEqual(["SUCCESS", "FAILED"]);
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
        if (call === 3) {
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

  test("a crash after R1 intent never reuses R1 and R2 converges once", async () => {
    const harness = createHarness({
      candidateStatus: "FAILED",
      active: candidateId,
      rollback: async () => {
        harness.addRestoration(
          restorationTwo,
          "SUCCESS",
          "2026-09-03T00:50:00Z",
        );
        return restorationTwo;
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
    ).rejects.toThrow("fresh authorized run");
    expect(harness.rollbackCalls()).toBe(1);
    expect(harness.state.rollbackIntents).toHaveLength(2);
    const result = await reconcileGatewayWebhook(
      { ...config },
      await bundle(),
      harness.dependencies,
    );
    expect(result.result).toBe("prior-snapshot-restored");
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
          return restorationOne;
        }
        harness.addRestoration(
          restorationTwo,
          "SUCCESS",
          "2026-09-03T00:50:00Z",
        );
        return restorationTwo;
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
    const client = new RailwayCliClient({ scope, execute: execute as any });
    const rows = await client.listDeployments();
    expect(rows.map((row) => row.id)).toEqual([candidateId, priorId]);
    expect(calls.map((call) => call.after)).toEqual([null, "next"]);
  });

  test("uses the official rollback object selection and returned id", async () => {
    let document = "";
    let childEnvironment: Record<string, string> = {};
    const execute = async (_command: string, args: string[], options: any) => {
      document = args[1];
      childEnvironment = options.env;
      return {
        stdout: JSON.stringify({
          data: { deploymentRollback: { id: restorationOne } },
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
    expect(await client.rollback(priorId)).toBe(restorationOne);
    expect(document).toContain("deploymentRollback(id: $id) { id }");
    expect(childEnvironment).toEqual({
      PATH: "/fixture/bin",
      RAILWAY_TOKEN: "railway-only",
    });
  });
});
