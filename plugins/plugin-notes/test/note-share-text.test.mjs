import assert from "node:assert/strict";
import test from "node:test";
import { noteShareText } from "../src/client/note-share-text.ts";

test("text and checklist export keeps complete lines and completion state", () => {
  assert.equal(
    noteShareText({ kind: "text", title: "Draft", body: "one\n\ntwo" }).text,
    "Draft\n\none\n\ntwo",
  );
  assert.equal(
    noteShareText({
      kind: "list",
      title: "List",
      items: [{ t: "milk", done: true }, { t: "bread" }],
    }).text,
    "List\n\n[x] milk\n[ ] bread",
  );
  assert.deepEqual(noteShareText({ kind: "text" }), {
    title: "Note",
    text: "Note",
  });
});

test("a link note shares its exact URL and saved clips", () => {
  assert.equal(
    noteShareText({
      kind: "link",
      title: "Source",
      url: "https://example.org/path?a=1",
      clips: ["saved excerpt"],
    }).text,
    "Source\n\nhttps://example.org/path?a=1\n\nsaved excerpt",
  );
});

test("voice text includes the actual transcript and excludes audio", () => {
  const text = noteShareText({
    kind: "voice",
    title: "Meeting",
    lines: [
      { s: "me", t: "Exact words" },
      { s: "p1", t: "Next words" },
    ],
    summary: ["Summary"],
    actions: [{ t: "Call", done: false }],
  }).text;
  assert.match(text, /Transcript\nExact words\nNext words/);
  assert.match(text, /audio not included/);
  assert.match(text, /Summary\nSummary/);
  assert.match(text, /\[ \] Call/);
  assert.match(noteShareText({ kind: "voice" }).text, /No transcript saved/);
  assert.match(
    noteShareText({ kind: "voice", body: "Saved body transcript" }).text,
    /Transcript\nSaved body transcript/,
  );
  assert.match(
    noteShareText({ kind: "voice", audio: { transcript: "Saved audio" } }).text,
    /Transcript\nSaved audio/,
  );
  assert.throws(() => noteShareText({ kind: "unknown" }), /supported text/);
});
