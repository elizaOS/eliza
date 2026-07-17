const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);
const RUNNING_QUEUE_STATES = new Set(["running", "building_integration"]);
const BLOCKED_QUEUE_STATES = new Set([
  "blocked_policy",
  "blocked_conflict",
  "blocked_stale",
  "quarantined",
  "waiting_for_review",
  "waiting_for_checks",
  "integration_failed",
]);

const RUNNING_RUN_STATUSES = new Set([
  "running",
  "queued",
  "in_progress",
  "recovering",
]);
const WAITING_RUN_STATUSES = new Set([
  "waiting_event",
  "waiting_approval",
  "waiting_input",
  "waiting",
]);
const FAILED_RUN_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
]);
const SUCCEEDED_RUN_STATUSES = new Set([
  "succeeded",
  "success",
  "completed",
  "passed",
  "finished",
  "continued",
]);

export function buildAgentPerformance({
  queueItems = [],
  claims = [],
  runs = [],
  now = new Date().toISOString(),
  repo,
  ownerAgentId,
  targetBranch,
  since,
} = {}) {
  const filters = normalizeFilters({ repo, ownerAgentId, targetBranch, since });
  const sinceMs = filters.since ? Date.parse(filters.since) : null;
  const scopedItems = queueItems
    .filter((item) => matchesRepo(item, filters.repo))
    .filter((item) => matchesTargetBranch(item, filters.targetBranch));
  const itemById = new Map(scopedItems.map((item) => [itemId(item), item]));
  const scopedClaims = claims
    .filter((claim) => matchesRepo(claim, filters.repo))
    .filter((claim) =>
      matchesClaimTargetBranch(claim, filters.targetBranch, itemById),
    );
  const scopedRuns = runs
    .filter((run) => matchesRepo(run, filters.repo))
    .filter((run) =>
      matchesRunTargetBranch(run, filters.targetBranch, itemById),
    );
  const agents = new Map();
  let handoffCount = 0;

  for (const item of scopedItems) {
    if (TERMINAL_QUEUE_STATES.has(normalizeStatus(item.queueState))) continue;
    const agentId = stringValue(item.ownerAgentId);
    if (!agentId || !matchesOwner(agentId, filters.ownerAgentId)) continue;
    addQueueItem(ensureAgent(agents, agentId), item);
  }

  for (const claim of scopedClaims) {
    const ownerId = stringValue(claim.ownerAgentId);
    if (
      ownerId &&
      matchesOwner(ownerId, filters.ownerAgentId) &&
      claimTouchesTelemetry(claim, { now, sinceMs })
    ) {
      addClaim(ensureAgent(agents, ownerId), claim, { now, sinceMs });
    }

    for (const handoff of claimHandoffs(claim)) {
      if (!isInWindow(handoff.transferredAt, sinceMs)) continue;
      const fromAgentId = stringValue(handoff.fromAgentId);
      const toAgentId = stringValue(handoff.toAgentId);
      const touchesFilter =
        matchesOwner(fromAgentId, filters.ownerAgentId) ||
        matchesOwner(toAgentId, filters.ownerAgentId);
      if (!touchesFilter) continue;

      handoffCount += 1;
      if (fromAgentId && matchesOwner(fromAgentId, filters.ownerAgentId)) {
        addHandoff(ensureAgent(agents, fromAgentId), handoff, "out");
      }
      if (toAgentId && matchesOwner(toAgentId, filters.ownerAgentId)) {
        addHandoff(ensureAgent(agents, toAgentId), handoff, "in");
      }
    }
  }

  for (const run of scopedRuns) {
    if (run.ownerKind && run.ownerKind !== "agent") continue;
    const agentId = stringValue(run.ownerId);
    if (!agentId || !matchesOwner(agentId, filters.ownerAgentId)) continue;
    addRun(ensureAgent(agents, agentId), run, { sinceMs });
  }

  const agentSummaries = [...agents.values()]
    .map(finalizeAgent)
    .sort(compareAgents);

  return {
    computedAt: now,
    filters,
    counts: {
      agents: agentSummaries.length,
      queueItems: sum(agentSummaries, "ownedQueueItems"),
      readyQueueItems: sum(agentSummaries, "readyQueueItems"),
      blockedQueueItems: sum(agentSummaries, "blockedQueueItems"),
      runningQueueItems: sum(agentSummaries, "runningQueueItems"),
      activeClaims: sum(agentSummaries, "activeClaims"),
      staleClaims: sum(agentSummaries, "staleClaims"),
      releasedClaims: sum(agentSummaries, "releasedClaims"),
      activeRuns: sum(agentSummaries, "activeRuns"),
      waitingRuns: sum(agentSummaries, "waitingRuns"),
      succeededRuns: sum(agentSummaries, "succeededRuns"),
      failedRuns: sum(agentSummaries, "failedRuns"),
      claimed: sum(agentSummaries, "claimed"),
      transferredIn: sum(agentSummaries, "transferredIn"),
      transferredOut: sum(agentSummaries, "transferredOut"),
      handoffs: handoffCount,
      idle: agentSummaries.filter((agent) => agent.health === "idle").length,
      healthy: agentSummaries.filter((agent) => agent.health === "healthy")
        .length,
      watch: agentSummaries.filter((agent) => agent.health === "watch").length,
      overloaded: agentSummaries.filter(
        (agent) => agent.health === "overloaded",
      ).length,
      needsTriage: agentSummaries.filter(
        (agent) => agent.health === "needs-triage",
      ).length,
    },
    leaders: buildLeaders(agentSummaries),
    agents: agentSummaries,
  };
}

