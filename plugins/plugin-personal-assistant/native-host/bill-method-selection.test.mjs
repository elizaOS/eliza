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
import { validateBillControls } from "./bill-controls.mjs";
import { createBillOutcomeStore } from "./bill-outcome-store.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";

const owner = {
  actorId: "a",
  agentId: "agent",
  connector: { source: "test", accountId: "account" },
};
const task = {
  id: "task",
  status: "active",
  epoch: 1,
  revision: 1,
  authorization: { state: "active", decisionId: "grant" },
  allowedOrigins: ["https://biller.example"],
  observation: { id: "view", version: 1, inputRevision: 0 },
};
const proposal = {
  id: "operation",
  taskId: "task",
  epoch: 1,
  authorizationId: "grant",
  capability: "browser.click",
  observationId: "view",
  observationVersion: 1,
  inputRevision: 0,
  targetRef: "view:0:1",
};
const snapshot = {
  documentId: "document",
  url: "https://biller.example/bill?token=private#secret",
  elements: [{ selector: "view:0:1", label: "Use existing method" }],
};
const decision = {
  kind: "choose-existing-method",
  reviewKey: "a".repeat(64),
  review: {
    source: snapshot.url,
    billSource: "mail:bill",
    company: "Power",
    accountLabel: "Ending 1234",
    method: "Visa ending 4242",
    amountMinor: 12000,
    feeMinor: 0,
    totalMinor: 12000,
    currency: "USD",
    currencyDigits: 2,
    paymentDate: "2026-10-03",
  },
};

