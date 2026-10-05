import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
