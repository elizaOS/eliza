// Back-references from a saved reminder or event to the voice note its draft came from.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addNoteOrigin,
  findNoteOrigin,
  NOTE_ORIGIN_LIMIT,
  noteOriginFor,
  noteOriginIndex,
  noteOriginKey,
  noteOriginOf,
  noteOriginTitle,
  removeNoteOrigin,
  resolveNoteOrigin,
} from "../src/client/note-origin.ts";

const revision = "a".repeat(64);
const note = {
  id: "n1",
  kind: "voice",
  title: "Venue meeting",
  body: "Transcript",
  audio: { audioId: "audio-1" },
};
const origin = noteOriginFor(note, revision);
const empty = () => noteOriginIndex(null);

test("an origin is the note id, its recording and the reviewed revision only; the title is never stored", () => {
  assert.deepEqual(origin, {
    version: 1,
    noteId: "n1",
    audioId: "audio-1",
    revision,
  });
  assert.equal(
    JSON.stringify(origin).includes("Venue meeting"),
    false,
    "the note title is note content and is not carried",
  );
  assert.equal(noteOriginTitle(note), "Venue meeting");
  assert.equal(
    noteOriginTitle({ ...note, title: "Renamed later" }),
    "Renamed later",
    "the shown title is the current one",
  );
  assert.equal(noteOriginTitle({ ...note, title: "" }), "Voice note");
  assert.equal(
    noteOriginTitle({ ...note, title: "Line\nbreak" }),
    "Line break",
  );
  assert.equal(
    noteOriginTitle({ ...note, title: "x".repeat(300) }).length,
    120,
  );
  assert.equal(
    noteOriginFor({ id: "n1", title: "Text note" }, revision),
    undefined,
    "a note without a recording has no origin",
  );
  assert.equal(noteOriginFor(note, "not-a-hash"), undefined);
  for (const bad of [
    null,
    {},
    { ...origin, version: 2 },
    { ...origin, noteId: "" },
    { ...origin, audioId: 7 },
    { ...origin, revision: "A".repeat(64) },
    { ...origin, noteId: "a\u0000b" },
  ])
    assert.equal(noteOriginOf(bad), undefined);
  assert.deepEqual(
    noteOriginOf({
      ...origin,
      title: "Private title",
      body: "leaked content",
      extra: 1,
    }),
    origin,
    "a title and unknown fields are dropped, never stored",
  );
  const withTitle = addNoteOrigin(
    noteOriginIndex(null),
    "event",
    "e9",
    { ...origin, title: "Private title" },
    1,
  );
  assert.equal(
    JSON.stringify(withTitle).includes("Private title"),
    false,
    "the stored index holds no title",
  );
  assert.equal(
    JSON.stringify(
      noteOriginIndex({
        version: 1,
        links: {
          "event:e9": { ...origin, title: "Private title", savedAt: 1 },
        },
      }),
    ).includes("Private title"),
    false,
    "a title in an older stored link is dropped on read",
  );
});

test("links are keyed by the saved record; a record keeps the note it was created from", () => {
  let index = addNoteOrigin(empty(), "reminder", "r1", origin, 10);
  index = addNoteOrigin(index, "event", "e1", origin, 11);
  assert.deepEqual(findNoteOrigin(index, "reminder", "r1"), origin);
  assert.deepEqual(findNoteOrigin(index, "event", "e1"), origin);
  assert.equal(
    findNoteOrigin(index, "event", "r1"),
    undefined,
    "a reminder id never resolves as an event",
  );
  assert.equal(findNoteOrigin(index, "reminder", "e1"), undefined);
  assert.equal(findNoteOrigin(index, "event", "e2"), undefined);
  const other = noteOriginFor(
    { ...note, id: "n2", audio: { audioId: "audio-2" }, title: "Other" },
    revision,
  );
  assert.equal(
    addNoteOrigin(index, "event", "e1", other, 12),
    index,
    "a second hand-off cannot relink an existing record",
  );
  assert.deepEqual(findNoteOrigin(index, "event", "e1"), origin);
  assert.throws(
    () => addNoteOrigin(index, "event", "e3", { ...origin, revision: "x" }, 12),
    /Invalid note link/,
  );
  assert.throws(
    () => addNoteOrigin(index, "event", "", origin, 12),
    /Invalid note link/,
  );
  index = removeNoteOrigin(index, "event", "e1");
  assert.equal(findNoteOrigin(index, "event", "e1"), undefined);
  assert.deepEqual(
    findNoteOrigin(index, "reminder", "r1"),
    origin,
    "removing one link leaves the others",
  );
  assert.equal(removeNoteOrigin(index, "event", "missing"), index);
});

