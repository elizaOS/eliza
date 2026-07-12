import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeIntegrationPlan } from "../src/integration-executor.js";
import { buildIntegrationPlan } from "../src/integration-plan.js";

describe("integration executor", () => {
  it("refuses execution when disabled", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: false, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "integration_disabled");
    assert.deepEqual(calls, []);
  });

  it("does not call the client in dry-run mode", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: true },
      confirmed: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.executions[0].status, "planned");
    assert.deepEqual(calls, []);
  });

  it("requires explicit confirmation for live execution", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "integration_execution_not_confirmed");
    assert.deepEqual(calls, []);
  });

  it("blocks live execution when required checks are missing", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan({ requiredChecks: [] }),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "required_checks_missing");
    assert.deepEqual(calls, []);
  });

  it("executes live multi-PR plans as a sequential merge train", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: batchPlan(),
      client: recordingClient(calls, {
        currentHeadSha: {
          12: "head-sha",
          13: "head-sha-two",
        },
      }),
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.strategy, "merge-train");
    assert.deepEqual(
      result.executions.map((execution) => execution.status),
      ["executed", "executed"],
    );
    assert.deepEqual(
      calls.map((call) => [
        call[0],
        call[1]?.plan?.pullRequestId ?? call[1]?.number,
      ]),
      [
        ["ensureIntegrationBranch", 12],
        ["mergePullRequestHeadIntoIntegration", 12],
        ["waitForIntegrationChecks", 12],
        ["getPullRequest", 12],
        ["mergeOriginalPullRequest", 12],
        ["ensureIntegrationBranch", 13],
        ["mergePullRequestHeadIntoIntegration", 13],
        ["waitForIntegrationChecks", 13],
        ["getPullRequest", 13],
        ["mergeOriginalPullRequest", 13],
      ],
    );
  });

  it("stops a merge train after the first failed item", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: batchPlan(),
      client: recordingClient(calls, {
        failAction: "waitForIntegrationChecks",
        currentHeadSha: {
          12: "head-sha",
          13: "head-sha-two",
        },
      }),
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(
      result.executions.map((execution) => execution.status),
      ["failed", "blocked"],
    );
    assert.equal(result.executions[1].reason, "merge_train_predecessor_failed");
    assert.equal(
      calls.some((call) => call[1]?.plan?.pullRequestId === 13),
      false,
    );
  });

  it("executes all actions with normalized repo objects when explicitly enabled", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.executions[0].status, "executed");
    assert.deepEqual(
      calls.map((call) => call[0]),
      [
        "ensureIntegrationBranch",
        "mergePullRequestHeadIntoIntegration",
        "waitForIntegrationChecks",
        "getPullRequest",
        "mergeOriginalPullRequest",
      ],
    );
    assert.deepEqual(calls[0][1].repo, { owner: "elizaos", repo: "eliza" });
  });

  it("stops before final merge when the PR head changed", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls, { currentHeadSha: "new-head-sha" }),
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.executions[0].status, "failed");
    assert.equal(
      result.executions[0].actions.at(-1).reason,
      "head_sha_changed",
    );
    assert.equal(
      calls.some((call) => call[0] === "mergeOriginalPullRequest"),
      false,
    );
  });

  it("stops before the next live action when the action guard blocks", async () => {
    const calls = [];
    const guards = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
      confirmed: true,
      async beforeAction({ action }) {
        guards.push(action.type);
        if (action.type === "merge_pr_head_into_integration") {
          return {
            ok: false,
            reason: "worker_lease_lost",
          };
        }
        return { ok: true };
      },
    });

    assert.equal(result.executions[0].status, "failed");
    assert.deepEqual(guards, [
      "ensure_integration_branch",
      "merge_pr_head_into_integration",
    ]);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["ensureIntegrationBranch"],
    );
    assert.equal(result.executions[0].actions[1].status, "failed");
    assert.equal(result.executions[0].actions[1].reason, "worker_lease_lost");
  });

  it("emits start and finish checkpoints around live actions", async () => {
    const calls = [];
    const checkpoints = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
      confirmed: true,
      async onActionStart({ action }) {
        checkpoints.push(["start", action.type]);
      },
      async onActionComplete({ action, result: actionResult }) {
        checkpoints.push(["finish", action.type, actionResult.status]);
      },
    });

    assert.equal(result.executions[0].status, "executed");
    assert.deepEqual(checkpoints.slice(0, 4), [
      ["start", "ensure_integration_branch"],
      ["finish", "ensure_integration_branch", "executed"],
      ["start", "merge_pr_head_into_integration"],
      ["finish", "merge_pr_head_into_integration", "executed"],
    ]);
    assert.equal(checkpoints.at(-1)[0], "finish");
    assert.equal(checkpoints.at(-1)[1], "merge_original_pull_request");
  });

  it("does not call the client when a start checkpoint fails", async () => {
    const calls = [];
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: recordingClient(calls),
      config: { enabled: true, dryRun: false },
      confirmed: true,
      async onActionStart() {
        throw new Error("checkpoint database unavailable");
      },
    });

    assert.equal(result.executions[0].status, "failed");
    assert.deepEqual(calls, []);
    assert.equal(result.executions[0].actions[0].status, "failed");
    assert.equal(
      result.executions[0].actions[0].reason,
      "integration_action_checkpoint_failed",
    );
    assert.equal(
      result.executions[0].actions[0].checkpoint.error.message,
      "checkpoint database unavailable",
    );
  });

  it("stops at unsupported actions", async () => {
    const result = await executeIntegrationPlan({
      plan: plan(),
      client: {
        async ensureIntegrationBranch() {
          return { ok: true };
        },
      },
      config: { enabled: true, dryRun: false },
      confirmed: true,
    });

    assert.equal(result.executions[0].status, "blocked");
    assert.equal(result.executions[0].actions[1].status, "unsupported");
  });
});

