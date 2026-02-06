import { logger } from "@/lib/utils/logger";
import type { SandboxInstance } from "@/lib/services/sandbox/types";
import { githubReposService } from "./github-repos";

/**
 * Git Sync Service
 *
 * Handles synchronization between sandbox files and GitHub repositories.
 * This is the critical layer that bridges sandbox development with persistent storage.
 */

declare global {
  var __sandboxInstances: Map<string, SandboxInstance> | undefined;
}

const getActiveSandboxes = (): Map<string, SandboxInstance> => {
  if (!global.__sandboxInstances) {
    global.__sandboxInstances = new Map<string, SandboxInstance>();
  }
  return global.__sandboxInstances;
};

export interface GitSyncConfig {
  sandboxId: string;
  repoFullName: string;
  branch?: string;
}

export interface CommitOptions {
  message: string;
  author?: { name: string; email: string };
  files?: string[];
}

export interface CommitResult {
  success: boolean;
  commitSha?: string;
  filesCommitted: number;
  error?: string;
}

export interface GitStatusResult {
  hasChanges: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * Default git author for commits.
 * Configure via environment variables to use your own email for Vercel attribution:
 * - GIT_COMMIT_AUTHOR_NAME: Name for commits (default: "ElizaCloud Bot")
 * - GIT_COMMIT_AUTHOR_EMAIL: Email for commits (default: "bot@elizacloud.ai")
 *
 * Important: For Vercel deployments, use an email that matches your GitHub account
 * to ensure proper commit author attribution.
 */
const DEFAULT_AUTHOR = {
  name: process.env.GIT_COMMIT_AUTHOR_NAME || "ElizaCloud Bot",
  email: process.env.GIT_COMMIT_AUTHOR_EMAIL || "bot@elizacloud.ai",
};

export class GitSyncService {
  private async runGitCommand(
    sandbox: SandboxInstance,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await sandbox.runCommand({ cmd: "git", args });
    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  }

  private getSandbox(sandboxId: string): SandboxInstance | null {
    return getActiveSandboxes().get(sandboxId) || null;
  }