test("a repeating event has one link for the series", () => {
  assert.equal(noteOriginKey("event", "abc:occ:1700000000000"), "event:abc");
  assert.equal(noteOriginKey("reminder", "abc:occ:1"), "reminder:abc:occ:1");
  const index = addNoteOrigin(
    empty(),
    "event",
    "abc:occ:1700000000000",
    origin,
    1,
  );
  assert.deepEqual(findNoteOrigin(index, "event", "abc"), origin);
  assert.deepEqual(
    findNoteOrigin(index, "event", "abc:occ:1700086400000"),
    origin,
  );
});

test("the index is bounded and a malformed index is refused, never partly trusted", () => {
  let index = empty();
  for (let i = 0; i <= NOTE_ORIGIN_LIMIT; i++)
    index = addNoteOrigin(index, "reminder", "r" + i, origin, i);
  assert.equal(Object.keys(index.links).length, NOTE_ORIGIN_LIMIT);
  assert.equal(
    findNoteOrigin(index, "reminder", "r0"),
    undefined,
    "the oldest link makes room",
  );
  assert.deepEqual(
    findNoteOrigin(index, "reminder", "r" + NOTE_ORIGIN_LIMIT),
    origin,
  );
  assert.deepEqual(noteOriginIndex(JSON.parse(JSON.stringify(index))), index);
  for (const bad of [
    [],
    { version: 2, links: {} },
    { version: 1 },
    { version: 1, links: [] },
    { version: 1, links: {}, extra: 1 },
    { version: 1, links: { "note:x": { ...origin, savedAt: 1 } } },
    { version: 1, links: { "event:x": { ...origin } } },
    {
      version: 1,
      links: { "event:x": { ...origin, revision: "bad", savedAt: 1 } },
    },
  ])
    assert.throws(() => noteOriginIndex(bad), /need recovery/);
});

test("opening the note fails closed when it was deleted, replaced or duplicated", () => {
  assert.equal(resolveNoteOrigin(origin, [note]).status, "found");
  assert.equal(
    resolveNoteOrigin(origin, [{ ...note, body: "Edited later" }]).status,
    "found",
    "an edited note is still the same note",
  );
  assert.equal(resolveNoteOrigin(origin, []).status, "missing");
  assert.equal(
    resolveNoteOrigin(origin, undefined).status,
    "missing",
    "an unread Notes list is missing, not found",
  );
  assert.equal(
    resolveNoteOrigin(origin, [{ ...note, id: "n2" }]).status,
    "missing",
  );
  assert.equal(
    resolveNoteOrigin(origin, [{ ...note, audio: { audioId: "audio-9" } }])
      .status,
    "missing",
    "the same id with another recording is a different note",
  );
  assert.equal(
    resolveNoteOrigin(origin, [
      { id: "n1", kind: "text", title: "Venue meeting" },
    ]).status,
    "missing",
  );
  assert.equal(
    resolveNoteOrigin(origin, [note, { ...note }]).status,
    "missing",
    "an ambiguous id opens nothing",
  );
  assert.equal(
    resolveNoteOrigin({ ...origin, revision: "x" }, [note]).status,
    "missing",
  );
});

test("a host may name its own untitled-note fallback", () => {
  assert.equal(noteOriginTitle({ title: "" }, "Recording"), "Recording");
  assert.equal(noteOriginTitle(undefined), "Voice note");
});
