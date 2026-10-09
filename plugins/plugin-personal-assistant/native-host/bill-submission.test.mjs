import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  controls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { createBillOutcomeStore } from "./bill-outcome-store.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";

const bill = {
  sourceRef: "mail:test",
  origin: "https://biller.example",
  company: "Power",
  accountLabel: "1234",
  amountMinor: 12000,
  currency: "USD",
  currencyDigits: 2,
};
const facts = {
  Environment: "Controlled test biller",
  Company: "Power",
  Session: "Signed in",
  Verification: "Not required",
  Account: "1234",
  "Bill amount": "USD 120.00",
  "Payment status": "Processing",
};
const snapshot = (changes) => ({
  url: bill.origin + "/bill?private=value#secret",
  elements: [],
  text: Object.entries({ ...facts, ...changes })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n"),
});
test("observed processing survives database reopen and prevents renewed preparation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bill-submission-"));
  const file = join(dir, "db");
  let db = new DatabaseSync(file);
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = {
    id: "task",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  };
  const tasks = {
    get: (_id, who) => (who.actorId === owner.actorId ? task : null),
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  let current = snapshot();
  let cleared = 0;
  const actuator = {
    readObservation: () => ({
      observation: task.observation,
      snapshot: current,
    }),
    quiesce: async () => {
      cleared++;
    },
  };
  try {
    let outcomes = createBillOutcomeStore(db, tasks).forTask(runtime, task.id);
    const make = () =>
      new BillWorkflow({
        deriveBillDecision,
        controls,
        runtime,
        actuator,
        bill,
        taskId: task.id,
        outcomes,
      });
    assert.equal((await make().refresh()).kind, "submission-pending");
    const first = outcomes.loadAttempt();
    assert.equal(first.source, bill.origin + "/bill");
    assert.equal((await make().refresh()).kind, "submission-pending");
    assert.equal(outcomes.loadAttempt().attemptId, first.attemptId);
    db.close();
    db = new DatabaseSync(file);
    outcomes = createBillOutcomeStore(db, tasks).forTask(runtime, task.id);
    assert.deepEqual(outcomes.loadAttempt(), first);
    current = snapshot({
      "Payment status": "Unpaid",
      Autopay: "Off",
      "Existing method": "Visa ending 4242",
      Fee: "USD 0.00",
      Total: "USD 120.00",
      "Payment date": "2026-10-01",
      "Method selected": "No",
    });
    assert.equal(
      deriveBillDecision(bill, current).kind,
      "choose-existing-method",
    );
    assert.equal((await make().refresh()).kind, "unknown-outcome");
    assert.equal(
      (await make().chooseExistingMethod("stale-review")).kind,
      "unknown-outcome",
    );
    runtime.observe = async () => {
      throw new Error("network lost");
    };
    assert.equal((await make().refresh()).kind, "unknown-outcome");
    assert.throws(
      () =>
        createBillOutcomeStore(db, tasks)
          .forTask({ owner: { ...owner, actorId: "other" } }, task.id)
          .loadAttempt(),
      /not owned/,
    );
    runtime.observe = async () => {};
    current = snapshot({ "Payment status": "Paid", Confirmation: "TEST-1" });
    outcomes.save = (decision) => decision;
    assert.equal((await make().refresh()).kind, "outcome");
    assert.ok(cleared >= 5);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("submission persistence rejects stale evidence and retains a failed write in this process", () => {
  const db = new DatabaseSync(":memory:");
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = {
    allowedOrigins: [bill.origin],
    observation: { id: "current" },
  };
  const outcomes = createBillOutcomeStore(db, { get: () => task }).forTask(
    { owner },
    "task",
  );
  const decision = deriveBillDecision(bill, snapshot());
  try {
    assert.throws(
      () => outcomes.recordSubmission(decision, "stale"),
      /current scoped/,
    );
    assert.equal(outcomes.loadAttempt(), null);
    db.exec(
      "CREATE TRIGGER fail_attempt BEFORE INSERT ON bill_attempts_v1 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
    );
    assert.throws(
      () => outcomes.recordSubmission(decision, "current"),
      /disk failure/,
    );
    const id = outcomes.loadAttempt().attemptId;
    db.exec("DROP TRIGGER fail_attempt");
    assert.equal(outcomes.recordSubmission(decision, "current").attemptId, id);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM bill_attempts_v1").get().n,
      1,
    );
    db.prepare("UPDATE bill_attempts_v1 SET document=?").run("null");
    assert.throws(() => outcomes.loadAttempt(), /Invalid submission record/);
  } finally {
    db.close();
  }
});

test("a replacement task retains same-owner bill history across restart and separates other bills and accounts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bill-prior-"));
  const file = join(dir, "db");
  let db = new DatabaseSync(file);
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = (id) => ({
    id,
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  });
  const tasks = { get: (id) => task(id) };
  const runtime = {
    owner,
    get: () => task("replacement"),
    observe: async () => {},
  };
  let current = snapshot({
    "Payment status": "Unpaid",
    Autopay: "Off",
    "Existing method": "Visa ending 4242",
    Fee: "USD 0.00",
    Total: "USD 120.00",
    "Payment date": "2026-10-01",
    "Method selected": "No",
  });
  const actuator = {
    readObservation: () => ({
      observation: { id: "observed" },
      snapshot: current,
    }),
    quiesce: async () => {},
  };
  try {
    let store = createBillOutcomeStore(db, tasks);
    const old = store.forTask({ owner }, "old");
    const pending = deriveBillDecision(bill, snapshot());
    db.exec(
      "CREATE TRIGGER fail_attempt BEFORE INSERT ON bill_attempts_v1 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
    );
    assert.throws(
      () => old.recordSubmission(pending, "observed"),
      /disk failure/,
    );
    assert.equal(
      store.forTask(runtime, "replacement").hasPriorPayment(bill),
      true,
      "pending writes also carry history across tasks",
    );
    db.exec("DROP TRIGGER fail_attempt");
    old.recordSubmission(pending, "observed");
    db.close();
    db = new DatabaseSync(file);
    store = createBillOutcomeStore(db, tasks);
    const outcomes = store.forTask(runtime, "replacement");
    const workflow = new BillWorkflow({
      deriveBillDecision,
      controls,
      runtime,
      actuator,
      bill,
      taskId: "replacement",
      outcomes,
    });
    assert.equal((await workflow.refresh()).kind, "unknown-outcome");
    assert.equal(
      (await workflow.chooseExistingMethod("stale")).kind,
      "unknown-outcome",
    );
    assert.equal(
      outcomes.hasPriorPayment({ ...bill, sourceRef: "mail:other-bill" }),
      false,
    );
    assert.equal(
      outcomes.hasPriorPayment({ ...bill, origin: "https://other.example" }),
      false,
    );
    assert.equal(
      store
        .forTask({ owner: { ...owner, actorId: "b" } }, "replacement")
        .hasPriorPayment(bill),
      false,
    );
    assert.equal(
      store
        .forTask(
          {
            owner: {
              ...owner,
              connector: { source: "test", accountId: "other" },
            },
          },
          "replacement",
        )
        .hasPriorPayment(bill),
      false,
    );
    runtime.observe = async () => {
      throw new Error("network lost");
    };
    assert.equal((await workflow.refresh()).kind, "unknown-outcome");
    runtime.observe = async () => {};
    current = snapshot({ "Payment status": "Paid", Confirmation: "TEST-1" });
    outcomes.save = (decision) => decision;
    assert.equal(
      (await workflow.refresh()).kind,
      "outcome",
      "fresh matched outcome remains observable",
    );
    // A direct confirmed outcome also prevents a new preparation without requiring
    // an intermediate Processing observation.
    const receipt = {
      schemaVersion: 1,
      observationId: "observed",
      observedAt: Date.now(),
      decision: {
        kind: "outcome",
        status: "paid",
        reference: "TEST-2",
        source: bill.origin + "/receipt",
        billSource: "mail:receipt-only",
      },
    };
    const ownerKey = JSON.stringify([
      owner.agentId,
      owner.actorId,
      owner.connector.source,
      owner.connector.accountId,
    ]);
    db.prepare("INSERT INTO bill_outcomes_v1 VALUES (?,?,?)").run(
      "receipt-task",
      ownerKey,
      JSON.stringify(receipt),
    );
    assert.equal(
      outcomes.hasPriorPayment({ ...bill, sourceRef: "mail:receipt-only" }),
      true,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only activity after this document payment review creates uncertainty, never a paid result", async () => {
  const db = new DatabaseSync(":memory:");
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = {
    id: "task",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  const store = createBillOutcomeStore(db, { get: () => task });
  const outcomes = store.forTask(runtime, task.id);
  const current = {
    ...snapshot({
      "Payment status": "Unpaid",
      Autopay: "Off",
      "Existing method": "Visa ending 4242",
      Fee: "USD 0.00",
      Total: "USD 120.00",
      "Payment date": "2026-10-01",
      "Method selected": "Yes",
    }),
    documentId: "document",
    inputRevision: 1,
  };
  const workflow = new BillWorkflow({
    deriveBillDecision,
    controls,
    runtime,
    bill,
    taskId: task.id,
    outcomes,
    actuator: {
      readObservation: () => ({
        observation: task.observation,
        snapshot: current,
      }),
      quiesce: async () => {},
    },
  });
  try {
    assert.equal((await workflow.refresh()).kind, "human-submit");
    const review = outcomes.loadReview();
    assert.equal(review.review.method, "Visa ending 4242");
    assert.equal(review.source, bill.origin + "/bill");
    const event = {
      kind: "form-submit",
      origin: bill.origin,
      documentId: "document",
      epoch: 1,
      observedAt: review.observedAt + 1,
    };
    for (const wrong of [
      { ...event, epoch: 0 },
      { ...event, documentId: "login-page" },
      { ...event, origin: "https://other.example" },
      { ...event, observedAt: review.observedAt - 1 },
    ]) {
      current.manualActivity = {
        events: [wrong],
        overflow: false,
        captureGap: false,
      };
      assert.equal((await workflow.refresh()).kind, "human-submit");
      assert.equal(outcomes.loadAttempt(), null);
    }
    current.manualActivity = {
      events: [event],
      overflow: false,
      captureGap: false,
    };
    assert.equal((await workflow.refresh()).kind, "unknown-outcome");
    assert.equal(outcomes.loadAttempt().evidenceKind, "manual-activity");
    assert.equal(outcomes.loadAttempt().review.totalMinor, 12000);
    assert.equal(outcomes.load(), null, "a submit event is not an outcome");
    current.manualActivity = { events: [], overflow: false, captureGap: false };
    assert.equal(
      (await workflow.refresh()).kind,
      "unknown-outcome",
      "removing the event cannot erase persisted uncertainty",
    );
  } finally {
    db.close();
  }
});

test("invalid stored review and failed review write clear guidance without offering preparation", async () => {
  const db = new DatabaseSync(":memory:");
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = {
    id: "task",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  const outcomes = createBillOutcomeStore(db, { get: () => task }).forTask(
    runtime,
    task.id,
  );
  const current = {
    ...snapshot({
      "Payment status": "Unpaid",
      Autopay: "Off",
      "Existing method": "Visa ending 4242",
      Fee: "USD 0.00",
      Total: "USD 120.00",
      "Payment date": "2026-10-01",
      "Method selected": "Yes",
    }),
    documentId: "document",
    inputRevision: 1,
  };
  let cleared = 0,
    shown = 0;
  const workflow = new BillWorkflow({
    deriveBillDecision,
    controls,
    runtime,
    bill,
    taskId: task.id,
    outcomes,
    actuator: {
      readObservation: () => ({
        observation: task.observation,
        snapshot: current,
      }),
      quiesce: async () => {
        cleared++;
      },
      showGuidance: async () => {
        shown++;
      },
    },
  });
  try {
    db.exec(
      "CREATE TRIGGER fail_review BEFORE INSERT ON bill_reviews_v1 BEGIN SELECT RAISE(ABORT, 'review disk failure'); END;",
    );
    await assert.rejects(workflow.refresh(), /review disk failure/);
    assert.ok(cleared > 0);
    assert.equal(shown, 0);
    db.exec("DROP TRIGGER fail_review");
    assert.equal((await workflow.refresh()).kind, "human-submit");
    const valid = outcomes.loadReview();
    for (const invalid of [
      null,
      { ...valid, epoch: -1 },
      { ...valid, documentId: "" },
      { ...valid, review: { ...valid.review, method: "4111 1111 1111 1111" } },
      { ...valid, source: bill.origin + "/bill?token=private" },
    ]) {
      db.prepare("UPDATE bill_reviews_v1 SET document=?").run(
        JSON.stringify(invalid),
      );
      const before = cleared;
      await assert.rejects(workflow.refresh());
      assert.ok(cleared > before);
    }
    db.prepare("UPDATE bill_reviews_v1 SET document=?").run(
      JSON.stringify({
        ...valid,
        review: { ...valid.review, billSource: "mail:other" },
      }),
    );
    assert.equal((await workflow.refresh()).kind, "blocked");
  } finally {
    db.close();
  }
});

test("a bill the website already shows paid is not saved as this task's payment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bill-prior-outcome-"));
  const db = new DatabaseSync(join(dir, "db"));
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  const task = {
    id: "fresh",
    revision: 1,
    epoch: 1,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  try {
    const outcomes = createBillOutcomeStore(db, { get: () => task }).forTask(
      runtime,
      task.id,
    );
    let saved = 0;
    const save = outcomes.save.bind(outcomes);
    outcomes.save = (...args) => {
      saved++;
      return save(...args);
    };
    const workflow = new BillWorkflow({
      deriveBillDecision,
      controls,
      runtime,
      actuator: {
        readObservation: () => ({
          observation: { id: "observed" },
          snapshot: snapshot({
            "Payment status": "Paid",
            Confirmation: "OLD-1",
          }),
        }),
        quiesce: async () => {},
      },
      bill,
      taskId: task.id,
      outcomes,
    });
    for (const [status, text] of [
      ["Paid", /already paid/],
      ["Scheduled", /already scheduled/],
    ]) {
      workflow.actuator.readObservation = () => ({
        observation: { id: "observed" },
        snapshot: snapshot({ "Payment status": status, Confirmation: "OLD-1" }),
      });
      const result = await workflow.refresh();
      assert.equal(result.kind, "prior-outcome");
      assert.equal(result.status, status.toLowerCase());
      assert.equal(result.reference, "OLD-1");
      assert.match(result.message, text);
    }
    assert.equal(saved, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_outcomes_v1").get().n,
      0,
    );
    // Once this task recorded a submission, the same observation is its outcome.
    outcomes.recordSubmission(deriveBillDecision(bill, snapshot()), "observed");
    workflow.actuator.readObservation = () => ({
      observation: { id: "observed" },
      snapshot: snapshot({ "Payment status": "Paid", Confirmation: "NEW-1" }),
    });
    const outcome = await workflow.refresh();
    assert.equal(outcome.kind, "outcome");
    assert.equal(outcome.company, "Power");
    assert.equal(saved, 1);
    // A later task for the same bill sees the paid page without reviewing
    // anything. The earlier payment is not saved again as the later task's.
    const later = { ...task, id: "later", observation: { id: "seen" } };
    const laterRuntime = { owner, get: () => later, observe: async () => {} };
    const laterOutcomes = createBillOutcomeStore(db, {
      get: () => later,
    }).forTask(laterRuntime, later.id);
    const again = await new BillWorkflow({
      deriveBillDecision,
      controls,
      runtime: laterRuntime,
      actuator: {
        readObservation: () => ({
          observation: { id: "seen" },
          snapshot: snapshot({
            "Payment status": "Paid",
            Confirmation: "NEW-1",
          }),
        }),
        quiesce: async () => {},
      },
      bill,
      taskId: later.id,
      outcomes: laterOutcomes,
    }).refresh();
    assert.equal(again.kind, "prior-outcome");
    assert.equal(again.reference, "NEW-1");
    assert.match(again.message, /earlier task already recorded/);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM bill_outcomes_v1").get().n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
