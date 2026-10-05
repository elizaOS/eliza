import assert from "node:assert/strict";
import test from "node:test";
import {
  controls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { BillCodeCoordinator } from "./bill-code-coordinator.mjs";

function fixture() {
  const owner = {
    actorId: "actor",
    agentId: "agent",
    connector: { accountId: "account" },
  };
  const task = {
    id: "task",
    epoch: 1,
    revision: 1,
    status: "active",
    owner,
    authorization: { state: "active", decisionId: "grant" },
    operations: [],
  };
  const snapshot = {
    url: "https://biller.example/",
    text: "Environment: Controlled test biller\nCompany: Example\nSession: Signed in\nVerification: Required",
    elements: [{ selector: "otp" }],
  };
  const bill = {
    origin: "https://biller.example",
    sourceRef: "mail:bill",
    company: "Example",
    amountMinor: 100,
  };
  const stats = { reads: 0, fills: 0, consumes: 0 };
  let coordinator;
  const runtime = {
    owner,
    get: () => structuredClone(task),
    observe: async () => {
      task.revision++;
    },
    execute: async (_id, revision, proposal) => {
      assert.equal(revision, task.revision);
      const value = await coordinator.resolveValue(proposal.valueRef, task);
      assert.deepEqual(value, { kind: "verification-code", text: "123456" });
      stats.fills++;
      task.operations.push({ proposal, status: "succeeded" });
      task.revision++;
      return structuredClone(task);
    },
  };
  const resolver = {
    resolve: async () => {
      stats.reads++;
      return {
        status: "ready",
        valueRef: "opaque-handle",
        expiresAt: Date.now() + 60000,
      };
    },
    consumeForFill: async () => {
      stats.consumes++;
      return "123456";
    },
    revoke: () => {},
  };
  coordinator = new BillCodeCoordinator({
    deriveBillDecision,
    controls,
    runtime,
    actuator: {
      readObservation: () => ({
        snapshot,
        observation: { id: "observation", version: 1, inputRevision: 0 },
      }),
    },
    resolver,
    resolveGoogleAccount: async () => "google-account",
    challengeProvider: async () => ({
      targetRef: "otp",
      challengeId: "challenge",
      recipient: "user@example.com",
      senders: ["security@biller.example"],
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60000,
      searchQuery: "challenge",
    }),
  });
  return {
    coordinator,
    resolver,
    runtime,
    bill,
    task,
    snapshot,
    stats,
    fill: () => coordinator.fill({ taskId: task.id, bill }),
  };
}
test("fills a matched challenge once, keeps raw code out of result, and leaves Verify to human", async () => {
  const f = fixture();
  const result = await f.fill();
  assert.match(result.message, /press Verify yourself/);
  assert.equal(result.kind, "human-verification");
  assert.equal(JSON.stringify(result).includes("123456"), false);
  const duplicate = await f.fill();
  assert.match(duplicate.message, /already handled/);
  assert.deepEqual(f.stats, { reads: 1, fills: 1, consumes: 1 });
  await assert.rejects(f.coordinator.resolveValue("opaque-handle", f.task));
});
test("missing expired ambiguous and incomplete searches never dispatch a fill", async () => {
  for (const status of ["missing", "expired", "ambiguous", "incomplete"]) {
    const f = fixture();
    f.resolver.resolve = async () => ({ status });
    const result = await f.fill();
    assert.equal(result.kind, "human-verification");
    assert.equal(f.stats.fills, 0);
    assert.equal(f.stats.consumes, 0);
  }
});
test("authority and task revision changes after lookup prevent consumption", async () => {
  for (const change of [
    (f) => {
      f.task.epoch++;
    },
    (f) => {
      f.task.revision++;
    },
    (f) => {
      f.task.status = "paused";
    },
    (f) => {
      f.coordinator.stillAuthorized = async () => false;
    },
  ]) {
    const f = fixture();
    f.resolver.resolve = async () => {
      change(f);
      return {
        status: "ready",
        valueRef: "opaque-handle",
        expiresAt: Date.now() + 60000,
      };
    };
    await f.fill();
    assert.equal(f.stats.fills, 0);
    assert.equal(f.stats.consumes, 0);
  }
});
test("unsupported pages and concurrent repeated requests do not start extra lookups", async () => {
  const wrong = fixture();
  wrong.snapshot.url = "https://other.example";
  assert.equal((await wrong.fill()).kind, "blocked");
  assert.equal(wrong.stats.reads, 0);
  const f = fixture();
  let release, entered;
  const pending = new Promise((resolve) => (entered = resolve));
  f.resolver.resolve = async () => {
    entered();
    return new Promise((resolve) => (release = resolve));
  };
  const first = f.fill();
  await pending;
  assert.match((await f.fill()).message, /already in progress/);
  release({ status: "missing" });
  await first;
  assert.equal(f.stats.fills, 0);
});
test("provider errors cannot leak a code or message body to the workflow", async () => {
  const f = fixture();
  f.resolver.resolve = async () => {
    throw new Error("Private message 123456");
  };
  const result = await f.fill();
  assert.equal(JSON.stringify(result).includes("123456"), false);
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(f.stats.fills, 0);
});

test("request cancellation while dispatch is pending pauses only its matching task", async () => {
  const f = fixture(),
    controller = new AbortController();
  let start, finish;
  const entered = new Promise((resolve) => (start = resolve));
  f.runtime.control = (id, revision, action) => {
    assert.equal(id, f.task.id);
    assert.equal(revision, f.task.revision);
    assert.equal(action, "pause");
    f.task.status = "paused";
    f.task.epoch++;
  };
  f.runtime.execute = async () => {
    f.task.status = "waiting";
    start();
    await new Promise((resolve) => (finish = resolve));
    return structuredClone(f.task);
  };
  const pending = f.coordinator.fill({
    taskId: f.task.id,
    bill: f.bill,
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  finish();
  await pending;
  assert.equal(f.task.status, "paused");
  assert.equal(f.task.epoch, 2);
  assert.equal(f.stats.fills, 0);
});

test("Google connector identity is explicit and separate from the app task account", async () => {
  const f = fixture();
  let selected;
  f.resolver.resolve = async (context) => {
    selected = context.accountId;
    return { status: "missing" };
  };
  await f.fill();
  assert.equal(selected, "google-account");
  assert.equal(f.task.owner.connector.accountId, "account");
  const missing = fixture();
  missing.coordinator.resolveGoogleAccount = async () => null;
  await missing.fill();
  assert.equal(missing.stats.reads, 0);
});
