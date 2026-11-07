import assert from "node:assert/strict";
import test from "node:test";
import {
  documentSourceOf,
  recordingRevision,
  recordingSourceOf,
  retainedSourceReferences,
  summarySourceOf,
  webSourceOf,
} from "../src/documents/source-links.ts";

const sha = "a".repeat(64);
const document = {
  version: 1,
  name: "report.pdf",
  mimeType: "application/pdf",
  sha256: sha,
  size: 1200,
  reference: `a1:${"b".repeat(64)}`,
};

test("document links keep exact-byte identity and drop malformed references", () => {
  assert.deepEqual(documentSourceOf({ ...document, extra: true }), document);
  const { reference: _dropped, ...withoutReference } = document;
  assert.deepEqual(
    documentSourceOf({ ...document, reference: "c1:x" }),
    withoutReference,
    "a malformed reference is dropped, not kept",
  );
  assert.equal(
    documentSourceOf({
      ...document,
      reference: "b1:123e4567-e89b-42d3-a456-426614174000",
    })?.reference,
    "b1:123e4567-e89b-42d3-a456-426614174000",
  );
  for (const patch of [
    { version: 2 },
    { name: "" },
    { name: "a/b.pdf" },
    { name: "x".repeat(121) },
    { mimeType: "image/gif" },
    { sha256: "A".repeat(64) },
    { size: -1 },
    { size: 5 * 1024 * 1024 + 1 },
    { size: 1.5 },
  ])
    assert.equal(documentSourceOf({ ...document, ...patch }), undefined);
  assert.equal(documentSourceOf(null), undefined);
});

test("web links are credential-free HTTPS pages the host does not treat as sensitive", () => {
  const page = {
    kind: "web-page",
    version: 1,
    name: "Garden",
    url: "https://example.com/a?b=1",
  };
  assert.deepEqual(webSourceOf(page), page);
  for (const url of [
    "http://example.com/",
    "https://user:pw@example.com/",
    "https://exa mple.com/",
    "not a url",
    `https://example.com/${"x".repeat(4100)}`,
  ])
    assert.equal(webSourceOf({ ...page, url }), undefined, url);
  assert.equal(
    webSourceOf(page, (url) => url.includes("example.com")),
    undefined,
    "the host's reading policy can refuse a page",
  );
  assert.equal(webSourceOf({ ...page, name: " " }), undefined);
});

test("recording links name an exact revision", async () => {
  const note = { id: "n1", transcript: "hello" };
  const revision = await recordingRevision(note);
  assert.match(revision, /^[a-f0-9]{64}$/);
  assert.equal(
    revision,
    await recordingRevision({ id: "n1", transcript: "hello" }),
  );
  assert.notEqual(
    revision,
    await recordingRevision({ id: "n1", transcript: "hello!" }),
  );
  const link = {
    kind: "recording",
    version: 1,
    name: "Standup",
    noteId: "n1",
    revision,
  };
  assert.deepEqual(recordingSourceOf(link), link);
  assert.equal(recordingSourceOf({ ...link, revision: "x" }), undefined);
  assert.equal(recordingSourceOf({ ...link, noteId: "a\u0000b" }), undefined);
  assert.deepEqual(summarySourceOf(link), link);
  assert.deepEqual(summarySourceOf(document), document);
  assert.equal(summarySourceOf({ kind: "other" }), undefined);
});

test("saved and restorable items keep only their durable a1 references", () => {
  const a1 = `a1:${"c".repeat(64)}`;
  const items = [
    { documentSource: document },
    { documentSource: { ...document, reference: a1 } },
    { documentSource: { ...document } },
    {
      documentSource: {
        ...document,
        reference: "b1:123e4567-e89b-42d3-a456-426614174000",
      },
    },
    { documentSource: { ...document, sha256: "bad" } },
    {},
    undefined,
  ];
  assert.deepEqual(
    retainedSourceReferences(items).sort(),
    [document.reference, a1].sort(),
  );
  assert.deepEqual(
    retainedSourceReferences([{ link: document }], (item) => item.link),
    [document.reference],
  );
});
