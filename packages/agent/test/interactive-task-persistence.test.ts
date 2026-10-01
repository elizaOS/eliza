/** Real SQLite durability and competing-host integration; no provider calls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
      expect(restarted.create({ ...input, id: "task-2" }).id).toBe("task-2");
      expect(() => restarted.create(input)).toThrow(/identity/);
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
