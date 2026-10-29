// Durable deletion receipts decide when a reminder or event stops linking back to its note.
import assert from "node:assert/strict";
import test from "node:test";
import {
  deletedNoteOrigins,
  verifiedDeletedNoteOrigins,
  withoutDeletedNoteOrigins,
} from "../src/client/note-deleted-origins.ts";
import { addNoteOrigin, noteOriginIndex } from "../src/client/note-origin.ts";

const states = () => ({
  reminders: {
    sourceRevision: "s",
    reminders: [{ id: "r", status: "cancelled", occurrenceId: "o" }],
    deletions: {
      d: {
        owner: "owner",
        phase: "deleted",
        target: { sourceRevision: "s", row: { id: "r", occurrenceId: "o" } },
      },
    },
  },
  calendar: {
    sourceRevision: "s",
    events: [],
    deletions: {
      d: {
        owner: "owner",
        phase: "deleted",
        target: { sourceRevision: "s", row: { id: "e" } },
      },
    },
  },
});
const read = ({ reminders, calendar }) =>
  verifiedDeletedNoteOrigins(reminders, calendar, (owner) => owner === "owner");

test("a committed deletion retires reminder and whole-event links, including after restart", () => {
  const saved = JSON.parse(JSON.stringify(states()));
  assert.deepEqual(read(saved), [
    { kind: "reminder", id: "r" },
    { kind: "event", id: "e" },
  ]);
});

test("Undo, pending, unknown, conflict and other-owner receipts keep both links", () => {
  for (const phase of [
    "queued",
    "paused",
    "undone",
    "unknown",
    "dispatching",
    "conflict",
  ]) {
    const s = states();
    s.reminders.deletions.d.phase = s.calendar.deletions.d.phase = phase;
    assert.deepEqual(read(s), []);
  }
  const s = states();
  s.reminders.deletions.d.owner = s.calendar.deletions.d.owner = "other";
  assert.deepEqual(read(s), []);
});

test("source replacement and reused IDs do not retire newer links", () => {
  for (const mutate of [
    (s) => {
      s.reminders.sourceRevision = s.calendar.sourceRevision = "new";
    },
    (s) => {
      s.reminders.reminders[0].occurrenceId = "new";
      s.calendar.events.push({ id: "e" });
    },
    (s) => {
      s.reminders.reminders[0].status = "scheduled";
      s.calendar.deletions.d.target.row.seriesId = "series";
    },
  ]) {
    const s = states();
    mutate(s);
    assert.deepEqual(read(s), []);
  }
  const s = states();
  s.calendar.deletions.d.target.row.id = "series:occ:123";
  assert.deepEqual(read(s), [{ kind: "reminder", id: "r" }]);
});

test("the receipts port is read once each and pruning removes only deleted links", async () => {
  const calls = [];
  const s = states();
  const port = {
    reminders: async () => {
      calls.push("reminders");
      return s.reminders;
    },
    events: async () => {
      calls.push("events");
      return s.calendar;
    },
    visible: (owner) => owner === "owner",
  };
  const deleted = await deletedNoteOrigins(port);
  assert.deepEqual(calls, ["reminders", "events"]);
  const origin = { version: 2, noteId: "n1", revision: "b".repeat(64) };
  let index = noteOriginIndex(null);
  for (const [kind, id] of [
    ["reminder", "r"],
    ["event", "e"],
    ["event", "kept"],
  ])
    index = addNoteOrigin(index, kind, id, origin, 1);
  const pruned = withoutDeletedNoteOrigins(index, deleted);
  assert.deepEqual(Object.keys(pruned.links), ["event:kept"]);
  assert.equal(withoutDeletedNoteOrigins(pruned, []), pruned);
});
