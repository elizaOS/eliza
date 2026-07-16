import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  LocalGitIntegrationExecutor,
  repoWorkDirName,
} from "../src/local-git-executor.js";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

describe("local git integration executor", () => {
  it("prepares an integration branch without pushing by default", async () => {
    const { executor, calls, cleanup } = await testExecutor();
    try {
      const output = await executor.ensureIntegrationBranch({
        plan: plan(),
        action: {
          type: "ensure_integration_branch",
          branch: "eliza-queue/develop/elizaos-eliza-pr-12",
          from: "develop",
          mode: "reset",
        },
      });

      assert.equal(output.branch, "eliza-queue/develop/elizaos-eliza-pr-12");
      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["init"],
          ["remote", "remove", "origin"],
          [
            "remote",
            "add",
            "origin",
            "ssh://git@example.invalid/elizaos/eliza.git",
          ],
          ["fetch", "--depth=50", "origin", "--", "develop"],
          [
            "checkout",
            "-B",
            "eliza-queue/develop/elizaos-eliza-pr-12",
            "FETCH_HEAD",
            "--",
          ],
        ],
      );
    } finally {
      await cleanup();
    }
  });

  it("merges a PR head and pushes only when configured", async () => {
    const { executor, calls, cleanup } = await testExecutor({
      pushBranch: true,
    });
    try {
      const output = await executor.mergePullRequestHeadIntoIntegration({
        plan: plan(),
        action: {
          type: "merge_pr_head_into_integration",
          sourceBranch: "agent/change",
          headSha: "head-sha",
        },
      });

      assert.equal(output.pushed, true);
      assert.deepEqual(
        calls.map((call) => call.args),
        [
          ["init"],
          ["remote", "remove", "origin"],
          [
            "remote",
            "add",
            "origin",
            "ssh://git@example.invalid/elizaos/eliza.git",
          ],
          ["fetch", "--depth=50", "origin", "--", "agent/change"],
          ["checkout", "eliza-queue/develop/elizaos-eliza-pr-12", "--"],
          ["merge", "--no-ff", "--no-edit", "FETCH_HEAD"],
          [
            "push",
            "--force-with-lease",
            "origin",
            "HEAD:eliza-queue/develop/elizaos-eliza-pr-12",
          ],
        ],
      );
    } finally {
      await cleanup();
    }
  });

  it("ignores missing origin when preparing the repository", async () => {
    const { executor, cleanup } = await testExecutor({
      runCommand(_command, args) {
        if (args.join(" ") === "remote remove origin") {
          return { status: 2, stdout: "", stderr: "No such remote" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    try {
      await executor.ensureIntegrationBranch({
        plan: plan(),
        action: {
          type: "ensure_integration_branch",
          branch: "eliza-queue/develop/elizaos-eliza-pr-12",
          from: "develop",
        },
      });
    } finally {
      await cleanup();
    }
  });

  it("throws when required git commands fail", async () => {
    const { executor, cleanup } = await testExecutor({
      runCommand(_command, args) {
        if (args[0] === "fetch") {
          return { status: 1, stdout: "", stderr: "fetch failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    try {
      await assert.rejects(
        () =>
          executor.ensureIntegrationBranch({
            plan: plan(),
            action: {
              type: "ensure_integration_branch",
              branch: "eliza-queue/develop/elizaos-eliza-pr-12",
              from: "develop",
            },
          }),
        /fetch failed/,
      );
    } finally {
      await cleanup();
    }
  });

  it("waits for required Forgejo checks", async () => {
    const { executor, cleanup } = await testExecutor({
      statusClient: {
        async getCombinedCommitStatus() {
          return { statuses: [{ context: "smoke", state: "success" }] };
        },
      },
    });

    try {
      const result = await executor.waitForIntegrationChecks({
        plan: plan(),
        action: {
          type: "wait_for_checks",
          branch: "eliza-queue/develop/elizaos-eliza-pr-12",
          requiredChecks: ["smoke"],
        },
      });

      assert.equal(result.status, "passed");
    } finally {
      await cleanup();
    }
  });

  it("rejects failed integration checks", async () => {
    const { executor, cleanup } = await testExecutor({
      statusClient: {
        async getCombinedCommitStatus() {
          return { statuses: [{ context: "smoke", state: "failure" }] };
        },
      },
    });

    try {
      await assert.rejects(
        () =>
          executor.waitForIntegrationChecks({
            plan: plan(),
            action: {
              type: "wait_for_checks",
              branch: "eliza-queue/develop/elizaos-eliza-pr-12",
              requiredChecks: ["smoke"],
            },
          }),
        /integration checks failed/,
      );
    } finally {
      await cleanup();
    }
  });

  it("merges the original pull request through Forgejo after checks pass", async () => {
    const mergeCalls = [];
    const { executor, cleanup } = await testExecutor({
      mergeMethod: "squash",
      deleteBranchAfterMerge: true,
      mergeTitle: "Merge via Eliza Steward",
      mergeMessage: "Integration branch checks passed.",
      statusClient: {
        async mergePullRequest(repo, number, body) {
          mergeCalls.push({ repo, number, body });
          return { merged: true, sha: "merge-sha" };
        },
      },
    });

    try {
      const result = await executor.mergeOriginalPullRequest({
        plan: plan(),
        action: {
          type: "merge_original_pull_request",
          pullRequestId: 12,
        },
        repo: { owner: "elizaos", repo: "eliza" },
      });

      assert.equal(result.method, "squash");
      assert.equal(result.result.merged, true);
      assert.deepEqual(mergeCalls, [
        {
          repo: { owner: "elizaos", repo: "eliza" },
          number: 12,
          body: {
            Do: "squash",
            delete_branch_after_merge: true,
            MergeTitleField: "Merge via Eliza Steward",
            MergeMessageField: "Integration branch checks passed.",
          },
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  it("requires a Forgejo merge client for final PR merge", async () => {
    const { executor, cleanup } = await testExecutor();

    try {
      await assert.rejects(
        () =>
          executor.mergeOriginalPullRequest({
            plan: plan(),
            action: { type: "merge_original_pull_request" },
            repo: { owner: "elizaos", repo: "eliza" },
          }),
        /Forgejo merge client is not configured/,
      );
    } finally {
      await cleanup();
    }
  });

  it("rejects option-like or revision-operator refs before they reach git", async () => {
    const hostile = [
      "--upload-pack=/tmp/pwn",
      "-b",
      "feature..main",
      "branch@{upstream}",
      "branch name",
      "branch~1",
      "branch^",
      "refs/heads/",
      "/refs/heads/x",
      "a//b",
      "branch.lock",
      "branch.",
      "@",
      "",
      null,
    ];

    for (const ref of hostile) {
      const { executor, calls, cleanup } = await testExecutor();
      try {
        await assert.rejects(
          () =>
            executor.ensureIntegrationBranch({
              plan: plan(),
              action: {
                type: "ensure_integration_branch",
                branch: "eliza-queue/develop/elizaos-eliza-pr-12",
                from: ref,
              },
            }),
          /unsafe git ref/,
          `expected rejection for ${JSON.stringify(ref)}`,
        );
        await assert.rejects(
          () =>
            executor.mergePullRequestHeadIntoIntegration({
              plan: plan(),
              action: {
                type: "merge_pr_head_into_integration",
                sourceBranch: ref,
              },
            }),
          /unsafe git ref/,
          `expected rejection for ${JSON.stringify(ref)}`,
        );
        // Validation happens before any git subprocess is spawned.
        assert.equal(calls.length, 0);
      } finally {
        await cleanup();
      }
    }
  });

  it("rejects an unsafe integration branch from the plan", async () => {
    const { executor, calls, cleanup } = await testExecutor();
    try {
      await assert.rejects(
        () =>
          executor.mergePullRequestHeadIntoIntegration({
            plan: { ...plan(), integrationBranch: "--force" },
            action: {
              type: "merge_pr_head_into_integration",
              sourceBranch: "agent/change",
            },
          }),
        /unsafe git ref for plan.integrationBranch/,
      );
      assert.equal(calls.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("uses stable workspace names", () => {
    assert.equal(
      repoWorkDirName({ repo: "ElizaOS/Eliza Cloud", pullRequestId: 12 }),
      "elizaos-eliza-cloud-12",
    );
  });
});

async function testExecutor({
  pushBranch = false,
  statusClient,
  mergeMethod,
  deleteBranchAfterMerge,
  mergeTitle,
  mergeMessage,
  runCommand,
} = {}) {
  const workDir = await mkdtempInTestRoot("merge-steward-git-");
  const calls = [];
  return {
    calls,
    executor: new LocalGitIntegrationExecutor({
      remoteUrl: "ssh://git@example.invalid/elizaos/eliza.git",
      workDir,
      pushBranch,
      statusClient,
      mergeMethod,
      deleteBranchAfterMerge,
      mergeTitle,
      mergeMessage,
      runCommand:
        runCommand ??
        ((command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stdout: "", stderr: "" };
        }),
    }),
    cleanup: () => rm(workDir, { recursive: true, force: true }),
  };
}

function plan() {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 12,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    headSha: "head-sha",
    integrationBranch: "eliza-queue/develop/elizaos-eliza-pr-12",
  };
}
