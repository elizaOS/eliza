import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAgentClaimCandidates,
  buildClaimFromCandidate,
} from "../src/agent-claim-router.js";

describe("agent claim router", () => {
  it("selects claimable work by action priority and builds stable claims", () => {
    const candidates = buildAgentClaimCandidates({
      ownerAgentId: "agent-one",
      insights: {
        items: [
          insightItem({
            id: "elizaos/eliza#701",
            pullRequestId: 701,
            priority: 10,
            ownerAgentId: "agent-one",
            nextActions: ["enter_merge_queue"],
          }),
          insightItem({
            id: "elizaos/eliza#702",
            pullRequestId: 702,
            priority: 3,
            ownerAgentId: "agent-one",
            nextActions: ["route_failed_checks", "resolve_policy_blocker"],
            checks: { failed: [{ name: "unit", state: "failure" }] },
          }),
          insightItem({
            id: "elizaos/eliza#703",
            pullRequestId: 703,
            priority: 20,
            ownerAgentId: "agent-two",
            nextActions: ["route_failed_checks"],
          }),
          insightItem({
            id: "elizaos/eliza#704",
            pullRequestId: 704,
            priority: 50,
            ownerAgentId: "agent-one",
            nextActions: ["resolve_human_decision"],
            human: { openApprovals: 1, openRequests: 0 },
          }),
        ],
      },
    });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].itemId, "elizaos/eliza#702");
    assert.equal(candidates[0].action, "route_failed_checks");
    assert.equal(candidates[0].resource.kind, "pull_request");
    assert.equal(candidates[0].resource.id, "702");
    assert.equal(candidates[1].itemId, "elizaos/eliza#701");

    const claim = buildClaimFromCandidate(candidates[0], {
      ownerAgentId: "agent-one",
      now: "2026-07-06T00:10:00.000Z",
    });

    assert.equal(claim.repo, "elizaos/eliza");
    assert.equal(claim.resourceKind, "pull_request");
    assert.equal(claim.resourceId, "702");
    assert.equal(claim.ownerAgentId, "agent-one");
    assert.equal(claim.metadata.action, "route_failed_checks");
    assert.equal(claim.metadata.itemId, "elizaos/eliza#702");
  });

  it("can prefer package claims for overlap coordination", () => {
    const candidates = buildAgentClaimCandidates({
      ownerAgentId: "agent-one",
      resourceKind: "package",
      action: "coordinate_overlapping_prs",
      insights: {
        items: [
          insightItem({
            id: "elizaos/eliza#705",
            pullRequestId: 705,
            ownerAgentId: "agent-one",
            nextActions: ["coordinate_overlapping_prs"],
            duplicateRisk: {
              overlapping: true,
              relatedItemIds: ["elizaos/eliza#706"],
              sharedPackages: ["core"],
              sharedPaths: ["packages/core/src/runtime.ts"],
            },
          }),
        ],
      },
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].resource.kind, "package");
    assert.equal(candidates[0].resource.id, "core");
  });
});

function insightItem(overrides = {}) {
  return {
    id: "elizaos/eliza#701",
    repo: "elizaos/eliza",
    pullRequestId: 701,
    targetBranch: "develop",
    ownerAgentId: "agent-one",
    priority: 1,
    nextActions: ["enter_merge_queue"],
    checks: { failed: [] },
    claims: { active: [], stale: [] },
    human: { openApprovals: 0, openRequests: 0 },
    duplicateRisk: {
      overlapping: false,
      relatedItemIds: [],
      sharedPackages: [],
      sharedPaths: [],
    },
    decision: {
      blockers: [],
    },
    ...overrides,
  };
}
