import { DEFAULT_POLICY, evaluateMergePolicy } from "./policy.js";

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);
const RUNNING_QUEUE_STATES = new Set(["running", "building_integration"]);
const OPEN_APPROVAL_STATUSES = new Set([
  "requested",
  "pending",
  "waiting",
  "waiting_approval",
]);
const OPEN_HUMAN_REQUEST_STATUSES = new Set([
  "requested",
  "pending",
  "waiting",
  "waiting_input",
  "open",
]);
const FAILED_CHECK_STATES = new Set([
  "failure",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
  "action_required",
  "startup_failure",
]);
const PENDING_CHECK_STATES = new Set([
  "pending",
  "queued",
  "running",
  "in_progress",
  "waiting",
  "requested",
]);

const SEVERITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

const ACTION_RANK = Object.freeze({
  resolve_human_decision: 0,
  release_or_renew_stale_claim: 1,
  route_failed_checks: 2,
  rebase_or_update_branch: 3,
  coordinate_overlapping_prs: 4,
  resolve_policy_blocker: 5,
  wait_for_checks: 6,
  enter_merge_queue: 7,
  watch_run: 8,
  inspect: 9,
});

export function buildAgentInsights({
  queueItems = [],
  claims = [],
  runs = [],
  approvals = [],
  humanRequests = [],
  policy = DEFAULT_POLICY,
  now = new Date().toISOString(),
  repo,
  ownerAgentId,
  targetBranch,
  limit = 20,
} = {}) {
  const filters = normalizeFilters({ repo, ownerAgentId, targetBranch });
  const scopedItems = queueItems
    .filter((item) => !TERMINAL_QUEUE_STATES.has(item.queueState))
    .filter((item) => matchesFilters(item, filters));
  const impactIndex = buildImpactIndex(scopedItems);
  const context = buildContext({
    queueItems: scopedItems,
    claims,
    runs,
    approvals,
    humanRequests,
    now,
  });
  const items = scopedItems
    .map((item) => buildItemInsight({ item, policy, impactIndex, context }))
    .sort(compareItems);
  const duplicateRisks = [
    ...clusterSummaries({ clusters: impactIndex.paths, kind: "path" }),
    ...clusterSummaries({ clusters: impactIndex.packages, kind: "package" }),
  ].sort(compareClusters);
  const recommendations = items
    .flatMap((item) => item.recommendations)
    .sort(compareRecommendations)
    .slice(0, positiveInteger(limit) ?? 20);

  return {
    computedAt: now,
    filters,
    counts: {
      items: items.length,
      recommendations: recommendations.length,
      duplicateRiskItems: items.filter(
        (item) => item.duplicateRisk.overlapping === true,
      ).length,
      duplicateRiskClusters: duplicateRisks.length,
      staleBranches: items.filter((item) => item.staleBranch.stale === true)
        .length,
      failedChecks: items.reduce(
        (count, item) => count + item.checks.failed.length,
        0,
      ),
      missingChecks: items.reduce(
        (count, item) => count + item.checks.missing.length,
        0,
      ),
      needsHuman: items.filter(
        (item) => item.human.openApprovals > 0 || item.human.openRequests > 0,
      ).length,
      staleClaims: items.reduce(
        (count, item) => count + item.claims.stale.length,
        0,
      ),
      blocked: items.filter((item) => item.decision.allowed === false).length,
      ready: items.filter(
        (item) =>
          item.decision.allowed === true &&
          !RUNNING_QUEUE_STATES.has(item.queueState),
      ).length,
      running: items.filter((item) => RUNNING_QUEUE_STATES.has(item.queueState))
        .length,
    },
    recommendations,
    duplicateRisks,
    staleBranches: items
      .filter((item) => item.staleBranch.stale === true)
      .map(branchSummary),
    ciFailureRoutes: items.flatMap(ciFailureRoutes),
    hotspots: {
      paths: clusterSummaries({
        clusters: impactIndex.paths,
        kind: "path",
      }).slice(0, 10),
      packages: clusterSummaries({
        clusters: impactIndex.packages,
        kind: "package",
      }).slice(0, 10),
    },
    items,
  };
}

