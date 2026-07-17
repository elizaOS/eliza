import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { waitForRequiredChecks } from "./check-watcher.js";
import { defaultIntegrationWorkDir } from "./runtime-paths.js";

export class LocalGitIntegrationExecutor {
  constructor({
    remoteUrl,
    workDir = defaultIntegrationWorkDir(),
    gitBinary = "git",
    pushBranch = false,
    statusClient,
    checkConfig = {},
    mergeMethod = "merge",
    deleteBranchAfterMerge = false,
    mergeTitle,
    mergeMessage,
    sleep,
    runCommand = runCommandProcess,
  } = {}) {
    if (!remoteUrl) {
      throw new TypeError("LocalGitIntegrationExecutor requires remoteUrl");
    }

    this.remoteUrl = remoteUrl;
    this.workDir = workDir;
    this.gitBinary = gitBinary;
    this.pushBranch = pushBranch;
    this.statusClient = statusClient;
    this.checkConfig = checkConfig;
    this.mergeMethod = mergeMethod;
    this.deleteBranchAfterMerge = deleteBranchAfterMerge;
    this.mergeTitle = mergeTitle;
    this.mergeMessage = mergeMessage;
    this.sleep = sleep;
    this.runCommand = runCommand;
  }

  async ensureIntegrationBranch({ plan, action }) {
    const from = assertSafeGitRef(action.from, "action.from");
    const branch = assertSafeGitRef(action.branch, "action.branch");
    const cwd = await this.prepareRepository(plan);
    await this.git(["fetch", "--depth=50", "origin", "--", from], { cwd });
    await this.git(["checkout", "-B", branch, "FETCH_HEAD", "--"], { cwd });

    return {
      cwd,
      branch,
      from,
      mode: action.mode,
    };
  }

  async mergePullRequestHeadIntoIntegration({ plan, action }) {
    const sourceBranch = assertSafeGitRef(
      action.sourceBranch,
      "action.sourceBranch",
    );
    const integrationBranch = assertSafeGitRef(
      plan.integrationBranch,
      "plan.integrationBranch",
    );
    const cwd = await this.prepareRepository(plan);
    await this.git(["fetch", "--depth=50", "origin", "--", sourceBranch], {
      cwd,
    });
    await this.git(["checkout", integrationBranch, "--"], { cwd });
    await this.git(["merge", "--no-ff", "--no-edit", "FETCH_HEAD"], { cwd });

    if (this.pushBranch) {
      await this.git(
        ["push", "--force-with-lease", "origin", `HEAD:${integrationBranch}`],
        { cwd },
      );
    }

    return {
      cwd,
      branch: integrationBranch,
      sourceBranch,
      pushed: this.pushBranch,
    };
  }

  async waitForIntegrationChecks({ plan, action }) {
    const result = await waitForRequiredChecks({
      client: this.statusClient,
      repo: plan.repo,
      ref: action.branch,
      requiredChecks: action.requiredChecks,
      config: this.checkConfig,
      sleep: this.sleep,
    });

    if (result.status !== "passed") {
      throw new Error(`integration checks ${result.status}: ${result.reason}`);
    }

    return result;
  }

  async mergeOriginalPullRequest({ plan, action, repo }) {
    if (typeof this.statusClient?.mergePullRequest !== "function") {
      throw new Error("Forgejo merge client is not configured");
    }

    const pullRequestId = action.pullRequestId ?? plan.pullRequestId;
    const body = dropUndefined({
      Do: action.mergeMethod ?? this.mergeMethod,
      delete_branch_after_merge:
        action.deleteBranchAfterMerge ?? this.deleteBranchAfterMerge,
      MergeTitleField: action.mergeTitle ?? this.mergeTitle,
      MergeMessageField: action.mergeMessage ?? this.mergeMessage,
    });
    const result = await this.statusClient.mergePullRequest(
      repo,
      pullRequestId,
      body,
    );

    return {
      pullRequestId,
      method: body.Do,
      deleteBranchAfterMerge: body.delete_branch_after_merge,
      result,
    };
  }

  async prepareRepository(plan) {
    const cwd = join(this.workDir, repoWorkDirName(plan));
    await mkdir(cwd, { recursive: true });
    await this.git(["init"], { cwd });
    await this.git(["remote", "remove", "origin"], { cwd, allowFailure: true });
    await this.git(["remote", "add", "origin", this.remoteUrl], { cwd });
    return cwd;
  }

  async git(args, { cwd, allowFailure = false } = {}) {
    const result = await this.runCommand(this.gitBinary, args, { cwd });
    if (result.status !== 0 && !allowFailure) {
      const message =
        result.stderr ||
        result.stdout ||
        `${this.gitBinary} ${args.join(" ")} failed`;
      throw new Error(message.trim());
    }
    return result;
  }
}

export function repoWorkDirName(plan = {}) {
  return slug(`${plan.repo ?? "repo"}-${plan.pullRequestId ?? "pr"}`);
}

// Mirrors the git check-ref-format rules that matter for argv safety: refs are
// PR-derived (attacker-influenced), so anything that could read as an option
// (leading "-"), a revision operator ("..", "@{", "~", "^", ":"), a glob, or a
// path escape is rejected before it is ever placed on a git command line.
const SAFE_REF_CHARS = /^[\x21-\x7e]+$/;
const FORBIDDEN_REF_CHARS = /[~^:?*[\\\s]/;

export function assertSafeGitRef(value, label = "ref") {
  const ref = typeof value === "string" ? value : "";
  const valid =
    ref.length > 0 &&
    ref.length <= 255 &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.includes("@{") &&
    ref !== "@" &&
    SAFE_REF_CHARS.test(ref) &&
    !FORBIDDEN_REF_CHARS.test(ref);
  if (!valid) {
    throw new TypeError(
      `LocalGitIntegrationExecutor: unsafe git ref for ${label}: ${JSON.stringify(value)}`,
    );
  }
  return ref;
}

export function runCommandProcess(command, args = [], { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function slug(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "repo"
  );
}

function dropUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
