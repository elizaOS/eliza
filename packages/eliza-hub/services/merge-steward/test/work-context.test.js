import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkContext, WORK_CONTEXT_VERSION } from "../src/work-context.js";

describe("agent work context model", () => {
  it("composes an agent resume packet from inbox work fleet queue and search state", () => {
    const context = buildWorkContext({
      repo: "elizaos/eliza",
      ownerAgentId: "agent-one",
      targetBranch: "develop",
      query: "docs",
      now: "2026-07-07T01:00:00.000Z",
      bootstrap: {
        agentId: "agent-one",
        computedAt: "2026-07-07T01:00:00.000Z",
        identity: {
          required: true,
          known: true,
          state: "known",
          registrySummary: { knownAgentIdCount: 3 },
        },
        policyHints: {
          workItem: { required: true },
        },
        nextActions: [
          {
            id: "preflight_before_branch",
            priority: 20,
            method: "POST",
            href: "/api/agents/agent-one/work-preflight",
            reason: "Run work preflight.",
          },
        ],
        snapshots: {
          mergeTrain: {
            computedAt: "2026-07-07T01:00:00.000Z",
            status: "dry_run_ready",
            readOnly: true,
            selectedTrain: {
              id: "train:elizaos-eliza:develop",
              repo: "elizaos/eliza",
              targetBranch: "develop",
              mode: "batch",
              planCount: 2,
              itemIds: ["elizaos/eliza#12", "elizaos/eliza#13"],
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
          workflowOperations: {
            status: "dry_run_ready",
            controlPlane: {
              status: "ready",
              ok: true,
              deploymentMode: "staging",
            },
            actions: {
              status: "dry_run_ready",
              provider: "forgejo_actions",
              ciAuthority: "required_checks",
              trustedWorkflow: "runner-smoke.yml",
            },
            runner: {
              status: "dry_run_only",
              trustedSmokeWorkflowRequired: true,
              isolatedRunnerRequired: true,
              privateEvidenceRequired: true,
            },
            mergeQueue: {
              status: "dry_run_ready",
              dryRunReviewReady: true,
              liveExecutionReady: false,
              selectedItemIds: ["elizaos/eliza#12", "elizaos/eliza#13"],
            },
            nextActions: [
              "review_dry_run_train",
              "confirm_live_merge_before_cutover",
            ],
          },
        },
      },
      inbox: {
        computedAt: "2026-07-07T01:00:00.000Z",
        counts: {
          cards: 2,
          ready: 1,
          running: 1,
          staleClaims: 1,
          activeClaims: 1,
          openApprovals: 1,
        },
        nextActions: [
          {
            action: "decide_approval",
            count: 1,
            cardIds: ["queue:elizaos/eliza#12"],
          },
          {
            action: "continue_work_item",
            count: 1,
            cardIds: ["work:elizaos/eliza:task:docs"],
          },
        ],
        claims: {
          active: [
            {
              id: "claim-active",
              repo: "elizaos/eliza",
              resourceKind: "path",
              resourceId: "docs/runtime.md",
              ownerAgentId: "agent-one",
              status: "active",
            },
          ],
          stale: [
            {
              id: "claim-stale",
              repo: "elizaos/eliza",
              resourceKind: "path",
              resourceId: "docs/old.md",
              ownerAgentId: "agent-one",
              status: "stale",
            },
          ],
        },
        cards: [
          {
            id: "queue:elizaos/eliza#12",
            kind: "queue-item",
            title: "Docs PR",
            queueItem: {
              id: "elizaos/eliza#12",
              repo: "elizaos/eliza",
              pullRequestId: 12,
            },
            links: {
              queueItemActionPlan:
                "/api/queue/item/action-plan?id=elizaos%2Feliza%2312&ownerAgentId=agent-one",
            },
            nextActions: ["decide_approval"],
          },
          {
            id: "work:elizaos/eliza:task:docs",
            kind: "work-item",
            workItem: {
              id: "work:elizaos/eliza:task:docs",
              repo: "elizaos/eliza",
              title: "Docs task",
              state: "in_progress",
            },
            nextActions: ["continue_work_item"],
          },
        ],
      },
      workDashboard: {
        computedAt: "2026-07-07T01:00:00.000Z",
        summary: {
          workItems: 2,
          active: 1,
          blocked: 1,
          ready: 0,
          pages: 1,
        },
        views: {
          builtIn: [
            {
              id: "builtin:active",
              title: "Active",
              builtIn: true,
              count: 1,
              itemIds: ["work:elizaos/eliza:task:docs"],
            },
          ],
          saved: [],
        },
      },
      workProgress: {
        summary: {
          total: 2,
          active: 1,
          blocked: 1,
          percentComplete: 50,
          latestUpdatedAt: "2026-07-07T00:55:00.000Z",
        },
      },
      fleetCoordination: {
        computedAt: "2026-07-07T01:00:00.000Z",
        claimProtocol: {
          blockedAfterMinutes: 30,
          evidenceRows: ["logs"],
        },
        sharedLevers: [
          {
            id: "runner_capacity",
            title: "Worker secrets and CI runner capacity",
            resourceKind: "runner",
            resourceId: "ci-capacity",
            state: "claimed_by_other",
            requiredAction: "wait_or_coordinate_with_claim_owner",
            activeClaim: {
              id: "claim-runner",
              ownerAgentId: "agent-two",
              status: "active",
            },
          },
        ],
        nextActions: [
          {
            id: "coordinate_shared_lever_claims",
            priority: 80,
            blocking: true,
            reason: "Another lane owns a shared lever.",
            leverIds: ["runner_capacity"],
          },
        ],
      },
      mergeQueue: {
        diagnostics: {
          health: "needs_attention",
          reasons: ["blocked_lane"],
          blockedCount: 1,
        },
        lanes: [
          {
            key: "elizaos/eliza:develop",
            state: "needs-attention",
            blocked: 1,
          },
        ],
      },
      routing: {
        recommendations: [
          {
            id: "route-one",
            agentId: "agent-one",
            workItemId: "work:elizaos/eliza:task:docs",
          },
        ],
      },
      search: {
        query: "docs",
        summary: {
          searchedDocuments: 8,
          matchedDocuments: 2,
          returnedResults: 2,
        },
        results: [
          {
            rank: 1,
            kind: "work_item",
            id: "work:elizaos/eliza:task:docs",
            title: "Docs task",
            score: 4,
          },
        ],
      },
      workPages: [
        {
          id: "page:elizaos/eliza:work:docs:agent_plan",
          title: "Docs agent plan",
          kind: "agent_plan",
          state: "active",
          workItemId: "work:elizaos/eliza:task:docs",
        },
      ],
    });

    assert.equal(context.version, WORK_CONTEXT_VERSION);
    assert.equal(context.readOnly, true);
    assert.equal(context.status, "needs_attention");
    assert.equal(context.filters.ownerAgentId, "agent-one");
    assert.equal(context.summary.cards, 2);
    assert.equal(context.summary.staleClaims, 1);
    assert.equal(context.summary.blockingSharedLevers, 1);
    assert.equal(context.summary.mergeTrainStatus, "dry_run_ready");
    assert.equal(context.summary.mergeTrainPreflightStatus, "dry_run_ready");
    assert.equal(context.summary.workflowOperationsStatus, "dry_run_ready");
    assert.equal(context.summary.workflowActionsStatus, "dry_run_ready");
    assert.equal(context.summary.runnerStatus, "dry_run_only");
    assert.equal(context.summary.searchResults, 2);
    assert.equal(
      context.links.self,
      "/api/work-context?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent-one&query=docs",
    );
    assert.equal(
      context.links.cockpit,
      "/api/agents/agent-one/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(context.links.actionPlan, "/api/agents/agent-one/action-plan");
    assert.equal(
      context.links.workflows,
      "/api/workflows?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent-one",
    );
    assert.equal(
      context.links.mergeTrain,
      "/api/merge-train?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.deepEqual(context.resume.activeClaimIds, ["claim-active"]);
    assert.deepEqual(context.resume.staleClaimIds, ["claim-stale"]);
    assert.deepEqual(context.resume.blockingLeverIds, ["runner_capacity"]);
    assert.deepEqual(context.resume.mergeTrainItemIds, [
      "elizaos/eliza#12",
      "elizaos/eliza#13",
    ]);
    assert.deepEqual(context.resume.pageIds, [
      "page:elizaos/eliza:work:docs:agent_plan",
    ]);
    assert.equal(
      context.resume.readFirst[0].id,
      "page:page:elizaos/eliza:work:docs:agent_plan",
    );
    assert.ok(
      context.resume.readFirst.some(
        (item) => item.id === "workflow_operations",
      ),
    );
    assert.ok(
      context.resume.readFirst.some((item) => item.id === "merge_train"),
    );
    assert.equal(context.snapshots.work.summary.percentComplete, 50);
    assert.equal(
      context.snapshots.inbox.cards[0].links.queueItemActionPlan,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%2312&ownerAgentId=agent-one",
    );
    assert.equal(
      context.snapshots.fleetCoordination.sharedLevers[0].activeClaim.id,
      "claim-runner",
    );
    assert.equal(
      context.snapshots.mergeTrain.preflight.dryRunReviewReady,
      true,
    );
    assert.equal(
      context.snapshots.workflowOperations.runner.privateEvidenceRequired,
      true,
    );
    assert.ok(
      context.nextActions.some(
        (action) =>
          action.id === "coordinate_shared_lever_claims" &&
          action.blocking === true,
      ),
    );
    assert.ok(
      context.nextActions.some((action) => action.id === "decide_approval"),
    );
    assert.ok(
      context.nextActions.some(
        (action) =>
          action.id === "review_merge_train_dry_run" &&
          action.source === "merge_train",
      ),
    );
    assert.ok(
      context.nextActions.some(
        (action) => action.id === "run_action_plan_before_pr",
      ),
    );
  });

  it("requires an agent id because the packet is agent-scoped", () => {
    assert.throws(
      () => buildWorkContext({ repo: "elizaos/eliza" }),
      /ownerAgentId/,
    );
  });
});
