/**
 * Real-Git regression tests for the foreground SHELL workspace-delta receipt:
 * fingerprint capture and before/after resolution run against actual `git`
 * repositories in temp directories (no mocks), covering tracked-dirty,
 * untracked, index, HEAD, clean-to-clean, unchanged, and non-worktree cases.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseWorkspaceDeltaReceipt } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureWorkspaceBaseline,
  resolveWorkspaceDeltaReceipt,
  unknownExecutionRouteReceipt,
} from "./workspace-delta.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, "init", "--initial-branch=main");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "commit.gpgsign", "false");
}

describe("workspace-delta receipt (real git)", () => {
  let repo = "";

  beforeEach(async () => {
    repo = mkdtempSync(path.join(tmpdir(), "workspace-delta-"));
    await initRepo(repo);
    await fs.writeFile(path.join(repo, "tracked.txt"), "one\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "commit", "-m", "initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports unchanged for a read-only interval and stays content-free", async () => {
    const baseline = await captureWorkspaceBaseline(repo);
    expect(baseline.ok).toBe(true);
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt).toEqual({
      version: 1,
      status: "unchanged",
      beforeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      afterFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(receipt.beforeFingerprint).toBe(receipt.afterFingerprint);
    // Content-free contract: nothing in the serialized receipt names the
    // workspace, its files, or their contents.
    expect(JSON.stringify(receipt)).not.toContain("tracked");
    expect(JSON.stringify(receipt)).not.toContain(repo);
  });

  it("does not mutate the workspace by observing it", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "dirty\n");
    const statusBefore = await git(repo, "status", "--porcelain=v2");
    const baseline = await captureWorkspaceBaseline(repo);
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("unchanged");
    const statusAfter = await git(repo, "status", "--porcelain=v2");
    expect(statusAfter).toBe(statusBefore);
  });

  it("detects a tracked dirty file changing again (dirty baseline)", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "dirty-before\n");
    const baseline = await captureWorkspaceBaseline(repo);
    await fs.writeFile(path.join(repo, "tracked.txt"), "dirty-after\n");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
    expect(receipt.beforeFingerprint).not.toBe(receipt.afterFingerprint);
  });

  it("detects untracked file creation", async () => {
    const baseline = await captureWorkspaceBaseline(repo);
    await fs.writeFile(path.join(repo, "new-file.txt"), "created\n");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
  });

  it("detects an existing untracked file being modified", async () => {
    await fs.writeFile(path.join(repo, "untracked.txt"), "before\n");
    const baseline = await captureWorkspaceBaseline(repo);
    await fs.writeFile(path.join(repo, "untracked.txt"), "after\n");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
  });

  it("detects an index change (git add)", async () => {
    await fs.writeFile(path.join(repo, "staged.txt"), "stage me\n");
    const baseline = await captureWorkspaceBaseline(repo);
    await git(repo, "add", "staged.txt");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
  });

  it("detects a clean-to-clean edit+commit mutation", async () => {
    const baseline = await captureWorkspaceBaseline(repo);
    await fs.writeFile(path.join(repo, "tracked.txt"), "two\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "commit", "-m", "second");
    // Worktree is clean both before and after; only HEAD moved.
    expect(await git(repo, "status", "--porcelain=v2")).toBe("");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
  });

  it("detects a clean HEAD switch (checkout)", async () => {
    await fs.writeFile(path.join(repo, "tracked.txt"), "two\n");
    await git(repo, "add", "tracked.txt");
    await git(repo, "commit", "-m", "second");
    const baseline = await captureWorkspaceBaseline(repo);
    await git(repo, "checkout", "--quiet", "HEAD~1");
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, repo);
    expect(receipt.status).toBe("changed");
  });

  it("reports indeterminate for a directory outside any git worktree", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "workspace-delta-plain-"));
    try {
      const baseline = await captureWorkspaceBaseline(plain);
      expect(baseline).toEqual({ ok: false, reason: "not_a_git_worktree" });
      const receipt = await resolveWorkspaceDeltaReceipt(baseline, plain);
      expect(receipt).toEqual({
        version: 1,
        status: "indeterminate",
        reason: "not_a_git_worktree",
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reports indeterminate when the cwd vanishes before the baseline", async () => {
    const missing = path.join(repo, "does-not-exist");
    const baseline = await captureWorkspaceBaseline(missing);
    expect(baseline).toEqual({ ok: false, reason: "baseline_capture_failed" });
  });

  it("reports indeterminate when the workspace becomes unobservable after execution", async () => {
    const nested = mkdtempSync(path.join(tmpdir(), "workspace-delta-gone-"));
    await initRepo(nested);
    await fs.writeFile(path.join(nested, "a.txt"), "a\n");
    await git(nested, "add", "a.txt");
    await git(nested, "commit", "-m", "initial");
    const baseline = await captureWorkspaceBaseline(nested);
    expect(baseline.ok).toBe(true);
    rmSync(nested, { recursive: true, force: true });
    const receipt = await resolveWorkspaceDeltaReceipt(baseline, nested);
    expect(receipt.status).toBe("indeterminate");
    expect(receipt.reason).toBe("post_capture_failed");
  });

  it("handles an unborn HEAD (fresh init) without failing the capture", async () => {
    const fresh = mkdtempSync(path.join(tmpdir(), "workspace-delta-fresh-"));
    try {
      await initRepo(fresh);
      const baseline = await captureWorkspaceBaseline(fresh);
      expect(baseline.ok).toBe(true);
      await fs.writeFile(path.join(fresh, "first.txt"), "hello\n");
      const receipt = await resolveWorkspaceDeltaReceipt(baseline, fresh);
      expect(receipt.status).toBe("changed");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("builds the unknown-execution-route receipt as indeterminate", () => {
    expect(unknownExecutionRouteReceipt()).toEqual({
      version: 1,
      status: "indeterminate",
      reason: "execution_route_unknown",
    });
  });

  it("emits only receipts the core parser accepts", async () => {
    // The parser is a trust boundary that rejects any receipt whose fields do
    // not prove its status. This pins the producer to that contract from the
    // other side: if a capture path ever emits a shape the parser refuses,
    // the planner would silently stop seeing real evidence.
    const unchangedBaseline = await captureWorkspaceBaseline(repo);
    const unchanged = await resolveWorkspaceDeltaReceipt(
      unchangedBaseline,
      repo,
    );
    expect(unchanged.status).toBe("unchanged");

    const changedBaseline = await captureWorkspaceBaseline(repo);
    await fs.writeFile(path.join(repo, "untracked.txt"), "new\n");
    const changed = await resolveWorkspaceDeltaReceipt(changedBaseline, repo);
    expect(changed.status).toBe("changed");

    const plain = mkdtempSync(path.join(tmpdir(), "workspace-delta-parse-"));
    const notAWorktree = await resolveWorkspaceDeltaReceipt(
      await captureWorkspaceBaseline(plain),
      plain,
    );
    expect(notAWorktree.reason).toBe("not_a_git_worktree");

    const gone = mkdtempSync(
      path.join(tmpdir(), "workspace-delta-parse-gone-"),
    );
    await initRepo(gone);
    await fs.writeFile(path.join(gone, "a.txt"), "a\n");
    await git(gone, "add", "a.txt");
    await git(gone, "commit", "-m", "initial");
    const goneBaseline = await captureWorkspaceBaseline(gone);
    rmSync(gone, { recursive: true, force: true });
    const postFailure = await resolveWorkspaceDeltaReceipt(goneBaseline, gone);
    expect(postFailure.reason).toBe("post_capture_failed");

    try {
      for (const receipt of [
        unchanged,
        changed,
        notAWorktree,
        postFailure,
        unknownExecutionRouteReceipt(),
      ]) {
        expect(parseWorkspaceDeltaReceipt(receipt)).toEqual(receipt);
      }
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
