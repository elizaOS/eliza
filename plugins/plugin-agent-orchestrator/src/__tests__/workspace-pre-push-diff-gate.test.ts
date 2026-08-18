/** Verifies the public pre-push gate against a real branch diff. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodingWorkspaceService,
  DiffGateBlockedError,
} from "../services/workspace-service.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Pre Push Gate Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("CodingWorkspaceService.assertPullRequestDiffReady", () => {
  it("blocks a secret-bearing branch before publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-pre-push-gate-"));
    roots.push(root);
    const workdir = join(root, "work");
    git(root, "init", "-q", "-b", "main", workdir);
    writeFileSync(join(workdir, "README.md"), "seed\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "seed");
    git(workdir, "branch", "feature");
    git(workdir, "checkout", "-q", "feature");
    writeFileSync(join(workdir, ".env"), "GITHUB_TOKEN=secret-value\n");
    git(workdir, "add", ".");
    git(workdir, "commit", "-q", "-m", "unsafe");

    const runtime = {
      getSetting: () => undefined,
      reportError: vi.fn(),
    };
    const service = new CodingWorkspaceService(runtime as never, {
      baseDir: join(root, "unused"),
    });
    const workspace = {
      id: "workspace-1",
      path: workdir,
      branch: "feature",
      baseBranch: "main",
      isWorktree: false,
      repo: "https://github.com/example/repo.git",
      status: "ready",
    };
    (
      service as unknown as { workspaces: Map<string, typeof workspace> }
    ).workspaces.set(workspace.id, workspace);

    await expect(
      service.assertPullRequestDiffReady(workspace.id, "main"),
    ).rejects.toBeInstanceOf(DiffGateBlockedError);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });
});
