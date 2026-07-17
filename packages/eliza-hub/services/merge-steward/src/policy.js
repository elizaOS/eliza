import { applyStackDependencyEvidence } from "./stack-dependencies.js";

export const QUEUE_STATES = Object.freeze({
  OBSERVED: "observed",
  TRIAGED: "triaged",
  WAITING_FOR_CHECKS: "waiting_for_checks",
  WAITING_FOR_REVIEW: "waiting_for_review",
  READY: "ready",
  QUEUED: "queued",
  RUNNING: "running",
  BUILDING_INTEGRATION: "building_integration",
  INTEGRATION_FAILED: "integration_failed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED_CONFLICT: "blocked_conflict",
  BLOCKED_POLICY: "blocked_policy",
  BLOCKED_STALE: "blocked_stale",
  MERGED: "merged",
  CLOSED: "closed",
  QUARANTINED: "quarantined",
});

export const DEFAULT_POLICY = Object.freeze({
  maxLowRiskChangedLines: 250,
  maxMediumRiskChangedLines: 900,
  staleAfterTargetCommits: 25,
  maxRetries: 3,
  requireIssueLinkForAgentPrs: true,
  requirePlanForAgentPrs: true,
  requireValidationForAgentPrs: true,
  requireAgentRunReceiptForAgentPrs: false,
  requireVerifiedAgentRunReceiptForAgentPrs: false,
  requireAgentIdentityRegistryForAgentPrs: false,
  knownAgentIds: [],
  requireWorkItemForAgentPrs: false,
  requireWorkReservationForAgentPrs: false,
  requireAgentBranchNamespaceForAgentPrs: false,
  agentBranchNamespacePrefix: "agent",
  agentRunReceiptSignatureSecretEnv: "MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET",
  acceptedAgentRunStates: ["succeeded"],
  quarantineUnknownAgents: true,
  allowBatching: false,
  requiredHumanApprovalPaths: [
    "packages/cloud-api/**",
    "packages/cloud-shared/src/db/migrations/**",
    ".forgejo/workflows/**",
    ".github/workflows/**",
    "**/.env*",
  ],
  requiredLabels: [],
  blockedLabels: ["do-not-merge", "blocked"],
  successCheckStates: ["success", "skipped", "neutral"],
});

const AUTHOR_PRIORITY = Object.freeze({
  human: 0,
  bot: 1,
  agent: 2,
  unknown: 3,
});

const RISK_LEVEL_WEIGHT = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

const UNSCHEDULABLE_QUEUE_STATES = new Set([
  QUEUE_STATES.RUNNING,
  QUEUE_STATES.BUILDING_INTEGRATION,
  QUEUE_STATES.INTEGRATION_FAILED,
  QUEUE_STATES.MERGED,
  QUEUE_STATES.CLOSED,
  QUEUE_STATES.FAILED,
  QUEUE_STATES.CANCELLED,
]);

const OVERRIDABLE_BLOCKERS = new Set([
  "quarantined",
  "too_many_retries",
  "review_required",
  "unknown_agent",
  "missing_issue_link",
  "missing_agent_plan",
  "missing_agent_validation",
  "missing_agent_run_receipt",
  "unverified_agent_run_receipt",
  "agent_run_state_unknown",
  "agent_run_waiting_approval",
  "agent_run_not_succeeded",
  "agent_run_failed_children",
  "sensitive_paths_need_human",
  "high_conflict_risk",
]);

const REQUIRED_ACTIONS_BY_BLOCKER = new Map([
  ["too_many_retries", ["human_triage"]],
  ["review_required", ["maintainer_review"]],
  ["unknown_agent", ["register_agent_identity"]],
  ["missing_issue_link", ["link_task_or_issue"]],
  ["missing_agent_plan", ["add_agent_execution_plan"]],
  ["missing_agent_validation", ["add_validation_plan"]],
  ["missing_work_item", ["create_or_link_work_item"]],
  ["work_item_owner_mismatch", ["reassign_or_link_work_item"]],
  ["missing_agent_run_receipt", ["attach_agent_run_receipt"]],
  ["unverified_agent_run_receipt", ["attach_verified_agent_run_receipt"]],
  ["agent_identity_registry_missing", ["configure_agent_identity_registry"]],
  ["unregistered_agent_identity", ["register_agent_identity"]],
  ["missing_owner_agent_id", ["bind_agent_owner"]],
  ["agent_branch_namespace_mismatch", ["rename_branch_to_agent_namespace"]],
  ["agent_run_state_unknown", ["refresh_agent_run_receipt"]],
  ["agent_run_waiting_approval", ["resolve_agent_run_approval"]],
  ["agent_run_not_succeeded", ["rerun_agent_workflow"]],
  ["agent_run_failed_children", ["inspect_agent_run_failed_children"]],
  ["sensitive_paths_need_human", ["human_approval_for_sensitive_paths"]],
  ["high_conflict_risk", ["rebase_or_split_conflict"]],
  ["stack_dependency_pending", ["merge_stack_parents_first"]],
  ["stack_dependency_missing", ["link_missing_stack_dependencies"]],
  ["stack_dependency_failed", ["repair_or_recreate_failed_stack_parent"]],
  ["stack_dependency_cycle", ["repair_stack_cycle"]],
]);

