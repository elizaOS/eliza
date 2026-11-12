import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const modules = [
  "../trust/index",
  "eliza-source",
  "android/verify-android-instrumentation-results",
  "android/verify-native-runtime",
  "android/verify-source-lock",
  "android/deploy-pixel",
  "android/smoke-cuttlefish",
  "android/avd-test",
  "android/boot-validate",
  "android/build-bootanimation",
  "android/lint-init-rc",
  "android/prepare-chromium-browser",
  "android/stage-browser-apps",
  "android/bootstrap-aosp",
  "android/build-aosp",
  "android/capture-screens",
  "android/e2e-validate",
  "android/sim",
  "android/sync-to-aosp",
  "android/validate",
];
for (const name of modules) {
  test(`${name} imports without side effects`, () => {
    const module = new URL(`../${name}.ts`, import.meta.url);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(module.href)});`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
}
