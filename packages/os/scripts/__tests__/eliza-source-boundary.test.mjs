import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
  new URL(
    "../verify-eliza-source-boundary.mjs",
    import.meta.url,
  ),
);
const reviewedPaths = [
  "plugins/plugin-native-inference/__tests__/aosp-audio-resample.test.ts",
  "plugins/plugin-native-inference/__tests__/aosp-model-download-paths.test.ts",
  "plugins/plugin-native-inference/src/aosp-audio-resample.ts",
  "plugins/plugin-native-inference/src/aosp-model-paths.ts",
];

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "eliza-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  const add = (entry) => {
    const target = path.join(root, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "\n");
    execFileSync("git", ["add", "--", entry], { cwd: root });
  };
  for (const entry of [
    ".dockerignore",
    ".gitignore",
    "package.json",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    ".github/actionlint.yaml",
    "packages/app-core/platforms/android/runtime.ts",
    "packages/app-core/platforms/ios/runtime.ts",
    "packages/native/plugins/runtime.ts",
    "plugins/plugin-capacitor-bridge/android/runtime.ts",
    ...reviewedPaths,
  ])
    add(entry);
  const check = () =>
    spawnSync(process.execPath, [checker], {
      env: { ...process.env, ELIZAOS_ELIZA_ROOT: root },
      encoding: "utf8",
    });
  return { add, check };
}

test("source boundary accepts reviewed audio and model plugin runtime paths", (t) => {
  const { check } = fixture(t);
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /eliza source boundary passed/);
});

test("source boundary still requires review for adjacent AOSP plugin paths", (t) => {
  const { add, check } = fixture(t);
  const entry =
    "plugins/plugin-native-inference/src/aosp-model-image-builder.ts";
  add(entry);
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require an ownership decision/);
  assert.ok(result.stderr.includes(entry));
});

test("source boundary still rejects OS image ownership alongside reviewed runtime", (t) => {
  const { add, check } = fixture(t);
  const entry = "packages/os/android/image-builder.ts";
  add(entry);
  const result = check();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OS-owned paths are tracked in eliza/);
  assert.ok(result.stderr.includes(entry));
});
