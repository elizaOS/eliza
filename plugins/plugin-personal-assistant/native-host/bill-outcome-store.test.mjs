import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildTaskRuntime } from "../test/fixtures/bill-host/runtime.mjs";
import { createBillOutcomeStore } from "./bill-outcome-store.mjs";

test("outcome insert failure and interrupted completion retry storage only and preserve owner isolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bill-outcome-"));
  const bundle = join(directory, "runtime.mjs");
  buildTaskRuntime(bundle);
  const { SqliteInteractiveTaskStore, InteractiveTaskRuntime } = await import(
    pathToFileURL(bundle)
  );
  const db = new DatabaseSync(join(directory, "journal.sqlite"));
  db.exec("PRAGMA synchronous=FULL");
  try {
    const tasks = new SqliteInteractiveTaskStore(db);
    const owner = {
      actorId: "actor",
      agentId: "agent",
      connector: { source: "test", accountId: "account" },
    };
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: tasks,
      actuator: { capabilities: [] },
    });
    let task = runtime.create({
      id: "task",
      goalRef: "bill",
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: [],
      allowedOrigins: ["https://example.test"],
    });
    const observedAt = Date.now();
    task = tasks.transition(
      task.id,
      { owner, expectedRevision: task.revision, now: observedAt },
      {
        type: "observe",
        observation: {
          id: "observation",
          pageId: "page",
          origin: "https://example.test",
          version: 1,
          inputRevision: 0,
          observedAt,
        },
      },
    ).task;
    let failCompletion = true;
    const wrapped = {
      get: (...args) => tasks.get(...args),
      transition: (...args) => {
        if (failCompletion)
          throw new Error("Injected completion write failure");
        return tasks.transition(...args);
      },
    };
    let outcomes = createBillOutcomeStore(db, wrapped).forTask(
      runtime,
      task.id,
    );
    const decision = {
      kind: "outcome",
      status: "paid",
      reference: "TEST-123",
      source: "https://example.test/receipt",
      billSource: "mail:test",
      totalMinor: 12250,
      paymentDate: "2026-10-01",
      currency: "USD",
      currencyDigits: 2,
    };
    db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON bill_outcomes_v1 BEGIN SELECT RAISE(ABORT, 'injected disk write error'); END;",
    );
    let result = outcomes.save(decision, "observation");
    assert.equal(result.status, "paid");
    assert.equal(result.saveStatus, "pending");
    assert.equal(outcomes.loadEvidence().persisted, false);
    assert.equal(outcomes.loadEvidence().record.observedAt, result.observedAt);
    assert.equal(runtime.get(task.id).status, "active");
    db.exec("DROP TRIGGER fail_outcome");
    result = outcomes.retry();
    assert.equal(result.saveStatus, "pending");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_outcomes_v1").get().n,
      1,
    );
    assert.equal(outcomes.loadEvidence().persisted, true);
    const savedDocument = db
      .prepare("SELECT document FROM bill_outcomes_v1 WHERE task_id=?")
      .get(task.id).document;
    const conflict = JSON.parse(savedDocument);
    conflict.observedAt++;
    db.prepare("UPDATE bill_outcomes_v1 SET document=? WHERE task_id=?").run(
      JSON.stringify(conflict),
      task.id,
    );
    assert.equal(outcomes.loadEvidence().persisted, false);
    db.prepare("UPDATE bill_outcomes_v1 SET document=? WHERE task_id=?").run(
      savedDocument,
      task.id,
    );
    // Recreate the host service: the first commit is durable even though completion failed.
    outcomes = createBillOutcomeStore(db, wrapped).forTask(runtime, task.id);
    failCompletion = false;
    result = outcomes.retry();
    assert.equal(result.saveStatus, "saved");
    assert.equal(result.reference, "TEST-123");
    assert.equal(result.totalMinor, 12250);
    assert.equal(result.paymentDate, "2026-10-01");
    assert.equal(runtime.get(task.id).status, "completed");
    assert.equal(runtime.current(), null);
    assert.equal(outcomes.retry().saveStatus, "saved");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_outcomes_v1").get().n,
      1,
    );
    assert.throws(
      () =>
        createBillOutcomeStore(db, tasks)
          .forTask({ owner: { ...owner, actorId: "other" } }, task.id)
          .load(),
      /not owned/,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function journalFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bill-journal-"));
  const bundle = join(directory, "runtime.mjs");
  buildTaskRuntime(bundle);
  const { SqliteInteractiveTaskStore, InteractiveTaskRuntime } = await import(
    pathToFileURL(bundle)
  );
  const file = join(directory, "journal.sqlite");
  const journalPath = join(directory, "outcomes.jsonl");
  const owner = {
    actorId: "actor",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const open = () => {
    const db = new DatabaseSync(file);
    const tasks = new SqliteInteractiveTaskStore(db);
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: tasks,
      actuator: { capabilities: [] },
    });
    return { db, tasks, runtime };
  };
  const first = open();
  let task = first.runtime.create({
    id: "task",
    goalRef: "bill",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: [],
    allowedOrigins: ["https://example.test"],
  });
  const observedAt = Date.now();
  task = first.tasks.transition(
    task.id,
    { owner, expectedRevision: task.revision, now: observedAt },
    {
      type: "observe",
      observation: {
        id: "observation",
        pageId: "page",
        origin: "https://example.test",
        version: 1,
        inputRevision: 0,
        observedAt,
      },
    },
  ).task;
  return { directory, journalPath, open, first, task };
}
const observed = {
  kind: "outcome",
  status: "paid",
  reference: "TEST-9",
  source: "https://example.test/receipt",
  billSource: "mail:test",
  company: "Water Test",
};

