import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentInbox } from "../src/agent-inbox.js";

describe("agent inbox model", () => {
  it("summarizes one agent's owned cards claims next actions and merge lanes", () => {
    const inbox = buildAgentInbox({
      ownerAgentId: "agent-one",
      repo: "elizaos/eliza",
      now: "2026-07-06T00:10:00.000Z",
      readiness: {
        ok: true,
        checkedAt: "2026-07-06T00:10:00.000Z",
      },
      queueItems: [
        queueItem({
          pullRequestId: 1001,
          queueState: "ready",
          priority: 8,
          targetProtected: true,
          reviewSatisfied: true,
          headShaMatches: true,
          requiredChecks: ["smoke"],
          checkResults: { smoke: "success" },
          changedFiles: ["src/ready.ts"],
        }),
        queueItem({
          id: "elizaos/eliza#1002",
          pullRequestId: 1002,
          queueState: "waiting_for_review",
          priority: 10,
          changedFiles: ["src/review.ts"],
        }),
        queueItem({
          id: "elizaos/eliza#1003",
          pullRequestId: 1003,
          queueState: "blocked_conflict",
          ownerAgentId: "agent-two",
          changedFiles: ["src/other.ts"],
        }),
      ],
      claims: [
        claim({
          resourceId: "src/ready.ts",
          paths: ["src/ready.ts"],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          id: "claim-stale",
          resourceId: "src/old.ts",
          paths: ["src/old.ts"],
          expiresAt: "2026-07-06T00:09:00.000Z",
        }),
        claim({
          id: "claim-other",
          ownerAgentId: "agent-two",
          resourceId: "src/other.ts",
          paths: ["src/other.ts"],
        }),
      ],
      runs: [
        {
          id: "run-agent-one-review",
          queueItemId: "elizaos/eliza#1002",
          repo: "elizaos/eliza",
          pullRequestId: 1002,
          ownerKind: "agent",
          ownerId: "agent-one",
          status: "waiting_approval",
        },
      ],
      approvals: [
        {
          id: "approval-agent-one",
          runId: "run-agent-one-review",
          queueItemId: "elizaos/eliza#1002",
          status: "requested",
        },
      ],
      humanRequests: [
        {
          id: "human-agent-one",
          runId: "run-agent-one-review",
          status: "waiting_input",
          prompt: "Confirm the migration window.",
        },
      ],
    });

    assert.equal(inbox.agentId, "agent-one");
    assert.equal(inbox.readiness.ok, true);
    assert.equal(inbox.counts.cards, 2);
    assert.equal(inbox.counts.ready, 1);
    assert.equal(inbox.counts.needsHuman, 1);
    assert.equal(inbox.counts.activeClaims, 1);
    assert.equal(inbox.counts.staleClaims, 1);
    assert.equal(inbox.counts.openApprovals, 1);
    assert.equal(inbox.counts.openHumanRequests, 1);
    assert.equal(inbox.claims.active[0].resourceId, "src/ready.ts");
    assert.equal(inbox.claims.stale[0].resourceId, "src/old.ts");
    assert.equal(
      inbox.cards.some((card) => card.id === "queue:elizaos/eliza#1003"),
      false,
    );
    const readyCard = inbox.cards.find(
      (card) => card.id === "queue:elizaos/eliza#1001",
    );
    assert.equal(
      readyCard.links.queueItemActionPlan,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%231001&ownerAgentId=agent-one",
    );
    assert.equal(
      readyCard.links.agentInbox,
      "/api/agents/agent-one/inbox?repo=elizaos%2Feliza&targetBranch=develop",
    );

    assert.deepEqual(
      inbox.nextActions.slice(0, 3).map((action) => action.action),
      ["decide_approval", "answer_human_request", "claim_or_merge_queue_lane"],
    );

    const lane = inbox.mergeQueue.lanes.find(
      (candidate) => candidate.key === "elizaos/eliza:develop",
    );
    assert.equal(lane.state, "needs-attention");
    assert.deepEqual(lane.needsHumanCardIds, ["queue:elizaos/eliza#1002"]);
    assert.deepEqual(lane.batchCandidateCardIds, ["queue:elizaos/eliza#1001"]);
  });

  it("includes durable work items owned by the agent", () => {
    const inbox = buildAgentInbox({
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      now: "2026-07-07T00:00:00.000Z",
      workCycles: [
        {
          id: "cycle:elizaos/eliza:july",
          repo: "elizaos/eliza",
          state: "active",
          title: "July",
          ownerAgentId: "agent-docs",
        },
      ],
      workModules: [
        {
          id: "module:elizaos/eliza:docs",
          repo: "elizaos/eliza",
          state: "active",
          title: "Docs",
          ownerAgentId: "agent-docs",
        },
      ],
      workProgress: {
        summary: {
          total: 1,
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
          taskId: "docs-intake",
          cycleId: "cycle:elizaos/eliza:july",
          moduleId: "module:elizaos/eliza:docs",
          packages: ["docs"],
        },
        {
          id: "work:elizaos/eliza:task:runtime",
          repo: "elizaos/eliza",
          kind: "task",
          state: "ready",
          title: "Runtime work",
          ownerAgentId: "agent-runtime",
        },
      ],
    });

    assert.equal(inbox.counts.cards, 1);
    assert.equal(inbox.counts.ready, 1);
    assert.equal(inbox.cards[0].kind, "work-item");
    assert.equal(inbox.cards[0].workItem.taskId, "docs-intake");
    assert.equal(inbox.cards[0].workItem.cycleId, "cycle:elizaos/eliza:july");
    assert.equal(inbox.cards[0].workItem.moduleId, "module:elizaos/eliza:docs");
    assert.equal(inbox.work.cycles[0].title, "July");
    assert.equal(inbox.work.modules[0].title, "Docs");
    assert.equal(inbox.work.progress.summary.total, 1);
    assert.deepEqual(
      inbox.nextActions.map((action) => action.action),
      ["claim_work_item"],
    );
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#1001",
    repo: "elizaos/eliza",
    pullRequestId: 1001,
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

function claim(overrides = {}) {
  return {
    id: "claim-ready",
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/ready.ts",
    ownerAgentId: "agent-one",
    status: "active",
    paths: ["src/ready.ts"],
    expiresAt: "2026-07-06T00:30:00.000Z",
    ...overrides,
  };
}
