import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSensitiveText } from "@elizaos/core";
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

  it.each([
    'this.apiKey = "synthetic-fixture";',
    'return (obj.token = "synthetic-literal");',
    'call(password = "synthetic-literal");',
    '<Widget token="synthetic-literal" />',
  ])(
    "distinguishes source expressions from literal %s while runtime logs stay redacted",
    async (literalSource) => {
      git("checkout", "-q", "-b", "credential-source");
      const code = [
        "this.apiKey = config.apiKey;",
        "password === expected",
        "secret => handler(secret)",
        "const credential = await resolveCredential();",
        "return (obj.token = config.token);",
        "call(password = configuredPassword);",
        "<Widget token={configuredToken} />",
      ];
      writeFileSync(join(dir, "credentials.ts"), `${code.join("\n")}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", "read configured credential");
      const clean = await capturePrGateChangeSet(dir, "main");
      expect(clean).toBeDefined();
      if (!clean) throw new Error("Expected complete source changeset");
      expect(reviewDiff(clean).passed).toBe(true);
      // Runtime output has no source-code authority and must still mask assignments.
      expect(
        redactSensitiveText("password=ordinary-value", { mode: "tools" }),
      ).not.toContain("ordinary-value");
      writeFileSync(join(dir, "credentials.ts"), `${literalSource}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", "introduce credential literal");
      const literal = await capturePrGateChangeSet(dir, "main");
      expect(literal).toBeDefined();
      if (!literal) throw new Error("Expected complete literal changeset");
      expect(
        reviewDiff(literal).blocking.some(
          (finding) => finding.check === "secret",
        ),
      ).toBe(true);
    },
  );

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