function buildItemInsight({ item, policy, impactIndex, context }) {
  const id = queueItemId(item);
  const decision = evaluateMergePolicy(item, policy);
  const checks = checkSummary(item, policy);
  const staleBranch = staleBranchSummary(item, policy);
  const related = relatedItems({ item, impactIndex });
  const itemContext = context.get(id) ?? emptyItemContext();
  const duplicateRisk = {
    overlapping: related.itemIds.length > 0,
    relatedItemIds: related.itemIds,
    sharedPaths: related.paths,
    sharedPackages: related.packages,
  };
  const nextActions = nextActionsFor({
    item,
    decision,
    checks,
    staleBranch,
    duplicateRisk,
    context: itemContext,
  });
  const insight = {
    id,
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    sourceBranch: item.sourceBranch ?? null,
    ownerAgentId: item.ownerAgentId ?? null,
    suggestedOwnerAgentId:
      item.ownerAgentId ?? itemContext.claims.active[0]?.ownerAgentId ?? null,
    queueState: item.queueState ?? null,
    createdAt: item.createdAt ?? null,
    updatedAt: item.updatedAt ?? null,
    priority: numberOrZero(item.priority),
    summary: summaryText({
      item,
      checks,
      staleBranch,
      duplicateRisk,
      decision,
    }),
    impact: {
      paths: itemPaths(item),
      packages: itemPackages(item),
    },
    risk: decision.risk,
    conflict: decision.conflict,
    decision: {
      allowed: decision.allowed,
      state: decision.state,
      blockers: decision.blockers,
      requiredActions: decision.requiredActions,
      policyOverride: decision.policyOverride ?? null,
    },
    checks,
    staleBranch,
    duplicateRisk,
    human: {
      openApprovals: itemContext.approvals.length,
      openRequests: itemContext.humanRequests.length,
      approvalIds: itemContext.approvals.map((approval) => approval.id),
      requestIds: itemContext.humanRequests.map((request) => request.id),
    },
    claims: itemContext.claims,
    runs: itemContext.runs.map(runSummary),
    nextActions,
  };

  return {
    ...insight,
    recommendations: recommendationsFor(insight),
  };
}

function buildContext({
  queueItems,
  claims,
  runs,
  approvals,
  humanRequests,
  now,
}) {
  const queueIds = new Set(queueItems.map(queueItemId));
  const runsByQueueItem = groupBy(runs, (run) => run.queueItemId ?? null);
  const approvalsByQueueItem = groupBy(
    approvals.filter(isOpenApproval),
    (approval) => approval.queueItemId ?? null,
  );
  const approvalsByRun = groupBy(
    approvals.filter(isOpenApproval),
    (approval) => approval.runId ?? null,
  );
  const requestsByQueueItem = groupBy(
    humanRequests.filter(isOpenHumanRequest),
    (request) => request.queueItemId ?? null,
  );
  const requestsByRun = groupBy(
    humanRequests.filter(isOpenHumanRequest),
    (request) => request.runId ?? null,
  );
  const context = new Map();

  for (const item of queueItems) {
    const id = queueItemId(item);
    const itemRuns = runsByQueueItem.get(id) ?? [];
    const itemApprovals = uniqueById([
      ...(approvalsByQueueItem.get(id) ?? []),
      ...itemRuns.flatMap((run) => approvalsByRun.get(String(run.id)) ?? []),
    ]);
    const itemHumanRequests = uniqueById([
      ...(requestsByQueueItem.get(id) ?? []),
      ...itemRuns.flatMap((run) => requestsByRun.get(String(run.id)) ?? []),
    ]);
    const itemClaims = claimsForItem({ item, claims, now });
    context.set(id, {
      runs: itemRuns,
      approvals: itemApprovals,
      humanRequests: itemHumanRequests,
      claims: {
        active: itemClaims.filter((claim) => claim.status === "active"),
        stale: itemClaims.filter((claim) => claim.status === "stale"),
      },
    });
  }

  for (const approval of approvals.filter(isOpenApproval)) {
    if (!approval.queueItemId || queueIds.has(String(approval.queueItemId)))
      continue;
    const id = String(approval.queueItemId);
    const existing = context.get(id) ?? emptyItemContext();
    existing.approvals.push(approval);
    context.set(id, existing);
  }

  return context;
}

function checkSummary(item, policy) {
  const requiredChecks = arrayValue(item.requiredChecks);
  const successStates = new Set(
    arrayValue(
      policy.successCheckStates ?? DEFAULT_POLICY.successCheckStates,
    ).map(normalizeStatus),
  );
  const checkResults =
    item.checkResults && typeof item.checkResults === "object"
      ? item.checkResults
      : {};
  const checks = requiredChecks.map((name) => {
    const state = normalizeStatus(checkResults[name]);
    return {
      name,
      state: state || null,
      status: checkStatus({ state, successStates }),
    };
  });

  return {
    required: requiredChecks,
    passed: checks.filter((check) => check.status === "passed"),
    failed: checks.filter((check) => check.status === "failed"),
    pending: checks.filter((check) => check.status === "pending"),
    missing: checks.filter((check) => check.status === "missing"),
  };
}

