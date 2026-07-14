import {
  agentBranchMatchesNamespace,
  agentBranchNamespaceFor,
} from "./policy.js";

export const DEFAULT_WORK_PREFLIGHT_LIMITS = Object.freeze({
  maxPackageOverlapWarnings: 2,
  hotPathThreshold: 2,
  hotPackageThreshold: 2,
  maxSuggestedClaims: 8,
  maxFilesBeforeSplitRecommendation: 10,
  maxPackagesBeforeSplitRecommendation: 2,
  maxFilesPerSplit: 8,
  maxSplitUnits: 8,
});

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);
const TERMINAL_WORK_ITEM_STATES = new Set(["done", "cancelled"]);
const BLOCKING_WORK_ITEM_STATES = new Set([
  "claimed",
  "in_progress",
  "needs_human_review",
  "merge_queue",
  "blocked",
]);

export function buildAgentWorkPreflight({
  queueItems = [],
  claims = [],
  workItems = [],
  ownerAgentId,
  repo,
  targetBranch,
  proposedItem = null,
  changedFiles,
  affectedPackages,
  requireAgentBranchNamespace = false,
  agentBranchNamespacePrefix = "agent",
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const agentId = ownerAgentId ? String(ownerAgentId) : null;
  const effectiveLimits = {
    ...DEFAULT_WORK_PREFLIGHT_LIMITS,
    ...objectValue(limits),
  };
  const proposed = normalizeProposedWork({
    proposedItem,
    changedFiles,
    affectedPackages,
    ownerAgentId: agentId,
    repo,
    targetBranch,
  });
  const scopedQueue = queueItems
    .filter(
      (item) =>
        !TERMINAL_QUEUE_STATES.has(String(item.queueState ?? "").toLowerCase()),
    )
    .filter((item) => !proposed.repo || item.repo === proposed.repo)
    .filter(
      (item) =>
        !proposed.targetBranch || item.targetBranch === proposed.targetBranch,
    );
  const activeClaims = claims
    .filter((claim) => !proposed.repo || claim.repo === proposed.repo)
    .filter((claim) => isActiveClaim(claim, now));
  const activeWorkItems = workItems
    .filter(
      (item) =>
        !TERMINAL_WORK_ITEM_STATES.has(String(item.state ?? "").toLowerCase()),
    )
    .filter((item) => !proposed.repo || item.repo === proposed.repo)
    .filter(
      (item) =>
        !proposed.targetBranch ||
        !item.targetBranch ||
        item.targetBranch === proposed.targetBranch,
    );
  const queueOverlaps = findQueueOverlaps({
    proposed,
    queueItems: scopedQueue,
  });
  const claimConflicts = findClaimConflicts({ proposed, claims: activeClaims });
  const workItemOverlaps = findWorkItemOverlaps({
    proposed,
    workItems: activeWorkItems,
  });
  const hotspots = hotspotSummary({
    proposed,
    queueOverlaps,
    claimConflicts,
    workItemOverlaps,
    limits: effectiveLimits,
  });
  const decision = decisionFor({
    proposed,
    queueOverlaps,
    claimConflicts,
    workItemOverlaps,
    hotspots,
    limits: effectiveLimits,
    requireAgentBranchNamespace,
    agentBranchNamespacePrefix,
  });

  return {
    computedAt: now,
    agentId,
    repo: proposed.repo,
    targetBranch: proposed.targetBranch,
    proposed,
    decision,
    overlaps: {
      queueItems: queueOverlaps,
      claims: claimConflicts,
      workItems: workItemOverlaps,
    },
    hotspots,
    splitPlan: buildSplitPlan({
      proposed,
      decision,
      queueOverlaps,
      claimConflicts,
      workItemOverlaps,
      hotspots,
      limits: effectiveLimits,
    }),
    suggestedClaims: suggestedClaimsFor({
      proposed,
      limit: effectiveLimits.maxSuggestedClaims,
    }),
    labels: labelsFor(decision),
  };
}

function normalizeProposedWork({
  proposedItem,
  changedFiles,
  affectedPackages,
  ownerAgentId,
  repo,
  targetBranch,
}) {
  const item = objectValue(proposedItem);
  const files = uniqueStrings(changedFiles ?? item.changedFiles ?? item.paths);
  const packages = uniqueStrings(
    affectedPackages ?? item.affectedPackages ?? item.packages,
  );

  return {
    repo: stringOrNull(repo ?? item.repo),
    targetBranch: stringOrNull(targetBranch ?? item.targetBranch),
    sourceBranch: stringOrNull(item.sourceBranch),
    pullRequestId: item.pullRequestId ?? null,
    ownerAgentId: stringOrNull(ownerAgentId ?? item.ownerAgentId),
    changedFiles: files,
    affectedPackages: packages,
    fileCount: files.length,
    packageCount: packages.length,
  };
}

function findQueueOverlaps({ proposed, queueItems }) {
  return queueItems
    .map((item) => {
      const id = queueItemId(item);
      if (
        proposed.pullRequestId != null &&
        String(item.pullRequestId) === String(proposed.pullRequestId)
      )
        return null;
      const sharedFiles = intersection(
        proposed.changedFiles,
        uniqueStrings(item.changedFiles),
      );
      const sharedPackages = intersection(
        proposed.affectedPackages,
        uniqueStrings(item.affectedPackages),
      );
      if (sharedFiles.length === 0 && sharedPackages.length === 0) return null;

      return {
        id,
        repo: item.repo ?? null,
        pullRequestId: item.pullRequestId ?? null,
        ownerAgentId: item.ownerAgentId ?? null,
        queueState: item.queueState ?? null,
        sharedFiles,
        sharedPackages,
        severity: sharedFiles.length > 0 ? "high" : "medium",
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity) ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function findClaimConflicts({ proposed, claims }) {
  return claims
    .map((claim) => {
      const sharedFiles = claimSharedFiles({
        claim,
        files: proposed.changedFiles,
      });
      const sharedPackages = claimSharedPackages({
        claim,
        packages: proposed.affectedPackages,
      });
      if (sharedFiles.length === 0 && sharedPackages.length === 0) return null;
      const ownerMatches =
        proposed.ownerAgentId && claim.ownerAgentId === proposed.ownerAgentId;

      return {
        id: claim.id ?? null,
        ownerAgentId: claim.ownerAgentId ?? null,
        resourceKind: claim.resourceKind ?? null,
        resourceId: claim.resourceId ?? null,
        expiresAt: claim.expiresAt ?? null,
        ownerMatches: ownerMatches === true,
        sharedFiles,
        sharedPackages,
        severity: ownerMatches
          ? "low"
          : sharedFiles.length > 0
            ? "critical"
            : "high",
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity) ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function findWorkItemOverlaps({ proposed, workItems }) {
  return workItems
    .map((item) => {
      if (
        proposed.pullRequestId != null &&
        String(item.pullRequestId) === String(proposed.pullRequestId)
      )
        return null;
      const sharedFiles = intersection(
        proposed.changedFiles,
        uniqueStrings(item.paths ?? item.changedFiles),
      );
      const sharedPackages = intersection(
        proposed.affectedPackages,
        uniqueStrings(
          item.packages ?? item.affectedPackages ?? item.metadata?.packages,
        ),
      );
      if (sharedFiles.length === 0 && sharedPackages.length === 0) return null;
      const ownerMatches =
        proposed.ownerAgentId && item.ownerAgentId === proposed.ownerAgentId;
      const state = String(item.state ?? "").toLowerCase();
      const blocking = ownerMatches
        ? false
        : sharedFiles.length > 0 && BLOCKING_WORK_ITEM_STATES.has(state);

      return {
        id: item.id ?? null,
        title: item.title ?? item.id ?? null,
        repo: item.repo ?? null,
        kind: item.kind ?? null,
        state: item.state ?? null,
        ownerAgentId: item.ownerAgentId ?? null,
        targetBranch: item.targetBranch ?? null,
        pullRequestId: item.pullRequestId ?? null,
        taskId: item.taskId ?? null,
        issueId: item.issueId ?? null,
        ownerMatches: ownerMatches === true,
        sharedFiles,
        sharedPackages,
        blocking,
        suggestedAction: ownerMatches
          ? "continue_or_link_existing_work_item"
          : blocking
            ? "coordinate_with_work_item_owner"
            : "review_work_item_overlap",
        severity: ownerMatches
          ? "low"
          : blocking
            ? "critical"
            : sharedFiles.length > 0
              ? "high"
              : "medium",
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity) ||
        String(left.id).localeCompare(String(right.id)),
    );
}

function claimSharedFiles({ claim, files }) {
  const claimPaths = uniqueStrings([
    claim.resourceKind === "path" ? claim.resourceId : null,
    ...uniqueStrings(claim.paths),
  ]);
  return intersection(files, claimPaths);
}

function claimSharedPackages({ claim, packages }) {
  const claimPackages = uniqueStrings([
    claim.resourceKind === "package" ? claim.resourceId : null,
    ...(claim.metadata?.packages ?? []),
  ]);
  return intersection(packages, claimPackages);
}

function hotspotSummary({
  proposed,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  limits,
}) {
  const pathCounts = new Map(proposed.changedFiles.map((file) => [file, 1]));
  const packageCounts = new Map(
    proposed.affectedPackages.map((packageName) => [packageName, 1]),
  );

  for (const overlap of queueOverlaps) {
    for (const file of overlap.sharedFiles)
      pathCounts.set(file, (pathCounts.get(file) ?? 0) + 1);
    for (const packageName of overlap.sharedPackages)
      packageCounts.set(packageName, (packageCounts.get(packageName) ?? 0) + 1);
  }

  for (const conflict of claimConflicts) {
    for (const file of conflict.sharedFiles)
      pathCounts.set(file, (pathCounts.get(file) ?? 0) + 1);
    for (const packageName of conflict.sharedPackages)
      packageCounts.set(packageName, (packageCounts.get(packageName) ?? 0) + 1);
  }

  for (const overlap of workItemOverlaps.filter(
    (workItem) => !workItem.ownerMatches,
  )) {
    for (const file of overlap.sharedFiles)
      pathCounts.set(file, (pathCounts.get(file) ?? 0) + 1);
    for (const packageName of overlap.sharedPackages)
      packageCounts.set(packageName, (packageCounts.get(packageName) ?? 0) + 1);
  }

  return {
    paths: hotEntries(pathCounts, limits.hotPathThreshold, "path"),
    packages: hotEntries(packageCounts, limits.hotPackageThreshold, "package"),
  };
}

function decisionFor({
  proposed,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  hotspots,
  limits,
  requireAgentBranchNamespace,
  agentBranchNamespacePrefix,
}) {
  const blockers = [];
  const warnings = [];
  const requiredActions = [];
  const expectedBranchNamespace = agentBranchNamespaceFor({
    ownerAgentId: proposed.ownerAgentId,
    prefix: agentBranchNamespacePrefix,
  });

  if (
    !proposed.repo ||
    (proposed.changedFiles.length === 0 &&
      proposed.affectedPackages.length === 0)
  ) {
    blockers.push("missing_work_scope");
    requiredActions.push("provide_repo_and_changed_files_or_packages");
  }

  if (
    requireAgentBranchNamespace === true &&
    !agentBranchMatchesNamespace({
      branch: proposed.sourceBranch,
      ownerAgentId: proposed.ownerAgentId,
      prefix: agentBranchNamespacePrefix,
    })
  ) {
    blockers.push("agent_branch_namespace");
    requiredActions.push(
      proposed.sourceBranch
        ? "rename_branch_to_agent_namespace"
        : "create_branch_in_agent_namespace",
    );
  }

  const foreignClaimConflicts = claimConflicts.filter(
    (claim) => !claim.ownerMatches,
  );
  const foreignWorkItemOverlaps = workItemOverlaps.filter(
    (workItem) => !workItem.ownerMatches,
  );
  const blockingWorkItemOverlaps = foreignWorkItemOverlaps.filter(
    (workItem) => workItem.blocking,
  );
  const warningWorkItemOverlaps = foreignWorkItemOverlaps.filter(
    (workItem) => !workItem.blocking,
  );
  const fileQueueOverlaps = queueOverlaps.filter(
    (overlap) => overlap.sharedFiles.length > 0,
  );
  const packageQueueOverlaps = queueOverlaps.filter(
    (overlap) =>
      overlap.sharedFiles.length === 0 && overlap.sharedPackages.length > 0,
  );

  if (foreignClaimConflicts.length > 0) {
    blockers.push("active_claim_conflict");
    requiredActions.push("coordinate_with_claim_owner");
  }

  if (fileQueueOverlaps.length > 0) {
    blockers.push("overlapping_open_prs");
    requiredActions.push("coordinate_overlapping_prs");
  }

  if (blockingWorkItemOverlaps.length > 0) {
    blockers.push("active_work_item_conflict");
    requiredActions.push("coordinate_with_work_item_owner");
  }

  if (packageQueueOverlaps.length > 0) {
    warnings.push("package_overlap");
    requiredActions.push("review_package_overlap");
  }

  if (warningWorkItemOverlaps.length > 0) {
    warnings.push("work_item_overlap");
    requiredActions.push("review_work_item_overlap");
  }

  if (packageQueueOverlaps.length > limits.maxPackageOverlapWarnings) {
    blockers.push("too_many_package_overlaps");
    requiredActions.push("split_or_wait_for_package_lane");
  }

  if (hotspots.paths.length > 0 || hotspots.packages.length > 0) {
    warnings.push("hot_work_area");
    requiredActions.push("claim_or_coordinate_hot_work_area");
  }

  const allowed = blockers.length === 0;
  return {
    allowed,
    state: allowed ? (warnings.length > 0 ? "watch" : "ready") : "blocked",
    reason: reasonFor({ blockers, warnings }),
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
    requiredActions: uniqueStrings(requiredActions),
    branchNamespace: {
      required: requireAgentBranchNamespace === true,
      sourceBranch: proposed.sourceBranch,
      expectedNamespace: expectedBranchNamespace,
      prefix: agentBranchNamespacePrefix,
    },
  };
}

function suggestedClaimsFor({ proposed, limit }) {
  const suggestions = [];
  for (const file of proposed.changedFiles) {
    suggestions.push({
      resourceKind: "path",
      resourceId: file,
      reason: "Claim changed file before starting parallel agent work.",
    });
    if (suggestions.length >= limit) return suggestions;
  }
  for (const packageName of proposed.affectedPackages) {
    suggestions.push({
      resourceKind: "package",
      resourceId: packageName,
      reason: "Claim touched package when file-level claims are too granular.",
    });
    if (suggestions.length >= limit) return suggestions;
  }
  return suggestions;
}

function buildSplitPlan({
  proposed,
  decision,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  hotspots,
  limits,
}) {
  const reasons = splitRecommendationReasons({
    proposed,
    decision,
    queueOverlaps,
    claimConflicts,
    workItemOverlaps,
    hotspots,
    limits,
  });
  const scopeGroups = splitScopeGroups({ proposed, limits });
  const units = scopeGroups.map((group, index) =>
    splitUnitFor({
      proposed,
      decision,
      group,
      index,
      queueOverlaps,
      claimConflicts,
      workItemOverlaps,
      hotspots,
      limits,
    }),
  );
  const blockedUnits = units.filter((unit) => unit.state === "blocked").length;
  const watchUnits = units.filter((unit) => unit.state === "watch").length;
  const readyUnits = units.filter((unit) => unit.state === "ready").length;
  const recommended = reasons.length > 0;

  return {
    recommended,
    strategy: recommended ? splitStrategyFor({ reasons, units }) : "single_pr",
    reasons,
    summary: {
      proposedFiles: proposed.changedFiles.length,
      proposedPackages: proposed.affectedPackages.length,
      estimatedPrs: units.length,
      readyUnits,
      watchUnits,
      blockedUnits,
      hotPaths: hotspots.paths.length,
      hotPackages: hotspots.packages.length,
    },
    units,
    nextActions: splitNextActions({ recommended, units, decision }),
  };
}

function splitRecommendationReasons({
  proposed,
  decision,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  hotspots,
  limits,
}) {
  const reasons = [];
  if (decision.blockers.includes("missing_work_scope")) return reasons;
  if (claimConflicts.some((claim) => !claim.ownerMatches))
    reasons.push("active_claim_conflict");
  if (workItemOverlaps.some((workItem) => workItem.blocking === true))
    reasons.push("active_work_item_conflict");
  if (queueOverlaps.some((overlap) => overlap.sharedFiles.length > 0))
    reasons.push("overlapping_open_prs");
  if (decision.blockers.includes("too_many_package_overlaps"))
    reasons.push("too_many_package_overlaps");
  if (
    proposed.changedFiles.length >
    positiveInteger(
      limits.maxFilesBeforeSplitRecommendation,
      DEFAULT_WORK_PREFLIGHT_LIMITS.maxFilesBeforeSplitRecommendation,
    )
  ) {
    reasons.push("large_file_scope");
  }
  if (
    proposed.affectedPackages.length >
    positiveInteger(
      limits.maxPackagesBeforeSplitRecommendation,
      DEFAULT_WORK_PREFLIGHT_LIMITS.maxPackagesBeforeSplitRecommendation,
    )
  ) {
    reasons.push("large_package_scope");
  }
  if (hotspots.paths.length > 0 || hotspots.packages.length > 0)
    reasons.push("hot_work_area");
  return uniqueStrings(reasons);
}

function splitStrategyFor({ reasons, units }) {
  if (
    reasons.includes("active_claim_conflict") ||
    reasons.includes("active_work_item_conflict") ||
    reasons.includes("overlapping_open_prs")
  ) {
    return "split_conflicted_work_from_ready_lanes";
  }
  if (
    reasons.includes("too_many_package_overlaps") ||
    reasons.includes("large_package_scope")
  ) {
    return "split_by_package_lane";
  }
  if (reasons.includes("large_file_scope")) return "split_large_scope";
  if (units.some((unit) => unit.state !== "ready"))
    return "split_hot_work_from_ready_lanes";
  return "single_pr";
}

function splitScopeGroups({ proposed, limits }) {
  if (
    proposed.changedFiles.length === 0 &&
    proposed.affectedPackages.length === 0
  )
    return [];

  const maxFilesPerSplit = positiveInteger(
    limits.maxFilesPerSplit,
    DEFAULT_WORK_PREFLIGHT_LIMITS.maxFilesPerSplit,
  );
  const maxSplitUnits = positiveInteger(
    limits.maxSplitUnits,
    DEFAULT_WORK_PREFLIGHT_LIMITS.maxSplitUnits,
  );
  const packageNames = proposed.affectedPackages;
  const packageSet = new Set(packageNames);
  const groups = new Map();

  for (const packageName of packageNames) {
    groups.set(`package:${packageName}`, {
      lane: packageName,
      files: [],
      packages: [packageName],
    });
  }

  for (const file of proposed.changedFiles) {
    const inferredPackage = packageForFile(file, packageSet);
    const key = inferredPackage
      ? `package:${inferredPackage}`
      : `path:${scopeLaneForFile(file)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        lane: inferredPackage ?? scopeLaneForFile(file),
        files: [],
        packages: inferredPackage ? [inferredPackage] : [],
      });
    }
    groups.get(key).files.push(file);
  }

  const chunked = [];
  for (const group of [...groups.values()].sort(compareScopeGroup)) {
    const files = group.files.toSorted();
    if (files.length <= maxFilesPerSplit) {
      chunked.push({ ...group, files });
      continue;
    }

    for (let index = 0; index < files.length; index += maxFilesPerSplit) {
      chunked.push({
        ...group,
        lane: `${group.lane}-part-${Math.floor(index / maxFilesPerSplit) + 1}`,
        files: files.slice(index, index + maxFilesPerSplit),
      });
    }
  }

  if (chunked.length <= maxSplitUnits) return chunked;

  const visible = chunked.slice(0, maxSplitUnits - 1);
  const overflow = chunked.slice(maxSplitUnits - 1);
  visible.push({
    lane: "remaining-scope",
    files: uniqueStrings(overflow.flatMap((group) => group.files)).toSorted(),
    packages: uniqueStrings(
      overflow.flatMap((group) => group.packages),
    ).toSorted(),
    overflow: true,
  });
  return visible;
}

function splitUnitFor({
  proposed,
  decision,
  group,
  index,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  hotspots,
  limits,
}) {
  const unitProposed = {
    ...proposed,
    changedFiles: group.files,
    affectedPackages: group.packages,
  };
  const facts = splitUnitFacts({
    group,
    queueOverlaps,
    claimConflicts,
    workItemOverlaps,
    hotspots,
  });
  const blockers = [];
  const warnings = [];
  const requiredActions = [];

  if (decision.blockers.includes("agent_branch_namespace")) {
    blockers.push("agent_branch_namespace");
    requiredActions.push(
      proposed.sourceBranch
        ? "rename_branch_to_agent_namespace"
        : "create_branch_in_agent_namespace",
    );
  }
  if (group.overflow === true) {
    warnings.push("split_plan_overflow");
    requiredActions.push("increase_split_limit_or_refine_scope");
  }
  if (facts.claimConflicts.some((claim) => !claim.ownerMatches)) {
    blockers.push("active_claim_conflict");
    requiredActions.push("coordinate_with_claim_owner");
  }
  if (facts.fileQueueOverlaps.length > 0) {
    blockers.push("overlapping_open_prs");
    requiredActions.push("coordinate_overlapping_prs");
  }
  if (facts.blockingWorkItemOverlaps.length > 0) {
    blockers.push("active_work_item_conflict");
    requiredActions.push("coordinate_with_work_item_owner");
  }
  if (facts.packageQueueOverlaps.length > 0) {
    warnings.push("package_overlap");
    requiredActions.push("review_package_overlap");
  }
  if (facts.warningWorkItemOverlaps.length > 0) {
    warnings.push("work_item_overlap");
    requiredActions.push("review_work_item_overlap");
  }
  if (facts.packageQueueOverlaps.length > limits.maxPackageOverlapWarnings) {
    blockers.push("too_many_package_overlaps");
    requiredActions.push("split_or_wait_for_package_lane");
  }
  if (facts.hotPaths.length > 0 || facts.hotPackages.length > 0) {
    warnings.push("hot_work_area");
    requiredActions.push("claim_or_coordinate_hot_work_area");
  }

  const state =
    blockers.length > 0 ? "blocked" : warnings.length > 0 ? "watch" : "ready";

  return {
    id: `split-${String(index + 1).padStart(2, "0")}-${slugFor(group.lane || "scope")}`,
    title: splitUnitTitle(group),
    state,
    reason: splitUnitReason({ state, blockers, warnings }),
    repo: proposed.repo,
    targetBranch: proposed.targetBranch,
    ownerAgentId: proposed.ownerAgentId,
    suggestedBranch: suggestedSplitBranch({ proposed, group, index, decision }),
    changedFiles: group.files,
    affectedPackages: group.packages,
    blockers: uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
    requiredActions: uniqueStrings(requiredActions),
    claims: suggestedClaimsFor({
      proposed: unitProposed,
      limit: limits.maxSuggestedClaims,
    }),
    overlaps: {
      queueItems: facts.queueOverlaps,
      claims: facts.claimConflicts,
      workItems: facts.workItemOverlaps,
    },
    hotspots: {
      paths: facts.hotPaths,
      packages: facts.hotPackages,
    },
  };
}

function splitUnitFacts({
  group,
  queueOverlaps,
  claimConflicts,
  workItemOverlaps,
  hotspots,
}) {
  const queue = queueOverlaps.filter((overlap) => {
    return (
      intersection(group.files, overlap.sharedFiles).length > 0 ||
      intersection(group.packages, overlap.sharedPackages).length > 0
    );
  });
  const claims = claimConflicts.filter((claim) => {
    return (
      intersection(group.files, claim.sharedFiles).length > 0 ||
      intersection(group.packages, claim.sharedPackages).length > 0
    );
  });
  const workItems = workItemOverlaps.filter((workItem) => {
    return (
      intersection(group.files, workItem.sharedFiles).length > 0 ||
      intersection(group.packages, workItem.sharedPackages).length > 0
    );
  });
  const foreignWorkItems = workItems.filter(
    (workItem) => !workItem.ownerMatches,
  );
  return {
    queueOverlaps: queue,
    fileQueueOverlaps: queue.filter(
      (overlap) => intersection(group.files, overlap.sharedFiles).length > 0,
    ),
    packageQueueOverlaps: queue.filter(
      (overlap) =>
        intersection(group.files, overlap.sharedFiles).length === 0 &&
        intersection(group.packages, overlap.sharedPackages).length > 0,
    ),
    claimConflicts: claims,
    workItemOverlaps: workItems,
    blockingWorkItemOverlaps: foreignWorkItems.filter(
      (workItem) => workItem.blocking === true,
    ),
    warningWorkItemOverlaps: foreignWorkItems.filter(
      (workItem) => workItem.blocking !== true,
    ),
    hotPaths: hotspots.paths.filter((entry) =>
      group.files.includes(entry.path),
    ),
    hotPackages: hotspots.packages.filter((entry) =>
      group.packages.includes(entry.package),
    ),
  };
}

function splitNextActions({ recommended, units, decision }) {
  if (decision.blockers.includes("missing_work_scope")) {
    return ["provide_repo_and_changed_files_or_packages"];
  }

  const actions = [];
  if (recommended) actions.push("open_split_prs_for_ready_units");
  if (units.some((unit) => unit.state === "blocked"))
    actions.push("coordinate_blocked_split_units");
  if (units.some((unit) => unit.state === "watch"))
    actions.push("acknowledge_watch_units_before_reservation");
  if (!recommended && units.every((unit) => unit.state === "ready"))
    actions.push("reserve_work_claims");
  return uniqueStrings(actions);
}

function splitUnitTitle(group) {
  if (group.packages.length > 0)
    return `${group.packages.join(", ")} package lane`;
  if (group.lane) return `${group.lane} path lane`;
  return "Scoped work lane";
}

function splitUnitReason({ state, blockers, warnings }) {
  if (state === "blocked" && blockers.includes("active_claim_conflict"))
    return "Another active agent claim owns part of this split.";
  if (state === "blocked" && blockers.includes("active_work_item_conflict"))
    return "Another active Work item owns part of this split.";
  if (state === "blocked" && blockers.includes("overlapping_open_prs"))
    return "Open pull requests already touch files in this split.";
  if (state === "blocked" && blockers.includes("agent_branch_namespace"))
    return "This split still needs an agent-owned branch namespace.";
  if (warnings.includes("package_overlap"))
    return "This split shares a package lane with open work.";
  if (warnings.includes("work_item_overlap"))
    return "This split shares scope with planned or package-level Work items.";
  if (warnings.includes("hot_work_area"))
    return "This split touches a hot work area.";
  if (warnings.includes("split_plan_overflow"))
    return "This split contains remaining scope after the configured split-unit limit.";
  return "This split can be reserved as focused agent work.";
}

function suggestedSplitBranch({ group, index, decision }) {
  const namespace = decision.branchNamespace.expectedNamespace;
  if (!namespace) return null;
  return `${namespace}${slugFor(group.lane || `split-${index + 1}`)}`;
}

function packageForFile(file, packageSet) {
  const parts = String(file).split("/").filter(Boolean);
  if (parts[0] === "packages" && parts[1]) {
    if (
      parts[1].startsWith("@") &&
      parts[2] &&
      packageSet.has(`${parts[1]}/${parts[2]}`)
    )
      return `${parts[1]}/${parts[2]}`;
    if (packageSet.has(parts[1])) return parts[1];
  }
  for (const packageName of packageSet) {
    if (
      String(file).includes(`/${packageName}/`) ||
      String(file).startsWith(`${packageName}/`)
    )
      return packageName;
  }
  return null;
}

function scopeLaneForFile(file) {
  const parts = String(file).split("/").filter(Boolean);
  if (parts[0] === "docs") return "docs";
  if (parts[0] === "scripts") return "scripts";
  if (parts[0] === ".github") return "github-workflows";
  return parts[0] ?? "root";
}

function compareScopeGroup(left, right) {
  const leftPackage = left.packages[0] ?? "";
  const rightPackage = right.packages[0] ?? "";
  if (leftPackage || rightPackage)
    return (
      leftPackage.localeCompare(rightPackage) ||
      left.lane.localeCompare(right.lane)
    );
  return left.lane.localeCompare(right.lane);
}

function labelsFor(decision) {
  const labels = [`work-preflight:${decision.state}`];
  if (!decision.allowed) labels.push("work-preflight:blocked");
  if (decision.allowed) labels.push("work-preflight:allowed");
  if (decision.blockers.includes("active_claim_conflict"))
    labels.push("agent:claimed-conflict");
  if (decision.blockers.includes("active_work_item_conflict"))
    labels.push("agent:work-item-conflict", "agent:duplicate-risk");
  if (decision.blockers.includes("overlapping_open_prs"))
    labels.push("agent:duplicate-risk");
  if (decision.blockers.includes("agent_branch_namespace"))
    labels.push("branch:namespace-mismatch", "agent:branch-unowned");
  if (decision.warnings.includes("work_item_overlap"))
    labels.push("agent:work-item-overlap");
  if (decision.warnings.includes("hot_work_area"))
    labels.push("agent:hot-work-area");
  return uniqueStrings(labels);
}

function reasonFor({ blockers, warnings }) {
  if (blockers.includes("missing_work_scope"))
    return "Work preflight needs a repo plus changed files or affected packages.";
  if (blockers.includes("agent_branch_namespace"))
    return "Agent work must start from the submitting agent branch namespace.";
  if (blockers.includes("active_claim_conflict"))
    return "Another active agent claim already owns part of this work.";
  if (blockers.includes("active_work_item_conflict"))
    return "Another active Work item already owns part of this work.";
  if (blockers.includes("overlapping_open_prs"))
    return "Open pull requests already touch the same files.";
  if (blockers.includes("too_many_package_overlaps"))
    return "Too many open pull requests touch the same packages.";
  if (warnings.includes("package_overlap"))
    return "Open pull requests touch the same packages.";
  if (warnings.includes("work_item_overlap"))
    return "Active or planned Work items touch the same scope.";
  if (warnings.includes("hot_work_area"))
    return "Proposed work touches a hot area.";
  return "Agent can start work with scoped claims.";
}

function hotEntries(counts, threshold, keyName) {
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([value, count]) => ({ [keyName]: value, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        String(left[keyName]).localeCompare(String(right[keyName])),
    )
    .slice(0, 10);
}

function isActiveClaim(claim, now) {
  if (claim.status !== "active") return false;
  if (!claim.expiresAt) return true;
  const expiresAt = Date.parse(claim.expiresAt);
  const checkedAt = Date.parse(now);
  return (
    Number.isNaN(expiresAt) || Number.isNaN(checkedAt) || expiresAt > checkedAt
  );
}

function queueItemId(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return item.pullRequestId != null ? String(item.pullRequestId) : null;
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringOrNull(value) {
  return value == null || value === "" ? null : String(value);
}

function severityRank(value) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[value] ?? 5;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function slugFor(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "scope";
}
