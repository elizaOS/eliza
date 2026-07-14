import {
  agentBranchMatchesNamespace,
  agentBranchNamespaceFor,
  evaluateAgentIdentity,
} from "./policy.js";
import { buildValidationPlan } from "./validation-plan.js";

export const DEFAULT_SUBMISSION_GATE_LIMITS = Object.freeze({
  maxWorkloadScore: 9,
  maxActiveWork: 3,
  maxQueuedWork: 4,
  warnQueuedWork: 3,
  maxRecentSubmissions: 3,
  warnRecentSubmissions: 2,
  recentSubmissionWindowMinutes: 30,
  maxBlockedQueueItems: 2,
  maxFailedChecks: 0,
  maxFailedRuns: 0,
  maxStaleClaims: 0,
  maxOpenHumanDecisions: 0,
  maxProposedChangedLines: 900,
  warnProposedChangedLines: 250,
  maxProposedFiles: 25,
  warnProposedFiles: 10,
});

const SEVERITY_WEIGHT = Object.freeze({
  critical: 60,
  high: 40,
  medium: 20,
  low: 8,
  info: 2,
});

export function buildAgentSubmissionGate({
  capacity = {},
  ownerAgentId = capacity?.filters?.ownerAgentId,
  repo = capacity?.filters?.repo,
  targetBranch = capacity?.filters?.targetBranch,
  proposedItem = null,
  validationPlan = null,
  validationCommands,
  requestedValidationCommands,
  allowBroadValidationCommands = false,
  validationLimits,
  claims,
  workItemLink,
  requireWorkItem = false,
  requireWorkReservation = false,
  requireAgentBranchNamespace = false,
  requireAgentIdentityRegistry = false,
  knownAgentIds = [],
  agentBranchNamespacePrefix = "agent",
  now = capacity?.computedAt ?? new Date().toISOString(),
  limits = {},
} = {}) {
  const agentId = requiredAgentId(ownerAgentId);
  const effectiveLimits = {
    ...DEFAULT_SUBMISSION_GATE_LIMITS,
    ...objectValue(limits),
  };
  const agent = findAgent(capacity, agentId);
  const proposed = normalizeProposedItem(proposedItem);
  const gates = [
    identityGate({
      agentId,
      proposed,
      requireAgentIdentityRegistry,
      knownAgentIds,
    }),
    branchNamespaceGate({
      agentId,
      proposed,
      requireAgentBranchNamespace,
      prefix: agentBranchNamespacePrefix,
    }),
    capacityGate({ agent }),
    activeWorkGate({ agent, limits: effectiveLimits }),
    queueDepthGate({ agent, limits: effectiveLimits }),
    submissionRateGate({ agent, limits: effectiveLimits, now }),
    workloadGate({ agent, limits: effectiveLimits }),
    triageGate({ agent, limits: effectiveLimits }),
    humanDecisionGate({ agent, limits: effectiveLimits }),
    blockedQueueGate({ agent, limits: effectiveLimits }),
    verificationGate({ proposed }),
    workItemGate({
      proposed,
      workItemLink,
      requireWorkItem,
    }),
    workReservationGate({
      proposed,
      claims,
      agentId,
      repo,
      requireWorkReservation,
      now,
    }),
    validationBudgetGate({
      proposed,
      validationPlan,
      validationCommands,
      requestedValidationCommands,
      allowBroadValidationCommands,
      validationLimits,
      now,
    }),
    changeSizeGate({ proposed, limits: effectiveLimits }),
  ];
  const decision = decisionFor({ agentId, gates });

  return {
    computedAt: now,
    agentId,
    filters: {
      repo: repo ? String(repo) : null,
      targetBranch: targetBranch ? String(targetBranch) : null,
    },
    summary: summaryFor({ agentId, decision, agent }),
    decision,
    gates,
    counts: countsFor(agent),
    proposedItem: proposed ? proposedSummary(proposed) : null,
    labels: labelsFor(decision),
  };
}

