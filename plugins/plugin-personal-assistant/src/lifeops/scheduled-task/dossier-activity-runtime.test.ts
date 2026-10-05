/**
 * Exercises the real dossier adapter and canonical memory store, including
 * competing admissions and control races. The runner integration uses the
 * canonical scheduler with a controlled dispatch port; no model or device runs.
 */
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  type ScheduledTask,
  type ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import { reconcileOwnerDossierActivity } from "./dossier-activity-migration.js";
import {
  DOSSIER_ACTIVITY_ANCHOR_KEY,
  DOSSIER_ACTIVITY_METADATA_KEY as KEY,
  readDossierActivityState,
} from "./dossier-activity-policy.js";
import {
  admitOwnerDossierActivity,
  createDossierActivityMutationPolicy,
  prepareDossierAutomaticFire,
  resolveOwnerDossierActivityAnchor,
  type TrustedDossierActivity,
} from "./dossier-activity-runtime.js";

type ScheduledTaskConditionalUpsertOptions = Parameters<
  ScheduledTaskStore["upsertIfStatus"]
>[1];

const policy = createDossierActivityMutationPolicy({
  ownerFacts: () => ({ timezone: "America/Los_Angeles" }),
});
function task(id = "dossier"): ScheduledTask {
  return {
    taskId: id,
    kind: "recap",
    promptInstructions: "Assemble the dossier",
    source: "first_run",
    idempotencyKey: "lifeops:first-run:default:morning-brief",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
      offsetMinutes: 0,
    },
    state: { status: "scheduled", followupCount: 0 },
    priority: "medium",
    respectsGlobalPause: true,
    createdBy: "agent",
    ownerVisible: true,
  };
}
async function migrated(id = "dossier"): Promise<ScheduledTask> {
  const result = await policy({
    previous: null,
    proposed: task(id),
    verb: "schedule",
    nowIso: "2026-09-19T12:00:00Z",
  });
  if (!result) throw new Error("Expected migration");
  return result;
}
function activity(id = "event-a"): TrustedDossierActivity {
  return {
    authenticated: true,
    principalId: "owner",
    ownerPrincipalId: "owner",
    receivedAtIso: "2026-09-19T12:01:00Z",
    signalId: id,
    kind: "foreground",
  };
}

function legacyDefault(): ScheduledTask {
  return {
    ...task(),
    kind: "watcher",
    promptInstructions:
      "Render the morning brief at the wake.confirmed anchor.",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    },
    metadata: { firstRunPack: "defaults", slot: "morningBrief" },
  };
}
const ownerDay = { timezone: "America/Los_Angeles", boundaryMinutes: 240 };

