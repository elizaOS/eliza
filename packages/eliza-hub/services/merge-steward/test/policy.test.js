import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentBranchMatchesNamespace,
  agentBranchNamespaceFor,
  computeConflictScore,
  computeRiskScore,
  DEFAULT_POLICY,
  evaluateMergePolicy,
  QUEUE_STATES,
  scheduleQueue,
} from "../src/index.js";

const greenBase = {
  id: 42,
  pullRequestId: 42,
  repo: "elizaos/eliza",
  sourceBranch: "agent/fix-small",
  targetBranch: "develop",
  authorKind: "agent",
  agentKnown: true,
  ownerAgentId: "agent-codex",
  taskId: "issue-123",
  hasIssueLink: true,
  hasExecutionPlan: true,
  hasValidationPlan: true,
  targetProtected: true,
  reviewSatisfied: true,
  headShaMatches: true,
  changedLines: 80,
  changedFiles: ["packages/shared/src/foo.ts"],
  requiredChecks: ["smoke", "typecheck"],
  checkResults: {
    smoke: "success",
    typecheck: "success",
  },
};

describe("merge policy", () => {
  it("allows a green known-agent PR", () => {
    const decision = evaluateMergePolicy(greenBase);

    assert.equal(decision.allowed, true);
    assert.equal(decision.state, QUEUE_STATES.READY);
    assert.deepEqual(decision.blockers, []);
    assert.equal(decision.risk.level, "low");
  });

  it("blocks sensitive paths without human approval", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      changedFiles: ["packages/cloud-api/auth/session.ts"],
      changedLines: 120,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.BLOCKED_POLICY);
    assert.ok(decision.blockers.includes("sensitive_paths_need_human"));
    assert.ok(
      decision.requiredActions.includes("human_approval_for_sensitive_paths"),
    );
    assert.equal(decision.risk.level, "high");
  });

  it("quarantines unknown agents", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      agentKnown: false,
      ownerAgentId: null,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.QUARANTINED);
    assert.ok(decision.blockers.includes("unknown_agent"));
  });

  it("requires agent ids to be registered when strict identity registry is enabled", () => {
    const allowed = evaluateMergePolicy(greenBase, {
      ...DEFAULT_POLICY,
      requireAgentIdentityRegistryForAgentPrs: true,
      knownAgentIds: ["agent-codex"],
    });
    const unregistered = evaluateMergePolicy(
      {
        ...greenBase,
        ownerAgentId: "agent-other",
        agentKnown: true,
      },
      {
        ...DEFAULT_POLICY,
        requireAgentIdentityRegistryForAgentPrs: true,
        knownAgentIds: ["agent-codex"],
      },
    );
    const missingRegistry = evaluateMergePolicy(greenBase, {
      ...DEFAULT_POLICY,
      requireAgentIdentityRegistryForAgentPrs: true,
      knownAgentIds: [],
    });

    assert.equal(allowed.allowed, true);
    assert.equal(allowed.agentIdentity.source, "registry");
    assert.equal(unregistered.allowed, false);
    assert.equal(unregistered.state, QUEUE_STATES.QUARANTINED);
    assert.ok(unregistered.blockers.includes("unregistered_agent_identity"));
    assert.ok(unregistered.requiredActions.includes("register_agent_identity"));
    assert.equal(missingRegistry.allowed, false);
    assert.ok(
      missingRegistry.blockers.includes("agent_identity_registry_missing"),
    );
    assert.ok(
      missingRegistry.requiredActions.includes(
        "configure_agent_identity_registry",
      ),
    );
  });

  it("does not allow policy overrides to bypass strict agent identity registry", () => {
    const decision = evaluateMergePolicy(
      {
        ...greenBase,
        ownerAgentId: "agent-other",
        policyOverride: {
          active: true,
          approvedBy: "operator-one",
          reason: "temporary test agent",
          blockers: ["unregistered_agent_identity"],
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      },
      {
        ...DEFAULT_POLICY,
        requireAgentIdentityRegistryForAgentPrs: true,
        knownAgentIds: ["agent-codex"],
      },
    );

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockers, ["unregistered_agent_identity"]);
    assert.equal(decision.policyOverride, null);
  });

  it("requires plan and validation touchpoints for agent PRs", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      hasExecutionPlan: false,
      hasValidationPlan: false,
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.includes("missing_agent_plan"));
    assert.ok(decision.blockers.includes("missing_agent_validation"));
    assert.ok(decision.requiredActions.includes("add_agent_execution_plan"));
    assert.ok(decision.requiredActions.includes("add_validation_plan"));
  });

  it("applies active human policy overrides to overridable blockers", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      hasExecutionPlan: false,
      policyOverride: {
        active: true,
        approvedBy: "operator-one",
        reason: "small docs-only agent PR",
        blockers: ["missing_agent_plan"],
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    });

    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.blockers, []);
    assert.deepEqual(decision.originalBlockers, ["missing_agent_plan"]);
    assert.deepEqual(decision.policyOverride.overriddenBlockers, [
      "missing_agent_plan",
    ]);
    assert.deepEqual(decision.policyOverride.remainingBlockers, []);
    assert.equal(decision.policyOverride.approvedBy, "operator-one");
  });

  it("keeps non-overridable blockers after a human policy override", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      hasExecutionPlan: false,
      checkResults: { smoke: "success" },
      policyOverride: {
        active: true,
        approvedBy: "operator-one",
        reason: "accept missing plan only",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    });

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockers, ["checks_not_green"]);
    assert.ok(decision.originalBlockers.includes("missing_agent_plan"));
    assert.ok(decision.originalBlockers.includes("checks_not_green"));
    assert.deepEqual(decision.policyOverride.overriddenBlockers, [
      "missing_agent_plan",
    ]);
    assert.deepEqual(decision.policyOverride.remainingBlockers, [
      "checks_not_green",
    ]);
    assert.deepEqual(decision.requiredActions, ["fix_checks:typecheck"]);
  });

  it("scopes human policy overrides to the requested blockers", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      hasExecutionPlan: false,
      changedFiles: ["packages/cloud-api/auth/session.ts"],
      policyOverride: {
        active: true,
        approvedBy: "operator-one",
        reason: "accept missing plan only",
        blockers: ["missing_agent_plan"],
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    });

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockers, ["sensitive_paths_need_human"]);
    assert.deepEqual(decision.policyOverride.overriddenBlockers, [
      "missing_agent_plan",
    ]);
    assert.deepEqual(decision.policyOverride.remainingBlockers, [
      "sensitive_paths_need_human",
    ]);
    assert.deepEqual(decision.requiredActions, [
      "human_approval_for_sensitive_paths",
    ]);
  });

  it("allows explicit sensitive-path policy overrides without treating every override as approval", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      changedFiles: ["packages/cloud-api/auth/session.ts"],
      policyOverride: {
        active: true,
        approvedBy: "operator-one",
        reason: "reviewed the auth change",
        blockers: ["sensitive_paths_need_human"],
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    });

    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.blockers, []);
    assert.deepEqual(decision.policyOverride.overriddenBlockers, [
      "sensitive_paths_need_human",
    ]);
  });

  it("blocks repositories with disabled queue policy snapshots", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      policySnapshot: {
        repo: "elizaos/eliza",
        queueMode: "disabled",
      },
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.BLOCKED_POLICY);
    assert.ok(decision.blockers.includes("repo_queue_disabled"));
    assert.ok(decision.requiredActions.includes("enable_repo_queue"));
  });

  it("requires agent run receipts when configured", () => {
    const decision = evaluateMergePolicy(greenBase, {
      ...DEFAULT_POLICY,
      requireAgentRunReceiptForAgentPrs: true,
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.includes("missing_agent_run_receipt"));
    assert.ok(decision.requiredActions.includes("attach_agent_run_receipt"));
  });

  it("requires verified agent run receipts when configured", () => {
    const missing = evaluateMergePolicy(greenBase, {
      ...DEFAULT_POLICY,
      requireVerifiedAgentRunReceiptForAgentPrs: true,
    });
    const unsigned = evaluateMergePolicy(
      {
        ...greenBase,
        agentRun: {
          runId: "run-green",
          state: "succeeded",
          failedChildren: 0,
        },
      },
      {
        ...DEFAULT_POLICY,
        requireVerifiedAgentRunReceiptForAgentPrs: true,
      },
    );
    const verified = evaluateMergePolicy(
      {
        ...greenBase,
        agentRun: {
          runId: "run-green",
          state: "succeeded",
          failedChildren: 0,
          verified: true,
          verification: { status: "verified" },
        },
      },
      {
        ...DEFAULT_POLICY,
        requireVerifiedAgentRunReceiptForAgentPrs: true,
      },
    );

    assert.equal(missing.allowed, false);
    assert.ok(missing.blockers.includes("missing_agent_run_receipt"));
    assert.equal(unsigned.allowed, false);
    assert.ok(unsigned.blockers.includes("unverified_agent_run_receipt"));
    assert.ok(
      unsigned.requiredActions.includes("attach_verified_agent_run_receipt"),
    );
    assert.equal(verified.allowed, true);
  });

  it("allows unverified receipts by default for local compatibility", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      agentRun: {
        runId: "run-green",
        state: "succeeded",
        failedChildren: 0,
      },
    });

    assert.equal(decision.allowed, true);
  });

  it("blocks agent run receipts that are waiting on approval", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      agentRun: {
        runId: "run-waiting",
        state: "waiting-approval",
        blocked: {
          kind: "approval",
          nodeId: "review",
          requestedAt: "2026-07-06T00:00:00.000Z",
        },
      },
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.WAITING_FOR_REVIEW);
    assert.ok(decision.blockers.includes("agent_run_waiting_approval"));
    assert.ok(decision.requiredActions.includes("resolve_agent_run_approval"));
  });

  it("blocks stale or degraded agent run receipts", () => {
    const stale = evaluateMergePolicy({
      ...greenBase,
      agentRun: {
        runId: "run-stale",
        state: "stale",
        unhealthy: {
          kind: "engine-heartbeat-stale",
          lastHeartbeatAt: "2026-07-06T00:00:00.000Z",
        },
      },
    });
    const degraded = evaluateMergePolicy({
      ...greenBase,
      agentRun: {
        runId: "run-degraded",
        state: "succeeded",
        failedChildren: 2,
        failedChildKeys: ["review::0", "validate::0"],
      },
    });

    assert.equal(stale.allowed, false);
    assert.ok(stale.blockers.includes("agent_run_unhealthy"));
    assert.ok(
      stale.blockers.includes("agent_run_unhealthy:engine-heartbeat-stale"),
    );
    assert.ok(stale.requiredActions.includes("recover_agent_run"));
    assert.equal(degraded.allowed, false);
    assert.ok(degraded.blockers.includes("agent_run_failed_children"));
    assert.ok(
      degraded.requiredActions.includes("inspect_agent_run_failed_children"),
    );
  });

  it("allows succeeded agent run receipts with no failed child agents", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      agentRun: {
        runId: "run-green",
        state: "succeeded",
        failedChildren: 0,
      },
    });

    assert.equal(decision.allowed, true);
  });

  it("requires covered work reservations for agent PRs when configured", () => {
    const missing = evaluateMergePolicy(greenBase, {
      ...DEFAULT_POLICY,
      requireWorkReservationForAgentPrs: true,
    });
    const covered = evaluateMergePolicy(
      {
        ...greenBase,
        workReservation: {
          state: "covered",
          activeClaimCount: 2,
          coveredFiles: ["packages/shared/src/foo.ts"],
          coveredPackages: ["shared"],
        },
      },
      {
        ...DEFAULT_POLICY,
        requireWorkReservationForAgentPrs: true,
      },
    );

    assert.equal(missing.allowed, false);
    assert.equal(missing.state, QUEUE_STATES.BLOCKED_POLICY);
    assert.ok(missing.blockers.includes("missing_work_reservation"));
    assert.ok(
      missing.requiredActions.includes("reserve_agent_work_before_submission"),
    );
    assert.equal(covered.allowed, true);
  });

  it("requires agent branch namespaces when configured", () => {
    const allowed = evaluateMergePolicy(
      {
        ...greenBase,
        sourceBranch: "agent/agent-codex/fix-small",
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
      },
    );
    const refAllowed = evaluateMergePolicy(
      {
        ...greenBase,
        sourceBranch: "refs/heads/agent/agent-codex/fix-small",
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
      },
    );
    const customPrefixAllowed = evaluateMergePolicy(
      {
        ...greenBase,
        sourceBranch: "bots/agent-codex/fix-small",
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
        agentBranchNamespacePrefix: "bots",
      },
    );
    const mismatch = evaluateMergePolicy(
      {
        ...greenBase,
        sourceBranch: "agent/agent-other/fix-small",
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
      },
    );
    const missingOwner = evaluateMergePolicy(
      {
        ...greenBase,
        ownerAgentId: null,
        sourceBranch: "agent/agent-codex/fix-small",
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
        quarantineUnknownAgents: false,
      },
    );

    assert.equal(
      agentBranchNamespaceFor({ ownerAgentId: "agent-codex" }),
      "agent/agent-codex/",
    );
    assert.equal(
      agentBranchMatchesNamespace({
        branch: "refs/heads/agent/agent-codex/fix-small",
        ownerAgentId: "agent-codex",
      }),
      true,
    );
    assert.equal(allowed.allowed, true);
    assert.equal(refAllowed.allowed, true);
    assert.equal(customPrefixAllowed.allowed, true);
    assert.equal(mismatch.allowed, false);
    assert.ok(mismatch.blockers.includes("agent_branch_namespace_mismatch"));
    assert.ok(
      mismatch.requiredActions.includes("rename_branch_to_agent_namespace"),
    );
    assert.equal(missingOwner.allowed, false);
    assert.ok(missingOwner.blockers.includes("missing_owner_agent_id"));
    assert.ok(missingOwner.requiredActions.includes("bind_agent_owner"));
  });

  it("does not allow policy overrides to bypass strict agent branch namespaces", () => {
    const decision = evaluateMergePolicy(
      {
        ...greenBase,
        sourceBranch: "agent/other/fix-small",
        policyOverride: {
          active: true,
          approvedBy: "operator-one",
          reason: "legacy branch name",
          blockers: ["agent_branch_namespace_mismatch"],
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      },
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
      },
    );

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockers, ["agent_branch_namespace_mismatch"]);
    assert.equal(decision.policyOverride, null);
  });

  it("waits for checks when required results are missing", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      checkResults: { smoke: "success" },
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.WAITING_FOR_CHECKS);
    assert.ok(decision.requiredActions.includes("fix_checks:typecheck"));
  });

  it("blocks stale branches", () => {
    const decision = evaluateMergePolicy({
      ...greenBase,
      targetCommitsBehind: 30,
    });

    assert.equal(decision.allowed, false);
    assert.equal(decision.state, QUEUE_STATES.BLOCKED_STALE);
    assert.ok(decision.requiredActions.includes("rebase_or_update_branch"));
  });

  it("blocks pull requests that are not live merge candidates", () => {
    const cases = [
      {
        item: { pullRequestMerged: true },
        blocker: "pull_request_merged",
        state: QUEUE_STATES.MERGED,
      },
      {
        item: { pullRequestState: "closed" },
        blocker: "pull_request_closed",
        state: QUEUE_STATES.CLOSED,
      },
      {
        item: { pullRequestDraft: true },
        blocker: "pull_request_draft",
        state: QUEUE_STATES.WAITING_FOR_REVIEW,
      },
      {
        item: { pullRequestMergeable: false },
        blocker: "pull_request_unmergeable",
        state: QUEUE_STATES.BLOCKED_CONFLICT,
      },
    ];

    for (const entry of cases) {
      const decision = evaluateMergePolicy({ ...greenBase, ...entry.item });

      assert.equal(decision.allowed, false);
      assert.equal(decision.state, entry.state);
      assert.ok(decision.blockers.includes(entry.blocker));
    }
  });
});