function identityGate({
  agentId,
  proposed,
  requireAgentIdentityRegistry = false,
  knownAgentIds = [],
}) {
  if (!proposed) {
    return pass(
      "agent_identity",
      "info",
      "No proposed PR identity was supplied.",
      {
        agentId,
        requireAgentIdentityRegistry: requireAgentIdentityRegistry === true,
        knownAgentIdCount: knownAgentIds.length,
      },
    );
  }
  if (proposed.ownerAgentId && proposed.ownerAgentId !== agentId) {
    return fail(
      "agent_identity",
      "critical",
      "Proposed PR owner does not match the submitting agent.",
      {
        agentId,
        proposedOwnerAgentId: proposed.ownerAgentId,
        requireAgentIdentityRegistry: requireAgentIdentityRegistry === true,
        knownAgentIdCount: knownAgentIds.length,
      },
      ["bind_agent_owner"],
    );
  }

  const identity = evaluateAgentIdentity(
    {
      authorKind: proposed.authorKind,
      ownerAgentId: proposed.ownerAgentId ?? agentId,
      agentKnown: proposed.agentKnown,
    },
    {
      requireAgentIdentityRegistryForAgentPrs:
        requireAgentIdentityRegistry === true,
      knownAgentIds,
    },
  );
  const evidence = {
    agentId,
    proposedOwnerAgentId: proposed.ownerAgentId ?? null,
    authorKind: proposed.authorKind,
    agentKnown: proposed.agentKnown,
    requireAgentIdentityRegistry: requireAgentIdentityRegistry === true,
    knownAgentIdCount: knownAgentIds.length,
    registryConfigured: identity.registryConfigured,
    identitySource: identity.source,
  };

  if (
    proposed.authorKind === "agent" &&
    identity.required &&
    !identity.registryConfigured
  ) {
    return fail(
      "agent_identity",
      "critical",
      "Allowed-agent identity registry is required but empty.",
      evidence,
      ["configure_agent_identity_registry"],
    );
  }
  if (proposed.authorKind === "agent" && !identity.known) {
    return fail(
      "agent_identity",
      "critical",
      "Agent identity is not registered or trusted.",
      {
        ...evidence,
        ownerAgentId: identity.ownerAgentId,
      },
      ["register_agent_identity"],
    );
  }
  if (proposed.authorKind && proposed.authorKind !== "agent") {
    return warn(
      "agent_identity",
      "low",
      "Submission is not marked as an agent-authored PR.",
      {
        ...evidence,
        authorKind: proposed.authorKind,
      },
      ["confirm_submission_actor"],
    );
  }
  return pass(
    "agent_identity",
    "info",
    "Agent identity is registered.",
    evidence,
  );
}

function branchNamespaceGate({
  agentId,
  proposed,
  requireAgentBranchNamespace,
  prefix,
}) {
  if (proposed?.authorKind !== "agent") {
    return pass(
      "agent_branch_namespace",
      "info",
      "No agent branch namespace requirements apply.",
      {},
    );
  }

  const expectedNamespace = agentBranchNamespaceFor({
    ownerAgentId: agentId,
    prefix,
  });
  const evidence = {
    required: requireAgentBranchNamespace === true,
    sourceBranch: proposed.sourceBranch,
    expectedNamespace,
    prefix,
  };

  if (requireAgentBranchNamespace !== true) {
    return pass(
      "agent_branch_namespace",
      "info",
      "Agent branch namespace enforcement is not required for this gate.",
      evidence,
    );
  }

  if (!proposed.sourceBranch) {
    return fail(
      "agent_branch_namespace",
      "medium",
      "Proposed agent PR is missing a source branch.",
      evidence,
      ["create_branch_in_agent_namespace"],
    );
  }

  if (
    !agentBranchMatchesNamespace({
      branch: proposed.sourceBranch,
      ownerAgentId: agentId,
      prefix,
    })
  ) {
    return fail(
      "agent_branch_namespace",
      "medium",
      "Proposed agent PR source branch is outside the submitting agent namespace.",
      evidence,
      ["rename_branch_to_agent_namespace"],
    );
  }

  return pass(
    "agent_branch_namespace",
    "info",
    "Proposed agent PR uses the submitting agent branch namespace.",
    evidence,
  );
}

function workItemGate({ proposed, workItemLink, requireWorkItem }) {
  if (proposed?.authorKind !== "agent") {
    return pass(
      "work_item",
      "info",
      "No agent work item requirements apply.",
      {},
    );
  }

  const evidence = {
    required: requireWorkItem === true,
    evidenceAvailable: Boolean(workItemLink),
    state: workItemLink?.state ?? "missing",
    workItemId: workItemLink?.workItemId ?? null,
    workItemState: workItemLink?.workItemState ?? null,
    ownerAgentId: workItemLink?.ownerAgentId ?? null,
    match: workItemLink?.match ?? null,
  };

  if (requireWorkItem !== true) {
    return pass(
      "work_item",
      "info",
      "Durable Eliza Work item linkage is not required for this gate.",
      evidence,
    );
  }

  if (!workItemLink || workItemLink.state === "missing") {
    return fail(
      "work_item",
      "medium",
      "Proposed agent PR is missing a linked durable Eliza Work item.",
      evidence,
      ["create_or_link_work_item"],
    );
  }

  if (workItemLink.state === "owner_mismatch") {
    return fail(
      "work_item",
      "medium",
      "Linked durable Eliza Work item is owned by another agent.",
      evidence,
      ["reassign_or_link_work_item"],
    );
  }

  if (workItemLink.state === "terminal") {
    return fail(
      "work_item",
      "medium",
      "Linked durable Eliza Work item is already terminal.",
      evidence,
      ["reopen_or_link_active_work_item"],
    );
  }

  if (workItemLink.state !== "linked") {
    return fail(
      "work_item",
      "medium",
      "Linked durable Eliza Work item is not usable for this PR.",
      evidence,
      ["create_or_link_work_item"],
    );
  }

  return pass(
    "work_item",
    "info",
    "Proposed agent PR is linked to a durable Eliza Work item.",
    evidence,
  );
}

