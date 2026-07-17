import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildProjectBoard } from "../src/project-board.js";

describe("project board model", () => {
  it("groups agent workflow cards into board columns lanes agents and merge queue state", () => {
    const board = buildProjectBoard({
      now: "2026-07-06T00:10:00.000Z",
      readiness: {
        ok: true,
        checkedAt: "2026-07-06T00:10:00.000Z",
        configuration: {
          deploymentMode: "production",
        },
      },
      queueItems: [
        queueItem({
          pullRequestId: 901,
          queueState: "waiting_for_review",
          priority: 10,
          changedFiles: ["src/core.ts"],
        }),
        queueItem({
          id: "elizaos/eliza#902",
          pullRequestId: 902,
          queueState: "blocked_conflict",
          priority: 8,
          ownerAgentId: "agent-two",
          changedFiles: ["src/conflict.ts"],
        }),
        queueItem({
          id: "elizaos/eliza#903",
          pullRequestId: 903,
          queueState: "ready",
          priority: 7,
          ownerAgentId: "agent-three",
          changedFiles: ["src/ready.ts"],
        }),
        queueItem({
          id: "elizaos/eliza#904",
          pullRequestId: 904,
          queueState: "running",
          priority: 5,
          ownerAgentId: "agent-four",
          changedFiles: ["src/running.ts"],
        }),
        queueItem({
          id: "elizaos/docs#1",
          repo: "elizaos/docs",
          pullRequestId: 1,
          queueState: "ready",
          ownerAgentId: "agent-docs",
        }),
      ],
      claims: [
        claim({
          resourceId: "src/core.ts",
          paths: ["src/core.ts"],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          id: "claim-conflict",
          ownerAgentId: "agent-two",
          resourceId: "src/conflict.ts",
          paths: ["src/conflict.ts"],
        }),
      ],
      runs: [
        {
          id: "run-needs-human",
          queueItemId: "elizaos/eliza#901",
          repo: "elizaos/eliza",
          pullRequestId: 901,
          ownerKind: "agent",
          ownerId: "agent-one",
          status: "waiting_approval",
        },
        {
          id: "run-failed-orphan",
          queueItemId: "elizaos/eliza#999",
          repo: "elizaos/eliza",
          pullRequestId: 999,
          targetBranch: "develop",
          ownerKind: "agent",
          ownerId: "agent-five",
          status: "failed",
          lastError: "integration failed",
        },
      ],
      approvals: [
        {
          id: "approval-board-one",
          runId: "run-needs-human",
          queueItemId: "elizaos/eliza#901",
          status: "requested",
        },
      ],
      repo: "elizaos/eliza",
    });

    assert.equal(board.id, "eliza-agent-work");
    assert.equal(board.readiness.ok, true);
    assert.equal(board.filters.repo, "elizaos/eliza");
    assert.equal(board.counts.cards, 5);
    assert.equal(board.counts.needsHuman, 1);
    assert.equal(board.counts.blocked, 1);
    assert.equal(board.counts.failed, 1);
    assert.equal(board.counts.running, 1);
    assert.equal(board.counts.ready, 1);

    const needsHumanColumn = board.columns.find(
      (column) => column.id === "needs-human",
    );
    assert.equal(needsHumanColumn.cards[0].id, "queue:elizaos/eliza#901");
    assert.equal(needsHumanColumn.cards[0].claims[0].resourceId, "src/core.ts");
    assert.deepEqual(needsHumanColumn.cards[0].nextActions.slice(0, 1), [
      "decide_approval",
    ]);

    const lane = board.lanes.find(
      (candidate) => candidate.key === "elizaos/eliza:develop",
    );
    assert.equal(lane.total, 5);
    assert.equal(lane.leadCardId, "queue:elizaos/eliza#901");
    assert.deepEqual(lane.readyCardIds, ["queue:elizaos/eliza#903"]);
    assert.deepEqual(lane.runningCardIds, ["queue:elizaos/eliza#904"]);
    assert.ok(lane.attentionCardIds.includes("queue:elizaos/eliza#901"));
    assert.ok(lane.blockedCardIds.includes("queue:elizaos/eliza#902"));
    assert.ok(lane.blockedCardIds.includes("run:run-failed-orphan"));

    const mergeLane = board.mergeQueue.lanes.find(
      (candidate) => candidate.key === "elizaos/eliza:develop",
    );
    assert.equal(mergeLane.state, "busy");
    assert.deepEqual(mergeLane.batchCandidateCardIds, []);
    assert.ok(mergeLane.actionableCardIds.includes("queue:elizaos/eliza#903"));

    assert.equal(
      board.agents.find((agent) => agent.agentId === "agent-one").needsHuman,
      1,
    );
    assert.equal(
      board.agents.find((agent) => agent.agentId === "agent-three").ready,
      1,
    );
    assert.equal(
      board.columns
        .find((column) => column.id === "ready")
        .cards.every((card) => card.repo === "elizaos/eliza"),
      true,
    );
  });

  it("can return a compact owner-specific board without empty columns", () => {
    const board = buildProjectBoard({
      now: "2026-07-06T00:10:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#911",
          pullRequestId: 911,
          queueState: "ready",
          ownerAgentId: "agent-one",
        }),
        queueItem({
          id: "elizaos/eliza#912",
          pullRequestId: 912,
          queueState: "ready",
          ownerAgentId: "agent-two",
        }),
      ],
      ownerAgentId: "agent-one",
      includeEmptyColumns: false,
    });

    assert.equal(board.filters.ownerAgentId, "agent-one");
    assert.equal(board.counts.cards, 1);
    assert.deepEqual(
      board.columns.map((column) => column.id),
      ["ready"],
    );
    assert.equal(board.columns[0].cards[0].id, "queue:elizaos/eliza#911");
    assert.deepEqual(
      board.agents.map((agent) => agent.agentId),
      ["agent-one"],
    );
  });

  it("uses planner-backed batch eligibility instead of marking every ready card as batchable", () => {
    const board = buildProjectBoard({
      now: "2026-07-06T00:10:00.000Z",
      integrationConfig: {
        allowBatching: true,
        maxBatchSize: 4,
      },
      queueItems: [
        schedulableQueueItem({
          id: "elizaos/eliza#921",
          pullRequestId: 921,
          priority: 10,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
        }),
        schedulableQueueItem({
          id: "elizaos/eliza#922",
          pullRequestId: 922,
          priority: 9,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["runtime"],
        }),
        schedulableQueueItem({
          id: "elizaos/eliza#923",
          pullRequestId: 923,
          priority: 8,
          changedLines: 1000,
          changedFiles: ["packages/client/src/c.ts"],
          affectedPackages: ["client"],
        }),
      ],
      repo: "elizaos/eliza",
    });

    const mergeLane = board.mergeQueue.lanes.find(
      (candidate) => candidate.key === "elizaos/eliza:develop",
    );
    const candidateCard = board.columns
      .find((column) => column.id === "ready")
      .cards.find((card) => card.id === "queue:elizaos/eliza#921");
    const overlapCard = board.columns
      .find((column) => column.id === "ready")
      .cards.find((card) => card.id === "queue:elizaos/eliza#922");

    assert.equal(mergeLane.state, "ready");
    assert.deepEqual(mergeLane.readyCardIds, [
      "queue:elizaos/eliza#921",
      "queue:elizaos/eliza#922",
      "queue:elizaos/eliza#923",
    ]);
    assert.deepEqual(mergeLane.batchCandidateCardIds, [
      "queue:elizaos/eliza#921",
    ]);
    assert.deepEqual(
      mergeLane.batchSkippedCards.map((card) => ({
        id: card.id,
        reason: card.reason,
      })),
      [
        { id: "queue:elizaos/eliza#922", reason: "batch_impact_overlap" },
        { id: "queue:elizaos/eliza#923", reason: "item_not_batch_safe" },
      ],
    );
    assert.equal(candidateCard.batchEligibility.selected, true);
    assert.equal(candidateCard.batchEligibility.reason, "selected");
    assert.equal(overlapCard.batchEligibility.selected, false);
    assert.equal(overlapCard.batchEligibility.reason, "batch_impact_overlap");
  });

  it("places stacked PR children in waiting with stack context", () => {
    const board = buildProjectBoard({
      now: "2026-07-06T00:10:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#931",
          pullRequestId: 931,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          queueState: "ready",
          priority: 10,
        }),
        queueItem({
          id: "elizaos/eliza#932",
          pullRequestId: 932,
          sourceBranch: "agent/runtime/followup",
          targetBranch: "agent/runtime/root",
          queueState: "ready",
          priority: 9,
        }),
      ],
      repo: "elizaos/eliza",
    });

    const readyColumn = board.columns.find((column) => column.id === "ready");
    const waitingColumn = board.columns.find(
      (column) => column.id === "waiting",
    );
    const child = waitingColumn.cards.find(
      (card) => card.id === "queue:elizaos/eliza#932",
    );

    assert.deepEqual(
      readyColumn.cards.map((card) => card.id),
      ["queue:elizaos/eliza#931"],
    );
    assert.equal(child.status, "waiting");
    assert.equal(child.columnId, "waiting");
    assert.equal(child.stack.state, "waiting_on_stack");
    assert.equal(child.stack.blockingDependencies[0].id, "elizaos/eliza#931");
    assert.deepEqual(child.nextActions, ["wait_for_stack_parent"]);
    assert.deepEqual(
      board.lanes.find(
        (lane) => lane.key === "elizaos/eliza:agent/runtime/root",
      ).waiting,
      1,
    );
  });

  it("shows durable work items as board cards", () => {
    const board = buildProjectBoard({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      workCycles: [
        {
          id: "cycle:elizaos/eliza:july",
          repo: "elizaos/eliza",
          state: "active",
          title: "July",
        },
      ],
      workModules: [
        {
          id: "module:elizaos/eliza:docs",
          repo: "elizaos/eliza",
          state: "active",
          title: "Docs",
        },
      ],
      workProgress: {
        summary: {
          total: 2,
        },
      },
      workItems: [
        {
          id: "work:elizaos/eliza:task:docs-intake",
          repo: "elizaos/eliza",
          kind: "task",
          state: "ready",
          title: "Document agent intake",
          ownerAgentId: "agent-docs",
          priority: 9,
          taskId: "docs-intake",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:docs",
          paths: ["docs/steward-runtime-model.md"],
          packages: ["docs"],
          labels: ["docs"],
        },
        {
          id: "work:elizaos/eliza:task:blocked-runtime",
          repo: "elizaos/eliza",
          kind: "task",
          state: "blocked",
          title: "Unblock runtime package",
          ownerAgentId: "agent-runtime",
          priority: 4,
          taskId: "blocked-runtime",
          packages: ["runtime"],
        },
      ],
      includeEmptyColumns: false,
    });

    assert.equal(board.counts.cards, 2);
    assert.equal(board.counts.workCycles, 1);
    assert.equal(board.counts.workModules, 1);
    assert.equal(board.counts.ready, 1);
    assert.equal(board.counts.blocked, 1);
    assert.deepEqual(
      board.columns.map((column) => column.id),
      ["blocked", "ready"],
    );
    assert.equal(
      board.columns.find((column) => column.id === "ready").cards[0].kind,
      "work-item",
    );
    assert.equal(
      board.columns.find((column) => column.id === "ready").cards[0].workItem
        .taskId,
      "docs-intake",
    );
    assert.equal(
      board.columns.find((column) => column.id === "ready").cards[0].cycleId,
      "cycle:elizaos/eliza:july",
    );
    assert.equal(
      board.columns.find((column) => column.id === "ready").cards[0].moduleId,
      "module:elizaos/eliza:docs",
    );
    assert.equal(board.work.cycles[0].title, "July");
    assert.equal(board.work.modules[0].title, "Docs");
    assert.equal(board.work.progress.summary.total, 2);
    assert.deepEqual(board.lanes[0].readyCardIds, [
      "work-item:work:elizaos/eliza:task:docs-intake",
    ]);
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#901",
    repo: "elizaos/eliza",
    pullRequestId: 901,
    targetBranch: "develop",
    queueState: "ready",
    ownerAgentId: "agent-one",
    priority: 1,
    hasExecutionPlan: true,
    changedFiles: [],
    affectedPackages: [],
    ...overrides,
  };
}

function schedulableQueueItem(overrides = {}) {
  return queueItem({
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedLines: 10,
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  });
}

function claim(overrides = {}) {
  return {
    id: "claim-core",
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-one",
    status: "active",
    paths: ["src/core.ts"],
    expiresAt: "2026-07-06T00:30:00.000Z",
    ...overrides,
  };
}
