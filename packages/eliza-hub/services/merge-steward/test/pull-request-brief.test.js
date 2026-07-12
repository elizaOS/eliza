import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPullRequestBrief } from "../src/pull-request-brief.js";

describe("pull request review brief", () => {
  it("routes high-risk failed agent PRs to human and CI review", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 42,
        sourceBranch: "agent/auth-fix",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-security",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: false,
        targetProtected: true,
        reviewSatisfied: false,
        headShaMatches: true,
        changedLines: 1200,
        changedFiles: [
          "packages/cloud-api/auth/session.ts",
          ".forgejo/workflows/merge-steward.yml",
          "packages/cloud-shared/src/db/migrations/001.sql",
        ],
        affectedPackages: ["cloud-api", "cloud-shared"],
        requiredChecks: ["unit", "lint"],
        checkResults: { unit: "failure", lint: "success" },
      },
      ciAnalysis: {
        summary: {
          failedLogs: 1,
          primaryCategory: "test_failure",
          maxSeverity: "high",
          retryable: false,
          nextAction: "inspect_failed_test",
        },
      },
    });

    assert.equal(brief.id, "elizaos/eliza#42");
    assert.equal(brief.risk.level, "high");
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "ci_failure_needs_triage");
    assert.equal(brief.verification.ci.primaryCategory, "test_failure");
    assert.deepEqual(
      brief.verification.checks.failed.map((check) => check.name),
      ["unit"],
    );
    assert.ok(brief.verification.missing.includes("validation_plan"));
    assert.ok(brief.verification.missing.includes("green_checks"));
    assert.ok(brief.verification.missing.includes("ci_failure_triage"));
    assert.ok(brief.review.suggestedActions.includes("inspect_failed_test"));
    assert.ok(brief.review.reviewerHints.includes("agent:agent-security"));
    assert.ok(brief.review.reviewerHints.includes("maintainer:ci"));
    assert.ok(brief.review.reviewerHints.includes("maintainer:database"));
    assert.ok(brief.review.reviewerHints.includes("maintainer:security"));
    assert.ok(brief.labels.includes("risk:high"));
    assert.ok(brief.labels.includes("needs-human"));
    assert.ok(brief.labels.includes("needs-verification"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("marks green low-risk PRs as merge ready", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 43,
        sourceBranch: "agent/readme",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-docs",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 12,
        changedFiles: ["README.md"],
        affectedPackages: [],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      },
    });

    assert.equal(brief.id, "elizaos/eliza#43");
    assert.equal(brief.mergeDecision.allowed, true);
    assert.equal(brief.risk.level, "low");
    assert.equal(brief.review.required, false);
    assert.deepEqual(brief.verification.missing, []);
    assert.ok(brief.labels.includes("risk:low"));
    assert.ok(brief.labels.includes("conflict:low"));
    assert.ok(brief.labels.includes("merge-ready"));
    assert.equal(brief.labels.includes("needs-human"), false);
    assert.equal(brief.labels.includes("needs-verification"), false);
  });

  it("blocks broad validation budgets in PR review briefs", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 44,
        sourceBranch: "agent/capacitor",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-mobile",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 80,
        changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
        affectedPackages: ["plugin-capacitor-bridge"],
        requiredChecks: ["unit"],
        checkResults: { unit: "success" },
      },
      validationCommands: ["turbo run typecheck"],
    });

    assert.equal(brief.mergeDecision.allowed, true);
    assert.equal(brief.validationBudget.allowed, false);
    assert.equal(brief.validationBudget.state, "blocked");
    assert.equal(brief.validationBudget.broadCommandCount, 1);
    assert.deepEqual(
      brief.validationBudget.recommendedCommands.map(
        (command) => command.command,
      ),
      ["turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge"],
    );
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "validation_budget_blocked");
    assert.ok(brief.verification.missing.includes("scoped_validation_budget"));
    assert.ok(
      brief.review.suggestedActions.includes("use_recommended_scoped_commands"),
    );
    assert.ok(brief.labels.includes("validation:broad-blocked"));
    assert.ok(brief.labels.includes("needs-verification"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("surfaces missing work reservations from the agent submission gate", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 45,
        sourceBranch: "agent/docs",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-docs",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 12,
        changedFiles: ["README.md"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      },
      submissionGate: {
        gates: [
          {
            name: "work_reservation",
            status: "warn",
            reason: "Proposed agent PR has unreserved files or packages.",
            evidence: {
              required: false,
              activeClaimCount: 0,
              missingFiles: ["README.md"],
              missingPackages: [],
            },
            requiredActions: ["reserve_agent_work_before_submission"],
          },
        ],
      },
    });

    assert.equal(brief.workReservation.state, "missing");
    assert.deepEqual(brief.workReservation.missingFiles, ["README.md"]);
    assert.ok(brief.verification.missing.includes("work_reservation"));
    assert.ok(
      brief.review.suggestedActions.includes(
        "reserve_agent_work_before_submission",
      ),
    );
    assert.ok(brief.labels.includes("reservation:watch"));
    assert.ok(brief.labels.includes("agent:unreserved-work"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("surfaces queue-depth throttling from the agent submission gate", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 47,
        sourceBranch: "agent/runtime/more-work",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-runtime",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 28,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      },
      submissionGate: {
        gates: [
          {
            name: "queue_depth_limit",
            status: "fail",
            reason: "Agent already owns too many open PRs.",
            evidence: {
              queueItems: 5,
              ready: 4,
              runningQueueItems: 1,
              blockedQueueItems: 0,
              maxQueuedWork: 4,
              warnQueuedWork: 3,
            },
            requiredActions: [
              "merge_or_close_existing_agent_prs",
              "split_work_across_agents",
            ],
          },
        ],
      },
    });

    assert.equal(brief.queueDepth.state, "blocked");
    assert.equal(brief.queueDepth.queueItems, 5);
    assert.equal(brief.queueDepth.maxQueuedWork, 4);
    assert.ok(brief.verification.missing.includes("queue_depth"));
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "queue_depth_blocked");
    assert.ok(
      brief.review.suggestedActions.includes(
        "merge_or_close_existing_agent_prs",
      ),
    );
    assert.ok(
      brief.review.suggestedActions.includes("split_work_across_agents"),
    );
    assert.ok(brief.labels.includes("queue:flood-blocked"));
    assert.ok(brief.labels.includes("agent:queue-throttled"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("surfaces submission-rate throttling from the agent submission gate", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:30:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 48,
        sourceBranch: "agent/runtime/burst",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-runtime",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 28,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      },
      submissionGate: {
        gates: [
          {
            name: "submission_rate_limit",
            status: "fail",
            reason:
              "Agent submitted too many PRs in the recent rate-limit window.",
            evidence: {
              evidenceAvailable: true,
              recentSubmissions: 4,
              recentPullRequestIds: [101, 102, 103, 104],
              maxRecentSubmissions: 3,
              warnRecentSubmissions: 2,
              recentSubmissionWindowMinutes: 30,
            },
            requiredActions: [
              "pause_new_agent_submissions",
              "merge_or_close_existing_agent_prs",
            ],
          },
        ],
      },
    });

    assert.equal(brief.rateLimit.state, "blocked");
    assert.equal(brief.rateLimit.recentSubmissions, 4);
    assert.deepEqual(brief.rateLimit.recentPullRequestIds, [
      "101",
      "102",
      "103",
      "104",
    ]);
    assert.ok(brief.verification.missing.includes("submission_rate"));
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "submission_rate_blocked");
    assert.ok(
      brief.review.suggestedActions.includes("pause_new_agent_submissions"),
    );
    assert.ok(brief.labels.includes("rate:blocked"));
    assert.ok(brief.labels.includes("agent:rate-throttled"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("requires a commit rollup when agent commits are low signal", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:45:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 49,
        sourceBranch: "agent/runtime/noisy-history",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-runtime",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 36,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
        commits: [
          "wip",
          "fix",
          "update",
          "more",
          "cleanup",
          { sha: "abc123", message: "Document runtime coordination receipts" },
        ],
      },
    });

    assert.equal(brief.commitHygiene.state, "needs_summary");
    assert.equal(brief.commitHygiene.total, 6);
    assert.equal(brief.commitHygiene.lowSignalCount, 5);
    assert.ok(brief.commitHygiene.lowSignalMessages.includes("wip"));
    assert.ok(brief.verification.missing.includes("commit_summary"));
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "commit_summary_required");
    assert.ok(brief.review.suggestedActions.includes("provide_commit_summary"));
    assert.ok(
      brief.review.suggestedActions.includes(
        "squash_or_rollup_low_signal_commits",
      ),
    );
    assert.ok(brief.labels.includes("commits:needs-summary"));
    assert.ok(brief.labels.includes("agent:commit-noise"));
    assert.equal(brief.labels.includes("merge-ready"), false);
  });

  it("accepts a provided commit rollup for noisy agent history", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:50:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 50,
        sourceBranch: "agent/runtime/noisy-history-rollup",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-runtime",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 36,
        changedFiles: ["packages/core/src/runtime.ts"],
        affectedPackages: ["core"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
        commitSummary:
          "Runtime coordination receipts and steward queue metadata were cleaned up across six local commits.",
        commits: [
          "wip",
          "fix",
          "update",
          "more",
          "cleanup",
          "Document runtime coordination receipts",
        ],
      },
    });

    assert.equal(brief.commitHygiene.state, "summary_provided");
    assert.equal(brief.commitHygiene.lowSignalCount, 5);
    assert.equal(
      brief.commitHygiene.providedSummary,
      "Runtime coordination receipts and steward queue metadata were cleaned up across six local commits.",
    );
    assert.deepEqual(brief.verification.missing, []);
    assert.equal(brief.review.required, false);
    assert.equal(brief.review.reason, "standard_review");
    assert.ok(brief.labels.includes("merge-ready"));
    assert.equal(brief.labels.includes("commits:needs-summary"), false);
  });

  it("requires review when strict work reservation is blocked", () => {
    const brief = buildPullRequestBrief({
      now: "2026-07-06T00:00:00.000Z",
      queueItem: {
        repo: "elizaos/eliza",
        pullRequestId: 46,
        sourceBranch: "agent/docs",
        targetBranch: "develop",
        authorKind: "agent",
        agentKnown: true,
        ownerAgentId: "agent-docs",
        hasIssueLink: true,
        hasExecutionPlan: true,
        hasValidationPlan: true,
        targetProtected: true,
        reviewSatisfied: true,
        headShaMatches: true,
        changedLines: 12,
        changedFiles: ["README.md"],
        requiredChecks: ["smoke"],
        checkResults: { smoke: "success" },
      },
      submissionGate: {
        gates: [
          {
            name: "work_reservation",
            status: "fail",
            reason: "Proposed agent PR is missing active work reservations.",
            evidence: {
              required: true,
              activeClaimCount: 0,
              missingFiles: ["README.md"],
              missingPackages: [],
            },
            requiredActions: ["reserve_agent_work_before_submission"],
          },
        ],
      },
    });

    assert.equal(brief.workReservation.state, "blocked");
    assert.equal(brief.review.required, true);
    assert.equal(brief.review.reason, "work_reservation_blocked");
    assert.ok(brief.labels.includes("reservation:missing"));
    assert.ok(brief.labels.includes("needs-human"));
  });
});
