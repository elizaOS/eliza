import assert from "node:assert/strict";
import test from "node:test";
import { reviewMailAttachment } from "../src/browser/attachment.ts";
import { fileArchive } from "../src/browser/file-archive.ts";

test("archives retain exact binary bytes and reject traversal and duplicate paths", async () => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  const result = new Uint8Array(
    await fileArchive([{ path: "sample.bin", bytes }]).arrayBuffer(),
  );
  assert.deepEqual(result.slice(40, 45), bytes);
  for (const path of [
    "../escape",
    "/absolute",
    "C:/absolute",
    "folder/../escape",
  ])
    assert.throws(
      () => fileArchive([{ path, bytes }]),
      /relative archive paths/,
    );
  assert.throws(
    () =>
      fileArchive([
        { path: "same", bytes },
        { path: "same", bytes },
      ]),
    /distinct/,
  );
});
test("attachments validate exact bytes and type before deriving a review hash", async () => {
  const bytes = "hello\r\n";
  const result = await reviewMailAttachment({
    name: "note.txt",
    mimeType: "text/plain",
    dataBase64: btoa(bytes),
  });
  assert.equal(result.text, bytes);
  assert.equal(result.size, 7);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    reviewMailAttachment({
      name: "note.pdf",
      mimeType: "application/pdf",
      dataBase64: btoa(bytes),
    }),
    /content must match/,
  );
  await assert.rejects(
    reviewMailAttachment({
      name: "../note.txt",
      mimeType: "text/plain",
      dataBase64: btoa(bytes),
    }),
    /Invalid attachment/,
  );
});
