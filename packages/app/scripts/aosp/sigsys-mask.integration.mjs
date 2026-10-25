import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("actual SIGSYS shim preserves only its translation signal during child setup", {
  skip: process.platform !== "linux" || process.arch !== "x64",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "sigsys-mask-"));
  const source = fileURLToPath(new URL("./seccomp-shim/", import.meta.url));
  const run = (command, args, env = process.env) => {
    const result = spawnSync(command, args, {
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(
      result.status,
      0,
      `${result.signal ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
    return result;
  };
  try {
    const shim = join(directory, "shim.so");
    const fixture = join(directory, "fixture");
    run("cc", [
      "-shared",
      "-fPIC",
      "-O2",
      "-o",
      shim,
      join(source, "sigsys-handler.c"),
      "-ldl",
    ]);
    run("cc", [
      "-O2",
      "-Wall",
      "-Werror",
      "-o",
      fixture,
      join(source, "signal-mask-fixture.c"),
    ]);
    const result = run(fixture, [], { ...process.env, LD_PRELOAD: shim });
    assert.match(result.stdout, /real child seccomp trap passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
