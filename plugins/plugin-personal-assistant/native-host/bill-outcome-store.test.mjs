import assert from "node:assert/strict";
import fs, {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
    assert.equal(result.reasonCode, "outcome-save-failed");
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
    const listed = createBillOutcomeStore(db, tasks).listForOwner(owner);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].taskId, task.id);
    assert.equal(listed[0].observedAt, result.observedAt);
    assert.equal(listed[0].decision.reference, "TEST-123");
    assert.equal(listed[0].decision.totalMinor, 12250);
    assert.deepEqual(
      createBillOutcomeStore(db, tasks).listForOwner({
        ...owner,
        actorId: "other",
      }),
      [],
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
    const acknowledged = readFileSync(f.journalPath, "utf8");
    appendFileSync(f.journalPath, "corrupt acknowledged record\n");
    const corrupt = readFileSync(f.journalPath, "utf8");
    assert.throws(
      () => createBillOutcomeStore(db, tasks, { journalPath: f.journalPath }),
      /Invalid outcome journal/,
    );
    assert.equal(readFileSync(f.journalPath, "utf8"), corrupt);
    // Repair the fixture, then model a torn, unacknowledged final append.
    writeFileSync(f.journalPath, `${acknowledged}{"partial":`);
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

test("a journaled outcome for a task that no longer exists is dropped at startup", async () => {
  const f = await journalFixture();
  let { db, tasks } = f.first;
  try {
    const owner = f.first.runtime.owner;
    const ownerKey = JSON.stringify([
      owner.agentId,
      owner.actorId,
      owner.connector.source,
      owner.connector.accountId,
    ]);
    const record = (taskId) => ({
      taskId,
      ownerKey,
      record: {
        schemaVersion: 1,
        observationId: "observation",
        observedAt: Date.now(),
        decision: {
          kind: "outcome",
          status: "paid",
          reference: "TEST-9",
          source: "https://example.test/receipt",
          billSource: "mail:test",
          totalMinor: null,
          paymentDate: null,
          currency: null,
          currencyDigits: null,
          company: "Water Test",
        },
      },
    });
    // The person's data was erased but the journal file was left behind.
    writeFileSync(
      f.journalPath,
      `${JSON.stringify(record("erased"))}\n${JSON.stringify(record(f.task.id))}\n`,
    );
    db.close();
    ({ db, tasks } = f.open());
    const runtime = { owner };
    const store = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    });
    const journal = readFileSync(f.journalPath, "utf8");
    assert.equal(journal.includes('"erased"'), false);
    assert.equal(journal.includes(`"${f.task.id}"`), true);
    // The surviving task's own outcome is still recovered.
    assert.equal(
      store.forTask(runtime, f.task.id).loadEvidence().record.decision
        .reference,
      "TEST-9",
    );
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

  for (const rollbackFails of [false, true]) {
    const f = await journalFixture();
    let current = f.first;
    const originalWrite = fs.writeFileSync,
      originalTruncate = fs.ftruncateSync;
    try {
      const store = createBillOutcomeStore(current.db, current.tasks, {
        journalPath: f.journalPath,
      });
      assert.equal(
        store.forTask(current.runtime, f.task.id).save(observed, "observation")
          .saveStatus,
        "saved",
      );
      const acknowledged = readFileSync(f.journalPath, "utf8");
      const next = (id) => {
        let task = current.runtime.create({
          id,
          goalRef: id,
          authorization: {
            decisionId: id,
            policyRevision: "policy",
            state: "active",
            decidedAt: new Date().toISOString(),
            revokedAt: null,
          },
          allowedCapabilities: [],
          allowedOrigins: ["https://example.test"],
        });
        task = current.tasks.transition(
          task.id,
          {
            owner: current.runtime.owner,
            expectedRevision: task.revision,
            now: Date.now(),
          },
          {
            type: "observe",
            observation: {
              id,
              pageId: id,
              origin: "https://example.test",
              version: 1,
              inputRevision: 0,
              observedAt: Date.now(),
            },
          },
        ).task;
        return store.forTask(current.runtime, task.id);
      };
      const second = next("task2");
      // Real file bytes are written before the controlled disk-full error.
      fs.writeFileSync = (fd, data, ...args) => {
        if (
          typeof fd === "number" &&
          typeof data === "string" &&
          data.includes('"ownerKey"')
        ) {
          originalWrite(fd, data.slice(0, 20), ...args);
          throw Object.assign(new Error("Controlled partial append"), {
            code: "ENOSPC",
          });
        }
        return originalWrite(fd, data, ...args);
      };
      if (rollbackFails)
        fs.ftruncateSync = () => {
          throw Object.assign(new Error("Controlled rollback failure"), {
            code: "EIO",
          });
        };
      syncBuiltinESMExports();
      assert.equal(
        second.save({ ...observed, reference: "TEST-10" }, "task2").saveStatus,
        "pending",
      );
      fs.writeFileSync = originalWrite;
      fs.ftruncateSync = originalTruncate;
      syncBuiltinESMExports();
      if (!rollbackFails)
        assert.equal(
          readFileSync(f.journalPath, "utf8"),
          acknowledged,
          "Rollback preserves every acknowledged record",
        );
      assert.equal(second.retry().saveStatus, "saved");
      const third = next("task3");
      const result = third.save({ ...observed, reference: "TEST-11" }, "task3");
      assert.equal(result.saveStatus, rollbackFails ? "pending" : "saved");
      if (rollbackFails) assert.equal(third.retry().saveStatus, "saved");
      current.db.close();
      current = f.open();
      const reopened = createBillOutcomeStore(current.db, current.tasks, {
        journalPath: f.journalPath,
      });
      for (const [id, reference] of [
        [f.task.id, "TEST-9"],
        ["task2", "TEST-10"],
        ["task3", "TEST-11"],
      ]) {
        const evidence = reopened.forTask(current.runtime, id).loadEvidence();
        assert.equal(evidence.persisted, true);
        assert.equal(evidence.record.decision.reference, reference);
      }
      assert.equal(readFileSync(f.journalPath, "utf8"), "");
    } finally {
      fs.writeFileSync = originalWrite;
      fs.ftruncateSync = originalTruncate;
      syncBuiltinESMExports();
      current.db.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
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

test("a submission attempt whose INSERT fails is journaled first and written at the next start", async () => {
  const f = await journalFixture();
  let { db, tasks, runtime } = f.first;
  try {
    const store = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    });
    db.exec(
      "CREATE TRIGGER fail_attempt BEFORE INSERT ON bill_attempts_v1 BEGIN SELECT RAISE(ABORT, 'injected disk write error'); END;",
    );
    const attempt = store.forTask(runtime, f.task.id).recordSubmission(
      {
        kind: "submission-pending",
        source: "https://example.test/payment",
        billSource: "mail:test",
      },
      "observation",
    );
    assert.equal(attempt.billSource, "mail:test");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_attempts_v1").get().n,
      0,
    );
    assert.match(readFileSync(f.journalPath, "utf8"), /"kind":"attempt"/);
    // The process dies here. Nothing reached the database.
    db.exec("DROP TRIGGER fail_attempt");
    db.close();
    ({ db, tasks, runtime } = f.open());
    const recovered = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
    }).forTask(runtime, f.task.id);
    assert.deepEqual(recovered.loadAttempt(), attempt);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_attempts_v1").get().n,
      1,
    );
    // The written attempt leaves the journal at the next start.
    assert.equal(readFileSync(f.journalPath, "utf8"), "");
    // A later task for the same bill sees this attempt as payment history.
    assert.equal(
      recovered.hasPriorPayment({
        sourceRef: "mail:test",
        origin: "https://example.test",
      }),
      false,
      "the same task is not its own prior payment",
    );
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a journal codec stores every record encoded and recovers it after a restart", async () => {
  const f = await journalFixture();
  let { db, tasks, runtime } = f.first;
  // A reversible stand-in for a host cipher: no record text is stored as is.
  const journalCodec = {
    encode: (line) => `sealed:${Buffer.from(line).toString("base64url")}`,
    decode: (line) => {
      if (!line.startsWith("sealed:")) throw new Error("not sealed");
      return Buffer.from(line.slice(7), "base64url").toString();
    },
  };
  try {
    assert.throws(
      () =>
        createBillOutcomeStore(db, tasks, {
          journalPath: f.journalPath,
          journalCodec: { encode: () => "x" },
        }),
      /Invalid outcome journal codec/,
    );
    const store = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
      journalCodec,
    });
    db.exec(
      "CREATE TRIGGER fail_outcome BEFORE INSERT ON bill_outcomes_v1 BEGIN SELECT RAISE(ABORT, 'injected disk write error'); END;",
    );
    assert.equal(
      store.forTask(runtime, f.task.id).save(observed, "observation")
        .saveStatus,
      "pending",
    );
    const stored = readFileSync(f.journalPath, "utf8");
    assert.match(stored, /^sealed:[A-Za-z0-9_-]+\n$/);
    assert.doesNotMatch(stored, /TEST-9|Water Test/);
    db.exec("DROP TRIGGER fail_outcome");
    db.close();
    ({ db, tasks, runtime } = f.open());
    // Without the codec the encoded journal is refused, never misread.
    assert.throws(
      () => createBillOutcomeStore(db, tasks, { journalPath: f.journalPath }),
      /Invalid outcome journal/,
    );
    const recovered = createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
      journalCodec,
    }).forTask(runtime, f.task.id);
    assert.equal(recovered.loadEvidence().record.decision.reference, "TEST-9");
    assert.equal(recovered.retry().saveStatus, "saved");
    db.close();
    ({ db, tasks, runtime } = f.open());
    createBillOutcomeStore(db, tasks, {
      journalPath: f.journalPath,
      journalCodec,
    });
    assert.equal(readFileSync(f.journalPath, "utf8"), "");
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
