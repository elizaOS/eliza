export const DEFAULT_REVIEW_ASSIGNMENT_LIMITS = Object.freeze({
  minReviewers: 1,
  maxReviewers: 2,
  maxCandidates: 12,
});

const UNAVAILABLE_HEALTH = new Set(["overloaded", "needs-triage"]);

export function buildReviewAssignment({
  registeredAgents = [],
  claims = [],
  capacity = null,
  queueItem = null,
  proposedItem = null,
  repo,
  targetBranch,
  ownerAgentId,
  changedFiles,
  affectedPackages,
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const effectiveLimits = normalizeLimits(limits);
  const proposed = normalizeProposedReview({
    queueItem,
    proposedItem,
    repo,
    targetBranch,
    ownerAgentId,
    changedFiles,
    affectedPackages,
  });
  const activeClaims = claims
    .filter((claim) => !proposed.repo || claim.repo === proposed.repo)
    .filter((claim) => isActiveClaim(claim, now));
  const candidates = buildCandidateMap({
    registeredAgents,
    capacity,
    claims: activeClaims,
  });
  const scored = [...candidates.values()]
    .map((candidate) => scoreCandidate({ candidate, proposed }))
    .sort(compareScoredCandidates);
  const excludedCandidates = scored
    .filter((candidate) => candidate.excludedReason)
    .map(excludedCandidateSummary);
  const candidateReviewers = scored
    .filter((candidate) => !candidate.excludedReason)
    .slice(0, effectiveLimits.maxCandidates)
    .map((candidate, index) => reviewerSummary(candidate, index + 1));
  const suggestedReviewers = candidateReviewers
    .filter((candidate) => candidate.score > 0 && candidate.available !== false)
    .slice(0, effectiveLimits.maxReviewers);
  const humanReviewHints = humanReviewHintsFor(proposed);
  const decision = decisionFor({
    proposed,
    suggestedReviewers,
    humanReviewHints,
    limits: effectiveLimits,
  });

  return {
    computedAt: now,
    repo: proposed.repo,
    targetBranch: proposed.targetBranch,
    ownerAgentId: proposed.ownerAgentId,
    proposed,
    decision,
    suggestedOwnerAgentId:
      proposed.ownerAgentId ?? suggestedReviewers[0]?.agentId ?? null,
    suggestedReviewers,
    candidateReviewers,
    excludedCandidates,
    humanReviewHints,
    labels: labelsFor({ decision, suggestedReviewers, humanReviewHints }),
  };
}

function normalizeProposedReview({
  queueItem,
  proposedItem,
  repo,
  targetBranch,
  ownerAgentId,
  changedFiles,
  affectedPackages,
}) {
  const item = objectValue(queueItem) ?? objectValue(proposedItem) ?? {};
  const files = uniqueStrings(
    changedFiles ?? item.changedFiles ?? item.paths ?? item.impact?.paths,
  );
  const packages = uniqueStrings(
    affectedPackages ??
      item.affectedPackages ??
      item.packages ??
      item.impact?.packages,
  );
  return {
    id: item.id ?? queueItemId(item),
    repo: stringOrNull(repo ?? item.repo),
    pullRequestId: item.pullRequestId ?? item.number ?? null,
    sourceBranch: stringOrNull(item.sourceBranch),
    targetBranch: stringOrNull(targetBranch ?? item.targetBranch),
    ownerAgentId: stringOrNull(
      ownerAgentId ?? item.ownerAgentId ?? item.suggestedOwnerAgentId,
    ),
    authorKind: item.authorKind ?? null,
    title: stringOrNull(item.title ?? item.summary),
    changedFiles: files,
    affectedPackages: packages,
    fileCount: files.length,
    packageCount: packages.length,
  };
}

function buildCandidateMap({ registeredAgents, capacity, claims }) {
  const candidates = new Map();

  for (const agent of arrayValue(registeredAgents)) {
    if (!agent?.id && !agent?.agentId) continue;
    const id = String(agent.id ?? agent.agentId);
    const candidate = ensureCandidate(candidates, id);
    candidate.sources.add("identity_registry");
    candidate.registeredAgent = agent;
    candidate.status = agent.status ?? candidate.status ?? "active";
    candidate.displayName =
      agent.displayName ?? agent.display_name ?? candidate.displayName;
    candidate.metadata = metadataExpertise(agent.metadata);
  }

  for (const agent of arrayValue(capacity?.agents)) {
    if (!agent?.agentId) continue;
    const candidate = ensureCandidate(candidates, agent.agentId);
    candidate.sources.add("capacity");
    candidate.capacity = agent;
  }

  for (const claim of claims) {
    if (!claim?.ownerAgentId) continue;
    const candidate = ensureCandidate(candidates, claim.ownerAgentId);
    candidate.sources.add("active_claim");
    candidate.claims.push(claim);
  }

  return candidates;
}

function ensureCandidate(candidates, agentId) {
  const id = String(agentId);
  if (!candidates.has(id)) {
    candidates.set(id, {
      agentId: id,
      displayName: null,
      status: "active",
      sources: new Set(),
      metadata: { paths: [], packages: [] },
      registeredAgent: null,
      capacity: null,
      claims: [],
    });
  }
  return candidates.get(id);
}

function scoreCandidate({ candidate, proposed }) {
  const capacityExpertise = {
    paths: uniqueStrings(candidate.capacity?.expertise?.paths),
    packages: uniqueStrings(candidate.capacity?.expertise?.packages),
  };
  const claimExpertise = claimExpertiseFor(candidate.claims);
  const metadataPathMatches = matchingPaths(
    proposed.changedFiles,
    candidate.metadata.paths,
  );
  const metadataPackageMatches = intersection(
    proposed.affectedPackages,
    candidate.metadata.packages,
  );
  const capacityPathMatches = matchingPaths(
    proposed.changedFiles,
    capacityExpertise.paths,
  );
  const capacityPackageMatches = intersection(
    proposed.affectedPackages,
    capacityExpertise.packages,
  );
  const claimPathMatches = matchingPaths(
    proposed.changedFiles,
    claimExpertise.paths,
  );
  const claimPackageMatches = intersection(
    proposed.affectedPackages,
    claimExpertise.packages,
  );
  const health = candidate.capacity?.health ?? null;
  const availableSlots = integerOrZero(candidate.capacity?.availableSlots);
  const workloadScore = integerOrZero(candidate.capacity?.workloadScore);
  const performanceHealth = candidate.capacity?.performance?.health ?? null;
  const authorCandidate = Boolean(
    proposed.ownerAgentId && candidate.agentId === proposed.ownerAgentId,
  );
  const disabledCandidate = candidate.status === "disabled";
  const unavailableHealth = UNAVAILABLE_HEALTH.has(health);

  let score = 10;
  score += metadataPackageMatches.length * 45;
  score += metadataPathMatches.length * 35;
  score += capacityPackageMatches.length * 25;
  score += capacityPathMatches.length * 18;
  score += claimPackageMatches.length * 22;
  score += claimPathMatches.length * 20;
  score += Math.min(availableSlots, 3) * 4;
  score -= workloadScore * 2;
  score += healthScore(health);
  score += performanceScore(candidate.capacity?.performance);
  if (candidate.sources.has("identity_registry")) score += 4;
  if (authorCandidate) score -= 100;
  if (disabledCandidate) score -= 100;
  if (unavailableHealth) score -= 30;

  return {
    agentId: candidate.agentId,
    displayName:
      candidate.displayName ?? candidate.registeredAgent?.displayName ?? null,
    status: candidate.status,
    sources: [...candidate.sources].sort(),
    score: Number(score.toFixed(2)),
    health,
    availableSlots,
    workloadScore,
    performanceHealth,
    canTakeNewWork: candidate.capacity?.canTakeNewWork ?? null,
    matches: {
      declaredPaths: metadataPathMatches,
      declaredPackages: metadataPackageMatches,
      capacityPaths: capacityPathMatches,
      capacityPackages: capacityPackageMatches,
      claimedPaths: claimPathMatches,
      claimedPackages: claimPackageMatches,
    },
    reasons: reasonsFor({
      metadataPathMatches,
      metadataPackageMatches,
      capacityPathMatches,
      capacityPackageMatches,
      claimPathMatches,
      claimPackageMatches,
      health,
      availableSlots,
      workloadScore,
      performanceHealth,
    }),
    excludedReason: disabledCandidate
      ? "agent_disabled"
      : authorCandidate
        ? "author_agent"
        : unavailableHealth
          ? `agent_${health}`
          : null,
  };
}

function metadataExpertise(metadata) {
  const value = objectValue(metadata) ?? {};
  const review = objectValue(value.review) ?? {};
  const expertise = objectValue(value.expertise) ?? {};
  return {
    paths: uniqueStrings([
      ...arrayValue(value.reviewPaths),
      ...arrayValue(value.review_paths),
      ...arrayValue(value.pathGlobs),
      ...arrayValue(value.path_globs),
      ...arrayValue(review.paths),
      ...arrayValue(review.pathGlobs),
      ...arrayValue(expertise.paths),
      ...arrayValue(value.paths),
    ]),
    packages: uniqueStrings([
      ...arrayValue(value.reviewPackages),
      ...arrayValue(value.review_packages),
      ...arrayValue(review.packages),
      ...arrayValue(expertise.packages),
      ...arrayValue(value.packages),
    ]),
  };
}

function claimExpertiseFor(claims) {
  return {
    paths: uniqueStrings(claims.flatMap(claimFiles)),
    packages: uniqueStrings(claims.flatMap(claimPackages)),
  };
}

function decisionFor({
  proposed,
  suggestedReviewers,
  humanReviewHints,
  limits,
}) {
  const blockers = [];
  const warnings = [];
  const requiredActions = [];

  if (
    !proposed.repo ||
    (proposed.changedFiles.length === 0 &&
      proposed.affectedPackages.length === 0)
  ) {
    blockers.push("missing_review_scope");
    requiredActions.push("provide_repo_and_changed_files_or_packages");
  }
  if (suggestedReviewers.length < limits.minReviewers) {
    blockers.push("no_reviewers_available");
    requiredActions.push("register_or_assign_path_owner_agent");
  }
  if (suggestedReviewers.length > 0)
    requiredActions.push("assign_suggested_reviewers");
  if (humanReviewHints.length > 0) {
    warnings.push("human_maintainer_review_recommended");
    requiredActions.push(
      ...humanReviewHints.flatMap((hint) => hint.requiredActions),
    );
  }

  const uniqueBlockers = uniqueStrings(blockers);
  const uniqueWarnings = uniqueStrings(warnings);
  const state =
    uniqueBlockers.length > 0
      ? "needs_reviewers"
      : humanReviewHints.length > 0
        ? "needs_human_review"
        : "ready";

  return {
    state,
    assignmentReady: uniqueBlockers.length === 0,
    reviewRequired: humanReviewHints.length > 0,
    reason: reasonFor({
      blockers: uniqueBlockers,
      humanReviewHints,
      suggestedReviewers,
    }),
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    requiredActions: uniqueStrings(requiredActions),
    minimumReviewers: limits.minReviewers,
    suggestedReviewerCount: suggestedReviewers.length,
  };
}

function reviewerSummary(candidate, rank) {
  return {
    rank,
    agentId: candidate.agentId,
    displayName: candidate.displayName,
    score: candidate.score,
    available: candidate.excludedReason
      ? false
      : candidate.canTakeNewWork !== false,
    health: candidate.health,
    availableSlots: candidate.availableSlots,
    workloadScore: candidate.workloadScore,
    performanceHealth: candidate.performanceHealth,
    sources: candidate.sources,
    matches: candidate.matches,
    reasons: candidate.reasons,
  };
}

function excludedCandidateSummary(candidate) {
  return {
    agentId: candidate.agentId,
    displayName: candidate.displayName,
    reason: candidate.excludedReason,
    health: candidate.health,
    score: candidate.score,
  };
}

function reasonsFor({
  metadataPathMatches,
  metadataPackageMatches,
  capacityPathMatches,
  capacityPackageMatches,
  claimPathMatches,
  claimPackageMatches,
  health,
  availableSlots,
  workloadScore,
  performanceHealth,
}) {
  const reasons = [];
  if (metadataPackageMatches.length > 0)
    reasons.push(
      `declared package owner: ${metadataPackageMatches.slice(0, 3).join(", ")}`,
    );
  if (metadataPathMatches.length > 0)
    reasons.push(
      `declared path owner: ${metadataPathMatches.slice(0, 3).join(", ")}`,
    );
  if (capacityPackageMatches.length > 0)
    reasons.push(
      `recent package expertise: ${capacityPackageMatches.slice(0, 3).join(", ")}`,
    );
  if (capacityPathMatches.length > 0)
    reasons.push(
      `recent path expertise: ${capacityPathMatches.slice(0, 3).join(", ")}`,
    );
  if (claimPackageMatches.length > 0)
    reasons.push(
      `active package claim: ${claimPackageMatches.slice(0, 3).join(", ")}`,
    );
  if (claimPathMatches.length > 0)
    reasons.push(
      `active path claim: ${claimPathMatches.slice(0, 3).join(", ")}`,
    );
  if (health) reasons.push(`health ${health}`);
  if (Number.isFinite(availableSlots))
    reasons.push(
      `${availableSlots} open slot${availableSlots === 1 ? "" : "s"}`,
    );
  reasons.push(`workload score ${workloadScore}`);
  if (performanceHealth) reasons.push(`performance ${performanceHealth}`);
  return uniqueStrings(reasons);
}

function humanReviewHintsFor(proposed) {
  const hints = [];
  const workflowPaths = proposed.changedFiles.filter(isWorkflowPath);
  const migrationPaths = proposed.changedFiles.filter(isMigrationPath);
  const securityPaths = proposed.changedFiles.filter(
    (file) => isEnvPath(file) || isSensitivePath(file),
  );

  if (workflowPaths.length > 0) {
    hints.push(
      humanHint({
        id: "maintainer:ci",
        kind: "workflow",
        paths: workflowPaths,
        reason: "Changes CI or automation behavior.",
        requiredActions: ["request_ci_maintainer_review"],
      }),
    );
  }
  if (migrationPaths.length > 0) {
    hints.push(
      humanHint({
        id: "maintainer:database",
        kind: "database_migration",
        paths: migrationPaths,
        reason: "Changes database migration state.",
        requiredActions: ["request_database_maintainer_review"],
      }),
    );
  }
  if (securityPaths.length > 0) {
    hints.push(
      humanHint({
        id: "maintainer:security",
        kind: "security_sensitive",
        paths: securityPaths,
        reason:
          "Touches environment, secrets, auth, or security-sensitive configuration.",
        requiredActions: ["request_security_maintainer_review"],
      }),
    );
  }

  return hints.sort((left, right) => left.id.localeCompare(right.id));
}

function humanHint({ id, kind, paths, reason, requiredActions }) {
  return {
    id,
    kind,
    paths: uniqueStrings(paths).slice(0, 8),
    reason,
    requiredActions,
  };
}

function labelsFor({ decision, suggestedReviewers, humanReviewHints }) {
  const labels = [`review-assignment:${decision.state}`];
  labels.push(
    decision.assignmentReady ? "reviewers:assigned" : "reviewers:needed",
  );
  if (suggestedReviewers.length > 0) labels.push("agent:review-route");
  if (humanReviewHints.length > 0) labels.push("needs-human");
  return uniqueStrings(labels);
}

function reasonFor({ blockers, humanReviewHints, suggestedReviewers }) {
  if (blockers.includes("missing_review_scope"))
    return "Review assignment needs a repo plus changed files or affected packages.";
  if (blockers.includes("no_reviewers_available"))
    return "No eligible non-author reviewer agent matched this change.";
  if (humanReviewHints.length > 0)
    return "Reviewer agents are assigned, with human maintainer review recommended for sensitive paths.";
  if (suggestedReviewers.length > 0)
    return "Reviewer agents are assigned from path, package, claim, and capacity evidence.";
  return "No review assignment needed.";
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

function matchingPaths(files, patterns) {
  return uniqueStrings(
    files.filter((file) =>
      patterns.some((pattern) => pathMatches(pattern, file)),
    ),
  );
}

function pathMatches(pattern, file) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedFile = normalizePath(file);
  if (!normalizedPattern || !normalizedFile) return false;
  if (normalizedPattern === normalizedFile) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!(normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`)))
      return false;
    return (
      normalizedFile
        .slice(prefix.length + 1)
        .split("/")
        .filter(Boolean).length <= 1
    );
  }
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.split("*").map(escapeRegExp).join(".*");
    return new RegExp(`^${escaped}$`).test(normalizedFile);
  }
  return (
    normalizedFile.startsWith(`${normalizedPattern}/`) ||
    normalizedPattern.startsWith(`${normalizedFile}/`)
  );
}

function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function compareScoredCandidates(left, right) {
  return right.score - left.score || left.agentId.localeCompare(right.agentId);
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function isWorkflowPath(file) {
  return (
    file.startsWith(".github/workflows/") ||
    file.startsWith(".forgejo/workflows/")
  );
}

function isMigrationPath(file) {
  return file.includes("/migrations/");
}

function isEnvPath(file) {
  return /(^|\/)\.env/.test(file);
}

function isSensitivePath(file) {
  return (
    /(^|\/)(auth|security|secrets?)(\/|$)/i.test(file) ||
    /secret|token|credential/i.test(file)
  );
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

function healthScore(health) {
  return (
    {
      idle: 6,
      available: 4,
      busy: -8,
      overloaded: -18,
      "needs-triage": -22,
    }[health] ?? 0
  );
}

function performanceScore(performance) {
  if (!performance) return 0;
  const rates = objectValue(performance.rates) ?? {};
  return (
    performanceHealthScore(performance.health) +
    nullableNumber(rates.successRate) * 8 -
    nullableNumber(rates.failureRate) * 12 -
    nullableNumber(rates.staleClaimRatio) * 8 -
    integerOrZero(performance.riskScore) * 1.5
  );
}

function performanceHealthScore(health) {
  return (
    {
      healthy: 5,
      idle: 2,
      watch: -4,
      overloaded: -18,
      "needs-triage": -24,
    }[health] ?? 0
  );
}

function normalizeLimits(limits) {
  const value = objectValue(limits) ?? {};
  const maxReviewers = positiveInteger(
    value.maxReviewers,
    DEFAULT_REVIEW_ASSIGNMENT_LIMITS.maxReviewers,
  );
  return {
    minReviewers: Math.min(
      maxReviewers,
      positiveInteger(
        value.minReviewers,
        DEFAULT_REVIEW_ASSIGNMENT_LIMITS.minReviewers,
      ),
    ),
    maxReviewers,
    maxCandidates: positiveInteger(
      value.maxCandidates,
      DEFAULT_REVIEW_ASSIGNMENT_LIMITS.maxCandidates,
    ),
  };
}

function queueItemId(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return item.pullRequestId != null ? String(item.pullRequestId) : null;
}

function uniqueStrings(value) {
  return [
    ...new Set(
      arrayValue(value)
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ].sort();
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
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

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
