import assert from "node:assert/strict";
import test from "node:test";
import { validateTaskChoiceWidget } from "../../../packages/core/src/messaging/task-widgets.ts";
import { formatMinorCurrency } from "../../../packages/ui/src/utils/value-formatting.ts";
import {
  BillClientResponseError,
  BillDecisionClient,
  BillSourceClient,
  BillSourceLinkClient,
  readBillDecision,
  readBillSourceOffer,
  validateBillSourceLinks,
} from "./bill-client.ts";

const validators = {
  choice: validateTaskChoiceWidget,
  money: (value) => formatMinorCurrency(value, "en-US"),
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const source = () => ({
  messageId: "message1",
  threadId: "thread1",
  url: "https://mail.google.com/mail/u/person%40example.com/#all/thread1",
});
const candidate = () => ({
  candidateId: "a".repeat(64),
  billId: "b".repeat(64),
  facts: {
    company: "Utility",
    accountLabel: "Account ending 12",
    origin: "https://biller.example",
    amountMinor: 1200,
    currency: "USD",
    currencyDigits: 2,
    dueDate: "2026-10-05",
  },
  sources: [source()],
});
const offer = () => ({
  status: "candidate",
  offerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  expectedRevision: 1,
  expiresAt: 10000,
  candidates: [candidate()],
  epoch: 3,
  taskId: "task1",
});
const decision = () => ({
  decision: {
    kind: "choose-existing-method",
    reviewKey: "c".repeat(64),
    review: {
      company: "Utility",
      accountLabel: "Account ending 12",
      amountMinor: 1200,
      feeMinor: 0,
      totalMinor: 1200,
      currency: "USD",
      currencyDigits: 2,
      paymentDate: "2026-10-05",
      method: "Existing card",
      servicePeriod: null,
      source: "https://biller.example",
    },
    choice: {
      schemaVersion: 1,
      taskId: "task1",
      epoch: 3,
      contextKey: "c".repeat(64),
      callbackData: `is1:${"d".repeat(32)}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      state: "pending",
      block: {
        kind: "choice",
        id: "method",
        scope: "bill",
        options: [{ value: "card", label: "Existing card" }],
      },
    },
  },
});
function fixture(Client = BillDecisionClient) {
  const calls = [],
    states = [];
  const client = new Client({
    validators,
    now: () => 100,
    changed: (s) => states.push(s),
    request: (path, body) => {
      const d = deferred();
      calls.push({ path, body, ...d });
      return d.promise;
    },
  });
  return { client, calls, states };
}

test("response admission preserves detached metadata and validates shared money, choice binding and source links", () => {
  const input = offer(),
    parsed = readBillSourceOffer(input, validators);
  input.candidates[0].facts.company = "changed";
  assert.equal(parsed.candidates[0].facts.company, "Utility");
  assert.equal(parsed.epoch, 3);
  assert.equal(
    readBillDecision(decision(), "task1", validators).choice.taskId,
    "task1",
  );
  assert.throws(() => readBillDecision(decision(), "different", validators));
  for (const mutate of [
    (v) => (v.decision.choice.contextKey = "e".repeat(64)),
    (v) => (v.decision.review.currencyDigits = 0),
    (v) => (v.decision.review.totalMinor = Number.MAX_SAFE_INTEGER + 1),
    (v) => (v.decision.kind = "pay"),
    (v) => (v.decision.guidance = false),
    (v) => (v.decision.guidance = null),
    (v) =>
      (v.decision.billSources = [
        { ...source(), url: "https://evil.example/" },
      ]),
  ]) {
    const v = decision();
    mutate(v);
    assert.throws(() => readBillDecision(v, "task1", validators));
  }
  for (const mutate of [
    (v) => (v.candidates[0].facts.currencyDigits = 0),
    (v) => (v.candidates[0].facts.origin = "http://biller.example"),
    (v) => (v.candidates[0].sources = [{ messageId: "../x" }]),
    (v) => (v.reason = "choose-for-user"),
    (v) => (v.candidates[0].facts.servicePeriod = false),
    (v) => (v.candidates[0].facts.servicePeriod = null),
    (v) => (v.candidates[0].sources[0].kind = false),
    (v) => (v.candidates[0].sources[0].partId = {}),
  ]) {
    const v = offer();
    mutate(v);
    assert.throws(() => readBillSourceOffer(v, validators));
  }
  const links = [source()],
    copy = validateBillSourceLinks(links);
  links[0].url = "changed";
  assert.notEqual(copy[0].url, "changed");

  const malformed = offer();
  malformed.candidates[0].facts.origin = "not a url";
  assert.throws(
    () => readBillSourceOffer(malformed, validators),
    (error) => {
      assert.equal(error instanceof BillClientResponseError, true);
      assert.equal(error.code, "BILL_CLIENT_RESPONSE_INVALID");
      assert.equal(error.cause instanceof TypeError, true);
      return true;
    },
  );
});

test("decision effect replay defers initial request and stop suppresses every later result", async () => {
  const { client, calls, states } = fixture();
  client.start("task1");
  client.stop();
  await tick();
  assert.equal(calls.length, 0);
  client.start("task1");
  await tick();
  assert.equal(calls.length, 1);
  const count = states.length;
  client.stop();
  calls[0].resolve(decision());
  await tick();
  assert.equal(states.length, count);
});

test("task switch clears decision and stale finalizer cannot unlock a new request", async () => {
  const { client, calls } = fixture();
  client.start("task1");
  await tick();
  client.start("task2");
  await tick();
  assert.equal(client.snapshot().decision, null);
  calls[0].reject(new Error("old"));
  await tick();
  assert.equal(client.snapshot().pending, true);
  assert.equal(client.snapshot().error, null);
  calls[1].resolve({ decision: { kind: "paused" } });
  await tick();
  assert.equal(client.snapshot().decision.kind, "paused");
  assert.equal(client.snapshot().pending, false);
});

test("choice and guidance send only explicit bound actions; uncertain choice returns failure without replay", async () => {
  const { client, calls } = fixture();
  client.start("task1");
  await tick();
  calls[0].resolve(decision());
  await tick();
  const widget = client.snapshot().decision.choice;
  assert.equal(
    await client.choose({ ...widget, contextKey: "e".repeat(64) }, "card"),
    false,
  );
  assert.equal(await client.choose(widget, "unknown"), false);
  assert.equal(calls.length, 1);
  const chosen = client.choose(widget, "card");
  assert.equal(await client.choose(widget, "card"), false);
  assert.deepEqual(calls[1].body, {
    callbackData: widget.callbackData,
    contextKey: widget.contextKey,
    value: "card",
  });
  calls[1].reject(new Error("network"));
  assert.equal(await chosen, false);
  assert.equal(client.snapshot().error, "load");
  assert.equal(calls.length, 2);
  const refresh = client.refresh();
  assert.equal(calls[2].body, undefined);
  calls[2].resolve({ decision: { kind: "outcome", saveStatus: "pending" } });
  assert.equal(await refresh, true);
  const save = client.refresh();
  calls[3].reject(new Error("disk"));
  await save;
  assert.equal(client.snapshot().error, "save");
  const guidance = client.restoreGuidance();
  assert.deepEqual(calls[4].body, { action: "show-guidance" });
  calls[4].resolve({ decision: { kind: "human-review" } });
  assert.equal(await guidance, true);
});

test("response validation failure cannot report successful choice delivery", async () => {
  const { client, calls } = fixture();
  client.start("task1");
  await tick();
  calls[0].resolve(decision());
  await tick();
  const chosen = client.choose(client.snapshot().decision.choice, "card");
  calls[1].resolve({ decision: { kind: "unknown" } });
  assert.equal(await chosen, false);
  assert.equal(client.snapshot().decision.kind, "choose-existing-method");
});

test("source task switch clears old offers; stale reply cannot select the current task", async () => {
  const { client, calls, states } = fixture(BillSourceClient);
  client.start("task1");
  await tick();
  calls[0].resolve(offer());
  await tick();
  const choosing = client.choose("a".repeat(64));
  client.start("task2");
  assert.equal(client.snapshot().offer, null);
  await tick();
  calls[1].resolve({ status: "selected" });
  assert.equal(await choosing, false);
  assert.equal(client.snapshot().pending, true);
  assert.equal(client.snapshot().selected, false);
  calls[2].resolve({ ...offer(), taskId: "task2" });
  await tick();
  assert.equal(client.snapshot().pending, false);
  assert.equal(
    states.some((s) => s.selected),
    false,
  );
});

test("uncertain source selection discards its offer; explicit search re-reads saved choice without replay", async () => {
  const { client, calls } = fixture(BillSourceClient);
  client.start("task1");
  await tick();
  calls[0].resolve(offer());
  await tick();
  assert.equal(await client.choose("f".repeat(64)), false);
  const chosen = client.choose("a".repeat(64));
  assert.equal(await client.search(), false);
  assert.deepEqual(calls[1].body, {
    candidateId: "a".repeat(64),
    offerId: offer().offerId,
    expectedRevision: 1,
  });
  calls[1].reject(new Error("reply lost"));
  assert.equal(await chosen, false);
  assert.equal(client.snapshot().offer, null);
  assert.equal(client.snapshot().error, "selection");
  assert.equal(await client.choose("a".repeat(64)), false);
  assert.equal(calls.length, 2);
  const search = client.search();
  assert.equal(calls[2].body, undefined);
  calls[2].resolve({ status: "selected" });
  assert.equal(await search, true);
  assert.equal(client.snapshot().selected, true);
  assert.equal(calls.length, 3);
});

test("expired, conflicting and incomplete source offers cannot dispatch selection", async () => {
  for (const patch of [
    { expiresAt: 99 },
    { reason: "conflicting-invoice" },
    { status: "incomplete" },
  ]) {
    const { client, calls } = fixture(BillSourceClient);
    client.start("task1");
    await tick();
    calls[0].resolve({ ...offer(), ...patch });
    await tick();
    assert.equal(await client.choose("a".repeat(64)), false);
    assert.equal(calls.length, 1);
  }
});

test("source replay and stop suppress network and observer callbacks", async () => {
  const { client, calls, states } = fixture(BillSourceClient);
  client.start("task1");
  client.stop();
  await tick();
  assert.equal(calls.length, 0);
  client.start("task1");
  await tick();
  const count = states.length;
  client.stop();
  calls[0].resolve({ status: "selected" });
  await tick();
  assert.equal(states.length, count);
});

test("source links open only explicit safe URLs, serialize taps and suppress stale completion", async () => {
  const calls = [],
    states = [],
    client = new BillSourceLinkClient({
      changed: (s) => states.push(s),
      open: (url) => {
        const d = deferred();
        calls.push({ url, ...d });
        return d.promise;
      },
    });
  assert.equal(await client.openSource(source()), false);
  client.start();
  assert.equal(
    await client.openSource({ ...source(), url: "https://evil.example" }),
    false,
  );
  const opening = client.openSource(source());
  assert.equal(await client.openSource(source()), false);
  assert.equal(calls.length, 1);
  client.stop();
  client.start();
  const next = client.openSource(source());
  calls[0].reject(new Error("old"));
  assert.equal(await opening, false);
  assert.equal(states.at(-1).opening, true);
  calls[1].reject(new Error("new"));
  assert.equal(await next, false);
  assert.deepEqual(states.at(-1), { opening: false, failed: true });
});