function capacityGate({ agent }) {
  if (!agent) {
    return pass(
      "capacity_available",
      "info",
      "Agent has no tracked active work.",
      {
        availableSlots: null,
        canTakeNewWork: true,
      },
    );
  }
  if (agent.canTakeNewWork === true) {
    return pass(
      "capacity_available",
      "info",
      "Agent has available work capacity.",
      {
        availableSlots: numberOrZero(agent.availableSlots),
        canTakeNewWork: true,
      },
    );
  }
  return fail(
    "capacity_available",
    "high",
    "Agent capacity model does not allow new work.",
    {
      health: agent.health ?? null,
      availableSlots: numberOrZero(agent.availableSlots),
      canTakeNewWork: agent.canTakeNewWork === true,
      performanceHealth: agent.performance?.health ?? null,
    },
    ["clear_existing_agent_work"],
  );
}

function activeWorkGate({ agent, limits }) {
  const counts = agent?.counts ?? {};
  const activeWork =
    numberOrZero(counts.activeClaims) +
    numberOrZero(counts.runningRuns) +
    numberOrZero(counts.runningQueueItems);
  if (activeWork > limits.maxActiveWork) {
    return fail(
      "active_work_limit",
      "medium",
      "Agent already has too much active work.",
      {
        activeWork,
        maxActiveWork: limits.maxActiveWork,
      },
      ["finish_or_release_active_work"],
    );
  }
  if (activeWork === limits.maxActiveWork) {
    return warn(
      "active_work_limit",
      "low",
      "Agent is at the active work limit.",
      {
        activeWork,
        maxActiveWork: limits.maxActiveWork,
      },
      ["avoid_new_parallel_work"],
    );
  }
  return pass(
    "active_work_limit",
    "info",
    "Agent active work is within limits.",
    {
      activeWork,
      maxActiveWork: limits.maxActiveWork,
    },
  );
}

function queueDepthGate({ agent, limits }) {
  const counts = agent?.counts ?? {};
  const queueItems = numberOrZero(counts.queueItems);
  const evidence = {
    queueItems,
    ready: numberOrZero(counts.ready),
    runningQueueItems: numberOrZero(counts.runningQueueItems),
    blockedQueueItems: numberOrZero(counts.blocked),
    maxQueuedWork: numberOrZero(limits.maxQueuedWork),
    warnQueuedWork: numberOrZero(limits.warnQueuedWork),
  };

  if (queueItems > evidence.maxQueuedWork) {
    return fail(
      "queue_depth_limit",
      "medium",
      "Agent already owns too many open PRs.",
      evidence,
      ["merge_or_close_existing_agent_prs", "split_work_across_agents"],
    );
  }

  if (queueItems >= evidence.warnQueuedWork && queueItems > 0) {
    return warn(
      "queue_depth_limit",
      "low",
      "Agent is close to the open PR limit.",
      evidence,
      ["watch_agent_queue_depth"],
    );
  }

  return pass(
    "queue_depth_limit",
    "info",
    "Agent open PR count is within limits.",
    evidence,
  );
}

function submissionRateGate({ agent, limits, now }) {
  const windowMinutes = Math.max(
    1,
    numberOrZero(limits.recentSubmissionWindowMinutes),
  );
  const windowMs = windowMinutes * 60 * 1000;
  const nowMs = timestampMs(now);
  const timestampedWork = arrayValue(agent?.currentWork)
    .map((item) => ({
      id: item.id ?? null,
      pullRequestId: item.pullRequestId ?? null,
      submittedAt: item.submittedAt ?? item.openedAt ?? item.createdAt ?? null,
      timestampMs: timestampMs(
        item.submittedAt ?? item.openedAt ?? item.createdAt,
      ),
    }))
    .filter((item) => Number.isFinite(item.timestampMs));

  const evidence = {
    evidenceAvailable: Number.isFinite(nowMs) && timestampedWork.length > 0,
    recentSubmissions: 0,
    recentPullRequestIds: [],
    maxRecentSubmissions: numberOrZero(limits.maxRecentSubmissions),
    warnRecentSubmissions: numberOrZero(limits.warnRecentSubmissions),
    recentSubmissionWindowMinutes: windowMinutes,
  };

  if (!evidence.evidenceAvailable) {
    return pass(
      "submission_rate_limit",
      "info",
      "No timestamped agent PR submission evidence was supplied.",
      evidence,
    );
  }

  const windowStartMs = nowMs - windowMs;
  const recent = timestampedWork
    .filter(
      (item) => item.timestampMs <= nowMs && item.timestampMs >= windowStartMs,
    )
    .sort(
      (left, right) =>
        right.timestampMs - left.timestampMs ||
        String(left.id).localeCompare(String(right.id)),
    );
  evidence.recentSubmissions = recent.length;
  evidence.recentPullRequestIds = recent
    .map((item) => item.pullRequestId)
    .filter((value) => value != null)
    .slice(0, 8);

  if (recent.length > evidence.maxRecentSubmissions) {
    return fail(
      "submission_rate_limit",
      "medium",
      "Agent submitted too many PRs in the recent rate-limit window.",
      evidence,
      ["pause_new_agent_submissions", "merge_or_close_existing_agent_prs"],
    );
  }

  if (recent.length >= evidence.warnRecentSubmissions && recent.length > 0) {
    return warn(
      "submission_rate_limit",
      "low",
      "Agent is close to the recent PR submission rate limit.",
      evidence,
      ["watch_agent_submission_rate"],
    );
  }

  return pass(
    "submission_rate_limit",
    "info",
    "Agent recent PR submission rate is within limits.",
    evidence,
  );
}