function checkStatus({ state, successStates }) {
  if (!state) return "missing";
  if (successStates.has(state)) return "passed";
  if (FAILED_CHECK_STATES.has(state)) return "failed";
  if (PENDING_CHECK_STATES.has(state)) return "pending";
  return "pending";
}

function staleBranchSummary(item, policy) {
  const threshold =
    positiveInteger(policy.staleAfterTargetCommits) ??
    DEFAULT_POLICY.staleAfterTargetCommits;
  const commitsBehind = numberOrZero(item.targetCommitsBehind);
  const stale =
    item.queueState === "blocked_stale" || commitsBehind > threshold;
  return {
    stale,
    commitsBehind,
    threshold,
    severity:
      stale && commitsBehind > threshold * 2
        ? "high"
        : stale
          ? "medium"
          : "none",
  };
}

function nextActionsFor({
  item,
  decision,
  checks,
  staleBranch,
  duplicateRisk,
  context,
}) {
  const actions = [];
  if (context.approvals.length > 0 || context.humanRequests.length > 0)
    actions.push("resolve_human_decision");
  if (context.claims.stale.length > 0)
    actions.push("release_or_renew_stale_claim");
  if (checks.failed.length > 0) actions.push("route_failed_checks");
  if (staleBranch.stale) actions.push("rebase_or_update_branch");
  if (duplicateRisk.overlapping) actions.push("coordinate_overlapping_prs");
  if (decision.allowed === false && decision.blockers.length > 0)
    actions.push("resolve_policy_blocker");
  if (
    checks.failed.length === 0 &&
    (checks.pending.length > 0 || checks.missing.length > 0)
  )
    actions.push("wait_for_checks");
  if (decision.allowed === true && !RUNNING_QUEUE_STATES.has(item.queueState))
    actions.push("enter_merge_queue");
  if (RUNNING_QUEUE_STATES.has(item.queueState)) actions.push("watch_run");
  if (actions.length === 0) actions.push("inspect");
  return [...new Set(actions)].sort(
    (left, right) =>
      actionRank(left) - actionRank(right) || left.localeCompare(right),
  );
}

function recommendationsFor(insight) {
  const recommendations = [];
  if (insight.human.openApprovals > 0 || insight.human.openRequests > 0) {
    recommendations.push(
      recommendation({
        insight,
        type: "human_decision",
        severity: "critical",
        action: "resolve_human_decision",
        title: "Resolve open human decision before the agent can continue",
        evidence: [...insight.human.approvalIds, ...insight.human.requestIds],
      }),
    );
  }
  if (insight.claims.stale.length > 0) {
    recommendations.push(
      recommendation({
        insight,
        type: "stale_claim",
        severity: "high",
        action: "release_or_renew_stale_claim",
        title: "Release or renew stale agent ownership",
        evidence: insight.claims.stale.map((claim) => claim.id),
      }),
    );
  }
  if (insight.checks.failed.length > 0) {
    recommendations.push(
      recommendation({
        insight,
        type: "failed_checks",
        severity: "high",
        action: "route_failed_checks",
        title: "Route failed CI checks to the owning agent",
        evidence: insight.checks.failed.map((check) => check.name),
      }),
    );
  }
  if (insight.staleBranch.stale) {
    recommendations.push(
      recommendation({
        insight,
        type: "stale_branch",
        severity: insight.staleBranch.severity,
        action: "rebase_or_update_branch",
        title: "Update the branch before it enters the merge queue",
        evidence: [`${insight.staleBranch.commitsBehind} commits behind`],
      }),
    );
  }
  if (insight.duplicateRisk.overlapping) {
    recommendations.push(
      recommendation({
        insight,
        type: "overlap_risk",
        severity: "medium",
        action: "coordinate_overlapping_prs",
        title: "Coordinate overlapping pull requests before batching",
        evidence: [
          ...insight.duplicateRisk.sharedPackages,
          ...insight.duplicateRisk.sharedPaths,
        ].slice(0, 6),
        relatedItemIds: insight.duplicateRisk.relatedItemIds,
      }),
    );
  }
  if (
    insight.decision.allowed === false &&
    insight.decision.blockers.length > 0
  ) {
    recommendations.push(
      recommendation({
        insight,
        type: "policy_blocker",
        severity: "medium",
        action: "resolve_policy_blocker",
        title: "Clear merge policy blockers",
        evidence: insight.decision.blockers,
      }),
    );
  }
  if (
    insight.decision.allowed === true &&
    insight.nextActions.includes("enter_merge_queue")
  ) {
    recommendations.push(
      recommendation({
        insight,
        type: "ready_to_merge",
        severity: "low",
        action: "enter_merge_queue",
        title: "Ready for merge queue scheduling",
        evidence: [insight.queueState ?? "ready"],
      }),
    );
  }
  return recommendations;
}

