import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ensureLinuxCefHelper,
  hashHelperFile,
  helperSdkSourcesHash,
  requireHelperHash,
  validateHelperCache,
  validateHelperVersion,
} from "./linux-cef-helper.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-helper-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("rejects a changed Electrobun dependency version", () => {
  assert.doesNotThrow(() => validateHelperVersion("1.18.1", "1.18.1"));
  assert.throws(
    () => validateHelperVersion("1.18.2", "1.18.1"),
    /requires Electrobun/,
  );
});
test("fails closed on modified executable or SDK bytes", (t) => {
  const file = path.join(fixture(t), "binary");
  writeFileSync(file, Buffer.from([0, 1, 2, 255]));
  const expected = hashHelperFile(file);
  requireHelperHash(file, expected);
  writeFileSync(file, Buffer.from([0, 1, 3, 255]));
  assert.throws(() => requireHelperHash(file, expected), /hash mismatch/);
});
test("cache must match build inputs and actual helper, not just an existing receipt", (t) => {
  const file = path.join(fixture(t), "helper");
  writeFileSync(file, "source-built helper");
  const receipt = { key: "expected-build", helperSha256: hashHelperFile(file) };
  assert.equal(
    validateHelperCache(receipt, "expected-build", file),
    receipt.helperSha256,
  );
  assert.throws(
    () => validateHelperCache(receipt, "different-compiler", file),
    /provenance/,
  );
  writeFileSync(file, "tampered helper");
  assert.throws(
    () => validateHelperCache(receipt, "expected-build", file),
    /hash mismatch/,
  );
});
test("SDK fingerprint covers source paths, headers and CMake configuration", (t) => {
  const sdk = fixture(t);
  for (const dir of ["include", "libcef_dll", "cmake"])
    mkdirSync(path.join(sdk, dir));
  writeFileSync(path.join(sdk, "CMakeLists.txt"), "configuration");
  const first = helperSdkSourcesHash(sdk);
  writeFileSync(path.join(sdk, "include/cef_app.h"), "header");
  const second = helperSdkSourcesHash(sdk);
  assert.notEqual(first, second);
  writeFileSync(path.join(sdk, "CMakeLists.txt"), "changed flags");
  assert.notEqual(second, helperSdkSourcesHash(sdk));
});
test("other architectures do not fetch or mutate the x64 helper", () => {
  assert.equal(
    ensureLinuxCefHelper("/nonexistent", { platform: "darwin", arch: "x64" }),
    null,
  );
  assert.equal(
    ensureLinuxCefHelper("/nonexistent", { platform: "linux", arch: "arm64" }),
    null,
  );
});
