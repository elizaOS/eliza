import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkIntakePlan } from "../src/work-intake.js";

describe("work intake", () => {
  it("plans durable work item creates updates and transitions from queue state", () => {
    const plan = buildWorkIntakePlan({
      now: "2026-07-07T10:00:00.000Z",
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#41",
          pullRequestId: 41,
          queueState: "ready",
          title: "Add docs agent",
          ownerAgentId: "agent-docs",
          changedFiles: ["docs/agents.md"],
          affectedPackages: ["docs"],
          labels: ["agent"],
        }),
        queueItem({
          id: "elizaos/eliza#42",
          pullRequestId: 42,
          queueState: "waiting_for_review",
          title: "Secure runtime",
          ownerAgentId: "agent-runtime",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/docs#1",
          repo: "elizaos/docs",
          pullRequestId: 1,
          queueState: "ready",
        }),
      ],
      workItems: [
        {
          id: "work:elizaos/eliza:pr:42",
          repo: "elizaos/eliza",
          kind: "pull_request",
          pullRequestId: 42,
          state: "in_progress",
          title: "Secure runtime",
          ownerAgentId: "agent-runtime",
          metadata: {
            transitions: [
              {
                from: "ready",
                to: "in_progress",
                at: "2026-07-07T09:00:00.000Z",
              },
            ],
          },
        },
      ],
    });

    assert.equal(plan.summary.queueItems, 2);
    assert.equal(plan.summary.creates, 1);
    assert.equal(plan.summary.transitions, 1);
    assert.equal(plan.summary.updates, 0);
    assert.equal(plan.summary.unchanged, 0);

    const create = plan.actions.find(
      (action) => action.type === "create_work_item",
    );
    assert.equal(create.targetWorkItem.id, "work:elizaos/eliza:pr:41");
    assert.equal(create.targetWorkItem.state, "ready");
    assert.deepEqual(create.targetWorkItem.paths, ["docs/agents.md"]);
    assert.deepEqual(create.targetWorkItem.packages, ["docs"]);
    assert.equal(create.queueItem.pullRequestId, 41);

    const transition = plan.actions.find(
      (action) => action.type === "transition_work_item",
    );
    assert.equal(transition.existingWorkItemId, "work:elizaos/eliza:pr:42");
    assert.deepEqual(transition.transition, {
      from: "in_progress",
      to: "needs_human_review",
      reason: "queue_state:waiting_for_review",
    });
    assert.equal(transition.targetWorkItem.metadata.transitions.length, 2);
    assert.equal(
      transition.targetWorkItem.metadata.transitions[1].reason,
      "queue_state:waiting_for_review",
    );
  });

  it("reports unchanged and skipped queue items without mutating input", () => {
    const plan = buildWorkIntakePlan({
      now: "2026-07-07T10:00:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#51",
          pullRequestId: 51,
          queueState: "merged",
          title: "Already landed",
        }),
        {
          id: "broken",
          repo: "elizaos/eliza",
          queueState: "ready",
        },
      ],
      workItems: [
        {
          id: "work:elizaos/eliza:pr:51",
          repo: "elizaos/eliza",
          kind: "pull_request",
          pullRequestId: 51,
          state: "done",
          title: "Already landed",
          summary: "PR #51 observed in queue state merged targeting develop.",
          priority: 10,
          ownerAgentId: "agent-one",
          targetBranch: "develop",
        },
      ],
      repo: "elizaos/eliza",
    });

    assert.equal(plan.summary.unchanged, 1);
    assert.equal(plan.summary.skipped, 1);
    assert.equal(plan.actions[0].type, "noop");
    assert.equal(plan.actions[0].reason, "terminal_queue_item_already_synced");
    assert.equal(plan.skipped[0].reason, "missing_repo_or_pull_request");
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#1",
    repo: "elizaos/eliza",
    pullRequestId: 1,
    queueState: "ready",
    title: "Example PR",
    targetBranch: "develop",
    sourceBranch: "agent/example",
    headSha: "head-sha",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    priority: 10,
    changedFiles: [],
    affectedPackages: [],
    labels: [],
    ...overrides,
  };
}