function recommendation({
  insight,
  type,
  severity,
  action,
  title,
  evidence = [],
  relatedItemIds = [],
}) {
  return {
    id: `${type}:${insight.id}`,
    type,
    severity,
    action,
    title,
    itemId: insight.id,
    repo: insight.repo,
    pullRequestId: insight.pullRequestId,
    ownerAgentId: insight.ownerAgentId,
    suggestedOwnerAgentId: insight.suggestedOwnerAgentId,
    priority: insight.priority,
    evidence,
    relatedItemIds,
  };
}

function ciFailureRoutes(insight) {
  return insight.checks.failed.map((check) => ({
    id: `ci:${insight.id}:${check.name}`,
    check: check.name,
    state: check.state,
    itemId: insight.id,
    repo: insight.repo,
    pullRequestId: insight.pullRequestId,
    ownerAgentId: insight.ownerAgentId,
    suggestedOwnerAgentId: insight.suggestedOwnerAgentId,
    action: "inspect_failed_check_log",
  }));
}

function buildImpactIndex(items) {
  return {
    paths: indexImpact(items, itemPaths),
    packages: indexImpact(items, itemPackages),
  };
}

function indexImpact(items, valuesForItem) {
  const index = new Map();
  for (const item of items) {
    const id = queueItemId(item);
    for (const value of new Set(valuesForItem(item))) {
      const key = String(value);
      const cluster = index.get(key) ?? {
        key,
        itemIds: [],
        items: [],
      };
      cluster.itemIds.push(id);
      cluster.items.push(item);
      index.set(key, cluster);
    }
  }
  return index;
}

function relatedItems({ item, impactIndex }) {
  const itemId = queueItemId(item);
  const related = new Map();
  const paths = new Set();
  const packages = new Set();

  for (const path of itemPaths(item)) {
    const cluster = impactIndex.paths.get(path);
    for (const candidate of cluster?.items ?? []) {
      const candidateId = queueItemId(candidate);
      if (candidateId === itemId) continue;
      paths.add(path);
      related.set(candidateId, candidate);
    }
  }

  for (const packageName of itemPackages(item)) {
    const cluster = impactIndex.packages.get(packageName);
    for (const candidate of cluster?.items ?? []) {
      const candidateId = queueItemId(candidate);
      if (candidateId === itemId) continue;
      packages.add(packageName);
      related.set(candidateId, candidate);
    }
  }

  return {
    itemIds: [...related.keys()].sort(),
    paths: [...paths].sort(),
    packages: [...packages].sort(),
  };
}

function clusterSummaries({ clusters, kind }) {
  return [...clusters.values()]
    .filter((cluster) => cluster.itemIds.length > 1)
    .map((cluster) => ({
      kind,
      key: cluster.key,
      count: cluster.itemIds.length,
      itemIds: [...cluster.itemIds].sort(),
      pullRequests: cluster.items
        .map((item) => ({
          itemId: queueItemId(item),
          repo: item.repo ?? null,
          pullRequestId: item.pullRequestId ?? null,
          ownerAgentId: item.ownerAgentId ?? null,
        }))
        .sort((left, right) =>
          String(left.itemId).localeCompare(String(right.itemId)),
        ),
    }))
    .sort(compareClusters);
}

function branchSummary(insight) {
  return {
    itemId: insight.id,
    repo: insight.repo,
    pullRequestId: insight.pullRequestId,
    ownerAgentId: insight.ownerAgentId,
    targetBranch: insight.targetBranch,
    commitsBehind: insight.staleBranch.commitsBehind,
    threshold: insight.staleBranch.threshold,
    severity: insight.staleBranch.severity,
  };
}

