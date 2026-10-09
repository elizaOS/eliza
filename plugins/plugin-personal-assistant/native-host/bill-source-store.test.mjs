import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBillSourceStore } from "./bill-source-store.mjs";

const owner = {
  actorId: "owner",
  agentId: "agent",
  connector: { source: "app", accountId: "owner" },
};
const candidate = {
  billId: "a".repeat(64),
  candidateId: "b".repeat(64),
  sourceRef: `bill-source:${"a".repeat(64)}`,
  facts: {
    company: "Test",
    origin: "https://example.org",
    accountLabel: "Ending 1234",
    amountMinor: 12345,
    currency: "USD",
    currencyDigits: 2,
    dueDate: "2026-10-01",
  },
  sources: [
    {
      kind: "gmail-message",
      messageId: "m1",
      accountRef: "c".repeat(64),
      contentSha256: "d".repeat(64),
    },
  ],
};
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const task = {
    id: "task",
    owner,
    revision: 1,
    epoch: 0,
    status: "active",
    authorization: { state: "active" },
    observation: null,
    operations: [],
    allowedOrigins: ["https://example.org"],
  };
  const tasks = {
    get: (id, o) =>
      id === task.id && JSON.stringify(o) === JSON.stringify(owner)
        ? structuredClone(task)
        : null,
  };
  let time = 1000;
  const store = createBillSourceStore(db, tasks, { now: () => time });
  const api = store.forTask({ owner }, task.id);
  const result = { status: "candidate", candidates: [candidate] };
  const offer = () => api.offer(result, task.revision);
  const input = (o) => ({
    offerId: o.offerId,
    candidateId: candidate.candidateId,
    expectedRevision: o.expectedRevision,
  });
  return {
    db,
    task,
    tasks,
    api,
    store,
    result,
    offer,
    input,
    expire: () => (time += 300001),
  };
}
test("selection survives store recreation, deduplicates retry and is owner bound", (t) => {
  const f = fixture(t),
    offer = f.offer(),
    input = f.input(offer);
  const selection = f.api.select(input, f.result);
  assert.equal(selection.candidate.facts.amountMinor, 12345);
  f.task.operations.push({ status: "succeeded" });
  assert.deepEqual(f.api.select(input, f.result), selection);
  assert.deepEqual(
    createBillSourceStore(f.db, f.tasks).forTask({ owner }, "task").load(),
    selection,
  );
  assert.throws(() =>
    f.store.forTask({ owner: { ...owner, actorId: "other" } }, "task").load(),
  );
  assert.throws(() =>
    f.api.select({ ...input, candidateId: "e".repeat(64) }, f.result),
  );
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM bill_source_selections_v1").get().n,
    1,
  );
});
test("stale offers and changed source contents cannot select", (t) => {
  const f = fixture(t),
    old = f.offer();
  f.offer();
  assert.throws(() => f.api.select(f.input(old), f.result));
  const fresh = f.offer(),
    changed = structuredClone(f.result);
  changed.candidates[0].sources[0].contentSha256 = "e".repeat(64);
  assert.throws(() => f.api.select(f.input(fresh), changed));
  assert.equal(f.api.load(), null);
  f.expire();
  assert.throws(() => f.api.select(f.input(fresh), f.result));
});
test("pause, new epoch, preparation and source-scope changes invalidate selection", (t) => {
  const f = fixture(t),
    o = f.offer();
  for (const mutate of [
    () => (f.task.status = "paused"),
    () => f.task.epoch++,
    () => (f.task.observation = {}),
    () => f.task.operations.push({}),
    () => (f.task.allowedOrigins = []),
  ]) {
    const before = structuredClone(f.task);
    mutate();
    assert.throws(() => f.api.select(f.input(o), f.result));
    Object.assign(f.task, before);
  }
  assert.equal(f.api.load(), null);
});
test("multiple invoices permit an explicit choice but conflicting versions and incomplete results do not", (t) => {
  const f = fixture(t);
  const other = {
    ...structuredClone(candidate),
    billId: "e".repeat(64),
    sourceRef: `bill-source:${"e".repeat(64)}`,
    candidateId: "f".repeat(64),
  };
  const ambiguous = { status: "ambiguous", candidates: [candidate, other] };
  const conflict = { ...ambiguous, reason: "conflicting-invoice" };
  let o = f.api.offer(conflict, 1);
  assert.throws(() => f.api.select(f.input(o), conflict));
  o = f.api.offer({ status: "incomplete", candidates: [] }, 1);
  assert.throws(() => f.api.select(f.input(o), f.result));
  o = f.api.offer(ambiguous, 1);
  assert.equal(
    f.api.select(f.input(o), ambiguous).candidate.billId,
    candidate.billId,
  );
});
test("write failure produces no selected record and can retry only persistence", (t) => {
  const f = fixture(t),
    o = f.offer(),
    i = f.input(o);
  f.db.exec(
    "CREATE TRIGGER fail_selection BEFORE INSERT ON bill_source_selections_v1 BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;",
  );
  assert.throws(() => f.api.select(i, f.result));
  assert.equal(f.api.load(), null);
  f.db.exec("DROP TRIGGER fail_selection");
  assert.equal(f.api.select(i, f.result).candidate.candidateId, i.candidateId);
});

