/** Exercises native-library freshness checks against an isolated Git source checkout and staged library fixtures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { nativeLibraryInventory } from "./lib/fused-artifact-integrity.mjs";

// Exercises the desktop fused-lib staleness guard (`--check`): a stale or
// unstamped staged lib must exit non-zero (2) so build/deploy flows never ship
// a native lib that no longer matches the fork source; a stamp matching the
// current fork exits 0.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "fused-source-fixture-"),
);
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const fixtureScripts = path.join(fixtureRoot, "packages/app-core/scripts");
fs.mkdirSync(path.join(fixtureScripts, "lib"), { recursive: true });
for (const relative of [
  "stage-desktop-fused-lib.mjs",
  "lib/fused-artifact-integrity.mjs",
  "lib/setup-state-dir.mjs",
]) {
  fs.copyFileSync(
    path.join(scriptDir, relative),
    path.join(fixtureScripts, relative),
  );
}
const script = path.join(fixtureScripts, "stage-desktop-fused-lib.mjs");
const forkDir = path.join(
  fixtureRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);
fs.mkdirSync(forkDir, { recursive: true });
fs.writeFileSync(
  path.join(forkDir, "CMakeLists.txt"),
  "project(fused_fixture)\n",
);
execFileSync("git", ["init", "--quiet", forkDir]);
execFileSync("git", ["-C", forkDir, "add", "CMakeLists.txt"]);
execFileSync("git", [
  "-C",
  forkDir,
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--quiet",
  "-m",
  "Initialize native source fixture",
]);
const libName =
  process.platform === "win32"
    ? "elizainference.dll"
    : process.platform === "darwin"
      ? "libelizainference.dylib"
      : "libelizainference.so";
const STAMP = ".eliza-fused-build-stamp.json";

function currentFork() {
  return execFileSync("git", ["-C", forkDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/** Run `--check --out <dir>`; return the process exit code (0 fresh, 2 stale). */
function checkExitCode(outDir, extraArgs = []) {
  try {
    execFileSync(
      process.execPath,
      [script, "--check", "--out", outDir, ...extraArgs],
      {
        stdio: "ignore",
      },
    );
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
        platform: process.platform,
        arch: process.arch,
        libraries: nativeLibraryInventory(dir),
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
        platform: process.platform,
        arch: process.arch,
        libraries: nativeLibraryInventory(dir),
        forkCommit: "0000000000000000000000000000000000000000",
        forkDirty: "",
        backend: "test",
        fusedLib: libName,
        fusedSha256: sha,
        builtAt: "old",
      }),
    );
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
        platform: process.platform,
        arch: process.arch,
        libraries: nativeLibraryInventory(dir),
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

test("--check: a host-native stamp is stale for a portable CPU request", () => {
  const dir = mkTmp();
  try {
    const bytes = Buffer.from("fake-host-native-lib");
    fs.writeFileSync(path.join(dir, libName), bytes);
    fs.writeFileSync(
      path.join(dir, STAMP),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        libraries: nativeLibraryInventory(dir),
        forkCommit: currentFork(),
        forkDirty: "",
        backend: "cpu",
        cpuNative: true,
        fusedLib: libName,
        fusedSha256: createHash("sha256").update(bytes).digest("hex"),
        builtAt: "now",
      }),
    );
    assert.equal(checkExitCode(dir, ["--portable-cpu"]), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--check: a portable CPU stamp is fresh for a portable CPU request", () => {
  const dir = mkTmp();
  try {
    const bytes = Buffer.from("fake-portable-lib");
    fs.writeFileSync(path.join(dir, libName), bytes);
    fs.writeFileSync(
      path.join(dir, STAMP),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        libraries: nativeLibraryInventory(dir),
        forkCommit: currentFork(),
        forkDirty: "",
        backend: "cpu",
        cpuNative: false,
        fusedLib: libName,
        fusedSha256: createHash("sha256").update(bytes).digest("hex"),
        builtAt: "now",
      }),
    );
    assert.equal(checkExitCode(dir, ["--portable-cpu"]), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
