import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTaskEvidenceStore } from "./task-evidence-store.mjs";

const owner = {
  agentId: "agent",
  actorId: "actor",
  connector: { source: "app", accountId: "account" },
};
const ownerKey = (value) =>
  JSON.stringify([
    value.agentId,
    value.actorId,
    value.connector.source,
    value.connector.accountId,
  ]);
const event = (eventId, expectedEpoch = 0, value = "yes") => ({
  eventId,
  expectedEpoch,
  value,
});
const validateInput = (value) => {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "eventId,expectedEpoch,value" ||
    !["yes", "no"].includes(value.value)
  )
    throw new Error("invalid product evidence");
  return {
    eventId: value.eventId,
    expectedEpoch: value.expectedEpoch,
    value: value.value,
  };
};
function setup(t, maxEvents = 3) {
  const root = mkdtempSync(join(tmpdir(), "task-evidence-"));
  const file = join(root, "state.sqlite");
  const connections = [];
  t.after(() => {
    for (const db of connections) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const connect = () => {
    const db = new DatabaseSync(file);
    connections.push(db);
    return db;
  };
  const db = connect();
  db.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY, owner_key TEXT, epoch INTEGER)",
  );
  db.prepare("INSERT INTO tasks VALUES (?,?,?)").run(
    "task",
    ownerKey(owner),
    0,
  );
  const storeFor = (connection) =>
    createTaskEvidenceStore(
      connection,
      {
        get: (id, who) =>
          connection
            .prepare("SELECT epoch FROM tasks WHERE id=? AND owner_key=?")
            .get(id, ownerKey(who)),
      },
      {
        table: "fixture_evidence_v1",
        source: "reported",
        validateInput,
        maxEvents,
        now: () => 100,
      },
    );
  return { db, connect, storeFor, scope: storeFor(db).forTask(owner, "task") };
}
test("durable delivery is sequenced, idempotent and epoch fenced across connections", (t) => {
  const { db, connect, storeFor, scope } = setup(t);
  const first = scope.record(event("one"));
  const second = storeFor(connect()).forTask(owner, "task");
  assert.deepEqual(second.record(event("one")), first);
  assert.throws(() => second.record(event("one", 0, "no")));
  db.prepare("UPDATE tasks SET epoch=1").run();
  assert.deepEqual(second.record(event("one")), first);
  assert.throws(() => second.record(event("two")));
  second.record(event("two", 1));
  assert.deepEqual(
    scope.read().map((value) => value.sequence),
    [1, 2],
  );
});
test("ownership is captured and rechecked; another account cannot read or append", (t) => {
  const { db, storeFor, scope } = setup(t);
  scope.record(event("one"));
  const mutable = structuredClone(owner),
    captured = storeFor(db).forTask(mutable, "task");
  mutable.connector.accountId = "other";
  assert.equal(captured.read().length, 1);
  const other = storeFor(db).forTask(mutable, "task");
  assert.throws(() => other.read());
  assert.throws(() => other.record(event("two")));
  db.prepare("UPDATE tasks SET owner_key=?").run(ownerKey(mutable));
  assert.throws(() => scope.read());
  assert.throws(() => scope.record(event("two")));
});
test("limits reject rather than truncate and malformed requests leave no transaction open", (t) => {
  const { db, scope } = setup(t, 1);
  assert.throws(() =>
    scope.record({ ...event("one"), privateText: "forbidden" }),
  );
  scope.record(event("one"));
  assert.throws(() => scope.record(event("two")));
  assert.deepEqual(scope.record(event("one")).eventId, "one");
  assert.equal(scope.read().length, 1);
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
});
test("stored document and SQL envelope disagreement reject without modifying history", (t) => {
  const { db, scope } = setup(t);
  scope.record(event("one"));
  db.prepare("UPDATE fixture_evidence_v1 SET event_id=?").run("mismatch");
  assert.throws(() => scope.read());
  assert.throws(() => scope.record(event("two")));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM fixture_evidence_v1").get().n,
    1,
  );
});
test("failed insertion rolls back and allows later retry without a sequence gap", (t) => {
  const { db, scope } = setup(t);
  db.exec(
    "CREATE TRIGGER fail_insert BEFORE INSERT ON fixture_evidence_v1 BEGIN SELECT RAISE(ABORT, 'controlled failure'); END",
  );
  assert.throws(() => scope.record(event("one")), /controlled failure/);
  db.exec("DROP TRIGGER fail_insert");
  assert.equal(scope.record(event("one")).sequence, 1);
});
test("SQL identifiers and reserved product envelope fields are rejected", (t) => {
  const { db } = setup(t);
  assert.throws(() =>
    createTaskEvidenceStore(
      db,
      {},
      { table: "x; DROP TABLE tasks", source: "reported", validateInput },
    ),
  );
  const store = createTaskEvidenceStore(
    db,
    { get: () => ({ epoch: 0 }) },
    { table: "other", source: "reported", validateInput: (value) => value },
  );
  assert.throws(() =>
    store.forTask(owner, "task").record({ ...event("one"), sequence: 55 }),
  );
});
