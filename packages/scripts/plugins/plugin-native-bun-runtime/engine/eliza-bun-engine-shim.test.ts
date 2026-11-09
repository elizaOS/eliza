/**
 * Builds the iOS Bun engine shim against a fake bun_start and runs its C
 * harness (plugins/plugin-native-bun-runtime/engine/tests/shim_harness.c):
 * the buffered protocol reader, JSON string decoding, argv and env handling,
 * concurrent calls, host calls with no call in flight, and restart after stop.
 * Skipped when no C compiler is on PATH.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.resolve(
  here,
  "../../../../../plugins/plugin-native-bun-runtime/engine/tests",
);
const compiler = process.env.CC || "cc";
const compilerAvailable =
  spawnSync(compiler, ["--version"], { stdio: "ignore" }).status === 0;

test("shim harness passes", {
  skip: compilerAvailable ? false : `C compiler unavailable: ${compiler}`,
  timeout: 120_000,
}, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-shim-"));
  try {
    const binary = path.join(scratch, "shim_harness");
    const build = spawnSync(
      compiler,
      [
        "-std=c11",
        "-D_GNU_SOURCE",
        "-pthread",
        "-I",
        testsDir,
        path.join(testsDir, "shim_harness.c"),
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr);
    const appSupport = path.join(scratch, "app-support");
    fs.mkdirSync(appSupport);
    const run = spawnSync(binary, [appSupport], {
      encoding: "utf8",
      timeout: 90_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /shim harness ok/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