function plan(overrides = {}) {
  return buildIntegrationPlan({
    items: [
      {
        repo: "elizaos/eliza",
        pullRequestId: 12,
        sourceBranch: "agent/change",
        targetBranch: "develop",
        headSha: "head-sha",
        authorKind: "agent",
        ownerAgentId: "agent-one",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedFiles: ["README.md"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
        ...overrides,
      },
    ],
    config: {
      enabled: true,
      dryRun: false,
    },
  });
}

function batchPlan() {
  return buildIntegrationPlan({
    items: [
      readyItem({
        pullRequestId: 12,
        changedFiles: ["packages/core/src/a.ts"],
      }),
      readyItem({
        pullRequestId: 13,
        sourceBranch: "agent/change-two",
        headSha: "head-sha-two",
        changedFiles: ["packages/client/src/b.ts"],
      }),
    ],
    config: {
      enabled: true,
      dryRun: false,
      allowBatching: true,
    },
  });
}

function readyItem(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 12,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    headSha: "head-sha",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    agentKnown: true,
    hasIssueLink: true,
    hasExecutionPlan: true,
    hasValidationPlan: true,
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedFiles: ["README.md"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  };
}

function recordingClient(
  calls,
  { currentHeadSha = "head-sha", failAction } = {},
) {
  return {
    async ensureIntegrationBranch(input) {
      calls.push(["ensureIntegrationBranch", input]);
      failIfRequested("ensureIntegrationBranch", failAction);
      return { ok: true };
    },
    async mergePullRequestHeadIntoIntegration(input) {
      calls.push(["mergePullRequestHeadIntoIntegration", input]);
      failIfRequested("mergePullRequestHeadIntoIntegration", failAction);
      return { ok: true };
    },
    async waitForIntegrationChecks(input) {
      calls.push(["waitForIntegrationChecks", input]);
      failIfRequested("waitForIntegrationChecks", failAction);
      return { ok: true };
    },
    async getPullRequest(repo, number) {
      calls.push(["getPullRequest", { repo, number }]);
      failIfRequested("getPullRequest", failAction);
      return {
        number,
        state: "open",
        merged: false,
        base: { ref: "develop" },
        head: {
          sha:
            typeof currentHeadSha === "object"
              ? currentHeadSha[number]
              : currentHeadSha,
        },
      };
    },
    async mergeOriginalPullRequest(input) {
      calls.push(["mergeOriginalPullRequest", input]);
      failIfRequested("mergeOriginalPullRequest", failAction);
      return { ok: true };
    },
  };
}

function failIfRequested(action, failAction) {
  if (action === failAction) {
    throw new Error(`${action} failed`);
  }
}