function workloadGate({ agent, limits }) {
  const workloadScore = numberOrZero(agent?.workloadScore);
  if (workloadScore > limits.maxWorkloadScore) {
    return fail(
      "workload_limit",
      "medium",
      "Agent workload score is above the submission limit.",
      {
        workloadScore,
        maxWorkloadScore: limits.maxWorkloadScore,
      },
      ["reduce_agent_workload"],
    );
  }
  if (workloadScore >= Math.ceil(limits.maxWorkloadScore * 0.75)) {
    return warn(
      "workload_limit",
      "low",
      "Agent workload is close to the submission limit.",
      {
        workloadScore,
        maxWorkloadScore: limits.maxWorkloadScore,
      },
      ["watch_agent_workload"],
    );
  }
  return pass("workload_limit", "info", "Agent workload is within limits.", {
    workloadScore,
    maxWorkloadScore: limits.maxWorkloadScore,
  });
}

function triageGate({ agent, limits }) {
  const counts = agent?.counts ?? {};
  const failedChecks = numberOrZero(counts.failedChecks);
  const failedRuns =
    numberOrZero(counts.failedRuns) +
    numberOrZero(agent?.performance?.counts?.failedRuns);
  const staleClaims =
    numberOrZero(counts.staleClaims) +
    numberOrZero(agent?.performance?.counts?.staleClaims);
  const failures = [];
  if (failedChecks > limits.maxFailedChecks) failures.push("failed_checks");
  if (failedRuns > limits.maxFailedRuns) failures.push("failed_runs");
  if (staleClaims > limits.maxStaleClaims) failures.push("stale_claims");
  if (failures.length > 0) {
    return fail(
      "triage_clear",
      "high",
      "Agent has unresolved failed or stale work.",
      {
        failedChecks,
        failedRuns,
        staleClaims,
        failures,
      },
      [
        "route_failed_checks",
        "recover_failed_runs",
        "release_or_renew_stale_claims",
      ],
    );
  }
  return pass(
    "triage_clear",
    "info",
    "Agent has no failed checks, failed runs, or stale claims above limits.",
    {
      failedChecks,
      failedRuns,
      staleClaims,
    },
  );
}

function humanDecisionGate({ agent, limits }) {
  const counts = agent?.counts ?? {};
  const openHumanDecisions =
    numberOrZero(counts.needsHuman) + numberOrZero(counts.waitingRuns);
  if (openHumanDecisions > limits.maxOpenHumanDecisions) {
    return fail(
      "human_decisions_clear",
      "medium",
      "Agent has open human decisions or waiting runs.",
      {
        openHumanDecisions,
        maxOpenHumanDecisions: limits.maxOpenHumanDecisions,
      },
      ["resolve_human_decision"],
    );
  }
  return pass(
    "human_decisions_clear",
    "info",
    "Agent has no open human decisions above limits.",
    {
      openHumanDecisions,
      maxOpenHumanDecisions: limits.maxOpenHumanDecisions,
    },
  );
}

function blockedQueueGate({ agent, limits }) {
  const blockedQueueItems = numberOrZero(agent?.counts?.blocked);
  if (blockedQueueItems > limits.maxBlockedQueueItems) {
    return fail(
      "blocked_queue_limit",
      "medium",
      "Agent has too many blocked PRs.",
      {
        blockedQueueItems,
        maxBlockedQueueItems: limits.maxBlockedQueueItems,
      },
      ["resolve_policy_blockers"],
    );
  }
  if (blockedQueueItems > 0) {
    return warn(
      "blocked_queue_limit",
      "low",
      "Agent has blocked PRs that should be cleared soon.",
      {
        blockedQueueItems,
        maxBlockedQueueItems: limits.maxBlockedQueueItems,
      },
      ["watch_blocked_prs"],
    );
  }
  return pass(
    "blocked_queue_limit",
    "info",
    "Agent blocked PR count is within limits.",
    {
      blockedQueueItems,
      maxBlockedQueueItems: limits.maxBlockedQueueItems,
    },
  );
}

