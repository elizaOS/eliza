import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const modules = [
  "eliza-source",
  "update-eliza-source-lock",
  "android/build-eliza-bootanimation",
  "aosp/verify-android-instrumentation-results",
  "aosp/verify-native-runtime",
  "aosp/verify-source-lock",
  "aosp/deploy-pixel",
  "aosp/smoke-cuttlefish",
  "distro-android/avd-test",
  "distro-android/boot-validate",
  "distro-android/build-bootanimation",
  "distro-android/collect-grizzly-graphics",
  "distro-android/grizzly-evidence",
  "distro-android/lint-init-rc",
  "distro-android/provision-cuttlefish-e1",
  "distro-android/verify-grizzly-artifacts",
  "distro-android/prepare-chromium-browser",
  "distro-android/stage-browser-apps",
  "distro-android/bootstrap-aosp",
  "distro-android/build-aosp",
  "distro-android/capture-screens",
  "distro-android/e2e-validate",
  "distro-android/prepare-grizzly",
  "distro-android/sim",
  "distro-android/sync-to-aosp",
  "distro-android/validate",

  "check-confidential-artifacts",
  "check-confidential-image-manifest",
  "check-confidential-layer",
  "check-confidential-policy",
  "check-confidential-profile",
  "check-dstack-pins",
  "check-pr-agent-attribution",
  "generate-confidential-artifacts",
  "read-eliza-source-lock",
  "tee-evidence-bridge",
  "tee-state-volume-mount",
  "verify-image-reproducibility",
];
for (const name of modules) {
  test(`${name} can be imported without invoking its CLI`, () => {
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
  ["read-eliza-source-lock", ["--unsupported"], 1, "Unknown argument"],
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
