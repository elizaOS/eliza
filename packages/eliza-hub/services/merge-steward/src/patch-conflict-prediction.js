import { computeConflictScore } from "./policy.js";

export const DEFAULT_PATCH_CONFLICT_LIMITS = Object.freeze({
  hotPathThreshold: 2,
  hotPackageThreshold: 2,
  maxPackageOverlapWarnings: 2,
  maxReportedOverlaps: 12,
});

const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);

export function buildPatchConflictPrediction({
  queueItems = [],
  claims = [],
  proposedItem = null,
  repo,
  targetBranch,
  ownerAgentId,
  changedFiles,
  affectedPackages,
  targetCommitsBehind,
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const effectiveLimits = {
    ...DEFAULT_PATCH_CONFLICT_LIMITS,
    ...objectValue(limits),
  };
  const proposed = normalizeProposedPatch({
    proposedItem,
    repo,
    targetBranch,
    ownerAgentId,
    changedFiles,
    affectedPackages,
    targetCommitsBehind,
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
  const queueOverlaps = queueOverlapsFor({
    proposed,
    queueItems: scopedQueue,
    limit: effectiveLimits.maxReportedOverlaps,
  });
  const claimOverlaps = claimOverlapsFor({
    proposed,
    claims: activeClaims,
    limit: effectiveLimits.maxReportedOverlaps,
  });
  const overlappingFiles = uniqueStrings([
    ...queueOverlaps.flatMap((item) => item.sharedFiles),
    ...claimOverlaps.flatMap((item) => item.sharedFiles),
  ]);
  const overlappingPackages = uniqueStrings([
    ...queueOverlaps.flatMap((item) => item.sharedPackages),
    ...claimOverlaps.flatMap((item) => item.sharedPackages),
  ]);
  const policyConflict = computeConflictScore({
    repo: proposed.repo,
    pullRequestId: proposed.pullRequestId,
    changedFiles: proposed.changedFiles,
    affectedPackages: proposed.affectedPackages,
    targetCommitsBehind: proposed.targetCommitsBehind,
    overlappingFiles,
    overlappingPackages,
  });
  const hotspots = hotspotsFor({
    proposed,
    queueOverlaps,
    claimOverlaps,
    limits: effectiveLimits,
  });
  const prediction = predictionFor({
    proposed,
    policyConflict,
    queueOverlaps,
    claimOverlaps,
    hotspots,
    limits: effectiveLimits,
  });

  return {
    computedAt: now,
    repo: proposed.repo,
    targetBranch: proposed.targetBranch,
    ownerAgentId: proposed.ownerAgentId,
    proposed,
    prediction,
    conflictScore: policyConflict,
    overlaps: {
      files: overlappingFiles,
      packages: overlappingPackages,
      queueItems: queueOverlaps,
      claims: claimOverlaps,
    },
    hotspots,
    recommendedPlan: recommendedPlanFor({
      prediction,
      proposed,
      queueOverlaps,
      claimOverlaps,
      hotspots,
    }),
    labels: labelsFor(prediction),
  };
}

function normalizeProposedPatch({
  proposedItem,
  repo,
  targetBranch,
  ownerAgentId,
  changedFiles,
  affectedPackages,
  targetCommitsBehind,
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
    pullRequestId: item.pullRequestId ?? item.number ?? null,
    ownerAgentId: stringOrNull(ownerAgentId ?? item.ownerAgentId),
    changedFiles: files,
    affectedPackages: packages,
    fileCount: files.length,
    packageCount: packages.length,
    targetCommitsBehind: integerOrZero(
      targetCommitsBehind ?? item.targetCommitsBehind,
    ),
  };
}

function queueOverlapsFor({ proposed, queueItems, limit }) {
  return queueItems
    .map((item) => {
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
      const severity = sharedFiles.length > 0 ? "high" : "medium";
      return {
        id: queueItemId(item),
        repo: item.repo ?? null,
        pullRequestId: item.pullRequestId ?? null,
        ownerAgentId: item.ownerAgentId ?? null,
        authorKind: item.authorKind ?? null,
        queueState: item.queueState ?? null,
        sourceBranch: item.sourceBranch ?? null,
        targetBranch: item.targetBranch ?? null,
        sharedFiles,
        sharedPackages,
        severity,
        reason:
          severity === "high" ? "same_file_open_pr" : "same_package_open_pr",
      };
    })
    .filter(Boolean)
    .sort(compareOverlap)
    .slice(
      0,
      positiveInteger(limit, DEFAULT_PATCH_CONFLICT_LIMITS.maxReportedOverlaps),
    );
}

function claimOverlapsFor({ proposed, claims, limit }) {
  return claims
    .map((claim) => {
      const sharedFiles = intersection(
        proposed.changedFiles,
        claimFiles(claim),
      );
      const sharedPackages = intersection(
        proposed.affectedPackages,
        claimPackages(claim),
      );
      if (sharedFiles.length === 0 && sharedPackages.length === 0) return null;
      const ownerMatches = Boolean(
        proposed.ownerAgentId && claim.ownerAgentId === proposed.ownerAgentId,
      );
      const severity = ownerMatches
        ? "low"
        : sharedFiles.length > 0
          ? "critical"
          : "high";
      return {
        id: claim.id ?? null,
        ownerAgentId: claim.ownerAgentId ?? null,
        resourceKind: claim.resourceKind ?? null,
        resourceId: claim.resourceId ?? null,
        expiresAt: claim.expiresAt ?? null,
        ownerMatches,
        sharedFiles,
        sharedPackages,
        severity,
        reason: ownerMatches ? "own_active_claim" : "foreign_active_claim",
      };
    })
    .filter(Boolean)
    .sort(compareOverlap)
    .slice(
      0,
      positiveInteger(limit, DEFAULT_PATCH_CONFLICT_LIMITS.maxReportedOverlaps),
    );
}

function predictionFor({
  proposed,
  policyConflict,
  queueOverlaps,
  claimOverlaps,
  hotspots,
  limits,
}) {
  const blockers = [];
  const warnings = [];
  const requiredActions = [];
  const reasons = [...policyConflict.reasons];
  const foreignClaims = claimOverlaps.filter((claim) => !claim.ownerMatches);
  const fileQueueOverlaps = queueOverlaps.filter(
    (item) => item.sharedFiles.length > 0,
  );
  const packageQueueOverlaps = queueOverlaps.filter(
    (item) => item.sharedFiles.length === 0 && item.sharedPackages.length > 0,
  );

  if (
    !proposed.repo ||
    (proposed.changedFiles.length === 0 &&
      proposed.affectedPackages.length === 0)
  ) {
    blockers.push("missing_patch_scope");
    requiredActions.push("provide_repo_and_changed_files_or_packages");
  }
  if (foreignClaims.length > 0) {
    blockers.push("active_claim_conflict");
    requiredActions.push("coordinate_with_claim_owner");
    reasons.push("foreign_active_claim");
  }
  if (fileQueueOverlaps.length > 0) {
    blockers.push("same_file_open_pr");
    requiredActions.push("coordinate_or_split_overlapping_prs");
  }
  if (policyConflict.level === "high") {
    blockers.push("high_conflict_prediction");
    requiredActions.push("split_rebase_or_wait_before_pr");
  }
  if (packageQueueOverlaps.length > 0) {
    warnings.push("same_package_open_pr");
    requiredActions.push("review_package_lane_before_pr");
  }
  if (
    packageQueueOverlaps.length >
    positiveInteger(
      limits.maxPackageOverlapWarnings,
      DEFAULT_PATCH_CONFLICT_LIMITS.maxPackageOverlapWarnings,
    )
  ) {
    blockers.push("crowded_package_lane");
    requiredActions.push("wait_or_split_package_lane");
  }
  if (hotspots.paths.length > 0 || hotspots.packages.length > 0) {
    warnings.push("hot_conflict_zone");
    requiredActions.push("coordinate_hot_zone_owner");
  }
  if (policyConflict.reasons.includes("lockfile_overlap")) {
    warnings.push("lockfile_conflict_risk");
    requiredActions.push("serialize_lockfile_changes");
  }
  if (policyConflict.reasons.includes("migration_overlap")) {
    blockers.push("migration_conflict_risk");
    requiredActions.push("serialize_database_migrations");
  }

  const uniqueBlockers = uniqueStrings(blockers);
  const uniqueWarnings = uniqueStrings(warnings);
  const state =
    uniqueBlockers.length > 0
      ? "blocked"
      : uniqueWarnings.length > 0 || policyConflict.level === "medium"
        ? "watch"
        : "clear";

  return {
    state,
    level: state === "blocked" ? "high" : policyConflict.level,
    score: policyConflict.score,
    safeToStart: state !== "blocked",
    reason: reasonFor({
      blockers: uniqueBlockers,
      warnings: uniqueWarnings,
      policyConflict,
    }),
    reasons: uniqueStrings(reasons),
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    requiredActions: uniqueStrings(requiredActions),
  };
}

function hotspotsFor({ proposed, queueOverlaps, claimOverlaps, limits }) {
  const pathCounts = new Map(proposed.changedFiles.map((file) => [file, 1]));
  const packageCounts = new Map(
    proposed.affectedPackages.map((packageName) => [packageName, 1]),
  );
  for (const overlap of [...queueOverlaps, ...claimOverlaps]) {
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

function recommendedPlanFor({
  prediction,
  proposed,
  queueOverlaps,
  claimOverlaps,
  hotspots,
}) {
  if (prediction.blockers.includes("missing_patch_scope")) {
    return {
      strategy: "provide_patch_scope",
      actions: ["provide_repo_and_changed_files_or_packages"],
      splitRecommended: false,
      coordinateWith: [],
    };
  }

  const coordinateWith = uniqueStrings([
    ...queueOverlaps.map((item) => item.ownerAgentId).filter(Boolean),
    ...claimOverlaps
      .filter((claim) => !claim.ownerMatches)
      .map((claim) => claim.ownerAgentId)
      .filter(Boolean),
  ]);
  const splitRecommended =
    proposed.changedFiles.length > 1 &&
    (prediction.blockers.includes("same_file_open_pr") ||
      prediction.blockers.includes("active_claim_conflict") ||
      prediction.warnings.includes("hot_conflict_zone"));
  const strategy =
    prediction.state === "blocked"
      ? splitRecommended
        ? "coordinate_then_split_patch"
        : "coordinate_before_pr"
      : prediction.state === "watch"
        ? "open_after_coordination_ack"
        : "safe_to_open";

  return {
    strategy,
    actions: prediction.requiredActions,
    splitRecommended,
    coordinateWith,
    hotPaths: hotspots.paths.map((item) => item.path),
    hotPackages: hotspots.packages.map((item) => item.package),
  };
}

function labelsFor(prediction) {
  const labels = [
    `patch-conflict:${prediction.state}`,
    `conflict:${prediction.level}`,
  ];
  if (prediction.blockers.includes("active_claim_conflict"))
    labels.push("agent:claimed-conflict");
  if (prediction.blockers.includes("same_file_open_pr"))
    labels.push("agent:duplicate-risk");
  if (prediction.blockers.includes("migration_conflict_risk"))
    labels.push("conflict:migration");
  if (prediction.warnings.includes("same_package_open_pr"))
    labels.push("conflict:package-watch");
  if (prediction.warnings.includes("lockfile_conflict_risk"))
    labels.push("conflict:lockfile-watch");
  return uniqueStrings(labels);
}

function reasonFor({ blockers, warnings, policyConflict }) {
  if (blockers.includes("missing_patch_scope"))
    return "Patch conflict prediction needs a repo plus changed files or affected packages.";
  if (blockers.includes("active_claim_conflict"))
    return "Another active agent claim owns part of this patch.";
  if (blockers.includes("same_file_open_pr"))
    return "Open pull requests already touch the same files.";
  if (blockers.includes("migration_conflict_risk"))
    return "Database migration changes should be serialized.";
  if (blockers.includes("high_conflict_prediction"))
    return "Patch has high predicted merge conflict risk.";
  if (warnings.includes("same_package_open_pr"))
    return "Open pull requests touch the same package lane.";
  if (warnings.includes("hot_conflict_zone"))
    return "Patch touches a hot conflict zone.";
  if (policyConflict.level === "medium")
    return "Patch has medium predicted merge conflict risk.";
  return "Patch has no detected active collision.";
}

function claimFiles(claim) {
  return uniqueStrings([
    claim.resourceKind === "path" ? claim.resourceId : null,
    ...uniqueStrings(claim.paths),
  ]);
}

function claimPackages(claim) {
  return uniqueStrings([
    claim.resourceKind === "package" ? claim.resourceId : null,
    ...(claim.metadata?.packages ?? []),
  ]);
}

function compareOverlap(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 9;
}

function hotEntries(counts, threshold, keyName) {
  return [...counts.entries()]
    .filter(([, count]) => count >= positiveInteger(threshold, 2))
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
  ].sort();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function integerOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}
