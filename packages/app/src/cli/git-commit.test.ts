import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("resolves packed refs in a linked worktree", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-commit-"));
  dirs.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "--quiet", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const worktree = path.join(root, "worktree");
  git("worktree", "add", "-b", "linked", worktree);
  git("pack-refs", "--all", "--prune");
  vi.resetModules();
  const { resolveCommitHash } = await import("./git-commit");
  expect(resolveCommitHash({ cwd: worktree, env: {} })).toBe(
    git("rev-parse", "HEAD").slice(0, 7),
  );
});
