import assert from "node:assert/strict";
import test from "node:test";
import { createNotesTrashPolicy } from "../src/client/notes-trash-policy.ts";

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 9, 7, 12);
const policy = createNotesTrashPolicy({
  retentionMs: 3 * DAY,
  maxEntries: 100,
  maxBytes: 1024 * 1024,
  kinds: ["text", "voice"],
  recordingKind: "voice",
});
const text = { id: "text-1", kind: "text", title: "Groceries", body: "Milk" };
const voice = {
  id: "voice-1",
  kind: "voice",
  title: "Standup",
  audio: { audioId: "audio-1" },
};
const entry = (note, id, deletedAt, extra = {}) => ({
  id,
  note,
  index: 0,
  deletedAt,
  ...extra,
});

test("host options are required and malformed rows are refused, never guessed", () => {
  assert.throws(() => createNotesTrashPolicy({ ...policy, retentionMs: 0 }));
  assert.deepEqual(policy.validate(null), { version: 1, entries: [] });
  for (const bad of [
    { version: 2, entries: [] },
    { version: 1, entries: [], extra: true },
    { version: 1, entries: [entry(text, "a", t0), entry(text, "b", t0)] },
    { version: 1, entries: [entry({ ...text, kind: "link" }, "a", t0)] },
    { version: 1, entries: [entry(text, "bad id!", t0)] },
    { version: 1, entries: [entry(text, "a", 0)] },
    {
      version: 1,
      entries: [entry(text, "a", t0, { audio: { audioId: "audio-1" } })],
    },
    {
      version: 1,
      entries: [entry(voice, "a", t0, { audio: { audioId: "other" } })],
    },
    {
      version: 1,
      entries: [
        entry(text, "a", t0, {
          target: { noteId: "other", revision: "r", sourceId: "s" },
        }),
      ],
    },
  ])
    assert.throws(() => policy.validate(bad));
  const noRecordings = createNotesTrashPolicy({
    retentionMs: DAY,
    maxEntries: 1,
    maxBytes: 4096,
    kinds: ["voice"],
  });
  assert.throws(() =>
    noRecordings.validate({
      version: 1,
      entries: [entry(voice, "a", t0, { audio: { audioId: "audio-1" } })],
    }),
  );
  assert.throws(
    () =>
      noRecordings.validate({
        version: 1,
        entries: [entry(voice, "a", t0), entry(text, "b", t0)],
      }),
    /full/,
  );
});

test("retention boundary, days left and an idempotent plan", () => {
  const due = entry(text, "op-1", t0);
  assert.equal(policy.expired(due, t0 + 3 * DAY - 1), false);
  assert.equal(policy.expired(due, t0 + 3 * DAY), true);
  assert.equal(policy.daysLeft(due, t0), 3);
  assert.equal(policy.daysLeft(due, t0 + 2 * DAY + 1), 1);
  assert.equal(policy.daysLeft(due, t0 + 3 * DAY), 0);
  // A clock moved backwards never advances the purge.
  assert.equal(policy.daysLeft(due, t0 - 10 * DAY), 3);
  let doc = policy.add(policy.empty(), due);
  doc = policy.add(
    doc,
    entry(voice, "op-2", t0 + DAY, { audio: { audioId: "audio-1" } }),
  );
  doc = policy.add(doc, entry({ ...text, id: "live" }, "op-3", t0));
  assert.throws(() => policy.add(doc, entry(text, "op-1", t0)));
  const plan = policy.plan(doc, new Set(["live"]), t0 + 3 * DAY);
  assert.deepEqual(
    plan.stale.map((e) => e.id),
    ["op-3"],
  );
  assert.deepEqual(
    plan.expired.map((e) => e.id),
    ["op-1"],
  );
  assert.deepEqual(
    plan.kept.map((e) => e.id),
    ["op-2"],
  );
  const after = policy.remove(doc, [
    ...plan.stale.map((e) => e.id),
    ...plan.expired.map((e) => e.id),
  ]);
  const again = policy.plan(after, new Set(["live"]), t0 + 3 * DAY);
  assert.deepEqual([again.stale.length, again.expired.length], [0, 0]);
  assert.deepEqual(
    policy.sorted(doc).map((e) => e.id),
    ["op-2", "op-3", "op-1"],
  );
});

test("restore reinserts the exact record and never replaces a live note", () => {
  const trashed = entry(text, "op-1", t0, { index: 1 });
  const list = [{ id: "a", kind: "text", title: "A" }];
  const restored = policy.restore(list, trashed);
  assert.deepEqual(
    restored.map((n) => n.id),
    ["a", "text-1"],
  );
  assert.deepEqual(restored[1], text);
  assert.notEqual(restored[1], text);
  assert.throws(() => policy.restore(restored, trashed));
});
