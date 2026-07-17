import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReviewAssignment } from "../src/review-assignment.js";

describe("review assignment", () => {
  it("suggests non-author reviewer agents from path, package, claim, and capacity evidence", () => {
    const assignment = buildReviewAssignment({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-author",
      changedFiles: [
        "packages/core/src/runtime.ts",
        "packages/core/src/db/migrations/002.sql",
      ],
      affectedPackages: ["core"],
      registeredAgents: [
        {
          id: "agent-author",
          metadata: {
            reviewPackages: ["core"],
          },
        },
        {
          id: "agent-core",
          displayName: "Core Agent",
          metadata: {
            reviewPackages: ["core"],
            reviewPaths: ["packages/core/**"],
          },
        },
        {
          id: "agent-ui",
          metadata: {
            reviewPackages: ["client"],
          },
        },
      ],
      claims: [
        {
          id: "claim-runtime",
          repo: "elizaos/eliza",
          status: "active",
          ownerAgentId: "agent-runtime",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          expiresAt: "2026-07-07T01:00:00.000Z",
        },
      ],
      capacity: {
        agents: [
          {
            agentId: "agent-core",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 1,
            performance: {
              health: "healthy",
              riskScore: 0,
              rates: { successRate: 1, failureRate: 0, staleClaimRatio: 0 },
            },
            expertise: {
              paths: ["packages/core/src/runtime.ts"],
              packages: ["core"],
            },
          },
          {
            agentId: "agent-author",
            health: "idle",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 0,
            expertise: {
              paths: ["packages/core/src/runtime.ts"],
              packages: ["core"],
            },
          },
          {
            agentId: "agent-ui",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 0,
            expertise: {
              paths: ["packages/client/src/index.ts"],
              packages: ["client"],
            },
          },
        ],
      },
    });

    assert.equal(assignment.decision.state, "needs_human_review");
    assert.equal(assignment.decision.assignmentReady, true);
    assert.equal(assignment.suggestedReviewers[0].agentId, "agent-core");
    assert.ok(
      assignment.suggestedReviewers[0].matches.declaredPackages.includes(
        "core",
      ),
    );
    assert.ok(
      assignment.suggestedReviewers[0].matches.declaredPaths.includes(
        "packages/core/src/runtime.ts",
      ),
    );
    assert.ok(
      assignment.suggestedReviewers.some(
        (reviewer) => reviewer.agentId === "agent-runtime",
      ),
    );
    assert.ok(
      assignment.excludedCandidates.some(
        (candidate) =>
          candidate.agentId === "agent-author" &&
          candidate.reason === "author_agent",
      ),
    );
    assert.ok(
      assignment.humanReviewHints.some(
        (hint) => hint.id === "maintainer:database",
      ),
    );
    assert.ok(
      assignment.labels.includes("review-assignment:needs_human_review"),
    );
    assert.ok(assignment.labels.includes("reviewers:assigned"));
  });

  it("blocks assignment when only the author is eligible", () => {
    const assignment = buildReviewAssignment({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-author",
      changedFiles: ["packages/core/src/runtime.ts"],
      affectedPackages: ["core"],
      registeredAgents: [
        {
          id: "agent-author",
          metadata: {
            reviewPackages: ["core"],
            reviewPaths: ["packages/core/**"],
          },
        },
      ],
      capacity: {
        agents: [
          {
            agentId: "agent-author",
            health: "idle",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 0,
            expertise: {
              paths: ["packages/core/src/runtime.ts"],
              packages: ["core"],
            },
          },
        ],
      },
    });

    assert.equal(assignment.decision.state, "needs_reviewers");
    assert.equal(assignment.decision.assignmentReady, false);
    assert.ok(assignment.decision.blockers.includes("no_reviewers_available"));
    assert.deepEqual(assignment.suggestedReviewers, []);
    assert.ok(assignment.labels.includes("reviewers:needed"));
  });
});
