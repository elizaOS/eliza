import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReleaseReadiness } from "../src/release-readiness.js";

describe("release readiness model", () => {
  it("allows a dry-run merge window with watch status", () => {
    const readiness = buildReleaseReadiness({
      now: "2026-07-06T00:10:00.000Z",
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 2,
          scheduled: 2,
          planned: 2,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: true,
          strategy: "batch",
          plans: [
            { repo: "elizaos/eliza", pullRequestId: 1 },
            { repo: "elizaos/eliza", pullRequestId: 2 },
          ],
        },
      }),
      routing: routingSummary({ routableAgents: 2, recommendations: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    assert.equal(readiness.status, "watch");
    assert.equal(readiness.canOpenMergeWindow, true);
    assert.equal(readiness.canAutoMerge, false);
    assert.equal(readiness.counts.planned, 2);
    assert.ok(readiness.labels.includes("release:watch"));
    assert.ok(readiness.labels.includes("merge-window:ready"));
    assert.ok(readiness.labels.includes("merge-window:dry-run"));
    assert.deepEqual(readiness.snapshots.plannedItemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.equal(
      readiness.checks.find((check) => check.name === "live_merge_enabled")
        .status,
      "warn",
    );
  });

  it("blocks release when queue, human, and agent triage signals are unhealthy", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 3,
          scheduled: 1,
          planned: 1,
          blocked: 1,
          running: 1,
          terminal: 0,
        },
        lanes: [
          {
            blockedItemIds: ["elizaos/eliza#9"],
            runningItemIds: ["elizaos/eliza#10"],
          },
        ],
      }),
      routing: routingSummary({
        routableAgents: 0,
        blockedAgents: 2,
        recommendations: 1,
      }),
      performance: performanceSummary({
        counts: {
          staleClaims: 1,
          failedRuns: 1,
          needsTriage: 1,
          overloaded: 1,
        },
      }),
      workflow: workflowSummary({
        counts: {
          openApprovals: 1,
          openHumanRequests: 1,
          staleClaims: 1,
          failedRuns: 1,
        },
      }),
    });

    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.canOpenMergeWindow, false);
    assert.ok(readiness.labels.includes("queue:blocked"));
    assert.ok(readiness.labels.includes("queue:busy"));
    assert.ok(readiness.labels.includes("needs-human"));
    assert.ok(readiness.labels.includes("needs-triage"));
    assert.ok(readiness.requiredActions.includes("resolve_queue_blockers"));
    assert.ok(readiness.requiredActions.includes("resolve_human_decisions"));
    assert.deepEqual(readiness.snapshots.blockedItemIds, ["elizaos/eliza#9"]);
    assert.deepEqual(readiness.snapshots.runningItemIds, ["elizaos/eliza#10"]);
  });

  it("explains stack dependency blockers before opening a merge window", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 2,
          scheduled: 1,
          planned: 1,
          blocked: 1,
          running: 0,
          terminal: 0,
        },
        lanes: [
          {
            blockedItemIds: ["elizaos/eliza#12"],
            runningItemIds: [],
          },
        ],
        dependencies: {
          stackCount: 1,
          blockedItemCount: 1,
        },
        diagnostics: {
          stacks: {
            blockedItemCount: 1,
            blockedItems: [
              {
                id: "elizaos/eliza#12",
                repo: "elizaos/eliza",
                pullRequestId: 12,
                state: "waiting_on_stack",
                requiredActions: ["merge_stack_parents_first"],
              },
            ],
            stacks: [
              {
                id: "stack:elizaos-eliza:develop:elizaos-eliza-11",
                state: "waiting",
                blockedItemIds: ["elizaos/eliza#12"],
                nextMergeItemId: "elizaos/eliza#11",
                requiredActions: ["merge_stack_parents_first"],
              },
            ],
          },
        },
        selectedPlan: {
          enabled: true,
          dryRun: true,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 11 }],
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const stackCheck = readiness.checks.find(
      (check) => check.name === "stack_dependency_order",
    );

    assert.equal(readiness.status, "blocked");
    assert.equal(
      readiness.summary,
      "Release blocked: Stacked PR children are waiting on parent PRs.",
    );
    assert.equal(stackCheck.status, "fail");
    assert.equal(stackCheck.details.stackBlocked, 1);
    assert.deepEqual(stackCheck.details.blockedItemIds, ["elizaos/eliza#12"]);
    assert.deepEqual(stackCheck.details.nextMergeItemIds, ["elizaos/eliza#11"]);
    assert.ok(readiness.labels.includes("stack:blocked"));
    assert.ok(readiness.labels.includes("queue:blocked"));
    assert.ok(readiness.requiredActions.includes("merge_stack_parents_first"));
    assert.deepEqual(readiness.snapshots.stackBlockedItemIds, [
      "elizaos/eliza#12",
    ]);
    assert.deepEqual(readiness.snapshots.stackNextMergeItemIds, [
      "elizaos/eliza#11",
    ]);
  });

  it("fails closed when live merge execution is required", () => {
    const readiness = buildReleaseReadiness({
      requireLiveMerge: true,
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: true,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const liveMerge = readiness.checks.find(
      (check) => check.name === "live_merge_enabled",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(liveMerge.status, "fail");
    assert.ok(
      readiness.requiredActions.includes("enable_live_merge_execution"),
    );
  });

  it("blocks live merge windows without strict work reservations", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady({
        configuration: {
          deploymentMode: "production",
          integrationEnabled: true,
          integrationDryRun: false,
          requireWorkReservationForAgentPrs: false,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
        },
      }),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const strictCheck = readiness.checks.find(
      (check) => check.name === "strict_work_reservations",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.canOpenMergeWindow, false);
    assert.equal(readiness.canAutoMerge, false);
    assert.equal(readiness.canRouteNewAgentWork, false);
    assert.equal(strictCheck.status, "fail");
    assert.equal(strictCheck.details.liveIntegrationActive, true);
    assert.equal(strictCheck.details.requireWorkReservationForAgentPrs, false);
    assert.ok(readiness.labels.includes("reservation:blocked"));
    assert.ok(
      readiness.requiredActions.includes("enable_strict_work_reservations"),
    );
  });

  it("blocks live merge windows without durable Work item links", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady({
        configuration: {
          deploymentMode: "production",
          integrationEnabled: true,
          integrationDryRun: false,
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: false,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
        },
      }),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const strictCheck = readiness.checks.find(
      (check) => check.name === "strict_work_items",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.canOpenMergeWindow, false);
    assert.equal(readiness.canAutoMerge, false);
    assert.equal(readiness.canRouteNewAgentWork, false);
    assert.equal(strictCheck.status, "fail");
    assert.equal(strictCheck.details.liveIntegrationActive, true);
    assert.equal(strictCheck.details.requireWorkItemForAgentPrs, false);
    assert.ok(readiness.labels.includes("work-item:blocked"));
    assert.ok(readiness.requiredActions.includes("enable_strict_work_items"));
  });

  it("blocks live merge windows without strict agent branch namespaces", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady({
        configuration: {
          deploymentMode: "production",
          integrationEnabled: true,
          integrationDryRun: false,
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: false,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
        },
      }),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const strictCheck = readiness.checks.find(
      (check) => check.name === "strict_agent_branch_namespaces",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(strictCheck.status, "fail");
    assert.equal(strictCheck.details.liveIntegrationActive, true);
    assert.equal(
      strictCheck.details.requireAgentBranchNamespaceForAgentPrs,
      false,
    );
    assert.ok(readiness.labels.includes("branch-namespace:blocked"));
    assert.ok(
      readiness.requiredActions.includes(
        "enable_strict_agent_branch_namespaces",
      ),
    );
  });

  it("blocks live merge windows without verified agent run receipts", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady({
        configuration: {
          deploymentMode: "production",
          integrationEnabled: true,
          integrationDryRun: false,
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: false,
        },
      }),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const receiptCheck = readiness.checks.find(
      (check) => check.name === "verified_agent_run_receipts",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(receiptCheck.status, "fail");
    assert.equal(receiptCheck.details.liveIntegrationActive, true);
    assert.equal(
      receiptCheck.details.requireVerifiedAgentRunReceiptForAgentPrs,
      false,
    );
    assert.ok(readiness.labels.includes("run-receipt:blocked"));
    assert.ok(
      readiness.requiredActions.includes("enable_verified_agent_run_receipts"),
    );
  });

  it("blocks live merge windows without an agent identity registry", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady({
        configuration: {
          deploymentMode: "production",
          integrationEnabled: true,
          integrationDryRun: false,
          requireWorkReservationForAgentPrs: true,
          requireWorkItemForAgentPrs: true,
          requireAgentBranchNamespaceForAgentPrs: true,
          requireVerifiedAgentRunReceiptForAgentPrs: true,
          requireAgentIdentityRegistryForAgentPrs: true,
          knownAgentIdCount: 0,
        },
      }),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const registryCheck = readiness.checks.find(
      (check) => check.name === "agent_identity_registry",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(registryCheck.status, "fail");
    assert.equal(registryCheck.details.liveIntegrationActive, true);
    assert.equal(
      registryCheck.details.requireAgentIdentityRegistryForAgentPrs,
      true,
    );
    assert.equal(registryCheck.details.knownAgentIdCount, 0);
    assert.ok(readiness.labels.includes("identity-registry:blocked"));
    assert.ok(
      readiness.requiredActions.includes("enable_agent_identity_registry"),
    );
  });

  it("fails closed when repository protection is required but not production-ready", () => {
    const readiness = buildReleaseReadiness({
      requireRepositoryProtection: true,
      repositoryProtection: {
        status: "watch",
        productionReady: false,
        summary: "Live Forgejo branch protection has not been verified.",
        labels: ["repo-protection:watch"],
        requiredActions: ["verify_live_branch_protection_before_cutover"],
        checks: [{ name: "live_branch_protection_verified", status: "warn" }],
      },
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: workflowSummary(),
    });

    const protection = readiness.checks.find(
      (check) => check.name === "repository_protection_verified",
    );
    assert.equal(readiness.status, "blocked");
    assert.equal(readiness.canOpenMergeWindow, false);
    assert.equal(protection.status, "fail");
    assert.ok(readiness.labels.includes("repo-protection:blocked"));
    assert.ok(
      readiness.requiredActions.includes(
        "verify_live_branch_protection_before_cutover",
      ),
    );
    assert.deepEqual(readiness.snapshots.repositoryProtection, {
      status: "watch",
      productionReady: false,
      labels: ["repo-protection:watch"],
      requiredActions: ["verify_live_branch_protection_before_cutover"],
    });
  });

  it("scopes workflow card blockers to the requested repo and branch", () => {
    const readiness = buildReleaseReadiness({
      readiness: runtimeReady(),
      mergeQueue: mergeQueueSummary({
        counts: {
          items: 1,
          scheduled: 1,
          planned: 1,
          blocked: 0,
          running: 0,
          terminal: 0,
        },
        selectedPlan: {
          enabled: true,
          dryRun: false,
          plans: [{ repo: "elizaos/eliza", pullRequestId: 1 }],
        },
        integration: {
          enabled: true,
          dryRun: false,
        },
      }),
      routing: routingSummary({ routableAgents: 1 }),
      performance: performanceSummary(),
      workflow: {
        cards: [
          {
            repo: "elizaos/eliza",
            targetBranch: "develop",
            status: "ready",
            approvals: [],
            humanRequests: [],
            claims: [],
          },
          {
            repo: "elizaos/docs",
            targetBranch: "develop",
            status: "needs-human",
            approvals: [{ id: "approval-other" }],
            humanRequests: [],
            claims: [{ id: "claim-other", status: "stale" }],
          },
        ],
      },
    });

    assert.equal(readiness.status, "ready");
    assert.equal(readiness.counts.openHumanDecisions, 0);
    assert.equal(readiness.counts.staleClaims, 0);
    assert.equal(readiness.canAutoMerge, true);
  });
});

