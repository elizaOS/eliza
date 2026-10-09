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

test("source offers carry arrival order, optional due dates and look-alike sources", () => {
  const newest = {
    ...candidate(),
    receivedAt: "2026-09-20T00:00:00.000Z",
    mostRecent: true,
  };
  delete newest.facts.dueDate;
  const read = readBillSourceOffer(
    { ...offer(), candidates: [newest] },
    validators,
  );
  assert.equal(read.candidates[0].mostRecent, true);
  assert.equal(read.candidates[0].facts.dueDate, undefined);
  const conflict = { differs: ["origin"] };
  assert.equal(
    readBillSourceOffer(
      {
        ...offer(),
        status: "conflicting-source",
        candidates: [],
        conflicts: [conflict],
        unreadable: 2,
      },
      validators,
    ).conflicts[0].differs[0],
    "origin",
  );
  assert.equal(
    readBillSourceOffer(
      {
        ...offer(),
        conflicts: [
          conflict,
          { differs: ["company"] },
          { differs: ["company", "accountLabel"] },
        ],
      },
      validators,
    ).conflicts.length,
    3,
  );
  assert.equal(
    readBillSourceOffer(
      {
        ...offer(),
        status: "incomplete",
        reason: "newer-unreadable",
        candidates: [],
        unreadable: 1,
      },
      validators,
    ).reason,
    "newer-unreadable",
  );
  for (const patch of [
    { conflicts: [{ ...conflict, origin: "https://lookalike.example" }] },
    { conflicts: [{ differs: [] }] },
    { conflicts: [{ differs: ["origin", "company"] }] },
    { conflicts: Array(8).fill(conflict) },
    { reason: "newer-unreadable" },
    { unreadable: 0 },
    { candidates: [{ ...newest, mostRecent: false }] },
    { candidates: [{ ...newest, receivedAt: "yesterday" }] },
    {
      candidates: [
        { ...candidate(), facts: { ...candidate().facts, dueDate: "soon" } },
      ],
    },
  ])
    assert.throws(
      () => readBillSourceOffer({ ...offer(), ...patch }, validators),
      BillClientResponseError,
    );
});

test("a conflicting-source offer cannot dispatch selection", async () => {
  const { client, calls } = fixture(BillSourceClient);
  client.start("task1");
  await tick();
  calls[0].resolve({ ...offer(), status: "conflicting-source" });
  await tick();
  assert.equal(await client.choose("a".repeat(64)), false);
  assert.equal(calls.length, 1);
});

test("a failed source search keeps only the host's fixed reason", async () => {
  for (const [reason, expected] of [
    ["reauth_required", "reauth_required"],
    ["cloud_sign_in_required", "cloud_sign_in_required"],
    ["insufficient_scope", "insufficient_scope"],
    ["account_changed", "account_changed"],
    ["timeout", "timeout"],
    ["provider said something private", undefined],
  ]) {
    const { client, calls } = fixture(BillSourceClient);
    client.start("task1");
    await tick();
    calls[0].reject(Object.assign(new Error("search failed"), { reason }));
    await tick();
    assert.equal(client.snapshot().error, "search");
    assert.equal(client.snapshot().reason, expected);
    const retry = client.search();
    assert.equal(client.snapshot().reason, undefined);
    calls[1].resolve(offer());
    assert.equal(await retry, true);
  }
});

test("prior and saved outcomes are admitted with their company", () => {
  const outcome = {
    kind: "outcome",
    status: "paid",
    reference: "TEST-1",
    source: "https://biller.example/receipt",
    company: "Utility",
  };
  assert.equal(
    readBillDecision({ decision: outcome }, "task1", validators).company,
    "Utility",
  );
  assert.equal(
    readBillDecision(
      { decision: { ...outcome, kind: "prior-outcome" } },
      "task1",
      validators,
    ).kind,
    "prior-outcome",
  );
  for (const company of ["", "x".repeat(301), 7])
    assert.throws(
      () =>
        readBillDecision(
          { decision: { ...outcome, company } },
          "task1",
          validators,
        ),
      BillClientResponseError,
    );
});