function verificationGate({ proposed }) {
  if (proposed?.authorKind !== "agent") {
    return pass(
      "verification_present",
      "info",
      "No agent PR verification requirements apply.",
      {},
    );
  }
  const missing = [];
  if (!proposed.hasIssueLink) missing.push("task_link");
  if (!proposed.hasExecutionPlan) missing.push("execution_plan");
  if (!proposed.hasValidationPlan) missing.push("validation_plan");
  if (missing.length > 0) {
    return fail(
      "verification_present",
      "medium",
      "Proposed agent PR is missing required verification.",
      {
        missing,
      },
      missing.map((item) => `provide_${item}`),
    );
  }
  return pass(
    "verification_present",
    "info",
    "Proposed agent PR includes task, execution, and validation evidence.",
    {},
  );
}

function workReservationGate({
  proposed,
  claims,
  agentId,
  repo,
  requireWorkReservation,
  now,
}) {
  if (proposed?.authorKind !== "agent") {
    return pass(
      "work_reservation",
      "info",
      "No agent work reservation requirements apply.",
      {},
    );
  }

  const surface = reservationSurfaceFor(proposed);
  if (
    surface.changedFiles.length === 0 &&
    surface.affectedPackages.length === 0
  ) {
    return pass(
      "work_reservation",
      "info",
      "No proposed changed files or packages need reservation coverage.",
      {
        required: requireWorkReservation === true,
        changedFiles: [],
        affectedPackages: [],
      },
    );
  }

  if (!Array.isArray(claims)) {
    if (requireWorkReservation === true) {
      return fail(
        "work_reservation",
        "medium",
        "Active work reservation evidence was not supplied.",
        {
          required: true,
          evidenceAvailable: false,
          changedFiles: surface.changedFiles,
          affectedPackages: surface.affectedPackages,
        },
        ["load_active_work_reservations"],
      );
    }

    return pass(
      "work_reservation",
      "info",
      "Active work reservation evidence was not supplied.",
      {
        required: false,
        evidenceAvailable: false,
        changedFiles: surface.changedFiles,
        affectedPackages: surface.affectedPackages,
      },
    );
  }

  const activeClaims = claims.map(normalizeClaim).filter((claim) =>
    claimAppliesToSubmission({
      claim,
      agentId,
      repo: proposed.repo ?? repo,
      now,
    }),
  );
  const coverage = reservationCoverageFor({ surface, claims: activeClaims });

  if (
    coverage.missingFiles.length === 0 &&
    coverage.missingPackages.length === 0
  ) {
    return pass(
      "work_reservation",
      "info",
      "Proposed agent PR is covered by active work reservations.",
      {
        required: requireWorkReservation === true,
        evidenceAvailable: true,
        activeClaimCount: activeClaims.length,
        changedFiles: surface.changedFiles,
        affectedPackages: surface.affectedPackages,
        coveredFiles: coverage.coveredFiles,
        coveredPackages: coverage.coveredPackages,
        coveringClaims: coverage.coveringClaims,
      },
    );
  }

  const evidence = {
    required: requireWorkReservation === true,
    evidenceAvailable: true,
    activeClaimCount: activeClaims.length,
    changedFiles: surface.changedFiles,
    affectedPackages: surface.affectedPackages,
    coveredFiles: coverage.coveredFiles,
    coveredPackages: coverage.coveredPackages,
    missingFiles: coverage.missingFiles,
    missingPackages: coverage.missingPackages,
    coveringClaims: coverage.coveringClaims,
  };
  const actions = ["reserve_agent_work_before_submission"];

  if (requireWorkReservation === true) {
    return fail(
      "work_reservation",
      "medium",
      "Proposed agent PR is missing active work reservations.",
      evidence,
      actions,
    );
  }

  return warn(
    "work_reservation",
    "low",
    "Proposed agent PR has unreserved files or packages.",
    evidence,
    actions,
  );
}

function validationBudgetGate({
  proposed,
  validationPlan,
  validationCommands,
  requestedValidationCommands,
  allowBroadValidationCommands,
  validationLimits,
  now,
}) {
  if (proposed?.authorKind !== "agent") {
    return pass(
      "validation_budget",
      "info",
      "No agent validation budget requirements apply.",
      {},
    );
  }

  const plan = buildSubmissionValidationPlan({
    proposed,
    validationPlan,
    validationCommands,
    requestedValidationCommands,
    allowBroadValidationCommands,
    validationLimits,
    now,
  });

  if (!plan) {
    return pass(
      "validation_budget",
      "info",
      "No proposed validation commands were supplied for budget classification.",
      {
        supplied: false,
      },
    );
  }

  const evidence = validationBudgetEvidence(plan);
  if (plan.decision?.allowed !== true) {
    return fail(
      "validation_budget",
      "medium",
      "Proposed validation commands are too broad for shared runner capacity.",
      evidence,
      [
        ...stringArray(plan.decision?.requiredActions),
        "replace_broad_validation_commands",
      ],
    );
  }

  if (plan.decision?.state === "watch") {
    return warn(
      "validation_budget",
      "low",
      "Proposed validation commands include explicitly allowed broad work.",
      evidence,
      ["watch_runner_capacity"],
    );
  }

  return pass(
    "validation_budget",
    "info",
    "Proposed validation commands are scoped to the touched surface.",
    evidence,
  );
}

