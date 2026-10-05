import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAndroidElf } from "./assert-android-elf.mjs";

function fixture({ android = true, machine = 62 } = {}) {
  const bytes = Buffer.alloc(512);
  bytes.write("\x7fELF", 0, "ascii");
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt16LE(1, 62);
  bytes.writeBigUInt64LE(256n, 128 + 24);
  bytes.writeBigUInt64LE(64n, 128 + 32);
  bytes.write("\0.shstrtab\0.note.android.ident\0", 256, "ascii");
  bytes.writeUInt32LE(android ? 11 : 1, 192);
  bytes.writeUInt32LE(7, 192 + 4);
  bytes.writeBigUInt64LE(320n, 192 + 24);
  bytes.writeBigUInt64LE(24n, 192 + 32);
  bytes.writeUInt32LE(8, 320);
  bytes.writeUInt32LE(4, 324);
  bytes.writeUInt32LE(1, 328);
  bytes.write("Android\0", 332, "ascii");
  bytes.writeUInt32LE(35, 340);
  return bytes;
}

test("accepts matching Android NDK identities for both shipped native architectures", () => {
  assert.doesNotThrow(() => assertAndroidElf(fixture(), "x86_64"));
  assert.doesNotThrow(() =>
    assertAndroidElf(fixture({ machine: 183 }), "arm64-v8a"),
  );
});
test("rejects musl target and wrong architecture before staging", () => {
  assert.throws(
    () => assertAndroidElf(fixture({ android: false }), "x86_64"),
    /musl/,
  );
  assert.throws(
    () => assertAndroidElf(fixture(), "arm64-v8a"),
    /does not match/,
  );
});
test("rejects truncated or corrupt ELF structures", () => {
  assert.throws(
    () => assertAndroidElf(fixture().subarray(0, 20), "x86_64"),
    /ELF64/,
  );
  const bytes = fixture();
  bytes.writeBigUInt64LE(9999n, 40);
  assert.throws(() => assertAndroidElf(bytes, "x86_64"), /section table/);
});
