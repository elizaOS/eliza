export function buildAgentRouting({
  capacity,
  now = capacity?.computedAt ?? new Date().toISOString(),
  maxRecommendations = 20,
} = {}) {
  const agents = Array.isArray(capacity?.agents) ? capacity.agents : [];
  const recommendations = (capacity?.assignmentSuggestions ?? [])
    .slice(0, positiveInteger(maxRecommendations) ?? 20)
    .map(routingRecommendation);
  const routableAgents = agents
    .filter((agent) => agent.canTakeNewWork === true)
    .map(agentRoutingSummary)
    .sort(compareRoutableAgents);
  const blockedAgents = agents
    .filter((agent) => agent.canTakeNewWork !== true)
    .map(blockedAgentSummary)
    .filter((agent) => agent.reasons.length > 0)
    .sort(compareBlockedAgents);

  return {
    computedAt: now,
    filters: capacity?.filters ?? {
      repo: null,
      ownerAgentId: null,
      targetBranch: null,
    },
    counts: {
      recommendations: recommendations.length,
      routableAgents: routableAgents.length,
      blockedAgents: blockedAgents.length,
      unassignedItems: capacity?.counts?.unassignedItems ?? 0,
    },
    recommendations,
    routableAgents,
    blockedAgents,
    unassignedItems: (capacity?.unassignedItems ?? []).slice(0, 20),
  };
}

function routingRecommendation(suggestion) {
  return {
    id: suggestion.id ?? null,
    agentId: suggestion.agentId ?? null,
    itemId: suggestion.itemId ?? null,
    repo: suggestion.repo ?? null,
    pullRequestId: suggestion.pullRequestId ?? null,
    targetBranch: suggestion.targetBranch ?? null,
    action: suggestion.action ?? null,
    priority: numberOrZero(suggestion.priority),
    score: numberOrZero(suggestion.score),
    reason: suggestion.reason ?? null,
    resource: suggestion.resource ?? null,
    itemSummary: suggestion.itemSummary ?? null,
  };
}

function agentRoutingSummary(agent) {
  return {
    agentId: agent.agentId,
    health: agent.health,
    availableSlots: numberOrZero(agent.availableSlots),
    workloadScore: numberOrZero(agent.workloadScore),
    performanceHealth: agent.performance?.health ?? null,
    performanceRiskScore: numberOrZero(agent.performance?.riskScore),
    topActions: agent.topActions ?? [],
    expertise: agent.expertise ?? {
      paths: [],
      packages: [],
    },
  };
}

function blockedAgentSummary(agent) {
  return {
    agentId: agent.agentId,
    health: agent.health,
    availableSlots: numberOrZero(agent.availableSlots),
    workloadScore: numberOrZero(agent.workloadScore),
    performanceHealth: agent.performance?.health ?? null,
    performanceRiskScore: numberOrZero(agent.performance?.riskScore),
    reasons: blockedReasons(agent),
  };
}

function blockedReasons(agent) {
  const reasons = [];
  if (numberOrZero(agent.availableSlots) === 0)
    reasons.push("no_available_slots");
  if (agent.health && agent.health !== "idle" && agent.health !== "available") {
    reasons.push(`capacity_${agent.health}`);
  }
  if (
    agent.performance?.health === "needs-triage" ||
    agent.performance?.health === "overloaded"
  ) {
    reasons.push(`performance_${agent.performance.health}`);
  }
  if (numberOrZero(agent.counts?.staleClaims) > 0) reasons.push("stale_claims");
  if (numberOrZero(agent.counts?.failedRuns) > 0) reasons.push("failed_runs");
  if (numberOrZero(agent.performance?.counts?.failedRuns) > 0)
    reasons.push("recent_failed_runs");
  return [...new Set(reasons)];
}

function compareRoutableAgents(left, right) {
  return (
    right.availableSlots - left.availableSlots ||
    left.workloadScore - right.workloadScore ||
    left.performanceRiskScore - right.performanceRiskScore ||
    left.agentId.localeCompare(right.agentId)
  );
}

function compareBlockedAgents(left, right) {
  return (
    right.performanceRiskScore - left.performanceRiskScore ||
    right.workloadScore - left.workloadScore ||
    left.agentId.localeCompare(right.agentId)
  );
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
