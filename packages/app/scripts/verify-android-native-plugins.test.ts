/** Exercises Android instrumentation completion and native module wiring without replacing device behavior. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  missingAndroidProjectDirectories,
  verifyAndroidNativePlugins,
} from "./verify-android-native-plugins.ts";

test("Android app wiring includes declared modules and no removed native projects", () => {
  const result = verifyAndroidNativePlugins();
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.missingDirectories, []);
});

test("missing native Gradle directories fail even if their include is present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-wiring-"));
  try {
    const module = "plugins/plugin-native-example/android";
    const settings = `include ':example'\nproject(':example').projectDir = new File('${module}')`;
    assert.deepEqual(missingAndroidProjectDirectories(settings, root), [
      { project: ":example", directory: module },
    ]);
    fs.mkdirSync(path.join(root, module), { recursive: true });
    fs.writeFileSync(path.join(root, module, "build.gradle"), "");
    assert.deepEqual(missingAndroidProjectDirectories(settings, root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
