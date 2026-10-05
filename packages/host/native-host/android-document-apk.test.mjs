import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyPackagedAndroidDocuments } from "./android-documents.mjs";

function fixture() {
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(183, 18);
  const files = new Map([
    ["lib/arm64-v8a/libeliza_canvas.so", elf],
    [
      "assets/agent/gateway/document-services.mjs",
      Buffer.from("export const fixture = true;"),
    ],
    ["assets/agent/gateway/document-services.mjs.json", Buffer.from("{}")],
    [
      "assets/agent/gateway/node_modules/@napi-rs/canvas/package.json",
      Buffer.from('{"version":"0.1.100"}'),
    ],
  ]);
  const manifest = {
    schemaVersion: 1,
    target: "linux-arm64-musl",
    sourceCommit: "a".repeat(40),
    files: [...files].map(([name, bytes]) => ({
      path: name.replace(/^lib\//, "jniLibs/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const key = "assets/agent/gateway/document-services.manifest.json";
  const save = () => files.set(key, Buffer.from(JSON.stringify(manifest)));
  save();
  return {
    files,
    manifest,
    key,
    save,
    verify: (entries = [...files.keys()]) =>
      verifyPackagedAndroidDocuments(entries, (name) => files.get(name)),
  };
}
test("packaged document paths and native bytes remain authenticated after JNI remapping", () => {
  const f = fixture();
  assert.equal(f.verify().verifiedFiles, 4);
  f.files.set("lib/arm64-v8a/libeliza_canvas.so", Buffer.alloc(64));
  assert.throws(f.verify, /bytes mismatch/);
  assert.equal(
    verifyPackagedAndroidDocuments([], () => {
      throw new Error("Unexpected read");
    }),
    null,
  );
});
test("incomplete, duplicate, traversing and unlisted APK entries fail admission", () => {
  for (const mutate of [
    (f) => f.files.delete(f.key),
    (f) => f.manifest.files.pop(),
    (f) => f.manifest.files.push({ ...f.manifest.files[0] }),
    (f) => (f.manifest.files[0].path = "jniLibs/arm64-v8a/../escape"),
    (f) =>
      f.files.set(
        "assets/agent/gateway/node_modules/@napi-rs/canvas/extra.js",
        Buffer.from("stale"),
      ),
  ]) {
    const f = fixture();
    mutate(f);
    if (f.files.has(f.key)) f.save();
    assert.throws(f.verify);
  }
  const f = fixture();
  assert.throws(() => f.verify([...f.files.keys(), f.key]), /Duplicate/);
  assert.throws(
    () => f.verify([...f.files.keys(), "lib/arm64-v8a/libeliza_canvas.so"]),
    /bytes mismatch/,
  );
});