function ensureAgent(agents, agentId) {
  const id = String(agentId);
  if (!agents.has(id)) {
    agents.set(id, {
      agentId: id,
      counts: {
        ownedQueueItems: 0,
        readyQueueItems: 0,
        blockedQueueItems: 0,
        runningQueueItems: 0,
        activeClaims: 0,
        staleClaims: 0,
        releasedClaims: 0,
        activeRuns: 0,
        waitingRuns: 0,
        succeededRuns: 0,
        failedRuns: 0,
        claimed: 0,
        transferredIn: 0,
        transferredOut: 0,
        handoffs: 0,
      },
      currentWork: [],
      claims: {
        active: [],
        stale: [],
        released: [],
      },
      runs: {
        active: [],
        waiting: [],
        failed: [],
        succeeded: [],
      },
      handoffs: [],
      lastActivityAt: null,
    });
  }
  return agents.get(id);
}

function addQueueItem(agent, item) {
  const state = normalizeStatus(item.queueState);
  const allowed = item.decision?.allowed === true;
  const blocked =
    item.decision?.allowed === false || BLOCKED_QUEUE_STATES.has(state);
  agent.counts.ownedQueueItems += 1;
  if (RUNNING_QUEUE_STATES.has(state)) agent.counts.runningQueueItems += 1;
  if (blocked) agent.counts.blockedQueueItems += 1;
  if (
    (allowed || state === "ready" || state === "queued") &&
    !RUNNING_QUEUE_STATES.has(state)
  ) {
    agent.counts.readyQueueItems += 1;
  }
  agent.currentWork.push(itemSummary(item));
  recordActivity(agent, item.updatedAt ?? item.createdAt);
}

function addClaim(agent, claim, { now, sinceMs }) {
  const status = claimStatus(claim, now);
  if (status === "stale") {
    agent.counts.staleClaims += 1;
    agent.claims.stale.push(claimSummary(claim, status));
  } else if (status === "active") {
    agent.counts.activeClaims += 1;
    agent.claims.active.push(claimSummary(claim, status));
  } else if (
    status === "released" &&
    isInWindow(claim.releasedAt ?? claim.updatedAt, sinceMs)
  ) {
    agent.counts.releasedClaims += 1;
    agent.claims.released.push(claimSummary(claim, status));
  }

  if (isInWindow(claim.claimedAt ?? claim.createdAt, sinceMs)) {
    agent.counts.claimed += 1;
  }
  recordActivity(
    agent,
    claim.updatedAt ??
      claim.releasedAt ??
      claim.renewedAt ??
      claim.claimedAt ??
      claim.createdAt,
  );
}

function addHandoff(agent, handoff, direction) {
  if (direction === "in") agent.counts.transferredIn += 1;
  if (direction === "out") agent.counts.transferredOut += 1;
  agent.counts.handoffs += 1;
  agent.handoffs.push({
    fromAgentId: stringValue(handoff.fromAgentId),
    toAgentId: stringValue(handoff.toAgentId),
    reason: handoff.reason ?? null,
    transferredAt: handoff.transferredAt ?? null,
    direction,
  });
  recordActivity(agent, handoff.transferredAt);
}