test("an outcome whose INSERT fails is journaled first and recovered after a restart", async () => {
  const f = await journalFixture();
  let { db, tasks, runtime } = f.first;
  try {
    const store = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    });
    db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON bill_outcomes_v1 BEGIN SELECT RAISE(ABORT, 'injected disk write error'); END;",
    );
    const result = store
      .forTask(runtime, f.task.id)
      .save(observed, "observation");
    assert.equal(result.saveStatus, "pending");
    assert.equal(result.company, "Water Test");
    assert.match(readFileSync(f.journalPath, "utf8"), /TEST-9/);
    // The process dies here. Nothing reached the database.
    db.exec("DROP TRIGGER fail_outcome");
    db.close();
    ({ db, tasks, runtime } = f.open());
    const recovered = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    }).forTask(runtime, f.task.id);
    const evidence = recovered.loadEvidence();
    assert.equal(evidence.persisted, false);
    assert.equal(evidence.record.decision.reference, "TEST-9");
    assert.equal(evidence.record.decision.company, "Water Test");
    const saved = recovered.retry();
    assert.equal(saved.saveStatus, "saved");
    assert.equal(saved.company, "Water Test");
    assert.equal(recovered.loadEvidence().persisted, true);
    // A later start drops journal entries that the database now holds.
    db.close();
    ({ db, tasks, runtime } = f.open());
    createBillOutcomeStore(db, tasks, { journalPath: f.journalPath });
    assert.equal(readFileSync(f.journalPath, "utf8"), "");
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a failed journal write keeps the outcome pending and asks for a retry", async () => {
  const f = await journalFixture();
  const { db, tasks, runtime } = f.first;
  try {
    const outcomes = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    }).forTask(runtime, f.task.id);
    // A read-only journal makes every append fail.
    chmodSync(f.journalPath, 0o400);
    const result = outcomes.save(observed, "observation");
    assert.equal(result.saveStatus, "pending");
    assert.match(result.message, /do not submit another payment/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_outcomes_v1").get().n,
      0,
    );
    assert.equal(outcomes.retry().saveStatus, "saved");
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("an invalid company is refused before it is stored", async () => {
  const f = await journalFixture();
  const { db, tasks, runtime } = f.first;
  try {
    const outcomes = createBillOutcomeStore(db, tasks).forTask(
      runtime,
      f.task.id,
    );
    assert.throws(
      () => outcomes.save({ ...observed, company: " " }, "observation"),
      /Invalid outcome record/,
    );
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
