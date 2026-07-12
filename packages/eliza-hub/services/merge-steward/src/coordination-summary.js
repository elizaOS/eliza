const TERMINAL_QUEUE_STATES = new Set([
  "closed",
  "merged",
  "failed",
  "cancelled",
  "integration_failed",
]);
const RUNNING_QUEUE_STATES = new Set(["running", "building_integration"]);
const BLOCKED_QUEUE_STATES = new Set([
  "waiting_for_checks",
  "waiting_for_review",
  "blocked_conflict",
  "blocked_policy",
  "blocked_stale",
  "quarantined",
]);

export function buildCoordinationSummary({
  queueItems = [],
  claims = [],
  runs = [],
  now = new Date().toISOString(),
  hotPathLimit = 10,
} = {}) {
  const activeClaims = claims.filter(
    (claim) => claim.status === "active" && !isExpired(claim.expiresAt, now),
  );
  const staleClaims = claims.filter(
    (claim) => claim.status === "active" && isExpired(claim.expiresAt, now),
  );
  const liveQueueItems = queueItems.filter(
    (item) => !TERMINAL_QUEUE_STATES.has(item.queueState),
  );

  return {
    computedAt: now,
    queue: {
      total: queueItems.length,
      live: liveQueueItems.length,
      ready: queueItems.filter(
        (item) => item.queueState === "ready" || item.queueState === "queued",
      ).length,
      running: queueItems.filter((item) =>
        RUNNING_QUEUE_STATES.has(item.queueState),
      ).length,
      blocked: queueItems.filter((item) =>
        BLOCKED_QUEUE_STATES.has(item.queueState),
      ).length,
      terminal: queueItems.filter((item) =>
        TERMINAL_QUEUE_STATES.has(item.queueState),
      ).length,
      byState: countBy(queueItems, (item) => item.queueState ?? "unknown"),
      lanes: summarizeLanes(liveQueueItems),
    },
    claims: {
      total: claims.length,
      active: activeClaims.length,
      stale: staleClaims.length,
      released: claims.filter((claim) => claim.status === "released").length,
      byOwner: countBy(
        activeClaims,
        (claim) => claim.ownerAgentId ?? "unknown",
      ),
      byResourceKind: countBy(
        claims,
        (claim) => claim.resourceKind ?? "unknown",
      ),
      staleClaims: staleClaims.map(claimSummary),
    },
    runs: {
      total: runs.length,
      running: runs.filter((run) => run.status === "running").length,
      waiting: runs.filter((run) =>
        String(run.status ?? "").startsWith("waiting_"),
      ).length,
      failed: runs.filter((run) => run.status === "failed").length,
      terminal: runs.filter(
        (run) =>
          run.status === "finished" ||
          run.status === "failed" ||
          run.status === "cancelled",
      ).length,
      byStatus: countBy(runs, (run) => run.status ?? "unknown"),
    },
    agents: summarizeAgents({ queueItems, activeClaims, staleClaims, runs }),
    hotPaths: summarizeHotPaths({
      queueItems: liveQueueItems,
      claims: activeClaims,
      limit: hotPathLimit,
    }),
    hotPackages: summarizeHotPackages({
      queueItems: liveQueueItems,
      claims: activeClaims,
      limit: hotPathLimit,
    }),
  };
}

function summarizeLanes(items) {
  const lanes = new Map();
  for (const item of items) {
    const key = `${item.repo ?? "unknown"}:${item.targetBranch ?? ""}`;
    const lane = lanes.get(key) ?? {
      repo: item.repo ?? "unknown",
      targetBranch: item.targetBranch ?? null,
      total: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      claimedBy: null,
      claimedAt: null,
      maxAttemptCount: 0,
      ownerAgentIds: [],
      currentBlocker: null,
      items: [],
    };
    lane.items.push(item);
    lane.total += 1;
    if (item.queueState === "ready" || item.queueState === "queued")
      lane.ready += 1;
    if (RUNNING_QUEUE_STATES.has(item.queueState)) lane.running += 1;
    if (BLOCKED_QUEUE_STATES.has(item.queueState)) lane.blocked += 1;
    lane.maxAttemptCount = Math.max(
      lane.maxAttemptCount,
      numberOrZero(item.attemptCount),
    );
    if (item.ownerAgentId && !lane.ownerAgentIds.includes(item.ownerAgentId)) {
      lane.ownerAgentIds.push(item.ownerAgentId);
    }
    if (!lane.claimedBy && RUNNING_QUEUE_STATES.has(item.queueState)) {
      lane.claimedBy = item.claimedBy ?? item.claimOwnerId ?? null;
      lane.claimedAt = item.claimedAt ?? null;
    }
    if (!lane.currentBlocker && BLOCKED_QUEUE_STATES.has(item.queueState)) {
      lane.currentBlocker = blockerSummary(item);
    }
    lanes.set(key, lane);
  }
  return [...lanes.values()]
    .map(({ items, ownerAgentIds, ...lane }) => ({
      ...lane,
      ownerAgentIds: ownerAgentIds.sort(),
    }))
    .sort((left, right) => {
      return (
        String(left.repo).localeCompare(String(right.repo)) ||
        String(left.targetBranch ?? "").localeCompare(
          String(right.targetBranch ?? ""),
        )
      );
    });
}

