// Owner-chosen Notes import and export rules. Browser downloads and file inputs are exercised by
// host browser specs; these are the pure rules.
import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTE_PDF_BASE64_LIMIT,
  noteDocumentFileName,
  noteImportText,
  notePdfBytes,
} from "../src/client/note-documents.ts";

test("download names drop path and control characters and fall back when blank", () => {
  assert.equal(
    noteDocumentFileName('a/b\\c:d*e?"f<g>h|i\u0001', "Note", 160),
    "a_b_c_d_e__f_g_h_i_",
  );
  assert.equal(noteDocumentFileName("", "Scan", 100), "Scan");
  assert.equal(noteDocumentFileName(undefined, "Scan", 100), "Scan");
  assert.equal(noteDocumentFileName("x".repeat(300), "Note", 160).length, 160);
});

test("a PDF export must be bounded base64 that starts with the PDF signature", () => {
  const pdf = Buffer.from("%PDF-1.7\n%%EOF").toString("base64");
  assert.equal(new TextDecoder().decode(notePdfBytes(pdf)), "%PDF-1.7\n%%EOF");
  for (const bad of [
    "",
    undefined,
    42,
    "abc",
    "!!!!",
    Buffer.from("not a pdf").toString("base64"),
    "A".repeat(NOTE_PDF_BASE64_LIMIT + 4),
  ])
    assert.throws(() => notePdfBytes(bad), /Invalid PDF export/);
});

test("imported text must be strict UTF-8 without NUL", () => {
  assert.equal(
    noteImportText(new TextEncoder().encode("Grüße").buffer),
    "Grüße",
  );
  assert.equal(
    noteImportText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer),
    "﻿a",
    "a byte-order mark is kept, not silently dropped",
  );
  assert.throws(() => noteImportText(new Uint8Array([0xff, 0xfe]).buffer));
  assert.throws(
    () => noteImportText(new Uint8Array([0x61, 0]).buffer),
    /Binary/,
  );
});