function changeSizeGate({ proposed, limits }) {
  if (!proposed) {
    return pass(
      "change_size",
      "info",
      "No proposed PR change size was supplied.",
      {},
    );
  }
  const changedLines = numberOrZero(proposed.changedLines);
  const fileCount = proposed.changedFiles.length;
  if (
    changedLines > limits.maxProposedChangedLines ||
    fileCount > limits.maxProposedFiles
  ) {
    return fail(
      "change_size",
      "medium",
      "Proposed PR is too large for another parallel agent submission.",
      {
        changedLines,
        fileCount,
        maxProposedChangedLines: limits.maxProposedChangedLines,
        maxProposedFiles: limits.maxProposedFiles,
      },
      ["split_large_change"],
    );
  }
  if (
    changedLines > limits.warnProposedChangedLines ||
    fileCount > limits.warnProposedFiles
  ) {
    return warn(
      "change_size",
      "low",
      "Proposed PR is moderate size and should be watched.",
      {
        changedLines,
        fileCount,
        warnProposedChangedLines: limits.warnProposedChangedLines,
        warnProposedFiles: limits.warnProposedFiles,
      },
      ["watch_change_size"],
    );
  }
  return pass(
    "change_size",
    "info",
    "Proposed PR change size is within limits.",
    {
      changedLines,
      fileCount,
    },
  );
}

function decisionFor({ agentId, gates }) {
  const failed = gates.filter((gate) => gate.status === "fail");
  const warnings = gates.filter((gate) => gate.status === "warn");
  const state = stateFor({ failed, warnings });
  const score = riskScoreFor(gates);
  return {
    allowed: failed.length === 0,
    state,
    score,
    reason: reasonFor({ failed, warnings }),
    blockers: failed.map((gate) => gate.name),
    warnings: warnings.map((gate) => gate.name),
    requiredActions: unique(failed.flatMap((gate) => gate.requiredActions)),
    ownerAgentId: agentId,
  };
}

function stateFor({ failed, warnings }) {
  const names = new Set(failed.map((gate) => gate.name));
  if (names.has("agent_identity")) return "quarantined";
  if (names.has("triage_clear") || names.has("human_decisions_clear"))
    return "triage_required";
  if (
    names.has("verification_present") ||
    names.has("work_item") ||
    names.has("validation_budget") ||
    names.has("work_reservation") ||
    names.has("agent_branch_namespace")
  )
    return "needs_verification";
  if (failed.length > 0) return "throttled";
  if (warnings.length > 0) return "watch";
  return "allowed";
}

function riskScoreFor(gates) {
  const score = gates.reduce((total, gate) => {
    const weight = SEVERITY_WEIGHT[gate.severity] ?? 0;
    if (gate.status === "fail") return total + weight;
    if (gate.status === "warn") return total + Math.ceil(weight / 2);
    return total;
  }, 0);
  return Math.min(100, score);
}

function reasonFor({ failed, warnings }) {
  if (failed.length > 0) return failed[0].reason;
  if (warnings.length > 0) return warnings[0].reason;
  return "Agent can submit new work.";
}

function labelsFor(decision) {
  const labels = [`submission:${decision.state}`];
  if (!decision.allowed) labels.push("submission:blocked");
  if (decision.allowed) labels.push("submission:allowed");
  if (decision.state === "triage_required") labels.push("needs-triage");
  if (decision.state === "needs_verification")
    labels.push("needs-verification");
  if (decision.state === "quarantined") labels.push("quarantined");
  if (decision.blockers.includes("validation_budget"))
    labels.push("validation:broad-blocked");
  if (decision.warnings.includes("validation_budget"))
    labels.push("validation:watch");
  if (decision.blockers.includes("queue_depth_limit"))
    labels.push("queue:flood-blocked", "agent:queue-throttled");
  if (decision.warnings.includes("queue_depth_limit"))
    labels.push("queue:watch", "agent:queue-watch");
  if (decision.blockers.includes("submission_rate_limit"))
    labels.push("rate:blocked", "agent:rate-throttled");
  if (decision.warnings.includes("submission_rate_limit"))
    labels.push("rate:watch", "agent:rate-watch");
  if (decision.blockers.includes("work_reservation"))
    labels.push("reservation:missing", "agent:unreserved-work");
  if (decision.warnings.includes("work_reservation"))
    labels.push("reservation:watch", "agent:unreserved-work");
  if (decision.blockers.includes("work_item"))
    labels.push("work-item:missing", "agent:untracked-work");
  if (decision.blockers.includes("agent_branch_namespace"))
    labels.push("branch:namespace-mismatch", "agent:branch-unowned");
  return labels;
}