function summarizeAgents({ queueItems, activeClaims, staleClaims, runs }) {
  const agentIds = new Set();
  for (const claim of [...activeClaims, ...staleClaims]) {
    if (claim.ownerAgentId) agentIds.add(claim.ownerAgentId);
  }
  for (const item of queueItems) {
    if (item.ownerAgentId) agentIds.add(item.ownerAgentId);
  }
  for (const run of runs) {
    if (run.ownerKind === "agent" && run.ownerId) agentIds.add(run.ownerId);
  }

  return [...agentIds].sort().map((agentId) => ({
    agentId,
    activeClaims: activeClaims.filter((claim) => claim.ownerAgentId === agentId)
      .length,
    staleClaims: staleClaims.filter((claim) => claim.ownerAgentId === agentId)
      .length,
    queueItems: queueItems.filter((item) => item.ownerAgentId === agentId)
      .length,
    runningQueueItems: queueItems.filter(
      (item) =>
        item.ownerAgentId === agentId &&
        RUNNING_QUEUE_STATES.has(item.queueState),
    ).length,
    runningRuns: runs.filter(
      (run) =>
        run.ownerKind === "agent" &&
        run.ownerId === agentId &&
        run.status === "running",
    ).length,
    waitingRuns: runs.filter(
      (run) =>
        run.ownerKind === "agent" &&
        run.ownerId === agentId &&
        String(run.status ?? "").startsWith("waiting_"),
    ).length,
  }));
}

function summarizeHotPaths({ queueItems, claims, limit }) {
  const counts = new Map();
  for (const item of queueItems) {
    const itemPaths = new Set([
      ...arrayValue(item.affectedPaths),
      ...arrayValue(item.changedFiles),
    ]);
    for (const path of itemPaths) {
      incrementPath(counts, path);
    }
  }
  for (const claim of claims) {
    const claimPaths = new Set(arrayValue(claim.paths));
    if (claim.resourceKind === "path") {
      claimPaths.add(claim.resourceId);
    }
    for (const path of claimPaths) {
      incrementPath(counts, path);
    }
  }

  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.path.localeCompare(right.path),
    )
    .slice(0, Math.max(0, Number.isFinite(limit) ? limit : 10));
}

function summarizeHotPackages({ queueItems, claims, limit }) {
  const counts = new Map();
  for (const item of queueItems) {
    for (const packageName of new Set(arrayValue(item.affectedPackages))) {
      incrementPath(counts, packageName);
    }
  }
  for (const claim of claims) {
    if (claim.resourceKind === "package") {
      incrementPath(counts, claim.resourceId);
    }
  }

  return [...counts.entries()]
    .map(([packageName, count]) => ({ packageName, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.packageName.localeCompare(right.packageName),
    )
    .slice(0, Math.max(0, Number.isFinite(limit) ? limit : 10));
}

function blockerSummary(item) {
  return {
    itemId: item.id ?? null,
    pullRequestId: item.pullRequestId ?? null,
    queueState: item.queueState ?? "unknown",
    lastError: item.lastError ?? null,
  };
}

function claimSummary(claim) {
  return {
    id: claim.id,
    repo: claim.repo,
    resourceKind: claim.resourceKind,
    resourceId: claim.resourceId,
    ownerAgentId: claim.ownerAgentId,
    expiresAt: claim.expiresAt ?? null,
  };
}

function countBy(items, keyForItem) {
  const counts = {};
  for (const item of items) {
    const key = String(keyForItem(item));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function incrementPath(counts, path) {
  if (!path) return;
  const key = String(path);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return false;
  return expiresAtMs <= nowMs;
}
