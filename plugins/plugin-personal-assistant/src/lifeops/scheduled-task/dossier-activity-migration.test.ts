/**
 * Exercises managed dossier upgrades and owner-day reconciliation against real
 * memory and PGlite scheduling stores, including restart and concurrent edits.
 */
import { PGlite } from "@electric-sql/pglite";
import {
  createInMemoryScheduledTaskStore,
  createSchedulingSqlScheduledTaskStore,
  migrateSchedulingTables,
  type ScheduledTask,
  type ScheduledTaskStore,
} from "@elizaos/plugin-scheduling";
import type { CarveOutDatabase } from "@elizaos/plugin-sql";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileOwnerDossierActivity } from "./dossier-activity-migration.js";
import {
  admitDossierActivity,
  DOSSIER_ACTIVITY_ANCHOR_KEY,
  DOSSIER_ACTIVITY_METADATA_KEY as KEY,
  readDossierActivityState,
} from "./dossier-activity-policy.js";

const nowIso = "2026-09-19T12:00:00Z";
const day = { timezone: "America/Los_Angeles", boundaryMinutes: 240 };
const databases: PGlite[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

function legacy(catalog = false): ScheduledTask {
  return {
    taskId: catalog ? "catalog-dossier" : "first-run-dossier",
    kind: catalog ? "recap" : "watcher",
    source: catalog ? "default_pack" : "first_run",
    idempotencyKey: catalog
      ? "default-pack:morning-brief:assembler"
      : "lifeops:first-run:default:morning-brief",
    promptInstructions: catalog
      ? "Assemble the owner's morning brief from LifeOps source data: overdue todos, today's meetings, yesterday's wins, tracked habits, inbox/calendar/contacts/promises. Rank for genuinely interesting, important, reply-needed, or schedule-changing items. Keep it concise. No invented facts; if a source is unavailable, say so in one clause. Use the existing morning-checkin assembler — do not regenerate the briefing structure."
      : "Render the morning brief at the wake.confirmed anchor.",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    },
    metadata: catalog
      ? { packKey: "morning-brief", recordKey: "morning-brief" }
      : { firstRunPack: "defaults", slot: "morningBrief" },
    state: { status: "scheduled", followupCount: 0 },
    priority: "high",
    output: { destination: "channel", target: "owner-chosen-channel" },
    respectsGlobalPause: true,
    createdBy: "owner-agent",
    ownerVisible: true,
  };
}
async function harness(backend: "memory" | "sql") {
  if (backend === "memory") {
    const store = createInMemoryScheduledTaskStore();
    return { store, reopen: () => store };
  }
  const pg = new PGlite();
  databases.push(pg);
  const execute = async (sql: string) =>
    (await pg.query<Record<string, unknown>>(sql)).rows;
  const database: CarveOutDatabase = {
    execute,
    transaction: (operation) =>
      pg.transaction((tx) =>
        operation(
          async (sql) => (await tx.query<Record<string, unknown>>(sql)).rows,
        ),
      ),
  };
  await migrateSchedulingTables(database);
  const reopen = () =>
    createSchedulingSqlScheduledTaskStore({
      agentId: "dossier-test-agent",
      executeSql: execute,
    });
  return { store: reopen(), reopen };
}
async function save(store: ScheduledTaskStore, value: ScheduledTask) {
  await store.upsert(value, { nextFireAtIso: nowIso });
}
function state(task: ScheduledTask) {
  const result = readDossierActivityState(task.metadata);
  if (!result) throw new Error("Expected persisted control");
  return result;
}
async function stored(store: ScheduledTaskStore, taskId: string) {
  const result = await store.get(taskId);
  if (!result) throw new Error("Expected task");
  return result;
}