describe("dossier activity runtime adapter", () => {
  it.each(["before", "after"] as const)(
    "keeps manual runs %s admission separate from automatic days across runner recreation",
    async (manualOrder) => {
      const store = createInMemoryScheduledTaskStore();
      const logStore = createInMemoryScheduledTaskLogStore();
      const anchors = createAnchorRegistry();
      anchors.register({
        anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
        consumption: "host_claim",
        describe: { label: "Owner activity", provider: "dossier-test" },
        resolve: ({ nowIso }) =>
          resolveOwnerDossierActivityAnchor(store, nowIso),
      });
      let nowIso = "2026-09-19T12:00:00Z";
      const delivered: Array<string | null> = [];
      const createRunner = () =>
        createScheduledTaskRunner({
          agentId: "dossier-agent",
          store,
          logStore,
          anchors,
          gates: createTaskGateRegistry(),
          completionChecks: createCompletionCheckRegistry(),
          ladders: createEscalationLadderRegistry(),
          consolidation: createConsolidationRegistry(),
          ownerFacts: () => ({ timezone: "America/Los_Angeles" }),
          globalPause: { current: async () => ({ active: false }) },
          activity: { hasSignalSince: () => false },
          subjectStore: { wasUpdatedSince: () => false },
          prepareMutation: policy,
          prepareAutomaticFire: prepareDossierAutomaticFire,
          now: () => new Date(nowIso),
          dispatcher: {
            async dispatch(record) {
              const state = readDossierActivityState(
                (await store.get(record.taskId))?.metadata,
              );
              if (!state) throw new Error("Expected committed dossier state");
              delivered.push(state.consumedDay);
              return { ok: true, messageId: `delivery-${delivered.length}` };
            },
          },
        });
      const runner = createRunner();
      const saved = await runner.schedule(task());
      if (manualOrder === "after") {
        nowIso = "2026-09-19T12:01:00Z";
        expect(
          await admitOwnerDossierActivity(store, activity()),
        ).toMatchObject({
          kind: "admitted",
        });
      }
      expect((await runner.fireWithResult(saved.taskId)).kind).toBe("fired");
      expect(delivered).toEqual([null]);

      nowIso = "2026-09-19T12:01:00Z";
      if (manualOrder === "before")
        expect(
          await admitOwnerDossierActivity(store, activity()),
        ).toMatchObject({
          kind: "admitted",
        });
      expect(
        (
          await runner.fireWithResult(saved.taskId, {
            cause: "automatic",
            allowTerminalRefire: true,
          })
        ).kind,
      ).toBe("fired");
      expect(delivered).toEqual([null, "2026-09-19"]);

      // Recreating the runner retains the committed day. Completing and
      // explicitly reopening the task permits a manual rerun without restoring
      // the already consumed automatic allowance.
      const restarted = createRunner();
      nowIso = "2026-09-19T12:02:00Z";
      await restarted.apply(saved.taskId, "complete");
      await restarted.apply(saved.taskId, "reopen");
      await restarted.fireWithResult(saved.taskId, {
        cause: "manual",
      });
      expect(
        (
          await restarted.fireWithResult(saved.taskId, {
            cause: "automatic",
            allowTerminalRefire: true,
          })
        ).kind,
      ).toBe("raced");
      expect(delivered).toEqual([null, "2026-09-19", "2026-09-19"]);

      nowIso = "2026-09-20T12:01:00Z";
      await admitOwnerDossierActivity(store, {
        ...activity("next-day-device"),
        receivedAtIso: nowIso,
      });
      expect(
        (
          await restarted.fireWithResult(saved.taskId, {
            cause: "automatic",
            allowTerminalRefire: true,
          })
        ).kind,
      ).toBe("fired");
      expect(delivered).toEqual([
        null,
        "2026-09-19",
        "2026-09-19",
        "2026-09-20",
      ]);
    },
  );

  it("initializes managed rows and leaves customized legacy rows alone", async () => {
    const current = await migrated();
    expect(readDossierActivityState(current.metadata)?.day).toEqual({
      timezone: "America/Los_Angeles",
      boundaryMinutes: 240,
    });
    const legacy = {
      ...task(),
      trigger: { kind: "cron" as const, expression: "0 9 * * *", tz: "UTC" },
    };
    expect(
      await policy({
        previous: legacy,
        proposed: legacy,
        verb: "edit",
        nowIso: "2026-09-19T12:00:00Z",
      }),
    ).toBeNull();
    const fallback = createDossierActivityMutationPolicy({
      ownerFacts: () => ({}),
      fallbackTimezone: () => "Europe/Paris",
      boundaryMinutes: 300,
    });
    const configured = await fallback({
      previous: null,
      proposed: task(),
      verb: "schedule",
      nowIso: "2026-09-19T12:00:00Z",
    });
    expect(readDossierActivityState(configured?.metadata)?.day).toEqual({
      timezone: "Europe/Paris",
      boundaryMinutes: 300,
    });
  });

  it("retains inherited or omitted reserved metadata but rejects forgery and identity changes", async () => {
    const previous = await migrated();
    const invoke = (proposed: ScheduledTask) =>
      policy({
        previous,
        proposed,
        verb: "edit",
        nowIso: "2026-09-19T12:02:00Z",
      });
    expect((await invoke(structuredClone(previous)))?.metadata).toEqual(
      previous.metadata,
    );
    expect(
      (await invoke({ ...previous, metadata: { label: "renamed" } }))?.metadata,
    ).toEqual({ ...previous.metadata, label: "renamed" });
    await expect(
      invoke({ ...previous, metadata: { [KEY]: {} } }),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_METADATA_READ_ONLY" });
    await expect(
      invoke({ ...previous, idempotencyKey: "changed" }),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_CONTROL_INVALID" });
    await expect(
      policy({
        previous: null,
        proposed: previous,
        verb: "schedule",
        nowIso: "2026-09-19T12:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_METADATA_READ_ONLY" });
  });

  it("persists a fixed anchor and its due index without dispatch or day consumption", async () => {
    const store = createInMemoryScheduledTaskStore();
    await store.upsert(await migrated());
    const calls: ScheduledTaskConditionalUpsertOptions[] = [];
    const observedStore = {
      ...store,
      async upsertIfStatus(
        next: ScheduledTask,
        options: ScheduledTaskConditionalUpsertOptions,
      ) {
        calls.push(options);
        return store.upsertIfStatus(next, options);
      },
    };
    expect(await admitOwnerDossierActivity(observedStore, activity())).toEqual({
      kind: "admitted",
      taskId: "dossier",
      atIso: activity().receivedAtIso,
      dayKey: "2026-09-19",
    });
    expect(calls[0]?.nextFireAtIso).toBe(activity().receivedAtIso);
    const stored = await store.get("dossier");
    expect(stored?.state.status).toBe("scheduled");
    expect(readDossierActivityState(stored?.metadata)?.consumedDay).toBeNull();
    expect(
      await admitOwnerDossierActivity(store, {
        ...activity("device-b"),
        receivedAtIso: "2026-09-19T18:00:00Z",
      }),
    ).toMatchObject({ kind: "not_admitted" });
    expect(
      readDossierActivityState((await store.get("dossier"))?.metadata)?.admitted
        ?.signalId,
    ).toBe("event-a");
  });

  it("allows only one competing device admission through the real store CAS", async () => {
    const store = createInMemoryScheduledTaskStore();
    await store.upsert(await migrated());
    const results = await Promise.allSettled([
      admitOwnerDossierActivity(store, activity("a")),
      admitOwnerDossierActivity(store, activity("b")),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toMatchObject({
      code: "DOSSIER_ACTIVITY_ADMISSION_RACED",
    });
  });

  it("does not overwrite a same-status disable committed after the admission read", async () => {
    const store = createInMemoryScheduledTaskStore();
    await store.upsert(await migrated());
    const interleaved = {
      ...store,
      async upsertIfStatus(
        next: ScheduledTask,
        options: ScheduledTaskConditionalUpsertOptions,
      ) {
        const previous = await store.get(next.taskId);
        if (!previous) throw new Error("Missing task");
        const paused = await policy({
          previous,
          proposed: { ...previous, trigger: { kind: "manual" } },
          verb: "edit",
          nowIso: "2026-09-19T12:02:00Z",
        });
        if (!paused) throw new Error("Expected managed pause");
        await store.upsert(paused);
        return store.upsertIfStatus(next, options);
      },
    };
    await expect(
      admitOwnerDossierActivity(interleaved, activity()),
    ).rejects.toMatchObject({
      code: "DOSSIER_ACTIVITY_ADMISSION_RACED",
      context: { taskId: "dossier", retryable: true },
    });
    expect(
      readDossierActivityState((await store.get("dossier"))?.metadata)?.enabled,
    ).toBe(false);
  });

  it("refuses ambiguous managed defaults without changing either row", async () => {
    const store = createInMemoryScheduledTaskStore();
    const first = await migrated();
    const second = {
      ...(await migrated("catalog")),
      source: "default_pack" as const,
      idempotencyKey: "default-pack:morning-brief:assembler",
    };
    await store.upsert(first);
    await store.upsert(second);
    await expect(
      admitOwnerDossierActivity(store, activity()),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_TASK_AMBIGUOUS" });
    await expect(
      resolveOwnerDossierActivityAnchor(store, "2026-09-19T12:02:00Z"),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_TASK_AMBIGUOUS" });
    expect(await store.get("dossier")).toEqual(first);
    expect(await store.get("catalog")).toEqual(second);
  });

  it("resolves only a current fixed admission and never a disabled or expired day", async () => {
    const store = createInMemoryScheduledTaskStore();
    expect(
      await resolveOwnerDossierActivityAnchor(store, "2026-09-19T12:02:00Z"),
    ).toBeNull();
    await store.upsert(await migrated());
    expect(
      await resolveOwnerDossierActivityAnchor(store, "2026-09-19T12:02:00Z"),
    ).toBeNull();
    await admitOwnerDossierActivity(store, activity());
    expect(
      await resolveOwnerDossierActivityAnchor(store, "2026-09-19T18:00:00Z"),
    ).toEqual({ atIso: activity().receivedAtIso });
    expect(
      await resolveOwnerDossierActivityAnchor(store, "2026-09-20T12:00:00Z"),
    ).toBeNull();
    const previous = await store.get("dossier");
    if (!previous) throw new Error("Expected task");
    const paused = await policy({
      previous,
      proposed: { ...previous, trigger: { kind: "manual" } },
      verb: "edit",
      nowIso: "2026-09-19T12:02:00Z",
    });
    if (!paused) throw new Error("Expected pause");
    await store.upsert(paused);
    expect(
      await resolveOwnerDossierActivityAnchor(store, "2026-09-19T18:00:00Z"),
    ).toBeNull();
  });

  it("returns explicit nonadmission for absent, disabled and nonowner activity", async () => {
    const store = createInMemoryScheduledTaskStore();
    expect(await admitOwnerDossierActivity(store, activity())).toEqual({
      kind: "not_admitted",
      reason: "no_managed_task",
    });
    const previous = await migrated();
    const paused = await policy({
      previous,
      proposed: { ...previous, trigger: { kind: "manual" } },
      verb: "edit",
      nowIso: "2026-09-19T12:02:00Z",
    });
    if (!paused) throw new Error("Expected pause");
    await store.upsert(paused);
    expect(await admitOwnerDossierActivity(store, activity())).toEqual({
      kind: "not_admitted",
      reason: "disabled",
    });
    expect(
      await admitOwnerDossierActivity(store, {
        ...activity(),
        principalId: "admin",
      }),
    ).toEqual({ kind: "not_admitted", reason: "untrusted_activity" });
  });
  it("migrates the persisted legacy default and admits the same first event with one inventory read", async () => {
    const store = createInMemoryScheduledTaskStore();
    await store.upsert(legacyDefault());
    let reads = 0;
    const counted: ScheduledTaskStore = {
      ...store,
      async list(filter) {
        reads++;
        return store.list(filter);
      },
    };
    const result = await admitOwnerDossierActivity(
      counted,
      activity(),
      ownerDay,
    );
    expect(result).toMatchObject({
      kind: "admitted",
      atIso: activity().receivedAtIso,
    });
    expect(reads).toBe(1);
    const current = await store.get(legacyDefault().taskId);
    const control = readDossierActivityState(current?.metadata);
    expect(control?.enabledAtIso).toBe(activity().receivedAtIso);
    expect(control?.admitted?.signalId).toBe(activity().signalId);
    expect(current?.metadata?.delegatesAssemblyTo).toBe(
      "lifeops:checkin:morning",
    );
    expect(
      await resolveOwnerDossierActivityAnchor(store, activity().receivedAtIso),
    ).toEqual({ atIso: activity().receivedAtIso });
  });

  it("reports unresolved prior delivery without admitting or changing the legacy task", async () => {
    const store = createInMemoryScheduledTaskStore();
    const previous = legacyDefault();
    previous.state = {
      ...previous.state,
      status: "fired",
      firedAt: "2026-09-19T11:30:00Z",
    };
    previous.metadata = {
      ...previous.metadata,
      lastDispatchResult: { ok: false, acceptance: "unknown" },
    };
    await store.upsert(previous);
    await expect(
      admitOwnerDossierActivity(store, activity(), ownerDay),
    ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_DELIVERY_UNRESOLVED" });
    expect(await store.get(previous.taskId)).toEqual(previous);
    expect(() =>
      prepareDossierAutomaticFire({
        task: previous,
        nowIso: activity().receivedAtIso,
      }),
    ).toThrow();
  });

  it("reconciles the changed owner day before admitting the current event", async () => {
    const store = createInMemoryScheduledTaskStore();
    await store.upsert(await migrated());
    await admitOwnerDossierActivity(store, activity(), ownerDay);
    const prior = readDossierActivityState(
      (await store.get(task().taskId))?.metadata,
    );
    const nextActivity = {
      ...activity("after-timezone-change"),
      receivedAtIso: "2026-09-19T12:02:00Z",
    };
    const changedDay = { timezone: "Europe/London", boundaryMinutes: 300 };
    expect(
      await admitOwnerDossierActivity(store, nextActivity, changedDay),
    ).toMatchObject({ kind: "admitted", atIso: nextActivity.receivedAtIso });
    const current = readDossierActivityState(
      (await store.get(task().taskId))?.metadata,
    );
    if (!prior || !current)
      throw new Error("Expected both control generations");
    expect(current.generation).toBe(prior.generation + 1);
    expect(current.day).toEqual(changedDay);
    expect(current.admitted?.signalId).toBe(nextActivity.signalId);
    expect(current.enabledAtIso).toBe(nextActivity.receivedAtIso);
  });

  it("does not migrate an existing default on an untrusted activity signal", async () => {
    const store = createInMemoryScheduledTaskStore();
    const previous = legacyDefault();
    await store.upsert(previous);
    let reads = 0;
    const counted: ScheduledTaskStore = {
      ...store,
      async list(filter) {
        reads++;
        return store.list(filter);
      },
    };
    expect(
      await admitOwnerDossierActivity(
        counted,
        { ...activity(), authenticated: false },
        ownerDay,
      ),
    ).toEqual({ kind: "not_admitted", reason: "untrusted_activity" });
    expect(reads).toBe(0);
    expect(await store.get(previous.taskId)).toEqual(previous);
  });

  it("reloads a migrated legacy task before one manual dispatch without consuming an automatic day", async () => {
    const store = createInMemoryScheduledTaskStore();
    const previous = legacyDefault();
    await store.upsert(previous);
    const anchors = createAnchorRegistry();
    anchors.register({
      anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
      consumption: "host_claim",
      describe: { label: "Owner activity", provider: "dossier-test" },
      resolve: ({ nowIso }) => resolveOwnerDossierActivityAnchor(store, nowIso),
    });
    let deliveries = 0;
    const runner = createScheduledTaskRunner({
      agentId: "dossier-agent",
      store,
      logStore: createInMemoryScheduledTaskLogStore(),
      anchors,
      gates: createTaskGateRegistry(),
      completionChecks: createCompletionCheckRegistry(),
      ladders: createEscalationLadderRegistry(),
      consolidation: createConsolidationRegistry(),
      ownerFacts: () => ({ timezone: ownerDay.timezone }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
      now: () => new Date(activity().receivedAtIso),
      prepareExecution: async ({ nowIso }) => {
        await reconcileOwnerDossierActivity(store, { nowIso, day: ownerDay });
      },
      prepareAutomaticFire: prepareDossierAutomaticFire,
      dispatcher: {
        async dispatch(record) {
          deliveries++;
          expect(record.metadata?.delegatesAssemblyTo).toBe(
            "lifeops:checkin:morning",
          );
          expect(
            readDossierActivityState(record.metadata)?.consumedDay,
          ).toBeNull();
          return { ok: true, messageId: "manual-receipt" };
        },
      },
    });
    expect(
      (await runner.fireWithResult(previous.taskId, { cause: "manual" })).kind,
    ).toBe("fired");
    expect(deliveries).toBe(1);
    const control = readDossierActivityState(
      (await store.get(previous.taskId))?.metadata,
    );
    expect(control?.consumedDay).toBeNull();
    expect(control?.admitted).toBeNull();
  });
});
