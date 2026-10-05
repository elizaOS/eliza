import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  "android/collect-grizzly-graphics",
  "android/grizzly-evidence",
  "android/lint-init-rc",
  "android/provision-cuttlefish-e1",
  "android/verify-grizzly-artifacts",
  "android/prepare-chromium-browser",
  "android/stage-browser-apps",
  "android/bootstrap-aosp",
  "android/build-aosp",
  "android/capture-screens",
  "android/e2e-validate",
  "android/prepare-grizzly",
  "android/sim",
  "android/sync-to-aosp",
  "android/validate",

  "check-confidential-artifacts",
  "check-confidential-image-manifest",
  "check-confidential-layer",
  "check-confidential-policy",
  "check-confidential-profile",
  "check-dstack-pins",
  "generate-confidential-artifacts",
  "tee-evidence-bridge",
  "tee-state-volume-mount",
  "verify-image-reproducibility",
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
for (const [name, args, expected, diagnostic] of [
  ["check-confidential-policy", [], 1, "--manifest must identify"],
  ["check-dstack-pins", [], 1, "--manifest must identify"],
  ["tee-state-volume-mount", [], 2, "real dm-crypt unseal is BLOCKED"],
]) {
  test(`${name} preserves refusal status through a symlink`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "os-cli-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const linked = join(dir, `${name}.mjs`);
    await symlink(new URL(`../${name}.ts`, import.meta.url).pathname, linked);
    const result = spawnSync(process.execPath, [linked, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, expected, result.stderr);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
  });
}