describe("risk and conflict scoring", () => {
  it("raises risk for large and sensitive changes", () => {
    const risk = computeRiskScore({
      ...greenBase,
      changedLines: 1200,
      changedFiles: [
        ".github/workflows/deploy.yml",
        "packages/cloud-api/src/index.ts",
      ],
    });

    assert.equal(risk.level, "high");
    assert.ok(risk.reasons.includes("large_change"));
    assert.ok(risk.reasons.includes("sensitive_paths"));
  });

  it("detects high conflict risk from overlap and migrations", () => {
    const conflict = computeConflictScore({
      ...greenBase,
      changedFiles: [
        "packages/cloud-shared/src/db/migrations/001.sql",
        "bun.lock",
      ],
      overlappingFiles: [
        "bun.lock",
        "packages/cloud-shared/src/db/migrations/001.sql",
      ],
      overlappingPackages: ["cloud-shared"],
    });

    assert.equal(conflict.level, "high");
    assert.ok(conflict.reasons.includes("file_overlap"));
    assert.ok(conflict.reasons.includes("migration_overlap"));
  });
});

describe("queue scheduling", () => {
  it("orders allowed items by priority, risk, conflict, and size", () => {
    const scheduled = scheduleQueue([
      { ...greenBase, pullRequestId: 2, priority: 0, changedLines: 120 },
      { ...greenBase, pullRequestId: 1, priority: 10, changedLines: 200 },
      { ...greenBase, pullRequestId: 3, agentKnown: false },
      { ...greenBase, pullRequestId: 4, priority: 0, changedLines: 20 },
    ]);

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [1, 4, 2],
    );
    assert.equal(scheduled[0].queuePosition, 1);
    assert.equal(scheduled[0].queueState, QUEUE_STATES.QUEUED);
  });

  it("does not schedule terminal or in-flight queue items again", () => {
    const scheduled = scheduleQueue([
      { ...greenBase, pullRequestId: 11, queueState: QUEUE_STATES.MERGED },
      { ...greenBase, pullRequestId: 12, queueState: QUEUE_STATES.RUNNING },
      { ...greenBase, pullRequestId: 13, queueState: QUEUE_STATES.FAILED },
      {
        ...greenBase,
        pullRequestId: 14,
        queueState: QUEUE_STATES.BUILDING_INTEGRATION,
      },
      {
        ...greenBase,
        pullRequestId: 15,
        queueState: QUEUE_STATES.INTEGRATION_FAILED,
      },
      { ...greenBase, pullRequestId: 16, queueState: QUEUE_STATES.OBSERVED },
    ]);

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [16],
    );
  });

  it("does not schedule agent PRs missing strict work reservation evidence", () => {
    const scheduled = scheduleQueue(
      [
        { ...greenBase, pullRequestId: 21 },
        {
          ...greenBase,
          pullRequestId: 22,
          workReservation: {
            state: "covered",
            activeClaimCount: 1,
            coveredFiles: ["packages/shared/src/foo.ts"],
          },
        },
      ],
      {
        ...DEFAULT_POLICY,
        requireWorkReservationForAgentPrs: true,
      },
    );

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [22],
    );
  });

  it("does not schedule agent PRs missing strict durable work item evidence", () => {
    const scheduled = scheduleQueue(
      [
        { ...greenBase, pullRequestId: 24 },
        {
          ...greenBase,
          pullRequestId: 25,
          workItemLink: {
            state: "linked",
            workItemId: "work:elizaos/eliza:pr:25",
            workItemState: "in_progress",
          },
        },
      ],
      {
        ...DEFAULT_POLICY,
        requireWorkItemForAgentPrs: true,
      },
    );

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [25],
    );
  });

  it("does not schedule agent PRs outside their strict branch namespace", () => {
    const scheduled = scheduleQueue(
      [
        {
          ...greenBase,
          pullRequestId: 31,
          sourceBranch: "agent/other/fix-small",
        },
        {
          ...greenBase,
          pullRequestId: 32,
          sourceBranch: "agent/agent-codex/fix-small",
        },
      ],
      {
        ...DEFAULT_POLICY,
        requireAgentBranchNamespaceForAgentPrs: true,
      },
    );

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [32],
    );
  });

  it("does not schedule stacked PR children before their parents merge", () => {
    const scheduled = scheduleQueue([
      stackItem({
        pullRequestId: 41,
        sourceBranch: "agent/stack/root",
        targetBranch: "develop",
        priority: 5,
      }),
      stackItem({
        pullRequestId: 42,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
        priority: 20,
      }),
    ]);

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [41],
    );
    assert.equal(scheduled[0].stackDependency.state, "stack_root");
  });

  it("schedules a stacked child after its parent is merged", () => {
    const scheduled = scheduleQueue([
      stackItem({
        pullRequestId: 51,
        sourceBranch: "agent/stack/root",
        targetBranch: "develop",
        queueState: QUEUE_STATES.MERGED,
      }),
      stackItem({
        pullRequestId: 52,
        sourceBranch: "agent/stack/followup",
        targetBranch: "agent/stack/root",
      }),
    ]);

    assert.deepEqual(
      scheduled.map((item) => item.pullRequestId),
      [52],
    );
    assert.equal(scheduled[0].stackDependency.state, "ready_in_stack");
  });

  it("reports stack dependency blockers as non-overridable merge policy failures", () => {
    const decision = evaluateMergePolicy({
      ...stackItem({ pullRequestId: 61 }),
      stackDependency: {
        state: "waiting_on_stack",
        stackBlocked: true,
        pendingDependencies: [{ id: "elizaos/eliza#60", state: "pending" }],
        requiredActions: ["merge_stack_parents_first"],
      },
      policyOverride: {
        active: true,
        approvedBy: "operator-one",
        reason: "do not bypass stack ordering",
        blockers: ["stack_dependency_pending"],
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    });

    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.blockers, ["stack_dependency_pending"]);
    assert.equal(decision.policyOverride, null);
    assert.ok(decision.requiredActions.includes("merge_stack_parents_first"));
    assert.equal(decision.stackDependency.state, "waiting_on_stack");
  });
});

function stackItem(overrides = {}) {
  const pullRequestId = overrides.pullRequestId ?? 1;
  return {
    ...greenBase,
    id: `elizaos/eliza#${pullRequestId}`,
    pullRequestId,
    sourceBranch: `agent/stack/${pullRequestId}`,
    targetBranch: "develop",
    priority: 0,
    queueState: QUEUE_STATES.READY,
    ...overrides,
  };
}