function claimsForItem({ item, claims, now }) {
  const paths = new Set(itemPaths(item));
  const packages = new Set(itemPackages(item));
  return claims
    .filter((claim) => claim.repo === item.repo)
    .filter((claim) => {
      if (claim.resourceKind === "path") {
        const claimPaths = new Set(
          [claim.resourceId, ...arrayValue(claim.paths)].filter(Boolean),
        );
        return intersects(paths, claimPaths);
      }
      if (claim.resourceKind === "package") {
        return packages.has(claim.resourceId);
      }
      if (
        claim.resourceKind === "pull_request" ||
        claim.resourceKind === "queue_item"
      ) {
        return (
          String(claim.resourceId) === String(item.pullRequestId) ||
          String(claim.resourceId) === queueItemId(item)
        );
      }
      return (
        claim.ownerAgentId &&
        item.ownerAgentId &&
        claim.ownerAgentId === item.ownerAgentId
      );
    })
    .map((claim) => ({
      id: claim.id,
      repo: claim.repo ?? null,
      resourceKind: claim.resourceKind ?? null,
      resourceId: claim.resourceId ?? null,
      ownerAgentId: claim.ownerAgentId ?? null,
      status:
        claim.status === "active" && isExpired(claim.expiresAt, now)
          ? "stale"
          : (claim.status ?? "unknown"),
      expiresAt: claim.expiresAt ?? null,
    }));
}

function summaryText({ item, checks, staleBranch, duplicateRisk, decision }) {
  const parts = [
    `${item.repo ?? "unknown"}#${item.pullRequestId ?? "unknown"} is ${item.queueState ?? decision.state ?? "unknown"}`,
  ];
  const packages = itemPackages(item).slice(0, 3);
  const paths = itemPaths(item).slice(0, 2);
  if (packages.length > 0) parts.push(`touches ${packages.join(", ")}`);
  else if (paths.length > 0) parts.push(`touches ${paths.join(", ")}`);
  if (checks.failed.length > 0)
    parts.push(
      `failed checks: ${checks.failed.map((check) => check.name).join(", ")}`,
    );
  if (staleBranch.stale)
    parts.push(
      `${staleBranch.commitsBehind} commits behind ${item.targetBranch ?? "target"}`,
    );
  if (duplicateRisk.overlapping)
    parts.push(`overlaps ${duplicateRisk.relatedItemIds.length} open item(s)`);
  if (decision.blockers.length > 0)
    parts.push(`blocked by ${decision.blockers.slice(0, 3).join(", ")}`);
  return `${parts.join("; ")}.`;
}

function runSummary(run) {
  return {
    id: run.id,
    status: run.status ?? null,
    ownerKind: run.ownerKind ?? null,
    ownerId: run.ownerId ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
  };
}

function matchesFilters(item, filters) {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.ownerAgentId && item.ownerAgentId !== filters.ownerAgentId)
    return false;
  if (filters.targetBranch && item.targetBranch !== filters.targetBranch)
    return false;
  return true;
}

function normalizeFilters({ repo, ownerAgentId, targetBranch }) {
  return {
    repo: repo ? String(repo) : null,
    ownerAgentId: ownerAgentId ? String(ownerAgentId) : null,
    targetBranch: targetBranch ? String(targetBranch) : null,
  };
}

function emptyItemContext() {
  return {
    runs: [],
    approvals: [],
    humanRequests: [],
    claims: {
      active: [],
      stale: [],
    },
  };
}

function compareItems(left, right) {
  return (
    right.priority - left.priority ||
    String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
    String(left.pullRequestId ?? "").localeCompare(
      String(right.pullRequestId ?? ""),
    )
  );
}

function compareRecommendations(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    right.priority - left.priority ||
    actionRank(left.action) - actionRank(right.action) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareClusters(left, right) {
  return (
    right.count - left.count ||
    left.kind.localeCompare(right.kind) ||
    left.key.localeCompare(right.key)
  );
}

function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.info;
}

function actionRank(action) {
  return ACTION_RANK[action] ?? ACTION_RANK.inspect;
}

function isOpenApproval(approval) {
  return OPEN_APPROVAL_STATUSES.has(normalizeStatus(approval.status));
}

function isOpenHumanRequest(request) {
  return OPEN_HUMAN_REQUEST_STATUSES.has(normalizeStatus(request.status));
}

function groupBy(items, keyForItem) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    if (!key) continue;
    const stringKey = String(key);
    groups.set(stringKey, [...(groups.get(stringKey) ?? []), item]);
  }
  return groups;
}

function uniqueById(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item?.id ?? JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function queueItemId(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return String(item.pullRequestId ?? "unknown");
}

function itemPaths(item) {
  return [
    ...new Set(
      [...arrayValue(item.affectedPaths), ...arrayValue(item.changedFiles)].map(
        String,
      ),
    ),
  ].sort();
}

function itemPackages(item) {
  return [...new Set(arrayValue(item.affectedPackages).map(String))].sort();
}

function intersects(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(expiresAtMs) &&
    Number.isFinite(nowMs) &&
    expiresAtMs <= nowMs
  );
}