test("a shown guide is checked again and renewed before it expires, and reported gone after", async () => {
  let time = 1000;
  const pending = [];
  const timers = {
    set: (callback, ms) => {
      const handle = { callback, at: time + ms };
      pending.push(handle);
      return handle;
    },
    clear: (handle) => {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const fire = async () => {
    const next = pending.shift();
    time = next.at;
    next.callback();
    await tick();
  };
  const calls = [];
  const client = new BillDecisionClient({
    validators,
    now: () => time,
    timers,
    changed: () => {},
    request: (path, body) => {
      const d = deferred();
      calls.push({ path, body, ...d });
      return d.promise;
    },
  });
  const guided = (expiresAt) => ({
    decision: {
      kind: "human-sign-in",
      guidance: {
        instruction: "Sign in yourself.",
        available: true,
        expiresAt,
      },
    },
  });
  client.start("task1");
  await tick();
  calls[0].resolve(guided(time + 60000));
  await tick();
  // A shown guide is checked again on the short interval.
  assert.equal(pending.length, 1);
  assert.equal(pending[0].at, 1000 + 15000);
  await fire();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body, undefined);
  // Close to expiry, the check runs before the guide ends.
  calls[1].resolve(guided(time + 8000));
  await tick();
  assert.equal(pending[0].at, time + 3000);
  await fire();
  calls[2].reject(new Error("offline"));
  await tick();
  // A failed renewal tries once more when the guide expires, and then the
  // guide is reported unavailable.
  assert.equal(pending[0].at, time + 5000);
  await fire();
  assert.equal(client.snapshot().decision.guidance.available, false);
  calls[3].reject(new Error("offline"));
  await tick();
  assert.equal(pending.length, 0);
  // No checks without a shown guide, and none after stop.
  client.start("task2");
  await tick();
  calls[4].resolve({ decision: { kind: "human-sign-in" } });
  await tick();
  assert.equal(pending.length, 0);
  client.start("task3");
  await tick();
  calls[5].resolve(guided(time + 60000));
  await tick();
  assert.equal(pending.length, 1);
  client.stop();
  assert.equal(pending.length, 0);
});

test("guide expiry must be a safe time", () => {
  for (const expiresAt of [-1, 1.5, "soon"])
    assert.throws(
      () =>
        readBillDecision(
          {
            decision: {
              kind: "human-sign-in",
              guidance: { instruction: "x", available: true, expiresAt },
            },
          },
          "task1",
          validators,
        ),
      BillClientResponseError,
    );
});

test("a background guide check never makes the panel pending or refuses a choice", async () => {
  let time = 1000;
  const pending = [];
  const timers = {
    set: (callback, ms) => {
      const handle = { callback, at: time + ms };
      pending.push(handle);
      return handle;
    },
    clear: (handle) => {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const calls = [];
  const client = new BillDecisionClient({
    validators,
    now: () => time,
    timers,
    changed: () => {},
    request: (path, body) => {
      const d = deferred();
      calls.push({ path, body, ...d });
      return d.promise;
    },
  });
  const guided = () => {
    const value = decision();
    value.decision.guidance = {
      instruction: "Choose the saved card.",
      available: true,
      expiresAt: time + 60000,
    };
    return value;
  };
  client.start("task1");
  await tick();
  calls[0].resolve(guided());
  await tick();
  const widget = client.snapshot().decision.choice;
  // The timed check is sent and is still in flight.
  const timer = pending.shift();
  time = timer.at;
  timer.callback();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body, undefined);
  assert.equal(client.snapshot().pending, false);
  // A tap now is accepted. It waits for the check to settle, then is sent.
  const chosen = client.choose(widget, "card");
  assert.equal(client.snapshot().pending, true);
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(guided());
  await tick();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, {
    callbackData: widget.callbackData,
    contextKey: widget.contextKey,
    value: "card",
  });
  calls[2].resolve({ decision: { kind: "human-review" } });
  assert.equal(await chosen, true);
  // The check's older reply did not replace the choice's reply.
  assert.equal(client.snapshot().decision.kind, "human-review");
  assert.equal(client.snapshot().pending, false);
  // A failed check does not block a later choice either.
  client.start("task1");
  await tick();
  calls[3].resolve(guided());
  await tick();
  const next = pending.shift();
  time = next.at;
  next.callback();
  await tick();
  calls[4].reject(new Error("offline"));
  await tick();
  assert.equal(client.snapshot().pending, false);
  const again = client.choose(client.snapshot().decision.choice, "card");
  assert.equal(calls.length, 6);
  calls[5].resolve({ decision: { kind: "human-review" } });
  assert.equal(await again, true);
});

test("a hold for a question stops re-checks and sends a waiting command only after release", async () => {
  const time = 1000;
  const pending = [];
  const timers = {
    set: (callback, ms) => {
      const handle = { callback, at: time + ms };
      pending.push(handle);
      return handle;
    },
    clear: (handle) => {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  const calls = [];
  const client = new BillDecisionClient({
    validators,
    now: () => time,
    timers,
    changed: () => {},
    request: (path, body) => {
      const d = deferred();
      calls.push({ path, body, ...d });
      return d.promise;
    },
  });
  const guided = {
    decision: {
      kind: "human-sign-in",
      guidance: {
        instruction: "Sign in yourself.",
        available: true,
        expiresAt: time + 60000,
      },
    },
  };
  client.start("task1");
  await tick();
  calls[0].resolve(guided);
  await tick();
  assert.equal(pending.length, 1);
  client.hold();
  assert.equal(client.held, true);
  assert.equal(pending.length, 0, "no re-check while a question is answered");
  const shown = client.restoreGuidance();
  await tick();
  assert.equal(calls.length, 1, "the command waits for release");
  client.release();
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { action: "show-guidance" });
  calls[1].resolve(guided);
  assert.equal(await shown, true);
  assert.equal(pending.length, 1, "re-checks resume");
  // A hold can start while a command is waiting behind an in-flight check.
  pending.shift().callback();
  await tick();
  assert.equal(calls.length, 3);
  const queued = client.restoreGuidance();
  await tick();
  client.hold();
  calls[2].resolve(guided);
  await tick();
  assert.equal(calls.length, 3, "a later hold fences the queued command");
  client.release();
  await tick();
  assert.equal(calls.length, 4);
  calls[3].resolve(guided);
  assert.equal(await queued, true);
  // A command waiting in a hold is dropped when the task stops.
  client.hold();
  const dropped = client.refresh();
  client.stop();
  assert.equal(await dropped, false);
  assert.equal(calls.length, 4);
});
