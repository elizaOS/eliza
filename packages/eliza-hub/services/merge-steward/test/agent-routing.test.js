import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentRouting } from "../src/agent-routing.js";

describe("agent routing model", () => {
  it("builds compact recommendations and blocked agent reasons", () => {
    const routing = buildAgentRouting({
      now: "2026-07-06T00:10:00.000Z",
      maxRecommendations: 1,
      capacity: {
        computedAt: "2026-07-06T00:09:00.000Z",
        filters: {
          repo: "elizaos/eliza",
          ownerAgentId: null,
          targetBranch: "develop",
        },
        counts: {
          unassignedItems: 2,
        },
        assignmentSuggestions: [
          {
            id: "assign:one",
            agentId: "agent-steady",
            itemId: "elizaos/eliza#901",
            repo: "elizaos/eliza",
            pullRequestId: 901,
            targetBranch: "develop",
            priority: 20,
            score: 44,
            action: "enter_merge_queue",
            reason: "package match: core; 1 open slot; performance healthy",
            resource: { kind: "pull_request", id: "901" },
          },
          {
            id: "assign:two",
            agentId: "agent-steady",
            itemId: "elizaos/eliza#902",
            repo: "elizaos/eliza",
            pullRequestId: 902,
            targetBranch: "develop",
            priority: 10,
            score: 30,
            action: "inspect",
            resource: { kind: "pull_request", id: "902" },
          },
        ],
        agents: [
          agent({
            agentId: "agent-steady",
            canTakeNewWork: true,
            health: "available",
            availableSlots: 1,
            workloadScore: 2,
            performance: { health: "healthy", riskScore: 0 },
          }),
          agent({
            agentId: "agent-flaky",
            canTakeNewWork: false,
            health: "available",
            availableSlots: 1,
            workloadScore: 1,
            performance: {
              health: "needs-triage",
              riskScore: 8,
              counts: { failedRuns: 2 },
            },
          }),
          agent({
            agentId: "agent-full",
            canTakeNewWork: false,
            health: "busy",
            availableSlots: 0,
            workloadScore: 9,
            counts: { staleClaims: 1 },
          }),
        ],
        unassignedItems: [
          { id: "elizaos/eliza#901" },
          { id: "elizaos/eliza#902" },
        ],
      },
    });

    assert.equal(routing.computedAt, "2026-07-06T00:10:00.000Z");
    assert.equal(routing.filters.repo, "elizaos/eliza");
    assert.equal(routing.counts.recommendations, 1);
    assert.equal(routing.counts.routableAgents, 1);
    assert.equal(routing.counts.blockedAgents, 2);
    assert.equal(routing.recommendations[0].agentId, "agent-steady");
    assert.equal(routing.recommendations[0].score, 44);
    assert.equal(routing.routableAgents[0].performanceHealth, "healthy");
    assert.deepEqual(routing.blockedAgents[0].reasons, [
      "performance_needs-triage",
      "recent_failed_runs",
    ]);
    assert.ok(routing.blockedAgents[1].reasons.includes("no_available_slots"));
    assert.ok(routing.blockedAgents[1].reasons.includes("stale_claims"));
    assert.equal(routing.unassignedItems.length, 2);
  });
});

function agent(overrides = {}) {
  return {
    agentId: "agent-steady",
    canTakeNewWork: true,
    health: "available",
    availableSlots: 1,
    workloadScore: 0,
    counts: {},
    expertise: {
      paths: [],
      packages: [],
    },
    topActions: [],
    ...overrides,
  };
}