for (const backend of ["memory", "sql"] as const)
  describe(`${backend} managed dossier migration`, () => {
    it.each([false, true])(
      "migrates an exact default and retains first activity after store restart (catalog=%s)",
      async (catalog) => {
        const { store, reopen } = await harness(backend);
        const original = legacy(catalog);
        await save(store, original);
        const result = await reconcileOwnerDossierActivity(store, {
          nowIso,
          day,
        });
        expect(result.changedTaskIds).toEqual([original.taskId]);
        const upgraded = await stored(reopen(), original.taskId);
        expect(upgraded.trigger).toEqual({
          kind: "relative_to_anchor",
          anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
          offsetMinutes: 0,
        });
        expect(upgraded.output).toEqual(original.output);
        expect(upgraded.priority).toBe("high");
        expect(upgraded.metadata?.delegatesAssemblyTo).toBe(
          "lifeops:checkin:morning",
        );
        const admitted = admitDossierActivity(state(upgraded), {
          authenticated: true,
          principalId: "owner",
          ownerPrincipalId: "owner",
          signalId: "first",
          receivedAtIso: nowIso,
          kind: "foreground",
        });
        expect(admitted.admitted?.atIso).toBe(nowIso);
        expect(
          (await reconcileOwnerDossierActivity(reopen(), { nowIso, day }))
            .changedTaskIds,
        ).toEqual([]);
      },
      30000,
    );

    it("preserves missing/deleted, manual, dismissed, and customized defaults", async () => {
      const { store } = await harness(backend);
      expect(
        (await reconcileOwnerDossierActivity(store, { nowIso, day })).tasks,
      ).toEqual([]);
      const changes: Array<(task: ScheduledTask) => ScheduledTask> = [
        (t) => ({ ...t, trigger: { kind: "manual" } }),
        (t) => ({ ...t, state: { ...t.state, status: "dismissed" } }),
        (t) => ({
          ...t,
          trigger: {
            kind: "relative_to_anchor",
            anchorKey: "wake.confirmed",
            offsetMinutes: 5,
          },
        }),
        (t) => ({ ...t, promptInstructions: "My customized dossier" }),
        (t) => ({ ...t, pipeline: { onComplete: [] } }),
        (t) => ({ ...t, completionCheck: { kind: "delivered", params: {} } }),
      ];
      for (const change of changes) {
        const task = change(legacy());
        await save(store, task);
        const before = await store.get(task.taskId);
        expect(
          (await reconcileOwnerDossierActivity(store, { nowIso, day }))
            .changedTaskIds,
        ).toEqual([]);
        expect(await store.get(task.taskId)).toEqual(before);
      }
      await store.delete(legacy().taskId);
      expect(
        (await reconcileOwnerDossierActivity(store, { nowIso, day })).tasks,
      ).toEqual([]);
    }, 30000);

    it("preflights both identities before any mutation, including unresolved delivery", async () => {
      const { store } = await harness(backend);
      await save(store, legacy());
      const duplicate = legacy(true);
      duplicate.state.status = "fired";
      await save(store, duplicate);
      const before = await store.list();
      await expect(
        reconcileOwnerDossierActivity(store, { nowIso, day }),
      ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_TASK_AMBIGUOUS" });
      expect(await store.list()).toEqual(before);
    }, 30000);

    it("migrates settled fired tasks, defers uncertain delivery, and preserves the consumed day", async () => {
      const { store } = await harness(backend);
      const task = legacy();
      task.state = {
        ...task.state,
        status: "fired",
        firedAt: "2026-09-19T11:30:00Z",
      };
      await save(store, task);
      expect(
        (await reconcileOwnerDossierActivity(store, { nowIso, day })).deferred,
      ).toEqual([{ taskId: task.taskId, reason: "unresolved_delivery" }]);
      task.metadata = {
        ...task.metadata,
        lastDispatchResult: { ok: true, messageId: "accepted" },
      };
      await save(store, task);
      await reconcileOwnerDossierActivity(store, { nowIso, day });
      const upgraded = await stored(store, task.taskId);
      expect(upgraded.state).toEqual(task.state);
      expect(state(upgraded).consumedDay).toBe("2026-09-19");
      expect(
        admitDossierActivity(state(upgraded), {
          authenticated: true,
          principalId: "owner",
          ownerPrincipalId: "owner",
          signalId: "later",
          receivedAtIso: nowIso,
          kind: "unlock",
        }).admitted,
      ).toBeNull();
    }, 30000);

    it("rotates changed owner timezone and boundary before admitting activity, including disabled controls", async () => {
      const { store } = await harness(backend);
      await save(store, legacy());
      await reconcileOwnerDossierActivity(store, { nowIso, day });
      const task = await stored(store, legacy().taskId);
      const initial = state(task);
      const admitted = admitDossierActivity(initial, {
        authenticated: true,
        principalId: "owner",
        ownerPrincipalId: "owner",
        signalId: "old",
        receivedAtIso: nowIso,
        kind: "foreground",
      });
      await save(store, {
        ...task,
        metadata: {
          ...task.metadata,
          [KEY]: { ...admitted, consumedDay: "2026-09-18" },
        },
      });
      const changedDay = { timezone: "Europe/London", boundaryMinutes: 300 };
      await reconcileOwnerDossierActivity(store, { nowIso, day: changedDay });
      const changed = state(await stored(store, task.taskId));
      expect(changed.generation).toBe(initial.generation + 1);
      expect(changed.admitted).toBeNull();
      expect(changed.consumedDay).toBe("2026-09-18");
      expect(changed.day).toEqual(changedDay);
      const paused = await stored(store, task.taskId);
      await save(store, { ...paused, trigger: { kind: "manual" } });
      await reconcileOwnerDossierActivity(store, { nowIso, day });
      const disabled = state(await stored(store, task.taskId));
      expect(disabled.enabled).toBe(false);
      expect(disabled.generation).toBe(changed.generation + 1);
      expect(disabled.consumedDay).toBe("2026-09-18");
      expect(disabled.admitted).toBeNull();
    }, 30000);

    it("keeps unknown and pending delivery parked even after a failed lifecycle transition", async () => {
      const { store } = await harness(backend);
      for (const metadata of [
        { lastDispatchResult: { ok: false, acceptance: "unknown" } },
        { lastDispatchResult: { ok: false } },
        { lastDispatchResult: { ok: false, acceptance: "malformed" } },
        { lastDispatchResult: { ok: true }, pendingDispatch: { attempt: 1 } },
      ]) {
        const task = legacy();
        task.state.status = "failed";
        task.metadata = { ...task.metadata, ...metadata };
        await save(store, task);
        const before = await store.get(task.taskId);
        const result = await reconcileOwnerDossierActivity(store, {
          nowIso,
          day,
        });
        expect(result.changedTaskIds).toEqual([]);
        expect(result.deferred).toEqual([
          { taskId: task.taskId, reason: "unresolved_delivery" },
        ]);
        expect(await store.get(task.taskId)).toEqual(before);
      }
    }, 30000);

    it("allows only one concurrent migration to commit the observed generation", async () => {
      const { store } = await harness(backend);
      await save(store, legacy());
      let arrivals = 0;
      const { promise: barrier, resolve: release } =
        Promise.withResolvers<void>();
      const simultaneous: ScheduledTaskStore = {
        ...store,
        async list(filter) {
          const snapshot = await store.list(filter);
          arrivals++;
          if (arrivals === 2) release();
          await barrier;
          return snapshot;
        },
      };
      const results = await Promise.allSettled([
        reconcileOwnerDossierActivity(simultaneous, { nowIso, day }),
        reconcileOwnerDossierActivity(simultaneous, { nowIso, day }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "DOSSIER_ACTIVITY_RECONCILIATION_RACED" },
      });
      expect(state(await stored(store, legacy().taskId)).generation).toBe(1);
    }, 30000);

    it("rejects malformed historical fire timestamps without mutation", async () => {
      const { store } = await harness(backend);
      const original = legacy();
      original.state.firedAt = "not-an-instant";
      await save(store, original);
      const before = await store.list();
      await expect(
        reconcileOwnerDossierActivity(store, { nowIso, day }),
      ).rejects.toMatchObject({ code: "DOSSIER_ACTIVITY_STATE_INVALID" });
      expect(await store.list()).toEqual(before);
    }, 30000);

    it.each(["trigger", "prompt", "output", "delete"] as const)(
      "rejects concurrent %s changes without overwriting or resurrecting",
      async (change) => {
        const { store } = await harness(backend);
        const original = legacy();
        await save(store, original);
        let raced = false;
        const interleaved: ScheduledTaskStore = {
          ...store,
          async upsertIfStatus(task, options) {
            if (!raced) {
              raced = true;
              if (change === "delete") await store.delete(task.taskId);
              else {
                const edited = await stored(store, task.taskId);
                if (change === "trigger") edited.trigger = { kind: "manual" };
                if (change === "prompt")
                  edited.promptInstructions = "New owner instructions";
                if (change === "output")
                  edited.output = {
                    destination: "channel",
                    target: "new-owner-channel",
                  };
                await save(store, edited);
              }
            }
            return store.upsertIfStatus(task, options);
          },
        };
        await expect(
          reconcileOwnerDossierActivity(interleaved, { nowIso, day }),
        ).rejects.toMatchObject({
          code: "DOSSIER_ACTIVITY_RECONCILIATION_RACED",
          context: { retryable: true },
        });
        const result = await store.get(original.taskId);
        if (change === "delete") expect(result).toBeNull();
        else {
          expect(result?.metadata?.[KEY]).toBeUndefined();
          if (change === "prompt")
            expect(result?.promptInstructions).toBe("New owner instructions");
        }
      },
      30000,
    );
  });