function addRun(agent, run, { sinceMs }) {
  const status = normalizeStatus(run.status);
  const summary = runSummary(run);
  if (RUNNING_RUN_STATUSES.has(status)) {
    agent.counts.activeRuns += 1;
    agent.runs.active.push(summary);
  } else if (WAITING_RUN_STATUSES.has(status)) {
    agent.counts.waitingRuns += 1;
    agent.runs.waiting.push(summary);
  } else if (FAILED_RUN_STATUSES.has(status)) {
    if (!isInWindow(run.finishedAt ?? run.updatedAt ?? run.createdAt, sinceMs))
      return;
    agent.counts.failedRuns += 1;
    agent.runs.failed.push(summary);
  } else if (SUCCEEDED_RUN_STATUSES.has(status)) {
    if (!isInWindow(run.finishedAt ?? run.updatedAt ?? run.createdAt, sinceMs))
      return;
    agent.counts.succeededRuns += 1;
    agent.runs.succeeded.push(summary);
  } else if (!isInWindow(run.updatedAt ?? run.createdAt, sinceMs)) {
    return;
  }
  recordActivity(agent, run.finishedAt ?? run.updatedAt ?? run.createdAt);
}

function finalizeAgent(agent) {
  const totalRuns = agent.counts.succeededRuns + agent.counts.failedRuns;
  const totalClaims = agent.counts.activeClaims + agent.counts.staleClaims;
  const successRate =
    totalRuns > 0 ? round(agent.counts.succeededRuns / totalRuns) : null;
  const failureRate =
    totalRuns > 0 ? round(agent.counts.failedRuns / totalRuns) : null;
  const staleClaimRatio =
    totalClaims > 0 ? round(agent.counts.staleClaims / totalClaims) : 0;
  const handoffRatio = round(
    agent.counts.handoffs /
      Math.max(1, agent.counts.claimed + agent.counts.transferredIn),
  );
  const loadScore = loadScoreFor(agent.counts);
  const riskScore = riskScoreFor(agent.counts, { handoffRatio });
  const riskSignals = riskSignalsFor(agent.counts, { handoffRatio });
  const health = healthFor({ counts: agent.counts, loadScore, riskSignals });

  return {
    agentId: agent.agentId,
    health,
    loadScore,
    riskScore,
    activityScore: activityScoreFor(agent.counts),
    lastActivityAt: agent.lastActivityAt,
    counts: agent.counts,
    rates: {
      successRate,
      failureRate,
      staleClaimRatio,
      handoffRatio,
    },
    riskSignals,
    currentWork: agent.currentWork.sort(compareWork).slice(0, 10),
    claims: {
      active: agent.claims.active.sort(compareClaims).slice(0, 10),
      stale: agent.claims.stale.sort(compareClaims).slice(0, 10),
      released: agent.claims.released.sort(compareClaims).slice(0, 10),
    },
    runs: {
      active: agent.runs.active.sort(compareRuns).slice(0, 10),
      waiting: agent.runs.waiting.sort(compareRuns).slice(0, 10),
      failed: agent.runs.failed.sort(compareRuns).slice(0, 10),
      succeeded: agent.runs.succeeded.sort(compareRuns).slice(0, 10),
    },
    handoffs: agent.handoffs.sort(compareHandoffs).slice(0, 10),
  };
}

function healthFor({ counts, loadScore, riskSignals }) {
  if (loadScore === 0 && activityScoreFor(counts) === 0) return "idle";
  if (
    riskSignals.includes("stale_claims") ||
    riskSignals.includes("failed_runs")
  )
    return "needs-triage";
  if (riskSignals.includes("high_load")) return "overloaded";
  if (riskSignals.length > 0) return "watch";
  return "healthy";
}

function riskSignalsFor(counts, { handoffRatio }) {
  const signals = [];
  if (counts.failedRuns > 0) signals.push("failed_runs");
  if (counts.staleClaims > 0) signals.push("stale_claims");
  if (counts.blockedQueueItems > 0) signals.push("blocked_queue");
  if (counts.waitingRuns > 0) signals.push("waiting_runs");
  if (
    counts.ownedQueueItems >= 6 ||
    counts.activeClaims + counts.activeRuns + counts.runningQueueItems >= 4
  )
    signals.push("high_load");
  if (counts.handoffs >= 3 || handoffRatio >= 1.5) signals.push("high_handoff");
  return signals;
}

