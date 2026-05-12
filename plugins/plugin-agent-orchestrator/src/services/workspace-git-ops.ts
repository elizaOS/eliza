/**
 * Git operations for Coding Workspace Service
 *
 * Extracted from workspace-service.ts — provides git status, commit, push,
 * and PR creation as standalone functions operating on workspace paths.
 *
 * @module services/workspace-git-ops
 */

import type {
  PullRequestInfo,
  WorkspaceFinalization,
  WorkspaceService,
} from "git-workspace-service";
import type {
  CommitOptions,
  PROptions,
  PushOptions,
  WorkspaceResult,
  WorkspaceStatusResult,
} from "./workspace-service.js";

/**
 * Get workspace git status (branch, staged/modified/untracked files).
 */
export async function getStatus(
  workspacePath: string,
): Promise<WorkspaceStatusResult> {
  const { execFileSync } = await import("node:child_process");

  const statusOutput = execFileSync("git", ["status", "--porcelain"], {
    cwd: workspacePath,
    encoding: "utf-8",
  });

  const branchOutput = execFileSync("git", ["branch", "--show-current"], {
    cwd: workspacePath,
    encoding: "utf-8",
  }).trim();

  const lines = statusOutput.split("\n").filter(Boolean);
  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filename = line.slice(3);

    if (indexStatus === "?" && workTreeStatus === "?") {
      untracked.push(filename);
    } else if (indexStatus !== " " && indexStatus !== "?") {
      staged.push(filename);
    } else if (workTreeStatus !== " ") {
      modified.push(filename);
    }
  }

  return {
    branch: branchOutput,
    clean: lines.length === 0,
    modified,
    staged,
    untracked,
  };
}

/**
 * Commit changes in a workspace directory.
 * Returns the commit hash.
 */
export async function commit(
  workspacePath: string,
  options: CommitOptions,
  log: (msg: string) => void,
): Promise<string> {
  const { execFileSync } = await import("node:child_process");

  if (options.all) {
    execFileSync("git", ["add", "-A"], { cwd: workspacePath });
  }

  execFileSync("git", ["commit", "-m", options.message], {
    cwd: workspacePath,
  });

  const hash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf-8",
  }).trim();

  log(`Committed ${hash.slice(0, 8)} in workspace at ${workspacePath}`);
  return hash;
}

/**
 * Push changes to remote for a workspace.
 */
export async function push(
  workspacePath: string,
  branch: string,
  options: PushOptions | undefined,
  log: (msg: string) => void,
): Promise<void> {
  const { execFileSync } = await import("node:child_process");

  const args = ["push"];
  if (options?.setUpstream) {
    args.push("-u", "origin", branch);
  }
  if (options?.force) {
    args.push("--force");
  }

  execFileSync("git", args, { cwd: workspacePath });
  log(`Pushed workspace at ${workspacePath}`);
}

/**
 * Create a pull request for a workspace via the underlying WorkspaceService.
 */
export async function createPR(
  workspaceService: WorkspaceService,
  workspace: WorkspaceResult,
  workspaceId: string,
  options: PROptions,
  log: (msg: string) => void,
): Promise<PullRequestInfo> {
  const finalization: WorkspaceFinalization = {
    push: false, // Already pushed
    createPr: true,
    pr: {
      title: options.title,
      body: options.body,
      targetBranch: options.base ?? workspace.baseBranch,
      draft: options.draft,
      labels: options.labels,
      reviewers: options.reviewers,
    },
    cleanup: false,
  };

  const result = await workspaceService.finalize(workspaceId, finalization);
  if (!result) {
    throw new Error("Failed to create PR");
  }

  log(`Created PR #${result.number} for workspace ${workspaceId}`);
  return result;
}
