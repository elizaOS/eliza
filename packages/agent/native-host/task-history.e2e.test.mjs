import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { buildTaskRuntime } from "../../app/scripts/build-consumer-task-runtime.mjs";

const root = mkdtempSync(join(tmpdir(), "history-runtime-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sourceRoot = resolve(import.meta.dirname, "../../..");
const bundle = join(root, "runtime.mjs");
buildTaskRuntime(bundle, {
  sourceRoot,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim(),
});
const { SqliteInteractiveTaskStore } = await import(pathToFileURL(bundle));
const owner = {
  agentId: "agent",
  actorId: "actor",
  connector: { source: "app", accountId: "account" },
};
const limits = { maxTasks: 10, maxEvents: 1000 };
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "task-history-"));
  const file = join(directory, "db.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA synchronous=FULL");
  const tasks = new SqliteInteractiveTaskStore(db);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (id = "task", who = owner) =>
    tasks.create({
      id,
      owner: who,
      goalRef: "report",
      now: 1000,
      authorization: {
        decisionId: "grant",
        policyRevision: "v1",
        state: "active",
        decidedAt: new Date(1000).toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: [],
      allowedOrigins: ["https://example.test"],
    });
  return { db, tasks, create, file };
}
test("complete owner history spans pages and completed tasks without truncation", (t) => {
  const { tasks, create } = setup(t);
  let task = create();
  for (let i = 0; i < 160; i++)
    task = tasks.transition(
      task.id,
      { owner, expectedRevision: task.revision, now: 1001 + i },
      i % 2
        ? {
            type: "resume",
            observation: {
              id: `view-${i}`,
              pageId: "page",
              version: i + 1,
              inputRevision: 0,
              origin: "https://example.test",
              observedAt: 1001 + i,
            },
          }
        : { type: "pause" },
    ).task;
  tasks.transition(
    task.id,
    { owner, expectedRevision: task.revision, now: 1200 },
    { type: "cancel" },
  );
  create("second");
  create("hidden", { ...owner, actorId: "other" });
  const result = tasks.readOwnerHistory(owner, limits, (rows) =>
    rows.map((row) => ({
      id: row.task.id,
      count: row.events.length,
      last: row.events.at(-1).sequence,
    })),
  );
  assert.deepEqual(result, [
    { id: "second", count: 1, last: 0 },
    { id: "task", count: 162, last: 161 },
  ]);
  assert.throws(
    () =>
      tasks.readOwnerHistory(
        owner,
        { maxTasks: 1, maxEvents: 1000 },
        () => null,
      ),
    /limit/,
  );
  assert.throws(
    () =>
      tasks.readOwnerHistory(
        owner,
        { maxTasks: 10, maxEvents: 162 },
        () => null,
      ),
    /limit/,
  );
  assert.deepEqual(
    tasks.readOwnerHistory(
      { ...owner, actorId: "absent" },
      limits,
      (rows) => rows,
    ),
    [],
  );
});
test("projection refuses writes through this connection and asynchronous publication", (t) => {
  const { tasks, create, db } = setup(t);
  create();
  assert.throws(
    () =>
      tasks.readOwnerHistory(owner, limits, () => {
        db.exec("CREATE TABLE unexpected (id INTEGER)");
        return 1;
      }),
    /changed/,
  );
  assert.throws(
    () =>
      tasks.readOwnerHistory(owner, limits, () => {
        db.exec("INSERT INTO unexpected VALUES (1)");
        return 1;
      }),
    /changed/,
  );
  assert.throws(
    () => tasks.readOwnerHistory(owner, limits, () => Promise.resolve(1)),
    /synchronous/,
  );
  assert.throws(
    () =>
      tasks.readOwnerHistory(owner, { ...limits, maxEvents: 0 }, () => null),
    /limits/,
  );
});
test("external commits invalidate projections but a subsequent fresh read succeeds", (t) => {
  const { tasks, create, file } = setup(t);
  create();
  const external = new DatabaseSync(file);
  try {
    assert.throws(
      () =>
        tasks.readOwnerHistory(owner, limits, () => {
          external.exec("CREATE TABLE external_change (id INTEGER)");
          return 1;
        }),
      /changed/,
    );
    assert.equal(
      tasks.readOwnerHistory(owner, limits, (rows) => rows.length),
      1,
    );
  } finally {
    external.close();
  }
});
test("a revision change between real pages is rejected before projection", (t) => {
  const { tasks, create, file } = setup(t);
  let task = create();
  for (let i = 0; i < 130; i++)
    task = tasks.transition(
      task.id,
      { owner, expectedRevision: task.revision, now: 1001 + i },
      i % 2
        ? {
            type: "resume",
            observation: {
              id: `view-${i}`,
              pageId: "page",
              version: i + 1,
              inputRevision: 0,
              origin: "https://example.test",
              observedAt: 1001 + i,
            },
          }
        : { type: "pause" },
    ).task;
  const external = new DatabaseSync(file),
    other = new SqliteInteractiveTaskStore(external);
  const read = tasks.events.bind(tasks);
  let changed = false,
    projected = false;
  tasks.events = (...args) => {
    const page = read(...args);
    if (!changed) {
      changed = true;
      other.transition(
        task.id,
        { owner, expectedRevision: task.revision, now: 2000 },
        { type: "pause" },
      );
    }
    return page;
  };
  try {
    assert.throws(
      () =>
        tasks.readOwnerHistory(owner, limits, () => {
          projected = true;
        }),
      /changed/,
    );
    assert.equal(projected, false);
  } finally {
    external.close();
  }
});
test("corrupt persisted history is rejected by the existing page validator", (t) => {
  const { tasks, create, db } = setup(t);
  const task = create();
  tasks.transition(
    task.id,
    { owner, expectedRevision: 0, now: 1001 },
    { type: "pause" },
  );
  db.exec("DELETE FROM interactive_task_events_v1 WHERE sequence=0");
  assert.throws(() => tasks.readOwnerHistory(owner, limits, () => 1), /gap/);
});