function loadScoreFor(counts) {
  return (
    counts.ownedQueueItems +
    counts.readyQueueItems +
    counts.blockedQueueItems * 2 +
    counts.runningQueueItems * 3 +
    counts.activeClaims * 2 +
    counts.staleClaims * 3 +
    counts.activeRuns * 2 +
    counts.waitingRuns
  );
}

function riskScoreFor(counts, { handoffRatio }) {
  return (
    counts.failedRuns * 4 +
    counts.staleClaims * 4 +
    counts.blockedQueueItems * 2 +
    counts.waitingRuns +
    counts.runningQueueItems +
    (handoffRatio >= 1.5 ? 2 : 0) +
    (counts.ownedQueueItems >= 6 ? 2 : 0)
  );
}

function activityScoreFor(counts) {
  return (
    counts.ownedQueueItems +
    counts.claimed +
    counts.releasedClaims +
    counts.transferredIn +
    counts.transferredOut +
    counts.activeRuns +
    counts.waitingRuns +
    counts.succeededRuns +
    counts.failedRuns
  );
}

function buildLeaders(agents) {
  const withTerminalRuns = agents.filter(
    (agent) => agent.counts.succeededRuns + agent.counts.failedRuns > 0,
  );
  return {
    highestSuccessRate: withTerminalRuns
      .toSorted((left, right) => {
        return (
          (right.rates.successRate ?? 0) - (left.rates.successRate ?? 0) ||
          right.counts.succeededRuns - left.counts.succeededRuns ||
          left.agentId.localeCompare(right.agentId)
        );
      })
      .slice(0, 5)
      .map(leaderSummary),
    busiest: agents
      .toSorted((left, right) => {
        return (
          right.activityScore - left.activityScore ||
          right.loadScore - left.loadScore ||
          left.agentId.localeCompare(right.agentId)
        );
      })
      .slice(0, 5)
      .map(leaderSummary),
    mostHandoffs: agents
      .filter((agent) => agent.counts.handoffs > 0)
      .toSorted(
        (left, right) =>
          right.counts.handoffs - left.counts.handoffs ||
          left.agentId.localeCompare(right.agentId),
      )
      .slice(0, 5)
      .map(leaderSummary),
    staleClaimOwners: agents
      .filter((agent) => agent.counts.staleClaims > 0)
      .toSorted(
        (left, right) =>
          right.counts.staleClaims - left.counts.staleClaims ||
          left.agentId.localeCompare(right.agentId),
      )
      .slice(0, 5)
      .map(leaderSummary),
  };
}

function leaderSummary(agent) {
  return {
    agentId: agent.agentId,
    health: agent.health,
    loadScore: agent.loadScore,
    riskScore: agent.riskScore,
    activityScore: agent.activityScore,
    counts: {
      activeClaims: agent.counts.activeClaims,
      staleClaims: agent.counts.staleClaims,
      failedRuns: agent.counts.failedRuns,
      succeededRuns: agent.counts.succeededRuns,
      handoffs: agent.counts.handoffs,
    },
    rates: agent.rates,
  };
}

function itemSummary(item) {
  return {
    id: itemId(item),
    repo: item.repo ?? null,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    queueState: item.queueState ?? null,
    priority: numberOrZero(item.priority),
    summary: item.summary ?? null,
  };
}

function claimSummary(claim, status) {
  return {
    id: claim.id ?? null,
    repo: claim.repo ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    status,
    claimedAt: claim.claimedAt ?? null,
    releasedAt: claim.releasedAt ?? null,
    expiresAt: claim.expiresAt ?? null,
    paths: arrayValue(claim.paths),
  };
}

function runSummary(run) {
  return {
    id: run.id ?? null,
    queueItemId: run.queueItemId ?? null,
    repo: run.repo ?? null,
    pullRequestId: run.pullRequestId ?? null,
    targetBranch: run.targetBranch ?? null,
    status: run.status ?? null,
    updatedAt: run.updatedAt ?? run.createdAt ?? null,
    finishedAt: run.finishedAt ?? null,
  };
}

function claimStatus(claim, now) {
  const status = normalizeStatus(claim.status);
  if (status === "active" && isExpired(claim.expiresAt, now)) return "stale";
  return status || "unknown";
}

function claimTouchesTelemetry(claim, { now, sinceMs }) {
  const status = claimStatus(claim, now);
  if (status === "active" || status === "stale") return true;
  if (isInWindow(claim.claimedAt ?? claim.createdAt, sinceMs)) return true;
  return isInWindow(claim.releasedAt ?? claim.updatedAt, sinceMs);
}