export function normalizeQueueItem(input = {}) {
  const changedFiles = Array.isArray(input.changedFiles)
    ? input.changedFiles
    : [];
  const labels = new Set(input.labels ?? []);
  const requiredChecks = Array.isArray(input.requiredChecks)
    ? input.requiredChecks
    : [];
  const checkResults = input.checkResults ?? {};

  return {
    id: input.id ?? input.pullRequestId ?? null,
    repo: input.repo ?? "",
    pullRequestId: input.pullRequestId ?? input.id ?? null,
    sourceBranch: input.sourceBranch ?? "",
    targetBranch: input.targetBranch ?? "",
    headSha: input.headSha ?? null,
    authorKind: input.authorKind ?? "unknown",
    ownerAgentId: input.ownerAgentId ?? null,
    taskId: input.taskId ?? null,
    priority: Number.isFinite(input.priority) ? input.priority : 0,
    changedLines: Number.isFinite(input.changedLines) ? input.changedLines : 0,
    changedFiles,
    affectedPackages: input.affectedPackages ?? [],
    targetCommitsBehind: Number.isFinite(input.targetCommitsBehind)
      ? input.targetCommitsBehind
      : 0,
    retryCount: Number.isFinite(input.retryCount) ? input.retryCount : 0,
    targetProtected: input.targetProtected === true,
    reviewSatisfied: input.reviewSatisfied === true,
    headShaMatches: input.headShaMatches !== false,
    pullRequestState: input.pullRequestState
      ? String(input.pullRequestState).toLowerCase()
      : null,
    pullRequestDraft: input.pullRequestDraft === true,
    pullRequestMerged: input.pullRequestMerged === true,
    pullRequestMergeable: input.pullRequestMergeable ?? null,
    quarantined: input.quarantined === true || labels.has("quarantined"),
    labels,
    requiredChecks,
    checkResults,
    commits: normalizeCommits(input.commits ?? input.commitList),
    commitSummary: stringOrNull(
      input.commitSummary ?? input.commitRollup ?? input.reviewSummary,
    ),
    policySnapshot:
      input.policySnapshot && typeof input.policySnapshot === "object"
        ? input.policySnapshot
        : {},
    policyOverride:
      input.policyOverride && typeof input.policyOverride === "object"
        ? input.policyOverride
        : null,
    workReservation: normalizeWorkReservation(
      input.workReservation,
      input.submissionGate,
    ),
    workItemLink: normalizeWorkItemLink(input.workItemLink),
    stackDependency: normalizeStackDependency(input.stackDependency),
    hasIssueLink: input.hasIssueLink === true,
    hasExecutionPlan: input.hasExecutionPlan === true,
    hasValidationPlan: input.hasValidationPlan === true,
    agentRun: normalizeAgentRunReceipt(input.agentRun ?? input.agentRunReceipt),
    hasHumanApproval: input.hasHumanApproval === true,
    agentKnown: input.agentKnown === true,
    queueState: input.queueState ?? QUEUE_STATES.OBSERVED,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null,
  };
}