function runtimeReady(overrides = {}) {
  const configuration = {
    deploymentMode: "production",
    ...(overrides.configuration ?? {}),
  };

  return {
    ok: true,
    checks: [],
    ...overrides,
    configuration,
  };
}

function mergeQueueSummary(overrides = {}) {
  return {
    computedAt: "2026-07-06T00:10:00.000Z",
    filters: {
      repo: "elizaos/eliza",
      targetBranch: "develop",
    },
    integration: {
      enabled: true,
      dryRun: true,
    },
    counts: {
      items: 0,
      scheduled: 0,
      planned: 0,
      blocked: 0,
      running: 0,
      terminal: 0,
    },
    selectedPlan: {
      enabled: true,
      dryRun: true,
      plans: [],
    },
    lanes: [],
    ...overrides,
  };
}

function routingSummary({
  routableAgents = 0,
  blockedAgents = 0,
  recommendations = 0,
  unassignedItems = 0,
} = {}) {
  return {
    computedAt: "2026-07-06T00:10:00.000Z",
    filters: {
      repo: "elizaos/eliza",
      targetBranch: "develop",
    },
    counts: {
      recommendations,
      routableAgents,
      blockedAgents,
      unassignedItems,
    },
    routableAgents: Array.from({ length: routableAgents }, (_, index) => ({
      agentId: `agent-${index + 1}`,
    })),
    blockedAgents: Array.from({ length: blockedAgents }, (_, index) => ({
      agentId: `blocked-${index + 1}`,
    })),
  };
}

function performanceSummary(overrides = {}) {
  return {
    computedAt: "2026-07-06T00:10:00.000Z",
    counts: {
      staleClaims: 0,
      failedRuns: 0,
      needsTriage: 0,
      overloaded: 0,
    },
    agents: [],
    ...overrides,
  };
}

function workflowSummary(overrides = {}) {
  return {
    computedAt: "2026-07-06T00:10:00.000Z",
    counts: {
      openApprovals: 0,
      openHumanRequests: 0,
      staleClaims: 0,
      failedRuns: 0,
    },
    ...overrides,
  };
}
