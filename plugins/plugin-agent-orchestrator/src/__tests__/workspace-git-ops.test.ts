/**
 * Real-git coverage for the workspace git operations (status/commit/push) and
 * the createPR payload/finalization contract. commit/push/getStatus run against
 * REAL local repositories with a local BARE repo standing in as the remote —
 * every assertion reads actual git state back. createPR's only collaborator is
 * the external `git-workspace-service` WorkspaceService (whose GitHub HTTP base
 * is hardcoded inside that package and not injectable from this plugin), so its
 * `finalize` seam is the boundary faked here: the tests assert the exact
 * finalization payload the unit constructs and that API errors / empty results
 * surface as typed failures instead of being swallowed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PullRequestInfo,
  WorkspaceFinalization,
  WorkspaceService,
} from "git-workspace-service";
import { afterEach, describe, expect, it } from "vitest";
import {
  commit,
  createPR,
  getStatus,
  push,
} from "../services/workspace-git-ops.ts";
import type { WorkspaceResult } from "../services/workspace-types.ts";

const cleanupDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Bare repo (the "remote") plus a working clone with identity configured. */
function makeRepoPair(): { bare: string; work: string } {
  const bare = tempDir("git-ops-bare-");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = tempDir("git-ops-work-");
  execFileSync("git", ["clone", "-q", bare, work]);
  git(work, "config", "user.email", "ops@test.local");
  git(work, "config", "user.name", "Git Ops Test");
  writeFileSync(join(work, "README.md"), "# seed\n");
  git(work, "add", "README.md");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "push", "-q", "-u", "origin", "main");
  return { bare, work };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const noopLog = () => {};

describe("getStatus (real git)", () => {
  it("reports clean on a fresh clone and classifies staged/modified/untracked", async () => {
    const { work } = makeRepoPair();
    expect(await getStatus(work)).toMatchObject({
      branch: "main",
      clean: true,
      modified: [],
      staged: [],
      untracked: [],
    });

    writeFileSync(join(work, "new.txt"), "untracked\n");
    writeFileSync(join(work, "README.md"), "# modified\n");
    writeFileSync(join(work, "staged.txt"), "staged\n");
    git(work, "add", "staged.txt");

    const status = await getStatus(work);
    expect(status.clean).toBe(false);
    expect(status.untracked).toContain("new.txt");
    expect(status.modified).toContain("README.md");
    expect(status.staged).toContain("staged.txt");
  });
});

describe("commit (real git)", () => {
  it("stages everything with all:true and creates a commit with the exact message + author", async () => {
    const { work } = makeRepoPair();
    writeFileSync(join(work, "feature.ts"), "export const x = 1;\n");

    const hash = await commit(
      work,
      { message: "feat: add feature", all: true },
      noopLog,
    );

    expect(hash).toBe(git(work, "rev-parse", "HEAD"));
    expect(git(work, "log", "-1", "--pretty=%B")).toBe("feat: add feature");
    expect(git(work, "log", "-1", "--pretty=%an")).toBe("Git Ops Test");
    // all:true really staged the untracked file into the commit.
    expect(git(work, "show", "--name-only", "--pretty=", "HEAD")).toContain(
      "feature.ts",
    );
    expect((await getStatus(work)).clean).toBe(true);
  });

  it("surfaces git's nothing-to-commit failure instead of fabricating a hash", async () => {
    const { work } = makeRepoPair();
    await expect(
      commit(work, { message: "empty", all: true }, noopLog),
    ).rejects.toThrow();
    // No commit was created.
    expect(git(work, "log", "--oneline")).not.toContain("empty");
  });
});

