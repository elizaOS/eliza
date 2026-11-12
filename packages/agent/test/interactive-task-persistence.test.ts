/** Real SQLite durability and competing-host integration; no provider calls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { InteractiveTaskRuntime } from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";

const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};
const input = {
  id: "task-1",
  goalRef: "goal-1",
  owner,
  now: 1000,
  authorization: {
    decisionId: "grant",
    policyRevision: "policy",
    state: "active" as const,
    decidedAt: new Date(1000).toISOString(),
    revokedAt: null,
  },
  allowedCapabilities: ["fill"],
  allowedOrigins: ["https://example.org"],
};

describe("durable interactive task journal", () => {
  it("arbitrates competing connections, survives reopening, and prevents unknown-outcome replay", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-journal-"));
    const connections: DatabaseSync[] = [];
    const open = () => {
      const connection = new DatabaseSync(join(root, "host.sqlite"));
      connections.push(connection);
      connection.exec("PRAGMA synchronous = FULL");
      return new SqliteInteractiveTaskStore(connection);
    };
    try {
      const first = open();
      const second = open();
      first.create(input);
      expect(() => second.create({ ...input, id: "task-2" })).toThrow(
        /unfinished/,
      );
      expect(second.get(input.id, { ...owner, actorId: "other" })).toBeNull();
      let task = first.transition(
        input.id,
        { owner, expectedRevision: 0, now: 1001 },
        {
          type: "observe",
          observation: {
            id: "view-1",
            pageId: "page-1",
            version: 1,
            inputRevision: 0,
            origin: "https://example.org",
            observedAt: 1001,
          },
        },
      ).task;
      expect(() =>
        second.transition(
          input.id,
          { owner, expectedRevision: 0, now: 1001 },
          { type: "pause" },
        ),
      ).toThrow(/revision/);
      task = first.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1002 },
        {
          type: "prepare",
          proposal: {
            id: "op-1",
            taskId: input.id,
            epoch: 0,
            observationId: "view-1",
            observationVersion: 1,
            inputRevision: 0,
            targetRef: "field-1",
            capability: "fill",
            authorizationId: "grant",
            expiresAt: 5000,
          },
        },
      ).task;
      task = first.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1003 },
        { type: "dispatch", operationId: "op-1" },
      ).task;
      for (const connection of connections.splice(0)) connection.close();
      const restarted = open();
      expect(restarted.get(input.id, owner)?.operations[0].status).toBe(
        "dispatched",
      );
      const recovered = restarted.recoverOwner(owner, 1004);
      expect(recovered).not.toBeNull();
      if (!recovered) throw new Error("Expected the persisted task");
      task = recovered;
      expect(task.operations[0].status).toBe("unknown");
      expect(() =>
        restarted.transition(
          input.id,
          { owner, expectedRevision: task.revision, now: 1005 },
          { type: "dispatch", operationId: "op-1" },
        ),
      ).toThrow();
      expect(restarted.get(input.id, owner)?.revision).toBe(task.revision);
      task = restarted.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1006 },
        { type: "cancel" },
      ).task;
      expect(() => restarted.create({ ...input, id: "task-2" })).toThrow(
        /unfinished/,
      );
      task = restarted.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1007 },
        {
          type: "reconcile",
          operationId: "op-1",
          status: "succeeded",
          evidenceRef: "readback-1",
        },
      ).task;
      expect(task.status).toBe("cancelled");
      expect(
        restarted
          .events(input.id, owner)
          .events.filter((event) => event.operationId !== undefined)
          .map(({ kind, operationId, operationStatus }) => [
            kind,
            operationId,
            operationStatus,
          ]),
      ).toEqual([
        ["prepare", "op-1", "prepared"],
        ["dispatch", "op-1", "dispatched"],
        ["reconcile", "op-1", "succeeded"],
      ]);
      expect(restarted.create({ ...input, id: "task-2" }).id).toBe("task-2");
      expect(() => restarted.create(input)).toThrow(/identity/);
    } finally {
      for (const connection of connections) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("lets the owner release the slot of a revoked task whose outcome stays unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-acknowledge-"));
    const connections: DatabaseSync[] = [];
    let clock = 1000;
    const open = () => {
      const connection = new DatabaseSync(join(root, "host.sqlite"));
      connections.push(connection);
      connection.exec("PRAGMA synchronous = FULL");
      return new InteractiveTaskRuntime({
        owner,
        store: new SqliteInteractiveTaskStore(connection),
        now: () => ++clock,
        actuator: {
          capabilities: ["fill"],
          observe: async () => ({
            id: "view-1",
            pageId: "page-1",
            version: 1,
            inputRevision: 0,
            origin: "https://example.org",
            observedAt: clock,
          }),
          // The reply is lost, so the effect may or may not have happened.
          execute: async () => {
            throw new Error("reply lost");
          },
          reconcile: async () => ({ status: "unknown" }),
        },
      });
    };
    try {
      let runtime = open();
      let task = runtime.create(input);
      task = await runtime.observe(task.id, task.revision);
      task = await runtime.execute(task.id, task.revision, {
        id: "op-1",
        taskId: input.id,
        epoch: task.epoch,
        observationId: "view-1",
        observationVersion: 1,
        inputRevision: 0,
        targetRef: "field-1",
        capability: "fill",
        authorizationId: "grant",
        expiresAt: 1_000_000,
      });
      expect(task.operations[0].status).toBe("unknown");
      // While the authorization is active, readback can still settle the
      // outcome, so the owner cannot release the slot and repeat the effect.
      expect(() => runtime.acknowledgeUnknown(task.id, task.revision)).toThrow(
        expect.objectContaining({ code: "TASK_UNKNOWN_OUTCOME" }),
      );
      expect(runtime.get(task.id).revision).toBe(task.revision);
      expect(() => runtime.create({ ...input, id: "task-2" })).toThrow(
        /unfinished/,
      );
      // Sign-out revokes the task, and readback needs an active authorization.
      task = runtime.control(task.id, task.revision, "revoke");
      await expect(
        runtime.reconcile(task.id, task.revision, "op-1", async () => true),
      ).rejects.toMatchObject({ code: "TASK_NOT_ACTIVE" });
      expect(() => runtime.create({ ...input, id: "task-2" })).toThrow(
        /unfinished/,
      );
      for (const connection of connections.splice(0)) connection.close();
      runtime = open();
      task = runtime.get(input.id);
      expect(() => runtime.create({ ...input, id: "task-2" })).toThrow(
        /unfinished/,
      );
      expect(() =>
        runtime.acknowledgeUnknown(task.id, task.revision - 1),
      ).toThrow(expect.objectContaining({ code: "TASK_CONFLICT" }));
      const acknowledged = runtime.acknowledgeUnknown(task.id, task.revision);
      await runtime.settle(task.id);
      // The outcome stays visibly unknown; nothing records success or failure.
      expect(acknowledged.status).toBe("cancelled");
      expect(acknowledged.operations[0]).toEqual({
        proposal: expect.objectContaining({ id: "op-1" }),
        status: "unknown",
      });
      expect(runtime.current()).toBeNull();
      expect(() =>
        runtime.acknowledgeUnknown(task.id, acknowledged.revision),
      ).toThrow(expect.objectContaining({ code: "TASK_REPLAY" }));
      for (const connection of connections.splice(0)) connection.close();
      runtime = open();
      expect(runtime.get(input.id).operations[0].status).toBe("unknown");
      // The history shows who accepted the unknown outcome and when.
      expect(runtime.events(input.id).acknowledgements).toEqual([
        { operationId: "op-1", acknowledgedAt: expect.any(Number) },
      ]);
      expect(runtime.create({ ...input, id: "task-2" }).id).toBe("task-2");
      // A later sign-out revokes the ended task again; the acknowledged
      // operation does not take the slot back from the new task.
      const ended = runtime.get(input.id);
      runtime.control(input.id, ended.revision, "revoke");
      await runtime.settle(input.id);
      expect(runtime.current()?.id).toBe("task-2");
    } finally {
      for (const connection of connections) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("sets aside a record another version wrote and keeps the host up", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-unreadable-"));
    const connections: DatabaseSync[] = [];
    const open = () => {
      const connection = new DatabaseSync(join(root, "host.sqlite"));
      connections.push(connection);
      connection.exec("PRAGMA synchronous = FULL");
      return connection;
    };
    const runtimeOn = (connection: DatabaseSync) =>
      new InteractiveTaskRuntime({
        owner,
        store: new SqliteInteractiveTaskStore(connection),
        now: () => 2000,
        actuator: {
          capabilities: ["fill"],
          observe: async () => {
            throw new Error("not used");
          },
          execute: async () => {
            throw new Error("not used");
          },
        },
      });
    try {
      const store = new SqliteInteractiveTaskStore(open());
      store.create({ ...input, id: "task-done" });
      store.transition(
        "task-done",
        { owner, expectedRevision: 0, now: 1001 },
        { type: "cancel" },
      );
      store.create(input);
      // A different build wrote the unfinished record with a field this one
      // does not know.
      const written = store.get(input.id, owner);
      const document = JSON.stringify({ ...written, laterField: true });
      connections[0]
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
        )
        .run(document, input.id);
      for (const connection of connections.splice(0)) connection.close();

      const runtime = runtimeOn(open());
      expect(runtime.current()).toBeNull();
      expect(runtime.unreadable()).toEqual([
        {
          taskId: input.id,
          reason: "Unexpected task record fields",
          quarantinedAt: 2000,
          acknowledgedAt: null,
        },
      ]);
      expect(() => runtime.get(input.id)).toThrow(
        expect.objectContaining({ code: "TASK_UNREADABLE" }),
      );
      expect(runtime.get("task-done").status).toBe("cancelled");
      // The record still holds the slot until the owner releases it.
      expect(() => runtime.create({ ...input, id: "task-2" })).toThrow(
        expect.objectContaining({ code: "TASK_UNREADABLE" }),
      );
      expect(runtime.acknowledgeUnreadable(input.id)[0].acknowledgedAt).toBe(
        2000,
      );
      expect(() => runtime.acknowledgeUnreadable(input.id)).toThrow(
        expect.objectContaining({ code: "TASK_NOT_FOUND" }),
      );
      expect(runtime.create({ ...input, id: "task-2" }).id).toBe("task-2");
      // The record itself is kept as it was written.
      const kept = connections[0]
        .prepare(
          "SELECT document FROM interactive_task_journal_v1 WHERE id = ?",
        )
        .get(input.id) as { document: string };
      expect(kept.document).toBe(document);
      // A torn record is still corruption, not a version difference.
      connections[0]
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = '{' WHERE id = ?",
        )
        .run("task-2");
      expect(() => runtimeOn(open())).toThrow(
        expect.objectContaining({ code: "TASK_STORAGE_CORRUPT" }),
      );
    } finally {
      for (const connection of connections) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads a long journal in pages when it sets records aside", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-paged-recovery-"));
    const connection = new DatabaseSync(join(root, "host.sqlite"));
    connection.exec("PRAGMA synchronous = FULL");
    try {
      let store = new SqliteInteractiveTaskStore(connection);
      const history = 150;
      for (let i = 0; i < history; i++) {
        const id = `task-${String(i).padStart(4, "0")}`;
        store.create({ ...input, id });
        store.transition(
          id,
          { owner, expectedRevision: 0, now: 1001 },
          { type: "cancel" },
        );
      }
      const last = store.create({ ...input, id: "task-9999" });
      connection
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
        )
        .run(JSON.stringify({ ...last, laterField: true }), last.id);
      // The largest set of journal rows recovery holds at once.
      let largest = 0;
      store = new SqliteInteractiveTaskStore({
        exec: (sql) => connection.exec(sql),
        prepare: (sql) => {
          const statement = connection.prepare(sql);
          return {
            get: (...parameters) => {
              const row = statement.get(...parameters) as
                | { rows?: unknown }
                | undefined;
              if (typeof row?.rows === "string")
                largest = Math.max(largest, JSON.parse(row.rows).length);
              return row;
            },
            run: (...parameters) => statement.run(...parameters),
          };
        },
      });
      expect(store.recoverOwner(owner, 2000)).toBeNull();
      expect(store.unreadable(owner).map((record) => record.taskId)).toEqual([
        last.id,
      ]);
      expect(largest).toBeGreaterThan(0);
      expect(largest).toBeLessThanOrEqual(64);
    } finally {
      connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reads a set-aside record again once a build can read it", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-readable-again-"));
    const connections: DatabaseSync[] = [];
    const open = () => {
      const connection = new DatabaseSync(join(root, "host.sqlite"));
      connections.push(connection);
      connection.exec("PRAGMA synchronous = FULL");
      return new SqliteInteractiveTaskStore(connection);
    };
    try {
      let store = open();
      const written = store.create(input);
      const original = JSON.stringify(written);
      // A newer build wrote the record, then the device rolled back.
      connections[0]
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
        )
        .run(JSON.stringify({ ...written, laterField: true }), input.id);
      store = open();
      expect(store.recoverOwner(owner, 2000)).toBeNull();
      expect(store.unreadable(owner)).toHaveLength(1);
      // The newer build returns, and the record reads again.
      connections[0]
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
        )
        .run(original, input.id);
      store = open();
      const recovered = store.recoverOwner(owner, 3000);
      expect(recovered).toMatchObject({ id: input.id, status: "paused" });
      expect(store.unreadable(owner)).toEqual([]);
      expect(store.get(input.id, owner)?.status).toBe("paused");
      // It holds the slot as an ordinary unfinished task again.
      expect(() => store.create({ ...input, id: "task-2" })).toThrow(
        expect.objectContaining({ code: "TASK_CONFLICT" }),
      );
    } finally {
      for (const connection of connections) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("recovers a stored dispatched operation whose plan no longer matches the task", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-task-stale-dispatch-"));
    const connections: DatabaseSync[] = [];
    const open = () => {
      const connection = new DatabaseSync(join(root, "host.sqlite"));
      connections.push(connection);
      connection.exec("PRAGMA synchronous = FULL");
      return { connection, store: new SqliteInteractiveTaskStore(connection) };
    };
    try {
      const { connection, store } = open();
      store.create(input);
      let task = store.transition(
        input.id,
        { owner, expectedRevision: 0, now: 1001 },
        {
          type: "observe",
          observation: {
            id: "view-1",
            pageId: "page-1",
            version: 1,
            inputRevision: 0,
            origin: "https://example.org",
            observedAt: 1001,
          },
        },
      ).task;
      task = store.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1002 },
        {
          type: "prepare",
          proposal: {
            id: "op-1",
            taskId: input.id,
            epoch: 0,
            observationId: "view-1",
            observationVersion: 1,
            inputRevision: 0,
            targetRef: "field-1",
            capability: "fill",
            authorizationId: "grant",
            expiresAt: 5000,
          },
        },
      ).task;
      task = store.transition(
        input.id,
        { owner, expectedRevision: task.revision, now: 1003 },
        { type: "dispatch", operationId: "op-1" },
      ).task;
      // A row written by another build or by hand: the effect may already have
      // happened, so the stale plan must still load and recover to unknown.
      const stale = structuredClone(task);
      stale.operations[0].proposal.authorizationId = "grant-old";
      stale.operations[0].proposal.observationId = "view-0";
      connection
        .prepare(
          "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
        )
        .run(JSON.stringify(stale), input.id);
      for (const each of connections.splice(0)) each.close();
      const restarted = open().store;
      const recovered = restarted.recoverOwner(owner, 1004);
      if (!recovered) throw new Error("Expected the persisted task");
      expect(recovered.operations[0].status).toBe("unknown");
      expect(recovered.status).toBe("paused");
      const cancelled = restarted.transition(
        input.id,
        { owner, expectedRevision: recovered.revision, now: 1005 },
        { type: "cancel" },
      ).task;
      expect(cancelled.status).toBe("cancelled");
    } finally {
      for (const connection of connections) connection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-durable host configuration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA synchronous = OFF");
      expect(() => new SqliteInteractiveTaskStore(db)).toThrow(
        /synchronization/,
      );
    } finally {
      db.close();
    }
  });
});

describe("durable task event history", () => {
  it("commits events with checkpoints, pages without dropping history, and rejects missing or foreign records", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-task-events-"));
    const db = new DatabaseSync(join(directory, "events.sqlite"));
    db.exec("PRAGMA synchronous=FULL");
    try {
      let store = new SqliteInteractiveTaskStore(db);
      let task = store.create(input);
      for (let n = 1; n <= 130; n++)
        task = store.transition(
          task.id,
          { owner, expectedRevision: task.revision, now: 1000 + n },
          {
            type: "observe",
            observation: {
              id: `observation-${n}`,
              pageId: "page",
              origin: "https://example.org",
              version: n,
              inputRevision: n,
              observedAt: 1000 + n,
            },
          },
        ).task;
      const first = store.events(task.id, owner);
      expect(first.events).toHaveLength(128);
      expect(first.events[0].kind).toBe("create");
      expect(first.cursor).toBe(127);
      expect(first.hasMore).toBe(true);
      const second = store.events(task.id, owner, first.cursor);
      expect(second.events.map((event) => event.sequence)).toEqual([
        128, 129, 130,
      ]);
      expect(second.hasMore).toBe(false);
      expect(store.events(task.id, owner, second.cursor).events).toEqual([]);
      expect(() =>
        store.events(task.id, { ...owner, actorId: "foreign" }),
      ).toThrow(/not found/);
      expect(() => store.events(task.id, owner, 1000)).toThrow(/ahead/);
      db.exec(
        "CREATE TRIGGER fail_event BEFORE INSERT ON interactive_task_events_v1 BEGIN SELECT RAISE(ABORT, 'injected event write failure'); END;",
      );
      expect(() =>
        store.transition(
          task.id,
          { owner, expectedRevision: task.revision, now: 2000 },
          { type: "pause" },
        ),
      ).toThrow(/injected/);
      expect(store.get(task.id, owner)?.revision).toBe(130);
      expect(store.get(task.id, owner)?.status).toBe("active");
      db.exec("DROP TRIGGER fail_event");
      // A pre-event database has a checkpoint but no event rows. Upgrading it
      // must disclose missing history rather than invent a creation sequence.
      db.exec("DELETE FROM interactive_task_events_v1");
      store = new SqliteInteractiveTaskStore(db);
      const migrated = store.events(task.id, owner);
      expect(
        migrated.events.map((event) => [event.kind, event.sequence]),
      ).toEqual([["checkpoint", 130]]);
      const recovered = store.recoverOwner(owner, 2001);
      if (!recovered) throw new Error("Expected recovered task");
      task = recovered;
      expect(store.events(task.id, owner, 130).events[0].kind).toBe("recover");
      db.prepare("DELETE FROM interactive_task_events_v1 WHERE sequence=?").run(
        task.revision,
      );
      expect(() => store.events(task.id, owner)).toThrow(/incomplete/);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
