import assert from "node:assert/strict";
import { test } from "node:test";
import { isJournalEntry, nextStep } from "../src/client.ts";

const base = {
  scope: "a".repeat(64),
  proposalId: "p1",
  operationId: "op-1",
  operationHash: "b".repeat(64),
  record: { operation: { type: "create_note" } },
  createdAt: 1,
};

test("only a reserved entry may be dispatched; applying and unknown outcomes reconcile", () => {
  assert.deepEqual(nextStep({ ...base, phase: "reserved" }), {
    kind: "dispatch",
  });
  assert.deepEqual(
    nextStep({ ...base, phase: "applying", attemptId: "a1", applyingAt: 5 }),
    { kind: "reconcile", since: 5 },
  );
  assert.deepEqual(
    nextStep({
      ...base,
      phase: "terminal",
      status: "unknown",
      summary: "Lost",
      finishedAt: 9,
    }),
    { kind: "reconcile", since: 9 },
  );
  const done = {
    ...base,
    phase: "terminal",
    status: "succeeded",
    summary: "Done",
    attemptId: "a1",
  };
  assert.deepEqual(nextStep(done), { kind: "settled", entry: done });
  assert.throws(() => nextStep({ ...base, phase: "other" }));
});

test("bridge entries are shape-checked before use", () => {
  assert.equal(isJournalEntry({ ...base, phase: "reserved" }), true);
  assert.equal(
    isJournalEntry({ ...base, phase: "applying", attemptId: "a1" }),
    true,
  );
  assert.equal(
    isJournalEntry({
      ...base,
      phase: "terminal",
      status: "cancelled",
      summary: "Rejected",
    }),
    true,
  );
  assert.equal(
    isJournalEntry({
      ...base,
      phase: "terminal",
      status: "succeeded",
      summary: "No dispatch",
    }),
    false,
  );
  assert.equal(
    isJournalEntry({ ...base, phase: "reserved", status: "failed" }),
    false,
  );
  assert.equal(
    isJournalEntry({ ...base, scope: "short", phase: "reserved" }),
    false,
  );
  assert.equal(
    isJournalEntry({ ...base, proposalId: "../x", phase: "reserved" }),
    false,
  );
  assert.equal(
    isJournalEntry({ ...base, record: [], phase: "reserved" }),
    false,
  );
  assert.equal(isJournalEntry(null), false);
});
