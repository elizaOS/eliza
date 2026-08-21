/**
 * The helper binary and its Swift source are both tracked, and git assigns every
 * file the checkout time. Deciding whether to run `swiftc` by comparing their
 * mtimes therefore turned the desktop build into a coin flip on a fresh clone or
 * worktree — measured at 2 ms apart, in an order nothing guarantees, which on a
 * machine with a drifted Swift toolchain is the difference between a working
 * build and a hard failure (#23776).
 *
 * These tests pin the decision to the source's content instead.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(pkgRoot, "scripts", "build-helper.mjs");
const source = path.join(pkgRoot, "swift-helper", "main.swift");
const stamp = path.join(pkgRoot, "bin", "macosalarm-helper.source.sha256");

const COMPILE_FLAGS = ["-O"];

function expectedStamp(): string {
  return createHash("sha256")
    .update(readFileSync(source))
    .update("\0")
    .update(COMPILE_FLAGS.join(" "))
    .digest("hex");
}

/**
 * Returns whether the build SKIPPED swiftc, not merely whether it exited 0.
 * Exit status alone cannot tell the two apart, so a status-only assertion
 * passes against the very mtime logic it is supposed to pin.
 */
function runBuildSkipped(): boolean {
  const result = spawnSync(process.execPath, [script], {
    cwd: pkgRoot,
    encoding: "utf8",
    env: { ...process.env, ELIZA_VERBOSE_PLUGIN_BUILD: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`build-helper exited ${result.status}: ${result.stderr}`);
  }
  return (result.stdout ?? "").includes("helper already current");
}

/** Force an mtime ordering without touching content. */
function makeNewest(target: string): void {
  const future = new Date(Date.now() + 10_000);
  utimesSync(target, future, future);
}

const onDarwin = process.platform === "darwin" ? describe : describe.skip;

onDarwin("build-helper currency check", () => {
  it("stamps the committed binary with the committed source's hash", () => {
    // If these drift, the build silently ships a binary that does not match its
    // source — the failure mode a content check has to avoid introducing.
    expect(readFileSync(stamp, "utf8").trim()).toBe(expectedStamp());
  });

  it("reaches the same decision whichever file git wrote first", () => {
    // This is the regression. Under the mtime comparison the first ordering ran
    // `swiftc` and the second skipped it, from byte-identical content. Both must
    // now skip, because the content and flags are unchanged.
    makeNewest(source);
    const sourceNewest = runBuildSkipped();

    makeNewest(path.join(pkgRoot, "bin", "macosalarm-helper"));
    const binaryNewest = runBuildSkipped();

    expect(sourceNewest).toBe(true);
    expect(binaryNewest).toBe(sourceNewest);
  });

  // The stamp keys on what actually determines the emitted binary. Source
  // content is the obvious half; the compile flags are the half an mtime scheme
  // and a source-only hash both miss, so changing -O would silently ship a
  // binary built under different optimization.
  it("rebuilds when a compile flag changes even though the source has not", () => {
    expect(runBuildSkipped()).toBe(true);

    const original = readFileSync(script, "utf8");
    try {
      writeFileSync(
        script,
        original.replace(
          'COMPILE_FLAGS = ["-O"]',
          'COMPILE_FLAGS = ["-Onone"]',
        ),
      );
      expect(runBuildSkipped()).toBe(false);
    } finally {
      writeFileSync(script, original);
      runBuildSkipped();
    }
  });
});