describe("push (real git, local bare remote)", () => {
  it("push with setUpstream updates the bare remote's branch to the local commit", async () => {
    const { bare, work } = makeRepoPair();
    git(work, "checkout", "-q", "-b", "feat/push-test");
    writeFileSync(join(work, "pushed.txt"), "pushed\n");
    const hash = await commit(
      work,
      { message: "feat: pushed change", all: true },
      noopLog,
    );

    await push(work, "feat/push-test", { setUpstream: true }, noopLog);

    // The BARE remote now has the branch at exactly the local commit.
    expect(git(bare, "rev-parse", "refs/heads/feat/push-test")).toBe(hash);
    // Upstream tracking was configured.
    expect(git(work, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/feat/push-test",
    );
  });

  it("surfaces a non-fast-forward push rejection instead of swallowing it", async () => {
    const { bare, work } = makeRepoPair();
    // Advance the remote's main from a second clone so `work` is behind.
    const other = tempDir("git-ops-other-");
    execFileSync("git", ["clone", "-q", bare, other]);
    git(other, "config", "user.email", "other@test.local");
    git(other, "config", "user.name", "Other");
    writeFileSync(join(other, "ahead.txt"), "ahead\n");
    git(other, "add", "ahead.txt");
    git(other, "commit", "-q", "-m", "remote moved");
    git(other, "push", "-q", "origin", "main");

    writeFileSync(join(work, "local.txt"), "local\n");
    await commit(work, { message: "local divergence", all: true }, noopLog);

    await expect(
      push(work, "main", { setUpstream: true }, noopLog),
    ).rejects.toThrow();
    // The remote kept the other clone's commit — nothing was clobbered.
    expect(git(bare, "log", "-1", "--pretty=%B", "main")).toBe("remote moved");
  });
});

describe("createPR (finalize boundary of git-workspace-service)", () => {
  const workspace: WorkspaceResult = {
    id: "ws-1",
    path: "/tmp/ws-1",
    branch: "feat/pr-branch",
    baseBranch: "develop",
    isWorktree: false,
    repo: "https://github.com/acme/widgets",
    status: "ready",
  };

  function finalizeRecorder(result: PullRequestInfo | undefined) {
    const calls: Array<{
      workspaceId: string;
      options: WorkspaceFinalization;
    }> = [];
    const service = {
      finalize: async (
        workspaceId: string,
        options: WorkspaceFinalization,
      ): Promise<PullRequestInfo | undefined> => {
        calls.push({ workspaceId, options });
        return result;
      },
    } as unknown as WorkspaceService;
    return { calls, service };
  }

  const prInfo: PullRequestInfo = {
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
  } as PullRequestInfo;

  it("sends the exact finalization payload (PR only, no re-push) and returns the PR info", async () => {
    const { calls, service } = finalizeRecorder(prInfo);
    const result = await createPR(
      service,
      workspace,
      "ws-1",
      {
        title: "feat: widgets",
        body: "adds widgets",
        draft: true,
        labels: ["auto"],
        reviewers: ["octocat"],
      },
      noopLog,
    );
    expect(result).toBe(prInfo);
    expect(calls).toEqual([
      {
        workspaceId: "ws-1",
        options: {
          push: false,
          createPr: true,
          pr: {
            title: "feat: widgets",
            body: "adds widgets",
            targetBranch: "develop", // no explicit base → workspace.baseBranch
            draft: true,
            labels: ["auto"],
            reviewers: ["octocat"],
          },
          cleanup: false,
        },
      },
    ]);
  });

  it("an explicit base overrides the workspace's provision-time base branch", async () => {
    const { calls, service } = finalizeRecorder(prInfo);
    await createPR(
      service,
      workspace,
      "ws-1",
      { title: "t", body: "b", base: "release/1.0" },
      noopLog,
    );
    expect(calls[0].options.pr?.targetBranch).toBe("release/1.0");
  });

  it("propagates a GitHub API error (e.g. 422) instead of swallowing it", async () => {
    const service = {
      finalize: async () => {
        throw new Error(
          "Validation Failed: A pull request already exists (HTTP 422)",
        );
      },
    } as unknown as WorkspaceService;
    await expect(
      createPR(service, workspace, "ws-1", { title: "t", body: "b" }, noopLog),
    ).rejects.toThrow(/422/);
  });

  it("an empty finalize result becomes a typed failure, never a fabricated PR", async () => {
    const { service } = finalizeRecorder(undefined);
    await expect(
      createPR(service, workspace, "ws-1", { title: "t", body: "b" }, noopLog),
    ).rejects.toThrow("Failed to create PR");
  });
});
