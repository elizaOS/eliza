import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentBootstrap } from "../src/agent-bootstrap.js";
import { loadConfig } from "../src/config.js";

describe("agent bootstrap model", () => {
  it("blocks startup actions when strict identity registry does not know the agent", () => {
    const config = loadConfig({
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-known",
    });
    const bootstrap = buildAgentBootstrap({
      agentId: "agent/new",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      now: "2026-07-07T00:00:00.000Z",
      config,
      knownAgentIds: ["agent-known"],
      identityRegistry: {
        required: true,
        configuredAgentIdCount: 1,
        knownAgentIdCount: 1,
      },
    });

    assert.equal(bootstrap.agentId, "agent/new");
    assert.equal(bootstrap.identity.state, "unregistered_blocked");
    assert.equal(bootstrap.identity.known, false);
    assert.equal(
      bootstrap.policyHints.agentBranchNamespace.expectedPrefix,
      "agent/agent/new/",
    );
    assert.equal(bootstrap.policyHints.workReservation.required, true);
    assert.equal(bootstrap.policyHints.workItem.required, true);
    assert.deepEqual(bootstrap.policyHints.workItem.matchKeys, [
      "pullRequestId",
      "taskId",
      "issueId",
    ]);
    assert.equal(bootstrap.policyHints.agentRunReceipt.verified, true);
    assert.equal(
      bootstrap.policyHints.submissionGate.checkBeforePullRequest,
      true,
    );
    assert.equal(bootstrap.policyHints.submissionGate.maxQueuedWork, 4);
    assert.equal(bootstrap.policyHints.submissionGate.maxRecentSubmissions, 3);
    assert.equal(
      bootstrap.policyHints.submissionGate.recentSubmissionWindowMinutes,
      30,
    );
    assert.equal(
      bootstrap.links.self,
      "/api/agents/agent%2Fnew/bootstrap?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(
      bootstrap.links.cockpit,
      "/api/agents/agent%2Fnew/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(
      bootstrap.links.workPreflight,
      "/api/agents/agent%2Fnew/work-preflight",
    );
    assert.equal(
      bootstrap.links.patchConflictPrediction,
      "/api/patch/conflict-prediction",
    );
    assert.equal(
      bootstrap.links.workContext,
      "/api/work-context?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent%2Fnew",
    );
    assert.equal(
      bootstrap.links.workflows,
      "/api/workflows?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent%2Fnew",
    );
    assert.equal(
      bootstrap.links.fleetCoordination,
      "/api/fleet-coordination?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent%2Fnew",
    );
    assert.equal(
      bootstrap.links.mergeTrain,
      "/api/merge-train?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(bootstrap.nextActions[0].id, "register_agent_identity");
    assert.equal(bootstrap.nextActions[0].blocking, true);
  });

  it("summarizes inbox routing claims and safe first calls for a registered agent", () => {
    const bootstrap = buildAgentBootstrap({
      agentId: "agent-one",
      repo: "elizaos/eliza",
      now: "2026-07-07T00:00:00.000Z",
      config: loadConfig(),
      knownAgentIds: ["agent-one"],
      registeredAgent: {
        id: "agent-one",
        status: "active",
        tenantId: "tenant-one",
        source: "eliza-cloud",
      },
      identityRegistry: {
        knownAgentIdCount: 1,
        persistedActiveAgentIdCount: 1,
      },
      inbox: {
        counts: { cards: 2, ready: 1 },
        nextActions: [
          {
            action: "claim_or_merge_queue_lane",
            count: 1,
            cardIds: ["card-one"],
          },
        ],
        cards: [{ id: "card-one" }, { id: "card-two" }],
      },
      routing: {
        counts: { recommendations: 1 },
        routableAgents: [{ agentId: "agent-one", availableSlots: 1 }],
        recommendations: [
          { id: "route-one", agentId: "agent-one", itemId: "elizaos/eliza#1" },
        ],
      },
      mergeTrain: {
        computedAt: "2026-07-07T00:00:00.000Z",
        status: "dry_run_ready",
        readOnly: true,
        selectedTrain: {
          id: "train:eliza",
          repo: "elizaos/eliza",
          targetBranch: "develop",
          mode: "batch",
          planCount: 2,
          itemIds: ["elizaos/eliza#1", "elizaos/eliza#2"],
          blockers: ["integration_dry_run"],
          nextAction: "review_dry_run_train",
        },
        preflight: {
          status: "dry_run_ready",
          liveExecutionReady: false,
          dryRunReviewReady: true,
          blockers: [],
          warnings: ["live_execution_enabled"],
          requiredActions: ["review_dry_run_train"],
        },
      },
      claims: [
        {
          id: "claim-active",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-one",
          resourceKind: "path",
          status: "active",
          expiresAt: "2026-07-07T00:05:00.000Z",
        },
        {
          id: "claim-stale",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-one",
          resourceKind: "package",
          status: "active",
          expiresAt: "2026-07-06T23:59:00.000Z",
        },
      ],
    });

    assert.equal(bootstrap.identity.state, "known");
    assert.equal(bootstrap.identity.record.tenantId, "tenant-one");
    assert.equal(
      bootstrap.policyHints.mergeQueue.trainPreflightStatus,
      "dry_run_ready",
    );
    assert.equal(bootstrap.policyHints.mergeQueue.dryRunReviewReady, true);
    assert.equal(
      bootstrap.policyHints.workflowOperations.status,
      "dry_run_ready",
    );
    assert.equal(
      bootstrap.policyHints.workflowOperations.actionsStatus,
      "dry_run_ready",
    );
    assert.equal(
      bootstrap.policyHints.workflowOperations.runnerStatus,
      "dry_run_only",
    );
    assert.equal(bootstrap.snapshots.inbox.counts.cards, 2);
    assert.deepEqual(bootstrap.snapshots.inbox.cardIds, [
      "card-one",
      "card-two",
    ]);
    assert.equal(
      bootstrap.snapshots.routing.recommendations[0].id,
      "route-one",
    );
    assert.equal(bootstrap.snapshots.claims.counts.active, 1);
    assert.equal(bootstrap.snapshots.claims.counts.stale, 1);
    assert.deepEqual(bootstrap.snapshots.mergeTrain.selectedTrain.itemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.equal(
      bootstrap.snapshots.mergeTrain.preflight.dryRunReviewReady,
      true,
    );
    assert.equal(
      bootstrap.snapshots.workflowOperations.status,
      "dry_run_ready",
    );
    assert.equal(
      bootstrap.snapshots.workflowOperations.mergeQueue.dryRunReviewReady,
      true,
    );
    assert.equal(
      bootstrap.snapshots.workflowOperations.runner.privateEvidenceRequired,
      true,
    );
    assert.deepEqual(
      bootstrap.nextActions.slice(0, 4).map((item) => item.id),
      [
        "renew_or_release_stale_claims",
        "inspect_agent_inbox",
        "claim_suggested_assignment",
        "review_merge_train_dry_run",
      ],
    );
  });
});