export function computeRiskScore(input = {}, policy = DEFAULT_POLICY) {
  const item = normalizeQueueItem(input);
  const reasons = [];
  let score = 0;

  if (item.changedLines > policy.maxMediumRiskChangedLines) {
    score += 35;
    reasons.push("large_change");
  } else if (item.changedLines > policy.maxLowRiskChangedLines) {
    score += 18;
    reasons.push("medium_change");
  }

  if (item.changedFiles.length > 25) {
    score += 18;
    reasons.push("many_files");
  } else if (item.changedFiles.length > 10) {
    score += 9;
    reasons.push("several_files");
  }

  const sensitiveFiles = item.changedFiles.filter((file) =>
    matchesAny(file, policy.requiredHumanApprovalPaths),
  );
  if (sensitiveFiles.length > 0) {
    score += 52;
    reasons.push("sensitive_paths");
  }

  if (item.authorKind === "agent") {
    const agentIdentity = evaluateAgentIdentity(item, policy);
    score += agentIdentity.known ? 4 : 18;
    reasons.push(agentIdentity.known ? "known_agent" : "unknown_agent");
  } else if (item.authorKind === "unknown") {
    score += 14;
    reasons.push("unknown_author");
  }

  if (item.retryCount > 0) {
    score += Math.min(item.retryCount * 5, 15);
    reasons.push("retry_history");
  }

  if (!item.hasIssueLink && item.authorKind === "agent") {
    score += 10;
    reasons.push("missing_task_link");
  }

  score = clamp(score, 0, 100);

  return {
    score,
    level: classifyRisk(score),
    reasons,
    sensitiveFiles,
  };
}

export function computeConflictScore(input = {}) {
  const item = normalizeQueueItem(input);
  const overlappingFiles = input.overlappingFiles ?? [];
  const overlappingPackages = input.overlappingPackages ?? [];
  const lockfileOverlap = item.changedFiles.some(
    (file) =>
      file.endsWith("bun.lock") ||
      file.endsWith("package-lock.json") ||
      file.endsWith("pnpm-lock.yaml"),
  );
  const migrationOverlap = item.changedFiles.some((file) =>
    file.includes("/migrations/"),
  );
  const reasons = [];
  let score = 0;

  if (item.targetCommitsBehind > 50) {
    score += 28;
    reasons.push("very_stale_target");
  } else if (item.targetCommitsBehind > 15) {
    score += 14;
    reasons.push("stale_target");
  }

  if (overlappingFiles.length > 0) {
    score += Math.min(35, overlappingFiles.length * 8);
    reasons.push("file_overlap");
  }

  if (overlappingPackages.length > 0) {
    score += Math.min(20, overlappingPackages.length * 6);
    reasons.push("package_overlap");
  }

  if (lockfileOverlap) {
    score += 12;
    reasons.push("lockfile_overlap");
  }

  if (migrationOverlap) {
    score += 18;
    reasons.push("migration_overlap");
  }

  score = clamp(score, 0, 100);

  return {
    score,
    level: score >= 50 ? "high" : score >= 25 ? "medium" : "low",
    reasons,
  };
}