test("method selection provenance survives restart, is owner scoped, immutable and distinct from submission", () => {
  const dir = mkdtempSync(join(tmpdir(), "method-selection-"));
  let db = new DatabaseSync(join(dir, "db"));
  const tasks = {
    get: (_id, who) =>
      JSON.stringify(who) === JSON.stringify(owner) ? task : null,
  };
  try {
    let store = createBillOutcomeStore(db, tasks).forTask({ owner }, task.id);
    const saved = store.recordMethodSelection(decision, proposal, snapshot);
    assert.equal(saved.source, "https://biller.example/bill");
    assert.equal(saved.review.source, saved.source);
    assert.equal(JSON.stringify(saved).includes("private"), false);
    assert.equal(store.loadAttempt(), null);
    assert.equal(store.loadReview(), null);
    assert.equal(
      store.hasPriorPayment({
        sourceRef: "mail:bill",
        origin: "https://biller.example",
      }),
      false,
    );
    db.close();
    db = new DatabaseSync(join(dir, "db"));
    store = createBillOutcomeStore(db, tasks).forTask({ owner }, task.id);
    assert.deepEqual(store.loadMethodSelection(proposal.id), saved);
    assert.throws(() =>
      store.recordMethodSelection(
        { ...decision, reviewKey: "b".repeat(64) },
        proposal,
        snapshot,
      ),
    );
    assert.deepEqual(store.loadMethodSelection(proposal.id), saved);
    assert.throws(
      () =>
        createBillOutcomeStore(db, tasks)
          .forTask({ owner: { ...owner, actorId: "other" } }, task.id)
          .loadMethodSelection(proposal.id),
      /not owned/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("method selection rejects stale observation, revoked authority and off-origin evidence before storing", () => {
  const db = new DatabaseSync(":memory:");
  let current = structuredClone(task);
  const store = createBillOutcomeStore(db, { get: () => current }).forTask(
    { owner },
    task.id,
  );
  try {
    for (const change of [
      { epoch: 2 },
      { observationId: "stale" },
      { observationVersion: 2 },
      { inputRevision: 1 },
      { authorizationId: "old" },
      { taskId: "other" },
      { capability: "browser.fill" },
    ])
      assert.throws(() =>
        store.recordMethodSelection(
          decision,
          { ...proposal, ...change },
          snapshot,
        ),
      );
    for (const change of [
      { status: "paused" },
      { authorization: { state: "revoked", decisionId: "grant" } },
    ]) {
      current = { ...task, ...change };
      assert.throws(() =>
        store.recordMethodSelection(decision, proposal, snapshot),
      );
    }
    current = task;
    assert.throws(() =>
      store.recordMethodSelection(decision, proposal, {
        ...snapshot,
        url: "https://other.example/bill",
      }),
    );
    assert.equal(store.loadMethodSelection(proposal.id), null);
  } finally {
    db.close();
  }
});

test("a failed durable method review prevents dispatch; successful storage precedes dispatch", async () => {
  const db = new DatabaseSync(":memory:");
  const events = [];
  const runtime = {
    owner,
    get: () => task,
    execute: async () => {
      events.push("execute");
      return { operations: [{ status: "succeeded" }] };
    },
  };
  const store = createBillOutcomeStore(db, { get: () => task }).forTask(
    runtime,
    task.id,
  );
  const workflow = new BillWorkflow({
    deriveBillDecision,
    runtime,
    bill: {},
    taskId: task.id,
    outcomes: store,
    controls: {
      ...validateBillControls(controls),
      existingMethod: {
        label: "Use existing method",
        selector: "#existing-method",
      },
    },
    actuator: {
      readObservation: () => ({ observation: task.observation, snapshot }),
      quiesce: async () => events.push("clear"),
    },
  });
  workflow.refresh = async () => decision;
  try {
    db.exec(
      "CREATE TRIGGER fail_selection BEFORE INSERT ON bill_method_selections_v1 BEGIN SELECT RAISE(ABORT, 'disk failure'); END;",
    );
    assert.equal(
      (
        await workflow.chooseExistingMethod(decision.reviewKey, {
          operationId: "operation",
        })
      ).kind,
      "blocked",
    );
    assert.deepEqual(events, ["clear"]);
    assert.equal(store.loadMethodSelection("operation"), null);
    db.exec("DROP TRIGGER fail_selection");
    runtime.execute = async (_id, _rev, p) => {
      assert.equal(
        store.loadMethodSelection(p.id).reviewKey,
        decision.reviewKey,
      );
      events.push("execute");
      return { operations: [{ proposal: p, status: "succeeded" }] };
    };
    await workflow.chooseExistingMethod(decision.reviewKey, {
      operationId: "operation",
    });
    assert.deepEqual(events, ["clear", "execute"]);
  } finally {
    db.close();
  }
});

test("a selection refused before the click is found again once, then reported", async () => {
  const db = new DatabaseSync(":memory:");
  const runtime = { owner, get: () => task };
  const store = createBillOutcomeStore(db, { get: () => task }).forTask(
    runtime,
    task.id,
  );
  const proposals = [];
  let results = ["failed", "succeeded"];
  let evidenceRef = "not-dispatched";
  runtime.execute = async (_id, _rev, proposal) => {
    proposals.push(proposal.id);
    return {
      operations: [{ proposal, status: results.shift(), evidenceRef }],
    };
  };
  const workflow = new BillWorkflow({
    deriveBillDecision,
    runtime,
    bill: {},
    taskId: task.id,
    outcomes: store,
    controls: {
      ...validateBillControls(controls),
      existingMethod: {
        label: "Use existing method",
        selector: "#existing-method",
      },
    },
    actuator: {
      readObservation: () => ({ observation: task.observation, snapshot }),
      quiesce: async () => {},
    },
  });
  let refreshes = 0;
  workflow.refresh = async () => {
    refreshes++;
    return refreshes === 3 ? { kind: "human-submit" } : decision;
  };
  try {
    const done = await workflow.chooseExistingMethod(decision.reviewKey, {
      operationId: "operation",
    });
    assert.equal(done.kind, "human-submit");
    assert.deepEqual(proposals, ["operation", "operation.relocated"]);
    // A second refusal is not retried again.
    results = ["failed", "failed"];
    proposals.length = 0;
    refreshes = 0;
    const stopped = await workflow.chooseExistingMethod(decision.reviewKey, {
      operationId: "second",
    });
    assert.equal(stopped.kind, "blocked");
    assert.match(stopped.reason, /No click was sent/);
    assert.deepEqual(proposals, ["second", "second.relocated"]);
    // A failed post-click verification is not proof that no effect occurred.
    evidenceRef = "evidence:post-click";
    results = ["failed", "succeeded"];
    proposals.length = 0;
    refreshes = 0;
    const failedAfterClick = await workflow.chooseExistingMethod(
      decision.reviewKey,
      {
        operationId: "after-click",
      },
    );
    assert.equal(failedAfterClick.kind, "unknown-outcome");
    assert.deepEqual(proposals, ["after-click"]);
  } finally {
    db.close();
  }
});