function summaryFor({ agentId, decision, agent }) {
  const workload = agent
    ? ` workload score ${numberOrZero(agent.workloadScore)}`
    : " no tracked workload";
  if (decision.allowed) {
    return `${agentId} may submit new work;${workload}.`;
  }
  return `${agentId} may not submit new work: ${decision.reason}`;
}

function countsFor(agent) {
  const counts = agent?.counts ?? {};
  return {
    queueItems: numberOrZero(counts.queueItems),
    ready: numberOrZero(counts.ready),
    blocked: numberOrZero(counts.blocked),
    activeClaims: numberOrZero(counts.activeClaims),
    staleClaims: numberOrZero(counts.staleClaims),
    runningRuns: numberOrZero(counts.runningRuns),
    waitingRuns: numberOrZero(counts.waitingRuns),
    failedRuns: numberOrZero(counts.failedRuns),
    failedChecks: numberOrZero(counts.failedChecks),
    needsHuman: numberOrZero(counts.needsHuman),
    workloadScore: numberOrZero(agent?.workloadScore),
    availableSlots: agent ? numberOrZero(agent.availableSlots) : null,
    canTakeNewWork: agent?.canTakeNewWork ?? true,
    health: agent?.health ?? "idle",
    performanceHealth: agent?.performance?.health ?? null,
    performanceRiskScore: numberOrZero(agent?.performance?.riskScore),
  };
}

function proposedSummary(proposed) {
  return {
    repo: proposed.repo,
    pullRequestId: proposed.pullRequestId,
    sourceBranch: proposed.sourceBranch,
    targetBranch: proposed.targetBranch,
    authorKind: proposed.authorKind,
    agentKnown: proposed.agentKnown,
    changedLines: proposed.changedLines,
    fileCount: proposed.changedFiles.length,
    affectedPackages: proposed.affectedPackages,
    hasIssueLink: proposed.hasIssueLink,
    hasExecutionPlan: proposed.hasExecutionPlan,
    hasValidationPlan: proposed.hasValidationPlan,
  };
}

function buildSubmissionValidationPlan({
  proposed,
  validationPlan,
  validationCommands,
  requestedValidationCommands,
  allowBroadValidationCommands,
  validationLimits,
  now,
}) {
  const suppliedPlan = objectValueOrNull(validationPlan);
  if (suppliedPlan) return suppliedPlan;
  if (!validationCommands && !requestedValidationCommands) return null;

  return buildValidationPlan({
    repo: proposed.repo,
    ownerAgentId: proposed.ownerAgentId,
    changedFiles: proposed.changedFiles,
    affectedPackages: proposed.affectedPackages,
    commands: validationCommands,
    requestedCommands: requestedValidationCommands,
    allowBroadCommands: allowBroadValidationCommands,
    limits: validationLimits,
    now,
  });
}

function validationBudgetEvidence(plan) {
  return {
    state: plan.decision?.state ?? "unknown",
    blockers: stringArray(plan.decision?.blockers),
    warnings: stringArray(plan.decision?.warnings),
    broadCommandCount: numberOrZero(plan.summary?.broadCommandCount),
    scopedCommandCount: numberOrZero(plan.summary?.scopedCommandCount),
    recommendedCommands: Array.isArray(plan.recommendedCommands)
      ? plan.recommendedCommands
          .map((command) => command.command)
          .filter(Boolean)
      : [],
    labels: stringArray(plan.labels),
  };
}

function reservationSurfaceFor(proposed) {
  return {
    changedFiles: unique(
      proposed.changedFiles.map(normalizePath).filter(Boolean),
    ),
    affectedPackages: unique(
      proposed.affectedPackages.map(normalizePackageName).filter(Boolean),
    ),
  };
}

function reservationCoverageFor({ surface, claims }) {
  const coveredFileSet = new Set();
  const coveredPackageSet = new Set();
  const coveringClaims = [];

  for (const file of surface.changedFiles) {
    const claim = claims.find((candidate) => claimCoversFile(candidate, file));
    if (claim) {
      coveredFileSet.add(file);
      addCoveringClaim(coveringClaims, claim);
    }
  }

  for (const packageName of surface.affectedPackages) {
    const claim = claims.find((candidate) =>
      claimCoversPackage(candidate, packageName),
    );
    if (claim) {
      coveredPackageSet.add(packageName);
      addCoveringClaim(coveringClaims, claim);
      continue;
    }

    const packageFiles = surface.changedFiles.filter(
      (file) => pathPackageName(file) === packageName,
    );
    if (
      packageFiles.length > 0 &&
      packageFiles.every((file) => coveredFileSet.has(file))
    ) {
      coveredPackageSet.add(packageName);
    }
  }

  return {
    coveredFiles: [...coveredFileSet],
    coveredPackages: [...coveredPackageSet],
    missingFiles: surface.changedFiles.filter(
      (file) => !coveredFileSet.has(file),
    ),
    missingPackages: surface.affectedPackages.filter(
      (packageName) => !coveredPackageSet.has(packageName),
    ),
    coveringClaims,
  };
}