export function evaluateMergePolicy(input = {}, policy = DEFAULT_POLICY) {
  const item = normalizeQueueItem(input);
  const risk = computeRiskScore(item, policy);
  const conflict = computeConflictScore(input);
  const agentIdentity = evaluateAgentIdentity(item, policy);
  const blockers = [];
  const requiredActions = [];

  if (item.quarantined) {
    blockers.push("quarantined");
  }

  if (item.policySnapshot.queueMode === "disabled") {
    blockers.push("repo_queue_disabled");
    requiredActions.push("enable_repo_queue");
  }

  if (item.pullRequestMerged) {
    blockers.push("pull_request_merged");
  }

  if (item.pullRequestState && item.pullRequestState !== "open") {
    blockers.push("pull_request_closed");
    requiredActions.push("reopen_pull_request");
  }

  if (item.pullRequestDraft) {
    blockers.push("pull_request_draft");
    requiredActions.push("mark_ready_for_review");
  }

  if (item.pullRequestMergeable === false) {
    blockers.push("pull_request_unmergeable");
    requiredActions.push("resolve_merge_conflicts");
  }

  if (!item.targetProtected) {
    blockers.push("target_not_protected");
    requiredActions.push("protect_target_branch");
  }

  if (!item.headShaMatches) {
    blockers.push("head_sha_changed");
    requiredActions.push("refresh_pr_state");
  }

  if (item.targetCommitsBehind > policy.staleAfterTargetCommits) {
    blockers.push("stale_target");
    requiredActions.push("rebase_or_update_branch");
  }

  if (item.retryCount > policy.maxRetries) {
    blockers.push("too_many_retries");
    requiredActions.push("human_triage");
  }

  if (!item.reviewSatisfied) {
    blockers.push("review_required");
    requiredActions.push("maintainer_review");
  }

  const missingChecks = item.requiredChecks.filter(
    (check) => !policy.successCheckStates.includes(item.checkResults[check]),
  );
  if (missingChecks.length > 0) {
    blockers.push("checks_not_green");
    requiredActions.push(`fix_checks:${missingChecks.join(",")}`);
  }

  for (const label of policy.requiredLabels) {
    if (!item.labels.has(label)) {
      blockers.push(`missing_label:${label}`);
    }
  }

  for (const label of policy.blockedLabels) {
    if (item.labels.has(label)) {
      blockers.push(`blocked_label:${label}`);
    }
  }

  if (item.authorKind === "agent") {
    if (policy.requireAgentIdentityRegistryForAgentPrs === true) {
      if (!agentIdentity.registryConfigured) {
        addUnique(blockers, "agent_identity_registry_missing");
        addUnique(requiredActions, "configure_agent_identity_registry");
      } else if (!agentIdentity.ownerAgentId) {
        addUnique(blockers, "missing_owner_agent_id");
        addUnique(requiredActions, "bind_agent_owner");
      } else if (!agentIdentity.known) {
        addUnique(blockers, "unregistered_agent_identity");
        addUnique(requiredActions, "register_agent_identity");
      }
    } else if (policy.quarantineUnknownAgents && !agentIdentity.known) {
      blockers.push("unknown_agent");
      requiredActions.push("register_agent_identity");
    }

    if (policy.requireIssueLinkForAgentPrs && !item.hasIssueLink) {
      blockers.push("missing_issue_link");
      requiredActions.push("link_task_or_issue");
    }

    if (policy.requirePlanForAgentPrs && !item.hasExecutionPlan) {
      blockers.push("missing_agent_plan");
      requiredActions.push("add_agent_execution_plan");
    }

    if (policy.requireValidationForAgentPrs && !item.hasValidationPlan) {
      blockers.push("missing_agent_validation");
      requiredActions.push("add_validation_plan");
    }

    const agentRunDecision = evaluateAgentRunReceipt(item.agentRun, policy);
    blockers.push(...agentRunDecision.blockers);
    requiredActions.push(...agentRunDecision.requiredActions);

    if (
      policy.requireWorkReservationForAgentPrs &&
      item.workReservation?.state !== "covered"
    ) {
      blockers.push("missing_work_reservation");
      requiredActions.push("reserve_agent_work_before_submission");
    }

    if (
      policy.requireWorkItemForAgentPrs &&
      item.workItemLink?.state !== "linked"
    ) {
      const workItemState = item.workItemLink?.state ?? "missing";
      blockers.push(
        workItemState === "owner_mismatch"
          ? "work_item_owner_mismatch"
          : "missing_work_item",
      );
      requiredActions.push(
        workItemState === "owner_mismatch"
          ? "reassign_or_link_work_item"
          : "create_or_link_work_item",
      );
    }

    if (policy.requireAgentBranchNamespaceForAgentPrs) {
      if (!item.ownerAgentId) {
        addUnique(blockers, "missing_owner_agent_id");
        addUnique(requiredActions, "bind_agent_owner");
      } else if (
        !agentBranchMatchesNamespace({
          branch: item.sourceBranch,
          ownerAgentId: item.ownerAgentId,
          prefix: policy.agentBranchNamespacePrefix,
        })
      ) {
        blockers.push("agent_branch_namespace_mismatch");
        requiredActions.push("rename_branch_to_agent_namespace");
      }
    }
  }

  if (risk.sensitiveFiles.length > 0 && !item.hasHumanApproval) {
    blockers.push("sensitive_paths_need_human");
    requiredActions.push("human_approval_for_sensitive_paths");
  }

  if (conflict.level === "high") {
    blockers.push("high_conflict_risk");
    requiredActions.push("rebase_or_split_conflict");
  }

  applyStackDependencyPolicy(item.stackDependency, blockers, requiredActions);

  const override = applyPolicyOverride(blockers, item.policyOverride);
  const effectiveBlockers = override?.remainingBlockers ?? blockers;
  const allowed = effectiveBlockers.length === 0;

  return {
    allowed,
    state: allowed ? QUEUE_STATES.READY : blockedStateFor(effectiveBlockers),
    blockers: effectiveBlockers,
    originalBlockers: override ? blockers : undefined,
    requiredActions: filterRequiredActionsForOverride(
      requiredActions,
      override,
    ),
    policyOverride: override,
    agentIdentity,
    risk,
    conflict,
    stackDependency: item.stackDependency,
  };
}