test("validated source links survive selection while non-Gmail or default-account links reject", (t) => {
  const f = fixture(t),
    result = structuredClone(f.result);
  const source = result.candidates[0].sources[0];
  source.threadId = "thread1";
  source.url =
    "https://mail.google.com/mail/u/person%40example.org/#all/thread1";
  const offer = f.api.offer(result, 1),
    selected = f.api.select(f.input(offer), result);
  assert.equal(selected.candidate.sources[0].url, source.url);
  assert.equal(f.api.load().candidate.sources[0].url, source.url);
});
test("an invalid source link cannot enter a durable offer", (t) => {
  const f = fixture(t);
  for (const url of [
    "https://evil.example/",
    "https://mail.google.com/mail/u/0/#all/thread1",
  ]) {
    const result = structuredClone(f.result);
    Object.assign(result.candidates[0].sources[0], {
      threadId: "thread1",
      url,
    });
    assert.throws(() => f.api.offer(result, 1));
  }
});

test("complete source offers persist more than one hundred candidates and sources", (t) => {
  const f = fixture(t);
  const sources = Array.from({ length: 101 }, (_, i) => ({
    ...candidate.sources[0],
    messageId: `m${i}`,
  }));
  const candidates = Array.from({ length: 101 }, (_, i) => ({
    ...structuredClone(candidate),
    candidateId: i.toString(16).padStart(64, "0"),
    sources,
  }));
  const result = { status: "ambiguous", candidates };
  const offer = f.api.offer(result, f.task.revision);
  const selected = f.api.select(
    {
      offerId: offer.offerId,
      candidateId: candidates[100].candidateId,
      expectedRevision: f.task.revision,
    },
    result,
  );
  assert.equal(offer.candidates.length, 101);
  assert.equal(selected.candidate.sources.length, 101);
  assert.deepEqual(f.api.load(), selected);
});

test("look-alike sources and newest-first facts survive an offer; a conflicting source cannot select", (t) => {
  const f = fixture(t);
  const conflict = { differs: ["origin"] };
  const conflicting = {
    status: "conflicting-source",
    candidates: [],
    conflicts: [
      { differs: ["company"] },
      { differs: ["accountLabel", "origin"] },
      { differs: ["company", "accountLabel", "origin"] },
    ],
    unreadable: 1,
  };
  const offer = f.api.offer(conflicting, f.task.revision);
  assert.equal(offer.status, "conflicting-source");
  assert.deepEqual(offer.conflicts, conflicting.conflicts);
  assert.equal(offer.unreadable, 1);
  assert.throws(() =>
    f.api.select(
      {
        offerId: offer.offerId,
        candidateId: candidate.candidateId,
        expectedRevision: offer.expectedRevision,
      },
      conflicting,
    ),
  );
  const { dueDate: _dueDate, ...facts } = candidate.facts;
  const newest = {
    ...candidate,
    facts,
    receivedAt: "2026-09-20T00:00:00.000Z",
    mostRecent: true,
  };
  const ranked = f.api.offer(
    { status: "candidate", candidates: [newest], conflicts: [conflict] },
    f.task.revision,
  );
  assert.equal(ranked.candidates[0].mostRecent, true);
  assert.equal(ranked.candidates[0].facts.dueDate, undefined);
  const withheld = f.api.offer(
    {
      status: "incomplete",
      reason: "newer-unreadable",
      candidates: [],
      unreadable: 1,
    },
    f.task.revision,
  );
  assert.equal(withheld.reason, "newer-unreadable");
  assert.deepEqual(withheld.candidates, []);
  for (const bad of [
    { ...conflicting, conflicts: [] },
    { ...conflicting, conflicts: [{ ...conflict, body: "private" }] },
    // The look-alike's own website is never carried.
    {
      ...conflicting,
      conflicts: [{ ...conflict, origin: "https://lookalike.example" }],
    },
    { ...conflicting, conflicts: [{ differs: [] }] },
    { ...conflicting, conflicts: [{ differs: ["origin", "company"] }] },
    { ...conflicting, conflicts: [{ differs: ["website"] }] },
    { ...conflicting, conflicts: [conflict, conflict] },
    { ...conflicting, reason: "newer-unreadable" },
    { status: "incomplete", candidates: [], reason: "newer-unreadable" },
    { status: "candidate", candidates: [newest], reason: "newer-unreadable" },
    { ...conflicting, unreadable: 0 },
    { ...conflicting, candidates: [candidate] },
    {
      status: "ambiguous",
      candidates: [newest, { ...newest, candidateId: "e".repeat(64) }],
    },
    {
      status: "candidate",
      candidates: [{ ...newest, receivedAt: "2026-09-20T00:00:00Z" }],
    },
  ])
    assert.throws(() => f.api.offer(bad, f.task.revision));
});
