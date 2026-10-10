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
  // A task store that keeps each task's status, so ending is visible.
  const all = new Map();
  const tasks = {
    get: (id) => all.get(id) ?? null,
    transition: (id, context, transition) => {
      const task = all.get(id);
      assert.equal(context.expectedRevision, task.revision);
      assert.equal(transition.type, "complete");
      task.status = "completed";
      task.revision++;
      task.epoch++;
    },
  };
  const make = (id, page, observationId = "observed") => {
    const task = {
      id,
      revision: 1,
      epoch: 1,
      status: "active",
      operations: [],
      allowedOrigins: [bill.origin],
      observation: { id: observationId },
    };
    all.set(id, task);
    const runtime = {
      owner,
      get: () => all.get(id),
      observe: async () => {},
    };
    const outcomes = createBillOutcomeStore(db, tasks).forTask(runtime, id);
    const workflow = new BillWorkflow({
      deriveBillDecision,
      controls,
      runtime,
      actuator: {
        readObservation: () => ({
          observation: { id: observationId },
          snapshot: page.current,
        }),
        quiesce: async () => {},
      },
      bill,
      taskId: id,
      outcomes,
    });
    return { task, outcomes, workflow };
  };
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  try {
    for (const [id, status, text] of [
      ["paid-task", "Paid", /already paid/],
      ["scheduled-task", "Scheduled", /already scheduled/],
    ]) {
      const page = {
        current: snapshot({ "Payment status": status, Confirmation: "OLD-1" }),
      };
      const { task, workflow } = make(id, page);
      const result = await workflow.refresh();
      assert.equal(result.kind, "prior-outcome");
      assert.equal(result.status, status.toLowerCase());
      assert.equal(result.reference, "OLD-1");
      assert.match(result.message, text);
      // The fact is kept and the task ends; it is not this task's payment.
      assert.equal(result.ended, true);
      assert.equal(task.status, "completed");
      // A later look shows the kept fact, whatever the page shows now.
      page.current = snapshot({ "Payment status": "Unpaid" });
      const again = await workflow.refresh();
      assert.equal(again.kind, "prior-outcome");
      assert.equal(again.status, status.toLowerCase());
      assert.equal(again.ended, true);
    }
    assert.equal(count("bill_outcomes_v1"), 0);
    assert.equal(count("bill_prior_outcomes_v1"), 2);
    // Once a task recorded a submission, the same observation is its outcome.
    const page = { current: snapshot() };
    const submitted = make("submitted", page);
    submitted.outcomes.recordSubmission(
      deriveBillDecision(bill, snapshot()),
      "observed",
    );
    page.current = snapshot({
      "Payment status": "Paid",
      Confirmation: "NEW-1",
    });
    const outcome = await submitted.workflow.refresh();
    assert.equal(outcome.kind, "outcome");
    assert.equal(outcome.company, "Power");
    assert.equal(count("bill_outcomes_v1"), 1);
    // A later task for the same bill sees the paid page without reviewing
    // anything. The earlier payment is not saved again as the later task's.
    const later = make("later", page, "seen");
    const seen = await later.workflow.refresh();
    assert.equal(seen.kind, "prior-outcome");
    assert.equal(seen.reference, "NEW-1");
    assert.match(seen.message, /earlier task already recorded/);
    assert.equal(count("bill_outcomes_v1"), 1);
    // If the task cannot be ended, the kept fact still shows, and the next
    // look ends it.
    const failing = make("failing", {
      current: snapshot({ "Payment status": "Paid", Confirmation: "OLD-2" }),
    });
    const transition = tasks.transition;
    tasks.transition = () => {
      throw new Error("task store unavailable");
    };
    const kept = await failing.workflow.refresh();
    assert.equal(kept.kind, "prior-outcome");
    assert.equal(kept.ended, false);
    assert.equal(failing.task.status, "active");
    tasks.transition = transition;
    assert.equal((await failing.workflow.refresh()).ended, true);
    assert.equal(failing.task.status, "completed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a form she sent while the website was hers, before any review, leads to a status check", async () => {
  const db = new DatabaseSync(":memory:");
  const owner = {
    actorId: "a",
    agentId: "agent",
    connector: { source: "test", accountId: "account" },
  };
  // Epoch 2: the task was paused once and resumed.
  const task = {
    id: "task",
    revision: 3,
    epoch: 2,
    status: "active",
    operations: [],
    allowedOrigins: [bill.origin],
    observation: { id: "observed" },
  };
  const actions = [];
  const runtime = {
    owner,
    get: () => task,
    observe: async () => {},
    control: (_id, _revision, action) => {
      actions.push(action);
      task.status = "paused";
    },
    settle: async () => {},
  };
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
  const event = {
    kind: "form-submit",
    origin: bill.origin,
    documentId: "earlier-page",
    epoch: 1,
    observedAt: Date.now(),
  };
  const activity = (events, extra = {}) => ({
    events,
    overflow: false,
    captureGap: false,
    ...extra,
  });
  try {
    // A sign-in form, a form in this epoch, or one on another website is
    // not a payment made while the website was hers.
    for (const events of [
      [{ ...event, credential: true }],
      [{ ...event, epoch: 2 }],
      [{ ...event, origin: "https://other.example" }],
    ]) {
      db.exec("DELETE FROM bill_reviews_v1");
      current.manualActivity = activity(events);
      assert.equal((await workflow.refresh()).kind, "human-submit");
    }
    db.exec("DELETE FROM bill_reviews_v1");
    current.manualActivity = activity([event]);
    const result = await workflow.refresh();
    assert.equal(result.kind, "unknown-outcome");
    assert.match(result.message, /while it was yours/);
    const attempt = outcomes.loadAttempt();
    assert.equal(attempt.evidenceKind, "manual-activity");
    assert.equal(attempt.source, `${bill.origin}/bill`);
    assert.equal(outcomes.loadReview(), null, "no new review is prepared");
    current.manualActivity = activity([]);
    assert.equal(
      (await workflow.refresh()).kind,
      "unknown-outcome",
      "removing the event cannot erase persisted uncertainty",
    );
    // A page that tried to submit after a task action pauses the task.
    current.effectViolation = "submit";
    const paused = await workflow.refresh();
    assert.equal(paused.kind, "paused");
    assert.doesNotMatch(paused.message, /nothing was sent/i);
    assert.deepEqual(actions, ["pause"]);
  } finally {
    db.close();
  }
});

test("a saved outcome says its receipt is in email only after one receipt was found", async () => {
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
  const tasks = {
    get: () => task,
    transition: () => {
      task.status = "completed";
      task.revision++;
    },
  };
  const runtime = { owner, get: () => task, observe: async () => {} };
  const outcomes = createBillOutcomeStore(db, tasks).forTask(runtime, task.id);
  const page = { current: snapshot() };
  const looks = [];
  let answer = false;
  const workflow = new BillWorkflow({
    deriveBillDecision,
    controls,
    runtime,
    bill,
    taskId: task.id,
    outcomes,
    receipts: {
      find: async (outcome) => {
        looks.push(outcome);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    actuator: {
      readObservation: () => ({
        observation: task.observation,
        snapshot: page.current,
      }),
      quiesce: async () => {},
    },
  });
  try {
    outcomes.recordSubmission(deriveBillDecision(bill, snapshot()), "observed");
    page.current = snapshot({ "Payment status": "Paid", Confirmation: "R-77" });
    const first = await workflow.refresh();
    assert.equal(first.saveStatus, "saved");
    assert.equal(first.receiptInEmail, undefined);
    assert.deepEqual(
      looks.map((o) => o.reference),
      ["R-77"],
    );
    // Within a minute it does not search again.
    await workflow.refresh();
    assert.equal(looks.length, 1);
    // A later look finds the receipt; it then stays found without searching.
    db.prepare(
      "UPDATE bill_receipt_checks_v1 SET document=json_set(document,'$.checkedAt',0)",
    ).run();
    answer = true;
    assert.equal((await workflow.refresh()).receiptInEmail, true);
    assert.equal((await workflow.refresh()).receiptInEmail, true);
    assert.equal(looks.length, 2);
    // A failed search never changes the saved outcome.
    db.exec("DELETE FROM bill_receipt_checks_v1");
    answer = new Error("Google unavailable");
    const failed = await workflow.refresh();
    assert.equal(failed.saveStatus, "saved");
    assert.equal(failed.receiptInEmail, undefined);
    const afterFailure = looks.length;
    await workflow.refresh();
    assert.equal(
      looks.length,
      afterFailure,
      "failed searches obey the cooldown",
    );
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "UPDATE bill_receipt_checks_v1 SET document=json_set(document,'$.checkedAt',0)",
      ).run();
      await workflow.refresh();
    }
    assert.equal(
      looks.length,
      afterFailure + 2,
      "failures consume the three-attempt budget",
    );
    const restarted = createBillOutcomeStore(db, tasks).forTask(
      runtime,
      task.id,
    );
    assert.equal(restarted.loadReceiptCheck().checks, 3);
    db.exec("DELETE FROM bill_receipt_checks_v1");
    // At most three searches for one outcome.
    answer = false;
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "UPDATE bill_receipt_checks_v1 SET document=json_set(document,'$.checkedAt',0)",
      ).run();
      await workflow.refresh();
    }
    assert.equal(outcomes.loadReceiptCheck().checks, 3);
    // Concurrent looks reserve one attempt before either provider read completes.
    db.exec("DELETE FROM bill_receipt_checks_v1");
    let release;
    answer = new Promise((resolve) => {
      release = resolve;
    });
    const beforeConcurrent = looks.length;
    const concurrent = [workflow.refresh(), workflow.refresh()];
    await new Promise((resolve) => setImmediate(resolve));
    release(false);
    await Promise.all(concurrent);
    assert.equal(looks.length, beforeConcurrent + 1);
    // A restart after reservation cannot immediately replay that lookup.
    const resumed = createBillOutcomeStore(db, tasks).forTask(runtime, task.id);
    assert.equal(resumed.beginReceiptCheck(), null);
    // If durable reservation fails, no provider request is made.
    db.exec("DELETE FROM bill_receipt_checks_v1");
    db.exec(
      "CREATE TEMP TRIGGER reject_receipt_attempt BEFORE INSERT ON bill_receipt_checks_v1 BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END",
    );
    const beforeStorageFailure = looks.length;
    assert.equal((await workflow.refresh()).saveStatus, "saved");
    assert.equal(looks.length, beforeStorageFailure);
  } finally {
    db.close();
  }
});

test("delayed bill policy is cancelled without saving review or outcome", async () => {
  const controller = new AbortController();
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let clears = 0,
    writes = 0;
  const task = {
    id: "task",
    status: "active",
    epoch: 1,
    revision: 1,
    operations: [],
  };
  const workflow = new BillWorkflow({
    bill,
    controls,
    taskId: task.id,
    signal: controller.signal,
    runtime: { owner: {}, get: () => task, observe: async () => {} },
    actuator: {
      readObservation: () => ({
        observation: { id: "observed" },
        snapshot: snapshot(),
      }),
      quiesce: async () => {
        clears++;
      },
    },
    outcomes: {
      load: () => null,
      recordReview: () => {
        writes++;
      },
      save: () => {
        writes++;
      },
    },
    deriveBillDecision: (_bill, _snapshot, context) => {
      assert.equal(context.signal, controller.signal);
      assert.equal(context.taskId, task.id);
      assert.equal(context.epoch, task.epoch);
      started();
      return new Promise(() => {});
    },
  });
  const pending = workflow.refresh();
  await entered;
  controller.abort();
  await assert.rejects(pending, /Task authorization changed/);
  assert.equal(writes, 0);
  assert.equal(clears, 1);
});