export function scheduleQueue(items = [], policy = DEFAULT_POLICY) {
  return applyStackDependencyEvidence(items)
    .map((input) => {
      const item = normalizeQueueItem(input);
      const decision = evaluateMergePolicy(item, policy);
      return { item, decision };
    })
    .filter(
      ({ item, decision }) =>
        decision.allowed && !UNSCHEDULABLE_QUEUE_STATES.has(item.queueState),
    )
    .sort((left, right) => compareQueueEntries(left, right))
    .map(({ item, decision }, index) => ({
      ...item,
      queueState: QUEUE_STATES.QUEUED,
      queuePosition: index + 1,
      risk: decision.risk,
      conflict: decision.conflict,
    }));
}

export function classifyRisk(score) {
  if (score >= 55) return "high";
  if (score >= 30) return "medium";
  return "low";
}

export function agentBranchNamespaceFor({
  ownerAgentId,
  prefix = DEFAULT_POLICY.agentBranchNamespacePrefix,
} = {}) {
  const agentId = normalizeBranchSegment(ownerAgentId);
  const namespacePrefix = normalizeBranchPrefix(prefix);
  return agentId ? `${namespacePrefix}/${agentId}/` : null;
}

export function agentBranchMatchesNamespace({
  branch,
  ownerAgentId,
  prefix = DEFAULT_POLICY.agentBranchNamespacePrefix,
} = {}) {
  const namespace = agentBranchNamespaceFor({ ownerAgentId, prefix });
  return Boolean(
    namespace &&
      typeof branch === "string" &&
      normalizeBranch(branch).startsWith(namespace),
  );
}

export function evaluateAgentIdentity(input = {}, policy = DEFAULT_POLICY) {
  const item = input?.authorKind ? input : normalizeQueueItem(input);
  const ownerAgentId = normalizeAgentIdentityId(item.ownerAgentId);
  const knownAgentIds = knownAgentIdSet(policy);
  const registryConfigured = knownAgentIds.size > 0;
  const registryRequired =
    policy.requireAgentIdentityRegistryForAgentPrs === true;

  if (item.authorKind !== "agent") {
    return {
      required: registryRequired,
      registryConfigured,
      ownerAgentId,
      known: true,
      source: "not_agent",
    };
  }

  if (registryConfigured) {
    return {
      required: registryRequired,
      registryConfigured,
      ownerAgentId,
      known: Boolean(ownerAgentId && knownAgentIds.has(ownerAgentId)),
      source: "registry",
    };
  }

  return {
    required: registryRequired,
    registryConfigured,
    ownerAgentId,
    known: registryRequired ? false : item.agentKnown === true,
    source: registryRequired ? "missing_registry" : "queue_fact",
  };
}

function compareQueueEntries(left, right) {
  const leftRisk = RISK_LEVEL_WEIGHT[left.decision.risk.level] ?? 9;
  const rightRisk = RISK_LEVEL_WEIGHT[right.decision.risk.level] ?? 9;
  const leftAuthor = AUTHOR_PRIORITY[left.item.authorKind] ?? 9;
  const rightAuthor = AUTHOR_PRIORITY[right.item.authorKind] ?? 9;

  return (
    right.item.priority - left.item.priority ||
    leftRisk - rightRisk ||
    left.decision.conflict.score - right.decision.conflict.score ||
    leftAuthor - rightAuthor ||
    left.item.changedLines - right.item.changedLines ||
    String(left.item.pullRequestId).localeCompare(
      String(right.item.pullRequestId),
    )
  );
}

function normalizeBranch(value) {
  return String(value ?? "")
    .replace(/^refs\/heads\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeBranchPrefix(value) {
  const prefix = normalizeBranch(
    value ?? DEFAULT_POLICY.agentBranchNamespacePrefix,
  );
  return prefix || DEFAULT_POLICY.agentBranchNamespacePrefix;
}

function normalizeBranchSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "-");
}

