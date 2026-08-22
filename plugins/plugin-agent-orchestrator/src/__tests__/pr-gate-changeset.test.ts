import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewDiff } from "../services/diff-review-gate.js";
import { capturePrGateChangeSet } from "../services/workspace-diff.js";

const githubTestPat = () =>
  ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");

/**
 * Integration: capturePrGateChangeSet against a REAL git repo, feeding the
 * result into reviewDiff — the exact pairing the createPR seam performs. Proves
 * the branch-vs-base diff is scoped to the branch's own changes and that a
 * secret introduced on the branch is caught end-to-end.
 */
describe("capturePrGateChangeSet → reviewDiff (real git)", () => {
  let dir: string;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-gate-changeset-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    // Base branch content.
    writeFileSync(join(dir, "README.md"), "# base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    // Ensure a stable base branch name.
    git("branch", "-M", "main");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures only the feature branch's changes vs base", async () => {
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add src");

    const changeSet = await capturePrGateChangeSet(dir, "main");
    expect(changeSet).toBeDefined();
    expect(changeSet?.changedFiles).toContain("src.ts");
    // README.md was on base, must NOT appear in the branch-scoped diff.
    expect(changeSet?.changedFiles).not.toContain("README.md");
    // Honest flags: a complete capture reports false — these are DETECTED
    // verdicts now, never hard-coded decoration.
    expect(changeSet?.truncated).toBe(false);
    expect(changeSet?.filesTruncated).toBe(false);

    const result = reviewDiff({
      diff: changeSet?.diff ?? "",
      changedFiles: changeSet?.changedFiles ?? [],
    });
    expect(result.passed).toBe(true);
  });

  it("catches a secret introduced on the branch, end-to-end", async () => {
    git("checkout", "-q", "-b", "leak");
    writeFileSync(
      join(dir, "config.ts"),
      `export const KEY = "${githubTestPat()}";\n`,
    );
    git("add", "-A");
    git("commit", "-q", "-m", "leak key");

    const changeSet = await capturePrGateChangeSet(dir, "main");
    expect(changeSet).toBeDefined();
    const result = reviewDiff({
      diff: changeSet?.diff ?? "",
      changedFiles: changeSet?.changedFiles ?? [],
      diffTruncated: changeSet?.truncated,
      changedFilesTruncated: changeSet?.filesTruncated,
    });
    expect(result.passed).toBe(false);
    expect(result.blocking.some((f) => f.check === "secret")).toBe(true);
  });

  // The Bun fallback path streams git stdout to a file (no read-buffer cut is
  // possible there), so the forced-truncation seam only exercises the Node
  // spawnSync path.
  it.skipIf(Boolean(process.versions.bun))(
    "a buffer-cut diff reports truncated:true and the gate fails closed",
    async () => {
      process.env.WORKSPACE_DIFF_GIT_MAX_BUFFER = "256";
      try {
        git("checkout", "-q", "-b", "huge");
        writeFileSync(
          join(dir, "big.ts"),
          `export const blob = "${"a".repeat(20_000)}";\n`,
        );
        git("add", "-A");
        git("commit", "-q", "-m", "huge change");

        const changeSet = await capturePrGateChangeSet(dir, "main");
        expect(changeSet).toBeDefined();
        // The diff read cannot fit the 256-byte buffer: the cut is DETECTED
        // and reported, not silently stamped complete.
        expect(changeSet?.truncated).toBe(true);

        // End-to-end: the honest flag makes the secret-scan gate fail closed
        // with the typed truncated-diff BLOCK instead of passing a partial
        // scan as clean.
        const result = reviewDiff({
          diff: changeSet?.diff ?? "",
          changedFiles: changeSet?.changedFiles ?? [],
          diffTruncated: changeSet?.truncated,
          changedFilesTruncated: changeSet?.filesTruncated,
        });
        expect(result.passed).toBe(false);
        expect(result.blocking.some((f) => f.check === "truncated-diff")).toBe(
          true,
        );
      } finally {
        delete process.env.WORKSPACE_DIFF_GIT_MAX_BUFFER;
      }
    },
  );

  it("returns undefined for a non-git directory (gate unavailable, fail-safe)", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "pr-gate-nongit-"));
    try {
      const changeSet = await capturePrGateChangeSet(nonGit, "main");
      expect(changeSet).toBeUndefined();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns undefined when base branch is blank", async () => {
    const changeSet = await capturePrGateChangeSet(dir, "  ");
    expect(changeSet).toBeUndefined();
  });

  it("scans against the SPECIFIED base, not a fixed one (PR-target parity)", async () => {
    // Two divergent bases: `main` (has README) and `release` (adds a lockfile).
    // A branch off `release` that only adds source should be CLEAN vs release
    // but would spuriously include the lockfile if scanned against main.
    git("checkout", "-q", "-b", "release");
    writeFileSync(join(dir, "bun.lock"), '"x": "1"\n');
    git("add", "-A");
    git("commit", "-q", "-m", "release lockfile");
    git("checkout", "-q", "-b", "feature-off-release");
    writeFileSync(join(dir, "feat.ts"), "export const f = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feature");

    // Vs release: only feat.ts changed, no forbidden file.
    const vsRelease = await capturePrGateChangeSet(dir, "release");
    expect(vsRelease?.changedFiles).toContain("feat.ts");
    expect(vsRelease?.changedFiles).not.toContain("bun.lock");
    expect(
      reviewDiff({
        diff: vsRelease?.diff ?? "",
        changedFiles: vsRelease?.changedFiles ?? [],
      }).passed,
    ).toBe(true);

    // Vs main: the lockfile from release IS part of the range, and the gate
    // must block — proving the base argument actually changes the scan.
    const vsMain = await capturePrGateChangeSet(dir, "main");
    expect(vsMain?.changedFiles).toContain("bun.lock");
    expect(
      reviewDiff({
        diff: vsMain?.diff ?? "",
        changedFiles: vsMain?.changedFiles ?? [],
      }).passed,
    ).toBe(false);
  });
});
