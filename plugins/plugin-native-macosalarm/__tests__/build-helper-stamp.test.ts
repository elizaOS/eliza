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
import { readFileSync, utimesSync } from "node:fs";
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

function runBuild(): number {
  return spawnSync(process.execPath, [script], { cwd: pkgRoot }).status ?? 1;
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
    const expected = createHash("sha256")
      .update(readFileSync(source))
      .digest("hex");

    expect(readFileSync(stamp, "utf8").trim()).toBe(expected);
  });

  it("reaches the same decision whichever file git wrote first", () => {
    // This is the regression. Under the mtime comparison the first case ran
    // `swiftc` and the second skipped it, from identical content.
    makeNewest(source);
    const sourceNewest = runBuild();

    makeNewest(path.join(pkgRoot, "bin", "macosalarm-helper"));
    const binaryNewest = runBuild();

    expect(sourceNewest).toBe(0);
    expect(binaryNewest).toBe(sourceNewest);
  });
});
