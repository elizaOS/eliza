import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyStackDependencyEvidence,
  buildStackDependencyGraph,
} from "../src/stack-dependencies.js";

describe("stack dependency graph", () => {
  it("detects stacked pull requests from target branches", () => {
    const graph = buildStackDependencyGraph({
      queueItems: [
        item({
          id: "elizaos/eliza#10",
          pullRequestId: 10,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          queueState: "ready",
        }),
        item({
          id: "elizaos/eliza#11",
          pullRequestId: 11,
          sourceBranch: "agent/runtime/followup",
          targetBranch: "agent/runtime/root",
          queueState: "ready",
        }),
        item({
          id: "elizaos/eliza#12",
          pullRequestId: 12,
          sourceBranch: "agent/runtime/final",
          targetBranch: "agent/runtime/followup",
          queueState: "ready",
        }),
      ],
    });

    assert.equal(graph.stackCount, 1);
    assert.equal(graph.stackedItemCount, 3);
    assert.equal(graph.blockedItemCount, 2);
    assert.equal(graph.stacks[0].state, "waiting");
    assert.deepEqual(graph.stacks[0].itemIds, [
      "elizaos/eliza#10",
      "elizaos/eliza#11",
      "elizaos/eliza#12",
    ]);
    assert.equal(graph.stacks[0].nextMergeItemId, "elizaos/eliza#10");

    const root = graph.items.find((entry) => entry.id === "elizaos/eliza#10");
    const followup = graph.items.find(
      (entry) => entry.id === "elizaos/eliza#11",
    );
    const final = graph.items.find((entry) => entry.id === "elizaos/eliza#12");

    assert.equal(root.state, "stack_root");
    assert.equal(followup.state, "waiting_on_stack");
    assert.equal(followup.dependencies[0].source, "target_branch");
    assert.deepEqual(followup.requiredActions, ["merge_stack_parents_first"]);
    assert.equal(final.blockingDependencies[0].id, "elizaos/eliza#11");
  });

  it("advances the next merge item after a parent lands", () => {
    const graph = buildStackDependencyGraph({
      queueItems: [
        item({
          id: "elizaos/eliza#10",
          pullRequestId: 10,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          queueState: "merged",
        }),
        item({
          id: "elizaos/eliza#11",
          pullRequestId: 11,
          sourceBranch: "agent/runtime/followup",
          targetBranch: "agent/runtime/root",
          queueState: "ready",
        }),
      ],
    });

    const followup = graph.items.find(
      (entry) => entry.id === "elizaos/eliza#11",
    );

    assert.equal(graph.stacks[0].nextMergeItemId, "elizaos/eliza#11");
    assert.equal(followup.state, "ready_in_stack");
    assert.equal(followup.stackBlocked, false);
    assert.deepEqual(followup.nextActions, ["enter_merge_queue"]);
  });

  it("reports explicit missing and failed dependencies", () => {
    const graph = buildStackDependencyGraph({
      queueItems: [
        item({
          id: "elizaos/eliza#20",
          pullRequestId: 20,
          queueState: "failed",
        }),
        item({
          id: "elizaos/eliza#21",
          pullRequestId: 21,
          dependsOnPullRequestIds: [20, 99],
          queueState: "ready",
        }),
      ],
    });
    const child = graph.items.find((entry) => entry.id === "elizaos/eliza#21");

    assert.equal(graph.stackCount, 1);
    assert.equal(graph.missingDependencyCount, 1);
    assert.equal(graph.stacks[0].state, "missing_dependency");
    assert.equal(child.state, "missing_dependency");
    assert.deepEqual(
      child.failedDependencies.map((dependency) => dependency.id),
      ["elizaos/eliza#20"],
    );
    assert.deepEqual(
      child.missingDependencies.map((dependency) => dependency.id),
      ["elizaos/eliza#99"],
    );
    assert.deepEqual(child.requiredActions, [
      "link_missing_stack_dependencies",
      "repair_or_recreate_failed_stack_parent",
      "merge_stack_parents_first",
    ]);
  });

  it("marks dependency cycles as broken stacks", () => {
    const graph = buildStackDependencyGraph({
      queueItems: [
        item({
          id: "elizaos/eliza#30",
          pullRequestId: 30,
          dependsOnPullRequestIds: [31],
        }),
        item({
          id: "elizaos/eliza#31",
          pullRequestId: 31,
          dependsOnPullRequestIds: [30],
        }),
      ],
    });

    assert.equal(graph.cycleCount, 1);
    assert.equal(graph.stacks[0].state, "cycle");
    assert.equal(
      graph.items.find((entry) => entry.id === "elizaos/eliza#30").state,
      "cycle",
    );
    assert.ok(graph.stacks[0].requiredActions.includes("repair_stack_cycle"));
  });

  it("attaches stack dependency evidence to queue items", () => {
    const [root, child] = applyStackDependencyEvidence([
      item({
        id: "elizaos/eliza#40",
        pullRequestId: 40,
        sourceBranch: "agent/stack/root",
      }),
      item({
        id: "elizaos/eliza#41",
        pullRequestId: 41,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
      }),
    ]);

    assert.equal(root.stackDependency.state, "stack_root");
    assert.equal(root.stackDependency.stackBlocked, false);
    assert.equal(child.stackDependency.state, "waiting_on_stack");
    assert.equal(child.stackDependency.stackBlocked, true);
    assert.deepEqual(child.stackDependency.requiredActions, [
      "merge_stack_parents_first",
    ]);
  });
});

function item(overrides = {}) {
  return {
    id: "elizaos/eliza#1",
    repo: "elizaos/eliza",
    pullRequestId: 1,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    ownerAgentId: "agent-one",
    queueState: "ready",
    ...overrides,
  };
}