function blockedStateFor(blockers) {
  if (blockers.includes("pull_request_merged")) {
    return QUEUE_STATES.MERGED;
  }
  if (blockers.includes("pull_request_closed")) {
    return QUEUE_STATES.CLOSED;
  }
  if (blockers.includes("pull_request_draft")) {
    return QUEUE_STATES.WAITING_FOR_REVIEW;
  }
  if (blockers.includes("pull_request_unmergeable")) {
    return QUEUE_STATES.BLOCKED_CONFLICT;
  }
  if (
    blockers.includes("quarantined") ||
    blockers.includes("unknown_agent") ||
    blockers.includes("unregistered_agent_identity")
  ) {
    return QUEUE_STATES.QUARANTINED;
  }
  if (blockers.includes("stale_target")) {
    return QUEUE_STATES.BLOCKED_STALE;
  }
  if (blockers.includes("high_conflict_risk")) {
    return QUEUE_STATES.BLOCKED_CONFLICT;
  }
  if (blockers.includes("checks_not_green")) {
    return QUEUE_STATES.WAITING_FOR_CHECKS;
  }
  if (blockers.includes("review_required")) {
    return QUEUE_STATES.WAITING_FOR_REVIEW;
  }
  if (blockers.includes("agent_run_waiting_approval")) {
    return QUEUE_STATES.WAITING_FOR_REVIEW;
  }
  if (blockers.includes("missing_work_reservation")) {
    return QUEUE_STATES.BLOCKED_POLICY;
  }
  return QUEUE_STATES.BLOCKED_POLICY;
}

function applyPolicyOverride(blockers, override) {
  const active = activePolicyOverride(override);
  if (!active || blockers.length === 0) return null;

  const requestedBlockers = new Set(active.blockers ?? []);
  const overriddenBlockers = [];
  const remainingBlockers = [];

  for (const blocker of blockers) {
    if (
      isOverridableBlocker(blocker) &&
      overrideMatchesBlocker(requestedBlockers, blocker)
    ) {
      overriddenBlockers.push(blocker);
    } else {
      remainingBlockers.push(blocker);
    }
  }

  if (overriddenBlockers.length === 0) return null;

  return {
    active: true,
    approvedBy: active.approvedBy,
    reason: active.reason,
    createdAt: active.createdAt ?? null,
    expiresAt: active.expiresAt ?? null,
    blockers: active.blockers ?? [],
    overriddenBlockers,
    remainingBlockers,
  };
}

