// A canonical note becomes a reviewed Calendar or reminder draft with an identity-only back-link.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addNoteOrigin,
  findNoteLink,
  findNoteOrigin,
  noteLinkOf,
  noteOriginIndex,
  recordNoteOriginOf,
  recordNoteRevision,
  resolveNoteLink,
} from "../src/client/note-origin.ts";
import {
  NOTE_SCHEDULE_TEXT_LIMIT,
  noteScheduleDraft,
  noteScheduleText,
} from "../src/client/note-schedule-draft.ts";

const note = (patch = {}) => ({
  id: "n1",
  title: "Venue plan",
  body: "Book the venue",
  color: "yellow",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

test("draft text is open actions, then open list items, then the body", () => {
  assert.equal(
    noteScheduleText(
      note({
        format: {
          kind: "voice",
          data: {
            actions: [
              { t: "Email the caterer", done: false },
              { t: "Done already", done: true },
              { t: "  ", done: false },
            ],
            items: [{ t: "ignored", done: false }],
          },
        },
      }),
    ),
    "Email the caterer",
  );
  assert.equal(
    noteScheduleText(
      note({
        format: {
          kind: "list",
          data: {
            items: [
              { t: "Milk", done: false },
              { t: "Bread", done: true },
              { t: "Eggs" },
            ],
          },
        },
      }),
    ),
    "Milk\nEggs",
  );
  assert.equal(noteScheduleText(note()), "Book the venue");
});

test("a ready draft carries the note title, text and a record link; never more", async () => {
  const result = await noteScheduleDraft(note(), "event");
  assert.equal(result.status, "ready");
  assert.deepEqual(Object.keys(result.draft).sort(), [
    "kind",
    "notes",
    "origin",
    "title",
  ]);
  assert.equal(result.draft.notes, "Book the venue");
  assert.deepEqual(result.draft.origin, {
    version: 2,
    noteId: "n1",
    revision: await recordNoteRevision(note()),
  });
  assert.match(result.draft.origin.revision, /^[a-f0-9]{64}$/);
});

test("an empty or overlong note opens no draft", async () => {
  assert.equal(
    (await noteScheduleDraft(note({ body: "  " }), "reminder")).status,
    "empty",
  );
  const long = await noteScheduleDraft(
    note({ body: "x".repeat(NOTE_SCHEDULE_TEXT_LIMIT + 1) }),
    "reminder",
  );
  assert.equal(long.status, "too-long");
  assert.match(long.message, /Nothing scheduled/);
});

test("the record revision changes with authored content only", async () => {
  const base = await recordNoteRevision(note());
  assert.equal(
    await recordNoteRevision(
      note({ updatedAt: "2027-01-01T00:00:00.000Z", color: "rose" }),
    ),
    base,
  );
  assert.notEqual(
    await recordNoteRevision(note({ body: "Book the hall" })),
    base,
  );
  assert.notEqual(await recordNoteRevision(note({ title: "Hall plan" })), base);
});

test("record links are stored beside recording links and resolve by exact id only", async () => {
  const origin = (await noteScheduleDraft(note(), "event")).draft.origin;
  assert.equal(
    recordNoteOriginOf({ ...origin, title: "leak" }).title,
    undefined,
  );
  assert.equal(recordNoteOriginOf({ ...origin, revision: "x" }), undefined);
  assert.equal(recordNoteOriginOf({ ...origin, version: 1 }), undefined);
  const index = noteOriginIndex(
    JSON.parse(
      JSON.stringify(
        addNoteOrigin(noteOriginIndex(null), "event", "e1:occ:5", origin, 7),
      ),
    ),
  );
  assert.deepEqual(findNoteLink(index, "event", "e1"), origin);
  assert.equal(
    findNoteOrigin(index, "event", "e1"),
    undefined,
    "recording-only readers never see a record link",
  );
  assert.equal(resolveNoteLink(origin, [note()]).status, "found");
  assert.equal(resolveNoteLink(origin, [note({ id: "n2" })]).status, "missing");
  assert.equal(resolveNoteLink(origin, [note(), note()]).status, "missing");
  assert.equal(resolveNoteLink(origin, undefined).status, "missing");
  const recording = {
    version: 1,
    noteId: "n1",
    audioId: "a1",
    revision: "c".repeat(64),
  };
  assert.deepEqual(noteLinkOf(recording), recording);
  assert.equal(
    resolveNoteLink(recording, [note()]).status,
    "missing",
    "a recording link still needs the same recording",
  );
});
