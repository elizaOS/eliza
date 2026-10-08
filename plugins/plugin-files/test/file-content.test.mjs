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

test("ZIP entry counts stop before the ZIP64 sentinel", async () => {
  const bytes = new Uint8Array(0);
  const entries = Array.from({ length: 65_534 }, (_, index) => ({
    path: `file-${index}`,
    bytes,
  }));
  const archive = new Uint8Array(await fileArchive(entries).arrayBuffer());
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const eocd = archive.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  assert.equal(view.getUint16(eocd + 8, true), entries.length);
  assert.equal(view.getUint16(eocd + 10, true), entries.length);
  let offset = view.getUint32(eocd + 16, true);
  for (const entry of entries) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const nameSize = view.getUint16(offset + 28, true);
    assert.equal(
      new TextDecoder().decode(
        archive.subarray(offset + 46, offset + 46 + nameSize),
      ),
      entry.path,
    );
    offset +=
      46 +
      nameSize +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  assert.equal(offset, eocd);
  assert.throws(
    () => fileArchive([...entries, { path: "overflow", bytes }]),
    /fewer than 65,535/,
  );
});