  async isGitAvailable(sandboxId: string): Promise<boolean> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return false;
    try {
      const result = await this.runGitCommand(sandbox, ["--version"]);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async isGitRepo(sandboxId: string): Promise<boolean> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return false;
    try {
      const result = await this.runGitCommand(sandbox, [
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      return result.exitCode === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async configureGit(
    config: GitSyncConfig,
  ): Promise<{ success: boolean; error?: string }> {
    const { sandboxId, repoFullName, branch = "main" } = config;
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return { success: false, error: "Sandbox not found" };

    logger.info("Configuring git in sandbox", {
      sandboxId,
      repoFullName,
      branch,
    });

    try {
      const gitAvailable = await this.isGitAvailable(sandboxId);
      if (!gitAvailable)
        return { success: false, error: "Git is not available in sandbox" };

      const repoName = repoFullName.includes("/")
        ? repoFullName.split("/").pop()!
        : repoFullName;
      let authenticatedUrl: string;
      try {
        authenticatedUrl =
          githubReposService.getAuthenticatedCloneUrl(repoName);
      } catch (e) {
        return {
          success: false,
          error: `Failed to get authenticated URL: ${e instanceof Error ? e.message : "Unknown"}`,
        };
      }

      const isRepo = await this.isGitRepo(sandboxId);
      if (!isRepo) {
        const initResult = await this.runGitCommand(sandbox, ["init"]);
        if (initResult.exitCode !== 0)
          return {
            success: false,
            error: `Git init failed: ${initResult.stderr}`,
          };
        await this.runGitCommand(sandbox, ["checkout", "-b", branch]);
      } else {
        // Repo exists (cloned from template) - ensure we're on the right branch
        const currentBranch = await this.runGitCommand(sandbox, [
          "branch",
          "--show-current",
        ]);
        const currentBranchName = currentBranch.stdout.trim();
        logger.info("Current git branch", {
          sandboxId,
          currentBranch: currentBranchName,
          targetBranch: branch,
        });

        // If not on the target branch, try to switch or create it
        if (currentBranchName !== branch) {
          // Try to checkout existing branch or create new one
          const checkoutResult = await this.runGitCommand(sandbox, [
            "checkout",
            "-B",
            branch,
          ]);
          if (checkoutResult.exitCode !== 0) {
            logger.warn("Failed to switch to target branch", {
              sandboxId,
              targetBranch: branch,
              error: checkoutResult.stderr,
            });
          }
        }
      }

      await this.runGitCommand(sandbox, [
        "config",
        "user.name",
        DEFAULT_AUTHOR.name,
      ]);
      await this.runGitCommand(sandbox, [
        "config",
        "user.email",
        DEFAULT_AUTHOR.email,
      ]);

      const remoteResult = await this.runGitCommand(sandbox, ["remote", "-v"]);
      const hasOrigin = remoteResult.stdout.includes("origin");

      if (hasOrigin) {
        await this.runGitCommand(sandbox, [
          "remote",
          "set-url",
          "origin",
          authenticatedUrl,
        ]);
      } else {
        await this.runGitCommand(sandbox, [
          "remote",
          "add",
          "origin",
          authenticatedUrl,
        ]);
      }

      // Fetch from origin (may fail if remote branch doesn't exist yet, that's ok)
      const fetchResult = await this.runGitCommand(sandbox, [
        "fetch",
        "origin",
        branch,
      ]);
      if (fetchResult.exitCode !== 0) {
        logger.info("Fetch from origin failed (branch may not exist yet)", {
          sandboxId,
          branch,
          stderr: fetchResult.stderr,
        });
        // This is ok - the branch might not exist on remote yet (new repo)
      }

      logger.info("Git configured successfully", {
        sandboxId,
        repoFullName,
        wasNewRepo: !isRepo,
      });
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to configure git", {
        sandboxId,
        repoFullName,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  }

  async getStatus(sandboxId: string): Promise<GitStatusResult | null> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return null;

    try {
      const result = await this.runGitCommand(sandbox, [
        "status",
        "--porcelain",
      ]);
      if (result.exitCode !== 0) return null;

      const lines = result.stdout.split("\n").filter((l) => l.trim());
      const staged: string[] = [];
      const unstaged: string[] = [];
      const untracked: string[] = [];

      for (const line of lines) {
        const indexStatus = line[0];
        const workingStatus = line[1];
        const filePath = line.substring(3);

        if (indexStatus === "?" && workingStatus === "?") {
          untracked.push(filePath);
        } else if (indexStatus !== " " && indexStatus !== "?") {
          staged.push(filePath);
        }
        if (workingStatus !== " " && workingStatus !== "?") {
          unstaged.push(filePath);
        }
      }

      return { hasChanges: lines.length > 0, staged, unstaged, untracked };
    } catch {
      return null;
    }
  }

  async hasUncommittedChanges(sandboxId: string): Promise<boolean> {
    const status = await this.getStatus(sandboxId);
    return status?.hasChanges ?? false;
  }

  async stageFiles(
    sandboxId: string,
    files?: string[],
  ): Promise<{ success: boolean; error?: string }> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) {
      logger.error("Sandbox not found for staging files", { sandboxId });
      return { success: false, error: "Sandbox not found" };
    }

    try {
      // Log current working directory and file list before staging
      const pwdResult = await sandbox.runCommand({ cmd: "pwd", args: [] });
      const lsResult = await sandbox.runCommand({
        cmd: "ls",
        args: ["-la"],
      });
      logger.info("Staging files - current state", {
        sandboxId,
        pwd: (await pwdResult.stdout()).trim(),
        files: files ?? "all (-A)",
        lsOutput: (await lsResult.stdout()).substring(0, 500),
      });

      const result =
        files && files.length > 0
          ? await this.runGitCommand(sandbox, ["add", ...files])
          : await this.runGitCommand(sandbox, ["add", "-A"]);

      logger.info("Git add result", {
        sandboxId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });

      if (result.exitCode !== 0)
        return { success: false, error: result.stderr };
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async commit(
    sandboxId: string,
    options: CommitOptions,
  ): Promise<CommitResult> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox)
      return { success: false, filesCommitted: 0, error: "Sandbox not found" };

    const { message, author = DEFAULT_AUTHOR, files } = options;

    try {
      // Configure author first
      await this.runGitCommand(sandbox, ["config", "user.name", author.name]);
      await this.runGitCommand(sandbox, ["config", "user.email", author.email]);

      const stageResult = await this.stageFiles(sandboxId, files);
      if (!stageResult.success) {
        return {
          success: false,
          filesCommitted: 0,
          error: `Failed to stage files: ${stageResult.error}`,
        };
      }

      // Get raw git status for debugging
      const rawStatus = await this.runGitCommand(sandbox, [
        "status",
        "--porcelain",
      ]);
      logger.info("Git status after staging", {
        sandboxId,
        exitCode: rawStatus.exitCode,
        stdout: rawStatus.stdout,
        stderr: rawStatus.stderr,
      });

      // Also check diff --cached to see what's actually staged
      const diffCached = await this.runGitCommand(sandbox, [
        "diff",
        "--cached",
        "--name-only",
      ]);
      const stagedFiles = diffCached.stdout
        .trim()
        .split("\n")
        .filter((f) => f.trim());

      logger.info("Staged files from diff --cached", {
        sandboxId,
        stagedFiles,
        count: stagedFiles.length,
      });

      // If nothing staged according to diff --cached, nothing to commit
      if (stagedFiles.length === 0) {
        logger.info("No files staged for commit", { sandboxId });
        return { success: true, filesCommitted: 0 };
      }

      const commitResult = await this.runGitCommand(sandbox, [
        "commit",
        "-m",
        message,
      ]);

      logger.info("Commit result", {
        sandboxId,
        exitCode: commitResult.exitCode,
        stdout: commitResult.stdout,
        stderr: commitResult.stderr,
      });

      if (commitResult.exitCode !== 0) {
        if (
          commitResult.stdout.includes("nothing to commit") ||
          commitResult.stderr.includes("nothing to commit")
        ) {
          return { success: true, filesCommitted: 0 };
        }
        return {
          success: false,
          filesCommitted: 0,
          error: commitResult.stderr || commitResult.stdout,
        };
      }

      const shaResult = await this.runGitCommand(sandbox, [
        "rev-parse",
        "HEAD",
      ]);
      const commitSha = shaResult.stdout.trim();

      logger.info("Commit created", {
        sandboxId,
        commitSha,
        filesCommitted: stagedFiles.length,
      });
      return { success: true, commitSha, filesCommitted: stagedFiles.length };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to create commit", {
        sandboxId,
        error: errorMessage,
      });
      return { success: false, filesCommitted: 0, error: errorMessage };
    }
  }

