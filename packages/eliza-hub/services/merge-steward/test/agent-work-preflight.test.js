import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentWorkPreflight } from "../src/agent-work-preflight.js";

describe("agent work preflight", () => {
  it("blocks new work that conflicts with active claims and overlapping PR files", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-two",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      proposedItem: {
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
      },
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 42,
          targetBranch: "develop",
          ownerAgentId: "agent-one",
          queueState: "ready",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        },
      ],
      claims: [
        {
          id: "claim:elizaos/eliza:path:packages/core/src/runtime.ts",
          repo: "elizaos/eliza",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          ownerAgentId: "agent-one",
          status: "active",
          expiresAt: "2026-07-06T00:30:00.000Z",
        },
      ],
    });

    assert.equal(preflight.decision.allowed, false);
    assert.equal(preflight.decision.state, "blocked");
    assert.deepEqual(preflight.decision.blockers, [
      "active_claim_conflict",
      "overlapping_open_prs",
    ]);
    assert.deepEqual(preflight.decision.warnings, ["hot_work_area"]);
    assert.ok(
      preflight.decision.requiredActions.includes(
        "coordinate_with_claim_owner",
      ),
    );
    assert.ok(
      preflight.decision.requiredActions.includes("coordinate_overlapping_prs"),
    );
    assert.equal(preflight.overlaps.queueItems[0].id, "elizaos/eliza#42");
    assert.equal(preflight.overlaps.queueItems[0].severity, "high");
    assert.equal(preflight.overlaps.claims[0].severity, "critical");
    assert.deepEqual(preflight.hotspots.paths, [
      { path: "packages/core/src/runtime.ts", count: 3 },
    ]);
    assert.deepEqual(preflight.hotspots.packages, [
      { package: "core", count: 2 },
    ]);
    assert.equal(preflight.splitPlan.recommended, true);
    assert.equal(
      preflight.splitPlan.strategy,
      "split_conflicted_work_from_ready_lanes",
    );
    assert.deepEqual(preflight.splitPlan.reasons, [
      "active_claim_conflict",
      "overlapping_open_prs",
      "hot_work_area",
    ]);
    assert.equal(preflight.splitPlan.summary.blockedUnits, 1);
    assert.equal(preflight.splitPlan.units[0].state, "blocked");
    assert.deepEqual(preflight.splitPlan.units[0].blockers, [
      "active_claim_conflict",
      "overlapping_open_prs",
    ]);
    assert.equal(
      preflight.splitPlan.units[0].suggestedBranch,
      "agent/agent-two/core",
    );
    assert.deepEqual(preflight.labels, [
      "work-preflight:blocked",
      "agent:claimed-conflict",
      "agent:duplicate-risk",
      "agent:hot-work-area",
    ]);
  });

  it("allows scoped work and suggests file and package claims", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["docs/readiness.md"],
      affectedPackages: ["docs"],
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 99,
          targetBranch: "develop",
          ownerAgentId: "agent-runtime",
          queueState: "ready",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        },
      ],
      claims: [],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.decision.state, "ready");
    assert.deepEqual(preflight.overlaps.queueItems, []);
    assert.deepEqual(preflight.overlaps.claims, []);
    assert.deepEqual(
      preflight.suggestedClaims.map(
        (claim) => `${claim.resourceKind}:${claim.resourceId}`,
      ),
      ["path:docs/readiness.md", "package:docs"],
    );
    assert.equal(preflight.splitPlan.recommended, false);
    assert.equal(preflight.splitPlan.strategy, "single_pr");
    assert.equal(preflight.splitPlan.summary.readyUnits, 1);
    assert.deepEqual(preflight.splitPlan.nextActions, ["reserve_work_claims"]);
    assert.deepEqual(preflight.labels, [
      "work-preflight:ready",
      "work-preflight:allowed",
    ]);
  });

  it("blocks new work that conflicts with active durable Work item files", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-two",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["packages/core/src/runtime.ts"],
      affectedPackages: ["core"],
      queueItems: [],
      claims: [],
      workItems: [
        {
          id: "work:elizaos/eliza:path:runtime",
          repo: "elizaos/eliza",
          kind: "path",
          state: "in_progress",
          title: "Runtime coordination",
          ownerAgentId: "agent-one",
          targetBranch: "develop",
          paths: ["packages/core/src/runtime.ts"],
          packages: ["core"],
        },
        {
          id: "work:elizaos/eliza:path:old-runtime",
          repo: "elizaos/eliza",
          kind: "path",
          state: "done",
          title: "Old runtime work",
          ownerAgentId: "agent-three",
          targetBranch: "develop",
          paths: ["packages/core/src/runtime.ts"],
          packages: ["core"],
        },
      ],
    });

    assert.equal(preflight.decision.allowed, false);
    assert.equal(preflight.decision.state, "blocked");
    assert.deepEqual(preflight.decision.blockers, [
      "active_work_item_conflict",
    ]);
    assert.deepEqual(preflight.decision.warnings, ["hot_work_area"]);
    assert.ok(
      preflight.decision.requiredActions.includes(
        "coordinate_with_work_item_owner",
      ),
    );
    assert.equal(preflight.overlaps.workItems.length, 1);
    assert.equal(
      preflight.overlaps.workItems[0].id,
      "work:elizaos/eliza:path:runtime",
    );
    assert.equal(preflight.overlaps.workItems[0].severity, "critical");
    assert.deepEqual(preflight.overlaps.workItems[0].sharedFiles, [
      "packages/core/src/runtime.ts",
    ]);
    assert.deepEqual(preflight.hotspots.paths, [
      { path: "packages/core/src/runtime.ts", count: 2 },
    ]);
    assert.deepEqual(preflight.splitPlan.reasons, [
      "active_work_item_conflict",
      "hot_work_area",
    ]);
    assert.equal(
      preflight.splitPlan.strategy,
      "split_conflicted_work_from_ready_lanes",
    );
    assert.deepEqual(preflight.splitPlan.units[0].blockers, [
      "active_work_item_conflict",
    ]);
    assert.equal(
      preflight.splitPlan.units[0].overlaps.workItems[0].ownerAgentId,
      "agent-one",
    );
    assert.deepEqual(preflight.labels, [
      "work-preflight:blocked",
      "agent:work-item-conflict",
      "agent:duplicate-risk",
      "agent:hot-work-area",
    ]);
  });

  it("warns on package-only durable Work item overlap without blocking", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-runtime",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["packages/core/src/cache.ts"],
      affectedPackages: ["core"],
      queueItems: [],
      claims: [],
      workItems: [
        {
          id: "work:elizaos/eliza:package:core",
          repo: "elizaos/eliza",
          kind: "package",
          state: "claimed",
          title: "Core package cleanup",
          ownerAgentId: "agent-memory",
          paths: ["packages/core/src/memory.ts"],
          packages: ["core"],
        },
      ],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.decision.state, "watch");
    assert.deepEqual(preflight.decision.blockers, []);
    assert.deepEqual(preflight.decision.warnings, [
      "work_item_overlap",
      "hot_work_area",
    ]);
    assert.equal(preflight.overlaps.workItems[0].severity, "medium");
    assert.equal(preflight.overlaps.workItems[0].blocking, false);
    assert.equal(
      preflight.overlaps.workItems[0].suggestedAction,
      "review_work_item_overlap",
    );
    assert.deepEqual(preflight.overlaps.workItems[0].sharedFiles, []);
    assert.deepEqual(preflight.overlaps.workItems[0].sharedPackages, ["core"]);
    assert.equal(preflight.splitPlan.units[0].state, "watch");
    assert.deepEqual(preflight.splitPlan.units[0].warnings, [
      "work_item_overlap",
      "hot_work_area",
    ]);
    assert.deepEqual(preflight.labels, [
      "work-preflight:watch",
      "work-preflight:allowed",
      "agent:work-item-overlap",
      "agent:hot-work-area",
    ]);
  });

  it("warns but does not block when planned Work items share files", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-runtime",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["packages/core/src/runtime.ts"],
      affectedPackages: ["core"],
      queueItems: [],
      claims: [],
      workItems: [
        {
          id: "work:elizaos/eliza:task:runtime-plan",
          repo: "elizaos/eliza",
          kind: "task",
          state: "ready",
          title: "Runtime plan",
          ownerAgentId: "agent-planner",
          targetBranch: "develop",
          paths: ["packages/core/src/runtime.ts"],
          packages: ["core"],
        },
      ],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.decision.state, "watch");
    assert.deepEqual(preflight.decision.blockers, []);
    assert.deepEqual(preflight.decision.warnings, [
      "work_item_overlap",
      "hot_work_area",
    ]);
    assert.equal(preflight.overlaps.workItems[0].severity, "high");
    assert.equal(preflight.overlaps.workItems[0].blocking, false);
    assert.equal(
      preflight.overlaps.workItems[0].suggestedAction,
      "review_work_item_overlap",
    );
  });

  it("does not block when the submitting agent already owns the Work item", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-runtime",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["packages/core/src/runtime.ts"],
      affectedPackages: ["core"],
      queueItems: [],
      claims: [],
      workItems: [
        {
          id: "work:elizaos/eliza:task:runtime-owned",
          repo: "elizaos/eliza",
          kind: "task",
          state: "in_progress",
          title: "Runtime owned work",
          ownerAgentId: "agent-runtime",
          targetBranch: "develop",
          paths: ["packages/core/src/runtime.ts"],
          packages: ["core"],
        },
      ],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.decision.state, "ready");
    assert.deepEqual(preflight.decision.blockers, []);
    assert.deepEqual(preflight.decision.warnings, []);
    assert.equal(preflight.overlaps.workItems[0].ownerMatches, true);
    assert.equal(preflight.overlaps.workItems[0].severity, "low");
    assert.equal(preflight.overlaps.workItems[0].blocking, false);
    assert.equal(
      preflight.overlaps.workItems[0].suggestedAction,
      "continue_or_link_existing_work_item",
    );
    assert.deepEqual(preflight.hotspots.paths, []);
    assert.deepEqual(preflight.labels, [
      "work-preflight:ready",
      "work-preflight:allowed",
    ]);
  });

  it("blocks work that starts outside the submitting agent branch namespace", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      requireAgentBranchNamespace: true,
      proposedItem: {
        sourceBranch: "agent/other/readme",
        changedFiles: ["docs/readiness.md"],
        affectedPackages: ["docs"],
      },
      queueItems: [],
      claims: [],
    });

    assert.equal(preflight.decision.allowed, false);
    assert.equal(preflight.decision.state, "blocked");
    assert.deepEqual(preflight.decision.blockers, ["agent_branch_namespace"]);
    assert.ok(
      preflight.decision.requiredActions.includes(
        "rename_branch_to_agent_namespace",
      ),
    );
    assert.equal(preflight.decision.branchNamespace.required, true);
    assert.equal(
      preflight.decision.branchNamespace.expectedNamespace,
      "agent/agent-docs/",
    );
    assert.equal(
      preflight.decision.branchNamespace.sourceBranch,
      "agent/other/readme",
    );
    assert.deepEqual(preflight.labels, [
      "work-preflight:blocked",
      "branch:namespace-mismatch",
      "agent:branch-unowned",
    ]);
  });

  it("warns but allows package-only overlap so agents can coordinate without blocking", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-runtime",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: ["packages/core/src/cache.ts"],
      affectedPackages: ["core"],
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 77,
          targetBranch: "develop",
          ownerAgentId: "agent-memory",
          queueState: "ready",
          changedFiles: ["packages/core/src/memory.ts"],
          affectedPackages: ["core"],
        },
      ],
      claims: [],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.decision.state, "watch");
    assert.deepEqual(preflight.decision.blockers, []);
    assert.deepEqual(preflight.decision.warnings, [
      "package_overlap",
      "hot_work_area",
    ]);
    assert.equal(preflight.overlaps.queueItems[0].severity, "medium");
    assert.deepEqual(preflight.overlaps.queueItems[0].sharedFiles, []);
    assert.deepEqual(preflight.overlaps.queueItems[0].sharedPackages, ["core"]);
    assert.deepEqual(preflight.hotspots.packages, [
      { package: "core", count: 2 },
    ]);
    assert.equal(preflight.splitPlan.recommended, true);
    assert.deepEqual(preflight.splitPlan.reasons, ["hot_work_area"]);
    assert.equal(preflight.splitPlan.units[0].state, "watch");
    assert.deepEqual(preflight.splitPlan.units[0].warnings, [
      "package_overlap",
      "hot_work_area",
    ]);
    assert.deepEqual(preflight.labels, [
      "work-preflight:watch",
      "work-preflight:allowed",
      "agent:hot-work-area",
    ]);
  });

  it("builds a deterministic package split plan for broad agent work", () => {
    const preflight = buildAgentWorkPreflight({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-platform",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      proposedItem: {
        sourceBranch: "agent/agent-platform/runtime-sweep",
        changedFiles: [
          "packages/client/src/app.ts",
          "packages/core/src/runtime.ts",
          "packages/plugin-sql/src/index.ts",
          "packages/server/src/index.ts",
        ],
        affectedPackages: ["client", "core", "plugin-sql", "server"],
      },
      limits: {
        maxFilesBeforeSplitRecommendation: 3,
        maxPackagesBeforeSplitRecommendation: 2,
      },
      queueItems: [
        {
          repo: "elizaos/eliza",
          pullRequestId: 12,
          targetBranch: "develop",
          ownerAgentId: "agent-db",
          queueState: "ready",
          changedFiles: ["packages/plugin-sql/src/schema.ts"],
          affectedPackages: ["plugin-sql"],
        },
      ],
      claims: [],
    });

    assert.equal(preflight.decision.allowed, true);
    assert.equal(preflight.splitPlan.recommended, true);
    assert.equal(preflight.splitPlan.strategy, "split_by_package_lane");
    assert.deepEqual(preflight.splitPlan.reasons, [
      "large_file_scope",
      "large_package_scope",
      "hot_work_area",
    ]);
    assert.deepEqual(
      preflight.splitPlan.units.map((unit) => unit.id),
      [
        "split-01-client",
        "split-02-core",
        "split-03-plugin-sql",
        "split-04-server",
      ],
    );
    assert.deepEqual(
      preflight.splitPlan.units.map((unit) => unit.suggestedBranch),
      [
        "agent/agent-platform/client",
        "agent/agent-platform/core",
        "agent/agent-platform/plugin-sql",
        "agent/agent-platform/server",
      ],
    );
    assert.equal(
      preflight.splitPlan.units.find(
        (unit) => unit.id === "split-03-plugin-sql",
      ).state,
      "watch",
    );
    assert.deepEqual(
      preflight.splitPlan.units.find(
        (unit) => unit.id === "split-03-plugin-sql",
      ).warnings,
      ["package_overlap", "hot_work_area"],
    );
    assert.deepEqual(preflight.splitPlan.nextActions, [
      "open_split_prs_for_ready_units",
      "acknowledge_watch_units_before_reservation",
    ]);
  });

  it("chunks oversized package lanes without losing remaining scope", () => {
    const files = Array.from(
      { length: 7 },
      (_, index) => `packages/core/src/file-${index}.ts`,
    );
    const preflight = buildAgentWorkPreflight({
      ownerAgentId: "agent-core",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      changedFiles: files,
      affectedPackages: ["core"],
      limits: {
        maxFilesBeforeSplitRecommendation: 2,
        maxFilesPerSplit: 3,
      },
      queueItems: [],
      claims: [],
    });

    assert.equal(preflight.splitPlan.recommended, true);
    assert.equal(preflight.splitPlan.strategy, "split_large_scope");
    assert.deepEqual(
      preflight.splitPlan.units.map((unit) => unit.changedFiles.length),
      [3, 3, 1],
    );
    assert.deepEqual(
      preflight.splitPlan.units.map((unit) => unit.id),
      ["split-01-core-part-1", "split-02-core-part-2", "split-03-core-part-3"],
    );
    assert.equal(preflight.splitPlan.summary.estimatedPrs, 3);
  });
});
