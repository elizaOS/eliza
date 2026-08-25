import assert from "node:assert/strict";
import test from "node:test";
import {
  androidSystemAbiEntriesToRemove,
  assertAndroidSystemAbiContents,
  parseAndroidSystemAbiAllowlist,
} from "./android-system-apk-abis.mjs";

const entries = [
  "AndroidManifest.xml",
  "assets/agent/agent-bundle.js",
  "assets/agent/arm64-v8a/bun",
  "assets/agent/x86_64/bun",
  "lib/arm64-v8a/libelizainference.so",
  "lib/armeabi-v7a/libplugin.so",
  "lib/x86/libplugin.so",
  "lib/x86_64/libplugin.so",
];

test("parses and validates the system APK ABI allowlist", () => {
  assert.deepEqual(parseAndroidSystemAbiAllowlist("arm64-v8a, arm64-v8a"), [
    "arm64-v8a",
  ]);
  assert.equal(parseAndroidSystemAbiAllowlist(""), null);
  assert.throws(
    () => parseAndroidSystemAbiAllowlist("arm64-v9a"),
    /unsupported ABI/,
  );
});

test("removes only ABI-scoped entries outside the allowlist", () => {
  assert.deepEqual(androidSystemAbiEntriesToRemove(entries, ["arm64-v8a"]), [
    "assets/agent/x86_64/bun",
    "lib/armeabi-v7a/libplugin.so",
    "lib/x86/libplugin.so",
    "lib/x86_64/libplugin.so",
  ]);
});

test("filtered contents fail closed on unexpected or missing ABIs", () => {
  const arm64Only = entries.filter(
    (entry) =>
      !androidSystemAbiEntriesToRemove(entries, ["arm64-v8a"]).includes(entry),
  );
  assert.doesNotThrow(() =>
    assertAndroidSystemAbiContents(arm64Only, ["arm64-v8a"]),
  );
  assert.throws(
    () => assertAndroidSystemAbiContents(entries, ["arm64-v8a"]),
    /still contains ABI/,
  );
  assert.throws(
    () => assertAndroidSystemAbiContents(arm64Only, ["x86_64"]),
    /still contains ABI|missing requested ABI/,
  );
});