  async push(
    sandboxId: string,
    options?: { branch?: string; force?: boolean },
  ): Promise<{ success: boolean; error?: string }> {
    const { branch = "main", force = false } = options || {};
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return { success: false, error: "Sandbox not found" };

    try {
      const args = ["push", "-u", "origin", branch];
      if (force) args.splice(1, 0, "--force");

      const result = await this.runGitCommand(sandbox, args);
      if (result.exitCode !== 0) {
        if (result.stderr.includes("rejected")) {
          return {
            success: false,
            error: "Push rejected - remote has changes",
          };
        }
        return { success: false, error: result.stderr };
      }

      logger.info("Push successful", { sandboxId, branch });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async commitAndPush(
    config: GitSyncConfig,
    options: CommitOptions,
  ): Promise<CommitResult> {
    const { sandboxId, repoFullName, branch = "main" } = config;

    logger.info("Starting commit and push", {
      sandboxId,
      repoFullName,
      branch,
    });

    const configResult = await this.configureGit(config);
    if (!configResult.success) {
      return {
        success: false,
        filesCommitted: 0,
        error: `Git configuration failed: ${configResult.error}`,
      };
    }

    const commitResult = await this.commit(sandboxId, options);
    if (!commitResult.success || commitResult.filesCommitted === 0) {
      return commitResult;
    }

    const pushResult = await this.push(sandboxId, { branch, force: true });
    if (!pushResult.success) {
      return {
        success: false,
        commitSha: commitResult.commitSha,
        filesCommitted: commitResult.filesCommitted,
        error: `Commit succeeded but push failed: ${pushResult.error}`,
      };
    }

    logger.info("Commit and push successful", {
      sandboxId,
      repoFullName,
      commitSha: commitResult.commitSha,
    });
    return commitResult;
  }

  async getCurrentCommitSha(sandboxId: string): Promise<string | null> {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return null;
    try {
      const result = await this.runGitCommand(sandbox, ["rev-parse", "HEAD"]);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  async getLocalCommits(
    sandboxId: string,
    limit: number = 10,
  ): Promise<
    Array<{ sha: string; message: string; author: string; date: string }>
  > {
    const sandbox = this.getSandbox(sandboxId);
    if (!sandbox) return [];
    try {
      const result = await this.runGitCommand(sandbox, [
        "log",
        `--max-count=${limit}`,
        "--format=%H|%s|%an|%ai",
      ]);
      if (result.exitCode !== 0) return [];
      return result.stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          const [sha, message, author, date] = line.split("|");
          return { sha, message, author, date };
        });
    } catch {
      return [];
    }
  }
}

export const gitSyncService = new GitSyncService();