function normalizeClaim(claim = {}) {
  const metadata = objectValue(claim.metadata);
  return {
    ...claim,
    repo: claim.repo ? String(claim.repo) : null,
    ownerAgentId: claim.ownerAgentId ? String(claim.ownerAgentId) : null,
    resourceKind: claim.resourceKind ? String(claim.resourceKind) : null,
    resourceId: claim.resourceId != null ? String(claim.resourceId) : null,
    status: claim.status ? String(claim.status) : "active",
    paths: unique(
      [
        ...stringArray(claim.paths),
        ...stringArray(metadata.paths),
        claim.resourceKind === "path" ? claim.resourceId : null,
      ]
        .filter(Boolean)
        .map(normalizePath),
    ),
    packageNames: unique(
      [
        ...stringArray(claim.packages),
        ...stringArray(claim.packageNames),
        ...stringArray(metadata.packages),
        ...stringArray(metadata.packageNames),
        claim.resourceKind === "package" ? claim.resourceId : null,
      ]
        .filter(Boolean)
        .map(normalizePackageName)
        .filter(Boolean),
    ),
    expiresAt: claim.expiresAt ?? null,
  };
}

function claimAppliesToSubmission({ claim, agentId, repo, now }) {
  if (claim.status !== "active") return false;
  if (claim.ownerAgentId && claim.ownerAgentId !== agentId) return false;
  if (repo && claim.repo && claim.repo !== repo) return false;
  if (isExpired(claim.expiresAt, now)) return false;
  return true;
}

function claimCoversFile(claim, file) {
  if (claim.paths.includes(file)) return true;
  const packageName = pathPackageName(file);
  return Boolean(packageName && claim.packageNames.includes(packageName));
}

function claimCoversPackage(claim, packageName) {
  return claim.packageNames.includes(packageName);
}

function addCoveringClaim(coveringClaims, claim) {
  const id = claim.id ?? `${claim.resourceKind}:${claim.resourceId}`;
  if (coveringClaims.some((item) => item.id === id)) return;
  coveringClaims.push({
    id,
    resourceKind: claim.resourceKind,
    resourceId: claim.resourceId,
  });
}

function pathPackageName(path) {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match ? normalizePackageName(match[1]) : null;
}

function normalizePath(value) {
  return String(value)
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function normalizePackageName(value) {
  const normalized = String(value)
    .replace(/^@elizaos\//, "")
    .replace(/^packages\//, "")
    .replace(/\/.*$/, "");
  return normalized || null;
}

function findAgent(capacity, agentId) {
  return (
    (Array.isArray(capacity?.agents) ? capacity.agents : []).find(
      (agent) => agent.agentId === agentId,
    ) ?? null
  );
}

function normalizeProposedItem(input) {
  if (!input || typeof input !== "object") return null;
  return {
    repo: input.repo ? String(input.repo) : null,
    pullRequestId: input.pullRequestId ?? null,
    sourceBranch: input.sourceBranch ? String(input.sourceBranch) : null,
    targetBranch: input.targetBranch ? String(input.targetBranch) : null,
    ownerAgentId: input.ownerAgentId ? String(input.ownerAgentId) : null,
    authorKind: input.authorKind ? String(input.authorKind) : "agent",
    agentKnown: input.agentKnown === true,
    changedLines: numberOrZero(input.changedLines),
    changedFiles: stringArray(input.changedFiles),
    affectedPackages: stringArray(input.affectedPackages),
    hasIssueLink: input.hasIssueLink === true,
    hasExecutionPlan: input.hasExecutionPlan === true,
    hasValidationPlan: input.hasValidationPlan === true,
  };
}

function pass(name, severity, reason, evidence = {}, requiredActions = []) {
  return gate({
    name,
    status: "pass",
    severity,
    reason,
    evidence,
    requiredActions,
  });
}

function warn(name, severity, reason, evidence = {}, requiredActions = []) {
  return gate({
    name,
    status: "warn",
    severity,
    reason,
    evidence,
    requiredActions,
  });
}

function fail(name, severity, reason, evidence = {}, requiredActions = []) {
  return gate({
    name,
    status: "fail",
    severity,
    reason,
    evidence,
    requiredActions,
  });
}

function gate({ name, status, severity, reason, evidence, requiredActions }) {
  return {
    name,
    status,
    severity,
    reason,
    evidence,
    requiredActions,
  };
}

function requiredAgentId(value) {
  if (!value)
    throw new TypeError("Agent submission gate requires ownerAgentId");
  return String(value);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function objectValueOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item))
    .filter(Boolean);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function timestampMs(value) {
  if (!value) return NaN;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}

function unique(values) {
  return [...new Set(values)];
}
