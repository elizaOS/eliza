/** Exercises stage desktop fused lib staleness behavior with deterministic app-core test fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercises the desktop fused-lib staleness guard (`--check`): a stale or
// unstamped staged lib must exit non-zero (2) so build/deploy flows never ship
// a native lib that no longer matches the fork source; a stamp matching the
// current fork exits 0.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(scriptDir, "stage-desktop-fused-lib.mjs");
const forkDir = path.join(
  scriptDir,
  "..",
  "..",
  "..",
  "plugins/plugin-local-inference/native/llama.cpp",
);
const libName =
  process.platform === "win32"
    ? "elizainference.dll"
    : process.platform === "darwin"
      ? "libelizainference.dylib"
      : "libelizainference.so";
const STAMP = ".eliza-fused-build-stamp.json";

function currentFork() {
  try {
    return execFileSync("git", ["-C", forkDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Run `--check --out <dir>`; return the process exit code (0 fresh, 2 stale). */
function checkExitCode(outDir) {
  try {
    execFileSync("node", [script, "--check", "--out", outDir], {
      stdio: "ignore",
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fused-stale-"));
}

test("--check: empty dir (no staged lib) is STALE → exit 2", () => {
  const dir = mkTmp();
  try {
    assert.equal(checkExitCode(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: staged lib without a stamp is STALE → exit 2", () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, libName), Buffer.from("fake-lib-bytes"));
    assert.equal(checkExitCode(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: stamp matching the current fork + lib hash is FRESH → exit 0", () => {
  const dir = mkTmp();
  try {
    const bytes = Buffer.from("fake-lib-bytes-fresh");
    fs.writeFileSync(path.join(dir, libName), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(
      path.join(dir, STAMP),
      JSON.stringify({
        forkCommit: currentFork(),
        forkDirty: "",
        backend: "test",
        fusedLib: libName,
        fusedSha256: sha,
        builtAt: "now",
      }),
    );
    assert.equal(checkExitCode(dir), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: stamp from a DIFFERENT fork commit is STALE → exit 2", () => {
  const dir = mkTmp();
  try {
    const bytes = Buffer.from("fake-lib-bytes-stale");
    fs.writeFileSync(path.join(dir, libName), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(
      path.join(dir, STAMP),
      JSON.stringify({
        forkCommit: "0000000000000000000000000000000000000000",
        forkDirty: "",
        backend: "test",
        fusedLib: libName,
        fusedSha256: sha,
        builtAt: "old",
      }),
    );
    // Only meaningful when we can read a real (different) fork HEAD; if the fork
    // submodule isn't checked out, forkCommit() is "unknown" and would also
    // differ from the all-zeros commit, so this still asserts STALE.
    assert.equal(checkExitCode(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: staged lib whose bytes don't match the stamp hash is STALE → exit 2", () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, libName), Buffer.from("actual-bytes"));
    fs.writeFileSync(
      path.join(dir, STAMP),
      JSON.stringify({
        forkCommit: currentFork(),
        forkDirty: "",
        backend: "test",
        fusedLib: libName,
        fusedSha256: createHash("sha256").update("OTHER").digest("hex"),
        builtAt: "now",
      }),
    );
    assert.equal(checkExitCode(dir), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