function claimHandoffs(claim) {
  return arrayValue(objectValue(claim.metadata).handoffs)
    .map((handoff) => objectValue(handoff))
    .filter((handoff) => handoff.fromAgentId || handoff.toAgentId);
}

function matchesRepo(record, repo) {
  if (!repo) return true;
  if (record.repo) return record.repo === repo;
  if (record.queueItemId)
    return String(record.queueItemId).startsWith(`${repo}#`);
  return false;
}

function matchesTargetBranch(record, targetBranch) {
  if (!targetBranch) return true;
  return (
    record.targetBranch == null || String(record.targetBranch) === targetBranch
  );
}

function matchesClaimTargetBranch(claim, targetBranch, itemById) {
  if (!targetBranch) return true;
  const metadata = objectValue(claim.metadata);
  const item = itemById.get(
    stringValue(metadata.itemId) ?? stringValue(claim.queueItemId),
  );
  const claimTargetBranch =
    claim.targetBranch ?? metadata.targetBranch ?? item?.targetBranch;
  return (
    claimTargetBranch == null || String(claimTargetBranch) === targetBranch
  );
}

function matchesRunTargetBranch(run, targetBranch, itemById) {
  if (!targetBranch) return true;
  const item = itemById.get(stringValue(run.queueItemId));
  const runTargetBranch = run.targetBranch ?? item?.targetBranch;
  return runTargetBranch == null || String(runTargetBranch) === targetBranch;
}

function matchesOwner(agentId, ownerAgentId) {
  if (!agentId) return ownerAgentId == null;
  return !ownerAgentId || String(agentId) === ownerAgentId;
}

function recordActivity(agent, value) {
  const timestamp = isoTimestamp(value);
  if (!timestamp) return;
  if (
    !agent.lastActivityAt ||
    Date.parse(timestamp) > Date.parse(agent.lastActivityAt)
  ) {
    agent.lastActivityAt = timestamp;
  }
}

function isInWindow(value, sinceMs) {
  if (sinceMs == null) return true;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp >= sinceMs;
}

function isExpired(expiresAt, now) {
  return Boolean(expiresAt) && Date.parse(expiresAt) <= Date.parse(now);
}

function normalizeFilters({ repo, ownerAgentId, targetBranch, since }) {
  return {
    repo: repo ? String(repo) : null,
    ownerAgentId: ownerAgentId ? String(ownerAgentId) : null,
    targetBranch: targetBranch ? String(targetBranch) : null,
    since: isoTimestamp(since),
  };
}

function itemId(item) {
  if (item.id) return String(item.id);
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return String(item.pullRequestId ?? "");
}

function compareAgents(left, right) {
  return (
    healthRank(left.health) - healthRank(right.health) ||
    right.riskScore - left.riskScore ||
    right.loadScore - left.loadScore ||
    left.agentId.localeCompare(right.agentId)
  );
}

function compareWork(left, right) {
  return (
    right.priority - left.priority ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareClaims(left, right) {
  const leftTimestamp =
    left.claimedAt ?? left.releasedAt ?? left.expiresAt ?? "";
  const rightTimestamp =
    right.claimedAt ?? right.releasedAt ?? right.expiresAt ?? "";
  return (
    String(rightTimestamp).localeCompare(String(leftTimestamp)) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function compareRuns(left, right) {
  const leftTimestamp = left.finishedAt ?? left.updatedAt ?? "";
  const rightTimestamp = right.finishedAt ?? right.updatedAt ?? "";
  return (
    String(rightTimestamp).localeCompare(String(leftTimestamp)) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function compareHandoffs(left, right) {
  return (
    String(right.transferredAt ?? "").localeCompare(
      String(left.transferredAt ?? ""),
    ) ||
    String(left.fromAgentId ?? "").localeCompare(
      String(right.fromAgentId ?? ""),
    ) ||
    String(left.toAgentId ?? "").localeCompare(String(right.toAgentId ?? ""))
  );
}

function healthRank(health) {
  return (
    {
      "needs-triage": 0,
      overloaded: 1,
      watch: 2,
      healthy: 3,
      idle: 4,
    }[health] ?? 9
  );
}

function sum(agents, key) {
  return agents.reduce((count, agent) => count + agent.counts[key], 0);
}

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function stringValue(value) {
  return value == null ? null : String(value);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isoTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
