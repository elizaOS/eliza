import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentSubmissionGate } from "../src/agent-submission-gate.js";

describe("agent submission gate", () => {
  it("allows a known idle agent with complete proposed PR evidence", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      capacity: {
        computedAt: "2026-07-06T00:00:00.000Z",
        filters: {
          repo: "elizaos/eliza",
          ownerAgentId: "agent-docs",
          targetBranch: "develop",
        },
        agents: [],
      },
      proposedItem: {
        repo: "elizaos/eliza",
        sourceBranch: "agent/docs/readme",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 24,
        changedFiles: ["README.md"],
      },
    });

    assert.equal(gate.agentId, "agent-docs");
    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "allowed");
    assert.equal(gate.decision.score, 0);
    assert.deepEqual(gate.decision.blockers, []);
    assert.ok(gate.labels.includes("submission:allowed"));
  });

  it("blocks strict agent submissions without a durable work item link", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      requireWorkItem: true,
      capacity: {
        filters: { repo: "elizaos/eliza", ownerAgentId: "agent-docs" },
        agents: [],
      },
      proposedItem: {
        repo: "elizaos/eliza",
        pullRequestId: 42,
        sourceBranch: "agent/docs/readme",
        targetBranch: "develop",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedFiles: ["README.md"],
      },
      workItemLink: {
        state: "missing",
        pullRequestId: 42,
      },
    });

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "needs_verification");
    assert.ok(gate.decision.blockers.includes("work_item"));
    assert.ok(
      gate.decision.requiredActions.includes("create_or_link_work_item"),
    );
    assert.ok(gate.labels.includes("work-item:missing"));
  });

  it("allows strict agent submissions with a matching durable work item link", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      requireWorkItem: true,
      capacity: {
        filters: { repo: "elizaos/eliza", ownerAgentId: "agent-docs" },
        agents: [],
      },
      proposedItem: {
        repo: "elizaos/eliza",
        pullRequestId: 42,
        sourceBranch: "agent/docs/readme",
        targetBranch: "develop",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedFiles: ["README.md"],
      },
      workItemLink: {
        state: "linked",
        workItemId: "work:elizaos/eliza:pr:42",
        workItemState: "in_progress",
        ownerAgentId: "agent-docs",
        match: "pull_request",
      },
    });

    assert.equal(gate.decision.allowed, true);
    assert.equal(
      gate.gates.find((candidate) => candidate.name === "work_item").status,
      "pass",
    );
    assert.equal(
      gate.gates.find((candidate) => candidate.name === "work_item").evidence
        .workItemId,
      "work:elizaos/eliza:pr:42",
    );
  });

  it("blocks overloaded agents with failed and stale work", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-runtime",
      capacity: {
        agents: [
          {
            agentId: "agent-runtime",
            health: "needs-triage",
            canTakeNewWork: false,
            availableSlots: 0,
            workloadScore: 14,
            counts: {
              queueItems: 5,
              blocked: 3,
              activeClaims: 2,
              staleClaims: 1,
              runningRuns: 1,
              waitingRuns: 1,
              failedRuns: 1,
              failedChecks: 2,
              needsHuman: 1,
            },
            performance: {
              health: "needs-triage",
              riskScore: 9,
              counts: {
                failedRuns: 1,
                staleClaims: 1,
              },
            },
          },
        ],
      },
      proposedItem: {
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: false,
        changedLines: 1100,
        changedFiles: Array.from(
          { length: 28 },
          (_, index) => `packages/core/src/file-${index}.ts`,
        ),
      },
    });

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "triage_required");
    assert.ok(gate.decision.blockers.includes("triage_clear"));
    assert.ok(gate.decision.blockers.includes("capacity_available"));
    assert.ok(gate.decision.blockers.includes("verification_present"));
    assert.ok(gate.decision.requiredActions.includes("recover_failed_runs"));
    assert.ok(
      gate.decision.requiredActions.includes("release_or_renew_stale_claims"),
    );
    assert.ok(
      gate.decision.requiredActions.includes("provide_validation_plan"),
    );
    assert.ok(gate.labels.includes("submission:blocked"));
    assert.ok(gate.labels.includes("needs-triage"));
  });

  it("throttles agents that already own too many queued PRs", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-runtime",
      capacity: {
        agents: [
          {
            agentId: "agent-runtime",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 4,
            counts: {
              queueItems: 5,
              ready: 4,
              blocked: 0,
              runningQueueItems: 1,
              activeClaims: 0,
              runningRuns: 0,
            },
          },
        ],
      },
      limits: {
        maxQueuedWork: 4,
        warnQueuedWork: 3,
        maxWorkloadScore: 99,
      },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-runtime",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 18,
        changedFiles: ["packages/core/src/runtime.ts"],
      },
    });

    const queueGate = gate.gates.find(
      (item) => item.name === "queue_depth_limit",
    );

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "throttled");
    assert.ok(gate.decision.blockers.includes("queue_depth_limit"));
    assert.ok(
      gate.decision.requiredActions.includes(
        "merge_or_close_existing_agent_prs",
      ),
    );
    assert.ok(
      gate.decision.requiredActions.includes("split_work_across_agents"),
    );
    assert.equal(queueGate.status, "fail");
    assert.equal(queueGate.evidence.queueItems, 5);
    assert.equal(queueGate.evidence.maxQueuedWork, 4);
    assert.ok(gate.labels.includes("queue:flood-blocked"));
    assert.ok(gate.labels.includes("agent:queue-throttled"));
  });

  it("warns when an agent is near the queued PR limit", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: {
        agents: [
          {
            agentId: "agent-docs",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 3,
            counts: {
              queueItems: 3,
              ready: 3,
              blocked: 0,
              runningQueueItems: 0,
              activeClaims: 0,
              runningRuns: 0,
            },
          },
        ],
      },
      limits: {
        maxQueuedWork: 4,
        warnQueuedWork: 3,
        maxWorkloadScore: 99,
      },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 12,
        changedFiles: ["README.md"],
      },
    });

    const queueGate = gate.gates.find(
      (item) => item.name === "queue_depth_limit",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "watch");
    assert.ok(gate.decision.warnings.includes("queue_depth_limit"));
    assert.equal(queueGate.status, "warn");
    assert.ok(queueGate.requiredActions.includes("watch_agent_queue_depth"));
    assert.equal(queueGate.evidence.queueItems, 3);
    assert.ok(gate.labels.includes("queue:watch"));
    assert.ok(gate.labels.includes("agent:queue-watch"));
  });

  it("throttles agents that burst submit too many PRs in the recent window", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:30:00.000Z",
      ownerAgentId: "agent-runtime",
      capacity: {
        computedAt: "2026-07-06T00:30:00.000Z",
        agents: [
          {
            agentId: "agent-runtime",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 4,
            counts: {
              queueItems: 4,
              ready: 4,
              blocked: 0,
              runningQueueItems: 0,
              activeClaims: 0,
              runningRuns: 0,
            },
            currentWork: [
              { pullRequestId: 101, createdAt: "2026-07-06T00:25:00.000Z" },
              { pullRequestId: 102, createdAt: "2026-07-06T00:20:00.000Z" },
              { pullRequestId: 103, createdAt: "2026-07-06T00:15:00.000Z" },
              { pullRequestId: 104, createdAt: "2026-07-06T00:10:00.000Z" },
            ],
          },
        ],
      },
      limits: {
        maxQueuedWork: 99,
        warnQueuedWork: 99,
        maxWorkloadScore: 99,
        maxRecentSubmissions: 3,
        warnRecentSubmissions: 2,
        recentSubmissionWindowMinutes: 30,
      },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-runtime",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 18,
        changedFiles: ["packages/core/src/runtime.ts"],
      },
    });

    const rateGate = gate.gates.find(
      (item) => item.name === "submission_rate_limit",
    );

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "throttled");
    assert.ok(gate.decision.blockers.includes("submission_rate_limit"));
    assert.ok(
      gate.decision.requiredActions.includes("pause_new_agent_submissions"),
    );
    assert.ok(
      gate.decision.requiredActions.includes(
        "merge_or_close_existing_agent_prs",
      ),
    );
    assert.equal(rateGate.status, "fail");
    assert.equal(rateGate.evidence.recentSubmissions, 4);
    assert.deepEqual(
      rateGate.evidence.recentPullRequestIds,
      [101, 102, 103, 104],
    );
    assert.ok(gate.labels.includes("rate:blocked"));
    assert.ok(gate.labels.includes("agent:rate-throttled"));
  });

  it("warns when agents approach the recent submission rate limit", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:30:00.000Z",
      ownerAgentId: "agent-docs",
      capacity: {
        computedAt: "2026-07-06T00:30:00.000Z",
        agents: [
          {
            agentId: "agent-docs",
            health: "available",
            canTakeNewWork: true,
            availableSlots: 2,
            workloadScore: 2,
            counts: {
              queueItems: 2,
              ready: 2,
              blocked: 0,
              runningQueueItems: 0,
              activeClaims: 0,
              runningRuns: 0,
            },
            currentWork: [
              { pullRequestId: 201, createdAt: "2026-07-06T00:25:00.000Z" },
              { pullRequestId: 202, createdAt: "2026-07-06T00:05:00.000Z" },
              { pullRequestId: 199, createdAt: "2026-07-05T23:00:00.000Z" },
            ],
          },
        ],
      },
      limits: {
        maxQueuedWork: 99,
        warnQueuedWork: 99,
        maxWorkloadScore: 99,
        maxRecentSubmissions: 3,
        warnRecentSubmissions: 2,
        recentSubmissionWindowMinutes: 30,
      },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 12,
        changedFiles: ["README.md"],
      },
    });

    const rateGate = gate.gates.find(
      (item) => item.name === "submission_rate_limit",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "watch");
    assert.ok(gate.decision.warnings.includes("submission_rate_limit"));
    assert.equal(rateGate.status, "warn");
    assert.equal(rateGate.evidence.recentSubmissions, 2);
    assert.ok(rateGate.requiredActions.includes("watch_agent_submission_rate"));
    assert.ok(gate.labels.includes("rate:watch"));
    assert.ok(gate.labels.includes("agent:rate-watch"));
  });

  it("quarantines unknown agent identities", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-unknown",
      proposedItem: {
        authorKind: "agent",
        agentKnown: false,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 10,
        changedFiles: ["README.md"],
      },
    });

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "quarantined");
    assert.deepEqual(gate.decision.blockers, ["agent_identity"]);
    assert.deepEqual(gate.decision.requiredActions, [
      "register_agent_identity",
    ]);
    assert.ok(gate.labels.includes("quarantined"));
  });

  it("uses the strict agent identity registry instead of proposed agentKnown facts", () => {
    const allowed = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: { agents: [] },
      requireAgentIdentityRegistry: true,
      knownAgentIds: ["agent-docs"],
      proposedItem: {
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: false,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 10,
        changedFiles: ["README.md"],
      },
    });
    const unregistered = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: { agents: [] },
      requireAgentIdentityRegistry: true,
      knownAgentIds: ["agent-other"],
      proposedItem: {
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 10,
        changedFiles: ["README.md"],
      },
    });

    assert.equal(allowed.decision.allowed, true);
    assert.equal(
      allowed.gates.find((gate) => gate.name === "agent_identity").evidence
        .identitySource,
      "registry",
    );
    assert.equal(unregistered.decision.allowed, false);
    assert.equal(unregistered.decision.state, "quarantined");
    assert.deepEqual(unregistered.decision.blockers, ["agent_identity"]);
    assert.deepEqual(unregistered.decision.requiredActions, [
      "register_agent_identity",
    ]);
  });

  it("blocks broad validation commands before agent submission", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:00:00.000Z",
      ownerAgentId: "agent-mobile",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      capacity: {
        computedAt: "2026-07-06T00:00:00.000Z",
        filters: {
          repo: "elizaos/eliza",
          ownerAgentId: "agent-mobile",
          targetBranch: "develop",
        },
        agents: [],
      },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-mobile",
        sourceBranch: "agent/mobile/capacitor",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 80,
        changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
        affectedPackages: ["plugin-capacitor-bridge"],
      },
      validationCommands: ["turbo run typecheck"],
    });

    const budgetGate = gate.gates.find(
      (item) => item.name === "validation_budget",
    );

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "needs_verification");
    assert.ok(gate.decision.blockers.includes("validation_budget"));
    assert.ok(
      gate.decision.requiredActions.includes("use_recommended_scoped_commands"),
    );
    assert.ok(gate.labels.includes("validation:broad-blocked"));
    assert.equal(budgetGate.status, "fail");
    assert.equal(budgetGate.evidence.broadCommandCount, 1);
    assert.deepEqual(budgetGate.evidence.recommendedCommands, [
      "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
    ]);
  });

  it("accepts scoped validation commands before agent submission", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-runtime",
      capacity: { agents: [] },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-runtime",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 40,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
      },
      validationCommands: ["turbo run typecheck --filter=@elizaos/core"],
    });

    const budgetGate = gate.gates.find(
      (item) => item.name === "validation_budget",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "allowed");
    assert.equal(budgetGate.status, "pass");
    assert.equal(budgetGate.evidence.scopedCommandCount, 1);
    assert.ok(gate.labels.includes("submission:allowed"));
  });

  it("blocks agent submissions outside the submitting agent branch namespace", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: { agents: [] },
      requireAgentBranchNamespace: true,
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        sourceBranch: "agent/other/readme",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 24,
        changedFiles: ["README.md"],
      },
    });

    const branchGate = gate.gates.find(
      (item) => item.name === "agent_branch_namespace",
    );

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "needs_verification");
    assert.ok(gate.decision.blockers.includes("agent_branch_namespace"));
    assert.ok(
      gate.decision.requiredActions.includes(
        "rename_branch_to_agent_namespace",
      ),
    );
    assert.equal(branchGate.status, "fail");
    assert.equal(branchGate.evidence.expectedNamespace, "agent/agent-docs/");
    assert.equal(branchGate.evidence.sourceBranch, "agent/other/readme");
    assert.ok(gate.labels.includes("branch:namespace-mismatch"));
  });

  it("allows agent submissions from the submitting agent branch namespace", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: { agents: [] },
      requireAgentBranchNamespace: true,
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        sourceBranch: "refs/heads/agent/agent-docs/readme",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 24,
        changedFiles: ["README.md"],
      },
    });

    const branchGate = gate.gates.find(
      (item) => item.name === "agent_branch_namespace",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "allowed");
    assert.equal(branchGate.status, "pass");
    assert.equal(branchGate.evidence.expectedNamespace, "agent/agent-docs/");
  });

  it("blocks proposed owner spoofing before branch namespace checks", () => {
    const gate = buildAgentSubmissionGate({
      ownerAgentId: "agent-docs",
      capacity: { agents: [] },
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-other",
        sourceBranch: "agent/agent-other/readme",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 24,
        changedFiles: ["README.md"],
      },
    });

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "quarantined");
    assert.deepEqual(gate.decision.blockers, ["agent_identity"]);
    assert.deepEqual(gate.decision.requiredActions, ["bind_agent_owner"]);
  });

  it("passes strict work reservation when active claims cover the proposed surface", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:10:00.000Z",
      ownerAgentId: "agent-runtime",
      repo: "elizaos/eliza",
      capacity: { agents: [] },
      requireWorkReservation: true,
      claims: [
        {
          id: "claim:path:runtime",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-runtime",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          status: "active",
          paths: ["packages/core/src/runtime.ts"],
          expiresAt: "2026-07-06T00:40:00.000Z",
        },
        {
          id: "claim:package:core",
          repo: "elizaos/eliza",
          ownerAgentId: "agent-runtime",
          resourceKind: "package",
          resourceId: "core",
          status: "active",
          expiresAt: "2026-07-06T00:40:00.000Z",
        },
      ],
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-runtime",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 40,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
      },
    });

    const reservationGate = gate.gates.find(
      (item) => item.name === "work_reservation",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "allowed");
    assert.equal(reservationGate.status, "pass");
    assert.deepEqual(reservationGate.evidence.coveredFiles, [
      "packages/core/src/runtime.ts",
    ]);
    assert.deepEqual(reservationGate.evidence.coveredPackages, ["core"]);
  });

  it("warns on unreserved proposed work until strict reservation is required", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:10:00.000Z",
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      capacity: { agents: [] },
      claims: [],
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 20,
        changedFiles: ["README.md"],
      },
    });

    const reservationGate = gate.gates.find(
      (item) => item.name === "work_reservation",
    );

    assert.equal(gate.decision.allowed, true);
    assert.equal(gate.decision.state, "watch");
    assert.ok(gate.decision.warnings.includes("work_reservation"));
    assert.equal(reservationGate.status, "warn");
    assert.deepEqual(reservationGate.evidence.missingFiles, ["README.md"]);
    assert.ok(gate.labels.includes("reservation:watch"));
  });

  it("blocks strict work reservation when active claims are missing or expired", () => {
    const gate = buildAgentSubmissionGate({
      now: "2026-07-06T00:10:00.000Z",
      ownerAgentId: "agent-docs",
      repo: "elizaos/eliza",
      capacity: { agents: [] },
      requireWorkReservation: true,
      claims: [
        {
          repo: "elizaos/eliza",
          ownerAgentId: "agent-docs",
          resourceKind: "path",
          resourceId: "README.md",
          status: "active",
          expiresAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      proposedItem: {
        repo: "elizaos/eliza",
        ownerAgentId: "agent-docs",
        authorKind: "agent",
        agentKnown: true,
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        changedLines: 20,
        changedFiles: ["README.md"],
      },
    });

    const reservationGate = gate.gates.find(
      (item) => item.name === "work_reservation",
    );

    assert.equal(gate.decision.allowed, false);
    assert.equal(gate.decision.state, "needs_verification");
    assert.ok(gate.decision.blockers.includes("work_reservation"));
    assert.ok(
      gate.decision.requiredActions.includes(
        "reserve_agent_work_before_submission",
      ),
    );
    assert.equal(reservationGate.status, "fail");
    assert.deepEqual(reservationGate.evidence.missingFiles, ["README.md"]);
    assert.ok(gate.labels.includes("reservation:missing"));
  });
});