function activePolicyOverride(override) {
  if (override?.active !== true || !override.approvedBy || !override.reason)
    return null;
  if (override.expiresAt) {
    const expiresAtMs = Date.parse(override.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return null;
  }
  return override;
}

function isOverridableBlocker(blocker) {
  return (
    OVERRIDABLE_BLOCKERS.has(blocker) ||
    blocker.startsWith("missing_label:") ||
    blocker.startsWith("blocked_label:") ||
    blocker.startsWith("agent_run_unhealthy:")
  );
}

function overrideMatchesBlocker(requestedBlockers, blocker) {
  if (requestedBlockers.size === 0) return true;
  if (requestedBlockers.has(blocker)) return true;
  const prefix = blocker.split(":")[0];
  return requestedBlockers.has(prefix);
}

function filterRequiredActionsForOverride(requiredActions, override) {
  const uniqueActions = unique(requiredActions);
  if (!override?.overriddenBlockers?.length) return uniqueActions;

  const overriddenActions = new Set();
  for (const blocker of override.overriddenBlockers) {
    for (const action of requiredActionsForBlocker(blocker)) {
      overriddenActions.add(action);
    }
  }

  return uniqueActions.filter((action) => !overriddenActions.has(action));
}

function requiredActionsForBlocker(blocker) {
  if (REQUIRED_ACTIONS_BY_BLOCKER.has(blocker)) {
    return REQUIRED_ACTIONS_BY_BLOCKER.get(blocker);
  }
  if (blocker.startsWith("agent_run_unhealthy:")) return ["recover_agent_run"];
  return [];
}

function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function knownAgentIdSet(policy = DEFAULT_POLICY) {
  return new Set(
    (policy.knownAgentIds ?? []).map(normalizeAgentIdentityId).filter(Boolean),
  );
}

function normalizeAgentIdentityId(value) {
  return String(value ?? "").trim();
}

function matchesAny(path, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeAgentRunReceipt(input) {
  if (!input || typeof input !== "object") return null;

  const failedChildren = Number.isFinite(input.failedChildren)
    ? input.failedChildren
    : parseInteger(input.failedChildren);
  const failedChildKeys = Array.isArray(input.failedChildKeys)
    ? input.failedChildKeys.filter(Boolean)
    : [];
  const state = input.state ?? input.status;
  const normalized = {
    runId: input.runId ?? input.id ?? null,
    state: state ? String(state).trim().toLowerCase().replace(/_/g, "-") : null,
    blocked:
      input.blocked && typeof input.blocked === "object" ? input.blocked : null,
    unhealthy:
      input.unhealthy && typeof input.unhealthy === "object"
        ? input.unhealthy
        : null,
    failedChildren: Number.isFinite(failedChildren) ? failedChildren : 0,
    failedChildKeys,
    url: input.url ?? null,
    updatedAt: input.updatedAt ?? input.computedAt ?? null,
    signature: input.signature ?? input.hmac ?? input.receiptSignature ?? null,
    verified: input.verified === true,
    verification:
      input.verification && typeof input.verification === "object"
        ? input.verification
        : null,
  };

  if (
    !normalized.runId &&
    !normalized.state &&
    !normalized.blocked &&
    !normalized.unhealthy &&
    normalized.failedChildren === 0 &&
    normalized.failedChildKeys.length === 0 &&
    !normalized.url &&
    !normalized.signature
  ) {
    return null;
  }

  return normalized;
}

function normalizeWorkReservation(input, submissionGate) {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : workReservationFromSubmissionGate(submissionGate);
  if (!source) return null;

  const state = normalizeWorkReservationState(source.state ?? source.status);
  return {
    allowed: source.allowed === true || state === "covered",
    state,
    required: source.required === true,
    activeClaimCount: numberOrZero(source.activeClaimCount),
    coveredFiles: arrayValue(source.coveredFiles),
    coveredPackages: arrayValue(source.coveredPackages),
    missingFiles: arrayValue(source.missingFiles),
    missingPackages: arrayValue(source.missingPackages),
    requiredActions: arrayValue(source.requiredActions),
  };
}

function normalizeWorkItemLink(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const state = String(input.state ?? input.status ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  return {
    state: state || "unknown",
    repo: stringOrNull(input.repo),
    pullRequestId: integerOrNull(input.pullRequestId),
    taskId: stringOrNull(input.taskId),
    issueId: integerOrNull(input.issueId),
    ownerAgentId: stringOrNull(input.ownerAgentId),
    workItemId: stringOrNull(input.workItemId ?? input.id),
    workItemState: stringOrNull(input.workItemState),
    workItemOwnerAgentId: stringOrNull(input.workItemOwnerAgentId),
    match: stringOrNull(input.match),
  };
}

function normalizeStackDependency(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return {
    source: input.source ? String(input.source) : null,
    state: input.state ? String(input.state) : null,
    stackBlocked: input.stackBlocked === true,
    canMergeAfterDependencies: input.canMergeAfterDependencies === true,
    cycleDetected: input.cycleDetected === true,
    dependencies: arrayValue(input.dependencies),
    dependents: arrayValue(input.dependents),
    blockingDependencies: arrayValue(input.blockingDependencies),
    missingDependencies: arrayValue(input.missingDependencies),
    failedDependencies: arrayValue(input.failedDependencies),
    pendingDependencies: arrayValue(input.pendingDependencies),
    requiredActions: arrayValue(input.requiredActions),
    nextActions: arrayValue(input.nextActions),
  };
}

function applyStackDependencyPolicy(
  stackDependency,
  blockers,
  requiredActions,
) {
  if (stackDependency?.stackBlocked !== true) return;

  const dependencyBlockers = [];
  if (stackDependency.cycleDetected || stackDependency.state === "cycle") {
    dependencyBlockers.push("stack_dependency_cycle");
  }
  if (
    stackDependency.missingDependencies.length > 0 ||
    stackDependency.state === "missing_dependency"
  ) {
    dependencyBlockers.push("stack_dependency_missing");
  }
  if (
    stackDependency.failedDependencies.length > 0 ||
    stackDependency.state === "broken_dependency"
  ) {
    dependencyBlockers.push("stack_dependency_failed");
  }
  if (
    dependencyBlockers.length === 0 ||
    stackDependency.pendingDependencies.length > 0 ||
    stackDependency.state === "waiting_on_stack"
  ) {
    dependencyBlockers.push("stack_dependency_pending");
  }

  for (const blocker of dependencyBlockers) {
    addUnique(blockers, blocker);
    for (const action of requiredActionsForBlocker(blocker)) {
      addUnique(requiredActions, action);
    }
  }

  for (const action of stackDependency.requiredActions) {
    addUnique(requiredActions, action);
  }
}

function workReservationFromSubmissionGate(submissionGate) {
  const gate = Array.isArray(submissionGate?.gates)
    ? submissionGate.gates.find((item) => item.name === "work_reservation")
    : null;
  if (!gate) return null;

  const evidence =
    gate.evidence && typeof gate.evidence === "object" ? gate.evidence : {};
  return {
    allowed: gate.status !== "fail",
    state: gate.status,
    required: evidence.required === true,
    activeClaimCount: evidence.activeClaimCount,
    coveredFiles: evidence.coveredFiles,
    coveredPackages: evidence.coveredPackages,
    missingFiles: evidence.missingFiles,
    missingPackages: evidence.missingPackages,
    requiredActions: gate.requiredActions,
  };
}

function normalizeWorkReservationState(value) {
  const state = String(value ?? "")
    .trim()
    .toLowerCase();
  if (state === "pass" || state === "covered") return "covered";
  if (state === "fail" || state === "blocked") return "blocked";
  if (state === "warn" || state === "missing") return "missing";
  return "unknown";
}

function arrayValue(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item))
    .filter(Boolean);
}

function normalizeCommits(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") {
        const message = item.trim();
        return message
          ? { sha: null, message, author: null, authoredAt: null }
          : null;
      }
      if (!item || typeof item !== "object") return null;
      const message = stringOrNull(
        item.message ?? item.summary ?? item.title ?? item.commit?.message,
      );
      if (!message) return null;
      return {
        sha: stringOrNull(item.sha ?? item.id ?? item.hash),
        message,
        author: stringOrNull(
          item.author ?? item.authorName ?? item.commit?.author?.name,
        ),
        authoredAt: stringOrNull(
          item.authoredAt ??
            item.createdAt ??
            item.timestamp ??
            item.commit?.author?.date,
        ),
      };
    })
    .filter(Boolean)
    .slice(0, 250);
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function evaluateAgentRunReceipt(receipt, policy) {
  const blockers = [];
  const requiredActions = [];

  if (!receipt) {
    if (
      policy.requireAgentRunReceiptForAgentPrs ||
      policy.requireVerifiedAgentRunReceiptForAgentPrs
    ) {
      blockers.push("missing_agent_run_receipt");
      requiredActions.push("attach_agent_run_receipt");
    }
    return { blockers, requiredActions };
  }

  const acceptedStates =
    policy.acceptedAgentRunStates ?? DEFAULT_POLICY.acceptedAgentRunStates;
  if (
    policy.requireVerifiedAgentRunReceiptForAgentPrs &&
    receipt.verified !== true
  ) {
    blockers.push("unverified_agent_run_receipt");
    requiredActions.push("attach_verified_agent_run_receipt");
  }

  if (!receipt.state) {
    blockers.push("agent_run_state_unknown");
    requiredActions.push("refresh_agent_run_receipt");
  } else if (!acceptedStates.includes(receipt.state)) {
    if (receipt.state === "waiting-approval") {
      blockers.push("agent_run_waiting_approval");
      requiredActions.push("resolve_agent_run_approval");
    } else if (
      [
        "stale",
        "orphaned",
        "recovering",
        "unknown",
        "waiting-event",
        "waiting-timer",
      ].includes(receipt.state)
    ) {
      blockers.push("agent_run_unhealthy");
      requiredActions.push("recover_agent_run");
    } else {
      blockers.push("agent_run_not_succeeded");
      requiredActions.push("rerun_agent_workflow");
    }
  }

  if (
    receipt.blocked?.kind === "approval" &&
    !blockers.includes("agent_run_waiting_approval")
  ) {
    blockers.push("agent_run_waiting_approval");
    requiredActions.push("resolve_agent_run_approval");
  }

  if (receipt.unhealthy?.kind) {
    blockers.push(`agent_run_unhealthy:${receipt.unhealthy.kind}`);
    requiredActions.push("recover_agent_run");
  }

  if (receipt.failedChildren > 0) {
    blockers.push("agent_run_failed_children");
    requiredActions.push("inspect_agent_run_failed_children");
  }

  return {
    blockers: unique(blockers),
    requiredActions: unique(requiredActions),
  };
}

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function integerOrNull(value) {
  const parsed = Number.isFinite(value) ? value : parseInteger(value);
  return Number.isFinite(parsed) ? parsed : null;
}
