import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTraceEvent } from "./research-store.mjs";
import { openTraceQueue as openQueue } from "./trace-queue.mjs";

const openTraceQueue = (options) =>
  openQueue({ ...options, validateEvent: validateTraceEvent });

import { createTaskTraceCapture as createPilotTaskCapture } from "./task-trace-capture.mjs";

test("journal capture is consent and owner scoped, pseudonymous and restart durable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-journal-")),
    key = randomBytes(32),
    pseudonymKey = randomBytes(32),
    path = join(dir, "queue");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let queue = openTraceQueue({ path, key });
  const owner = {
      agentId: "agent-secret",
      actorId: "account-secret",
      connector: { source: "source", accountId: "account-secret" },
    },
    ownerKey = JSON.stringify([
      "agent-secret",
      "account-secret",
      "source",
      "account-secret",
    ]);
  let current = true;
  let consent = {
    participantId: "participant",
    deviceId: "device",
    authorizedAt: 10,
    status: "active",
    changes: [
      { at: 20, status: "paused" },
      { at: 40, status: "active" },
    ],
    omittedControlCount: 0,
  };
  const events = [
    { sequence: 0, at: 5, kind: "create", text: "password do-not-copy" },
    { sequence: 1, at: 15, kind: "resume", amount: 999 },
    { sequence: 2, at: 30, kind: "pause" },
    { sequence: 3, at: 45, kind: "complete" },
  ];
  const db = {
      prepare: () => ({
        all: (who) => {
          assert.equal(who, ownerKey);
          return [{ id: "raw-task-secret" }];
        },
      }),
    },
    tasks = {
      events: (_id, who, cursor) => {
        assert.equal(who, owner);
        const found = events.filter((e) => e.sequence > cursor);
        return {
          events: found,
          cursor: found.at(-1)?.sequence ?? cursor,
          hasMore: false,
        };
      },
    };
  const make = () =>
    createPilotTaskCapture({
      db,
      tasks,
      owner,
      queue,
      participantId: "participant",
      deviceId: "device",
      pseudonymKey,
      captureState: async () => consent,
      isCurrentOwner: () => current,
    });
  assert.deepEqual(await make().collect(), {
    captured: 2,
    excluded: 2,
    hasMore: false,
  });
  let uploaded;
  await queue.flush(async (batch) => {
    uploaded = batch;
    return { durable: true, accepted: batch.map((e) => e.eventId) };
  });
  const serialized = JSON.stringify(uploaded);
  for (const secret of ["account-secret", "raw-task-secret", "password"])
    assert.equal(serialized.includes(secret), false);
  assert.equal(uploaded[0].amount, undefined);
  assert.deepEqual(
    uploaded.map((e) => e.sequence),
    [2, 4],
  );
  assert.equal(uploaded[0].monotonicMs, null);
  assert.equal(uploaded[1].status, "completed");
  queue.close();
  queue = openTraceQueue({ path, key });
  assert.equal((await make().collect()).captured, 0);
  current = false;
  await assert.rejects(make().collect(), /owner changed/);
  current = true;
  consent = { ...consent, status: "withdrawn" };
  assert.deepEqual(await make().collect(), { withdrawn: true });
  assert.equal(queue.status().queued, 0);
  queue.close();
});

test("an owner with more than a thousand journaled tasks is still captured", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "pilot-journal-many-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const queue = openTraceQueue({
    path: join(dir, "queue"),
    key: randomBytes(32),
  });
  t.after(() => queue.close());
  const owner = {
    agentId: "agent",
    actorId: "account",
    connector: { source: "source", accountId: "account" },
  };
  const ownerKey = JSON.stringify(["agent", "account", "source", "account"]);
  // The real journal table: every task an owner ever ran stays in it.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE interactive_task_journal_v1 (id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL, unfinished INTEGER NOT NULL, document TEXT NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO interactive_task_journal_v1 VALUES (?, ?, 0, '{}')",
  );
  const taskCount = 1001;
  for (let i = 0; i < taskCount; i++)
    insert.run(`task-${String(i).padStart(5, "0")}`, ownerKey);
  const tasks = {
    events: (_id, _who, cursor) =>
      cursor >= 0
        ? { events: [], cursor, hasMore: false }
        : {
            events: [{ sequence: 0, at: 50, kind: "create" }],
            cursor: 0,
            hasMore: false,
          },
  };
  const capture = createPilotTaskCapture({
    db,
    tasks,
    owner,
    queue,
    participantId: "participant",
    deviceId: "device",
    pseudonymKey: randomBytes(32),
    captureState: async () => ({
      participantId: "participant",
      deviceId: "device",
      authorizedAt: 10,
      status: "active",
      changes: [],
      omittedControlCount: 0,
    }),
    isCurrentOwner: () => true,
  });
  assert.deepEqual(await capture.collect(), {
    captured: taskCount,
    excluded: 0,
    hasMore: false,
  });
  // A second pass finds every task already checkpointed.
  assert.equal((await capture.collect()).captured, 0);
});
