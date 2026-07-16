export const AGENT_COCKPIT_VERSION = 1;
export const AGENT_COCKPIT_SCHEMA =
  "https://eliza.hub/schemas/agent-cockpit.v1";

export function buildAgentCockpit({
  agentId,
  repo,
  targetBranch,
  now = new Date().toISOString(),
  workflow = {},
  workContext = {},
  preflight = {},
  submissionGate = {},
} = {}) {
  const normalizedAgentId = requiredAgentId(agentId);
  const workflowSnapshot = objectValue(workflow);
  const workContextSnapshot = objectValue(workContext);
  const preflightSnapshot = objectValue(preflight);
  const submissionGateSnapshot = objectValue(submissionGate);
  const filters = {
    repo: stringOrNull(
      repo ??
        workflowSnapshot.filters?.repo ??
        workContextSnapshot.filters?.repo,
    ),
    targetBranch: stringOrNull(
      targetBranch ??
        workflowSnapshot.filters?.targetBranch ??
        workContextSnapshot.filters?.targetBranch,
    ),
    ownerAgentId: normalizedAgentId,
  };
  const links = {
    ...objectValue(workContextSnapshot.links),
    self: pathWithQuery(
      `/api/agents/${encodeURIComponent(normalizedAgentId)}/cockpit`,
      {
        repo: filters.repo,
        targetBranch: filters.targetBranch,
      },
    ),
    workflows: pathWithQuery("/api/workflows", filters),
    workContext: pathWithQuery("/api/work-context", filters),
    workPreflight: `/api/agents/${encodeURIComponent(normalizedAgentId)}/work-preflight`,
    submissionGate: `/api/agents/${encodeURIComponent(normalizedAgentId)}/submission-gate`,
  };
  const summary = summaryFor({
    workflow: workflowSnapshot,
    workContext: workContextSnapshot,
    preflight: preflightSnapshot,
    submissionGate: submissionGateSnapshot,
  });
  const focusCards = focusCardsFor({
    workflow: workflowSnapshot,
    workContext: workContextSnapshot,
  });
  const nextActions = cockpitNextActions({
    links,
    workContext: workContextSnapshot,
    workflow: workflowSnapshot,
    preflight: preflightSnapshot,
    submissionGate: submissionGateSnapshot,
    focusCards,
  });

  return {
    version: AGENT_COCKPIT_VERSION,
    schema: AGENT_COCKPIT_SCHEMA,
    computedAt: now,
    readOnly: true,
    agentId: normalizedAgentId,
    status: cockpitStatus({
      workContext: workContextSnapshot,
      workflow: workflowSnapshot,
      preflight: preflightSnapshot,
      submissionGate: submissionGateSnapshot,
      nextActions,
    }),
    filters,
    summary,
    focusCards,
    nextActions,
    links,
    snapshots: {
      workflow: workflowSnapshot,
      workContext: workContextSnapshot,
      preflight: preflightSnapshot,
      submissionGate: submissionGateSnapshot,
    },
  };
}

function summaryFor({
  workflow = {},
  workContext = {},
  preflight = {},
  submissionGate = {},
} = {}) {
  const workflowCounts = objectValue(workflow.counts);
  const contextSummary = objectValue(workContext.summary);
  const preflightDecision = objectValue(preflight.decision);
  const submissionDecision = objectValue(submissionGate.decision);
  const hasPreflightDecision = Object.keys(preflightDecision).length > 0;
  const hasSubmissionDecision = Object.keys(submissionDecision).length > 0;

  return {
    workflowCards: numberOrZero(workflowCounts.cards),
    queueItems: numberOrZero(workflowCounts.queueItems),
    workItems: numberOrZero(contextSummary.workItems),
    ownedCards: numberOrZero(contextSummary.cards),
    ready: numberOrZero(contextSummary.ready),
    running: numberOrZero(contextSummary.running),
    blocked: numberOrZero(contextSummary.blocked),
    needsHuman: numberOrZero(contextSummary.needsHuman),
    activeClaims: numberOrZero(contextSummary.activeClaims),
    staleClaims: numberOrZero(contextSummary.staleClaims),
    openApprovals: numberOrZero(contextSummary.openApprovals),
    openHumanRequests: numberOrZero(contextSummary.openHumanRequests),
    mergeQueueHealth: contextSummary.mergeQueueHealth ?? null,
    mergeTrainStatus:
      contextSummary.mergeTrainStatus ??
      workflow.operations?.mergeQueue?.status ??
      null,
    workflowOperationsStatus:
      contextSummary.workflowOperationsStatus ??
      workflow.operations?.status ??
      null,
    runnerStatus:
      contextSummary.runnerStatus ??
      workflow.operations?.runner?.status ??
      null,
    preflightAllowed: hasPreflightDecision
      ? preflightDecision.allowed === true
      : null,
    preflightState: preflightDecision.state ?? null,
    submissionAllowed: hasSubmissionDecision
      ? submissionDecision.allowed === true
      : null,
    submissionState: submissionDecision.state ?? null,
    nextActions: arrayValue(workContext.nextActions).length,
  };
}

function cockpitStatus({
  workContext = {},
  workflow = {},
  preflight = {},
  submissionGate = {},
  nextActions = [],
} = {}) {
  if (workContext.status === "blocked") return "blocked";
  if (submissionGate.decision?.allowed === false) return "submission_blocked";
  if (preflight.decision?.allowed === false) return "work_blocked";
  if (workflow.operations?.status === "control_plane_blocked")
    return "needs_attention";
  if (workContext.status === "needs_attention") return "needs_attention";
  if (nextActions.some((action) => action.blocking === true))
    return "needs_attention";
  if (workContext.status === "active") return "active";
  if (numberOrZero(workflow.counts?.cards) > 0) return "active";
  return "ready";
}

function cockpitNextActions({
  links = {},
  workContext = {},
  workflow = {},
  preflight = {},
  submissionGate = {},
  focusCards = [],
} = {}) {
  const actions = [];
  for (const action of compactActions(workContext.nextActions)) {
    actions.push({ ...action, source: action.source ?? "work_context" });
  }

  for (const action of focusCardActionPlanActions(focusCards)) {
    actions.push(action);
  }

  for (const action of arrayValue(workflow.operations?.nextActions)) {
    actions.push({
      id: action,
      priority: 35,
      blocking: false,
      method: "GET",
      href: links.workflows,
      reason: `Workflow operations recommend ${action}.`,
      source: "workflow_operations",
    });
  }

  if (preflight.decision?.allowed === false) {
    actions.push({
      id: "resolve_work_preflight",
      priority: 75,
      blocking: true,
      method: "POST",
      href: links.workPreflight,
      reason: preflight.decision.reason ?? "Work preflight has blockers.",
      requiredActions: arrayValue(preflight.decision.requiredActions),
      source: "work_preflight",
    });
  }

  if (submissionGate.decision?.allowed === false) {
    actions.push({
      id: "resolve_submission_gate",
      priority: 80,
      blocking: true,
      method: "POST",
      href: links.submissionGate,
      reason:
        submissionGate.decision.reason ??
        "Submission gate is blocking this agent.",
      requiredActions: arrayValue(submissionGate.decision.requiredActions),
      source: "submission_gate",
    });
  }

  const byKey = new Map();
  for (const action of actions) {
    const key = `${action.id}:${action.href ?? ""}`;
    const existing = byKey.get(key);
    if (!existing || actionRank(action) < actionRank(existing)) {
      byKey.set(key, action);
    }
  }

  return [...byKey.values()].sort(compareActions).slice(0, 20);
}

function focusCardActionPlanActions(focusCards = []) {
  return arrayValue(focusCards)
    .filter((card) => card.links?.queueItemActionPlan)
    .map((card) => ({
      id: "inspect_queue_item_action_plan",
      priority: focusCardActionPriority(card),
      blocking: focusCardBlocks(card),
      method: "GET",
      href: card.links.queueItemActionPlan,
      reason: focusCardActionReason(card),
      source: "focus_card",
      cardIds: [card.id],
      requiredActions: arrayValue(card.nextActions),
    }));
}

function focusCardActionPriority(card = {}) {
  return (
    numberOrZero(card.priority) +
    ({
      "needs-human": 68,
      failed: 66,
      blocked: 64,
      "needs-triage": 62,
      running: 44,
      ready: 40,
      waiting: 30,
    }[card.status] ?? 30)
  );
}

function focusCardBlocks(card = {}) {
  return ["needs-human", "failed", "blocked", "needs-triage"].includes(
    card.status,
  );
}

function focusCardActionReason(card = {}) {
  const actions = arrayValue(card.nextActions);
  const recommended = actions.length ? actions.join(", ") : "inspect";
  return `${card.title ?? card.id} needs ${recommended}.`;
}

function focusCardsFor({ workflow = {}, workContext = {} } = {}) {
  const cards = [
    ...arrayValue(workflow.cards).map((card) => focusCard(card, "workflow")),
    ...arrayValue(workContext.snapshots?.inbox?.cards).map((card) =>
      focusCard(card, "inbox"),
    ),
  ].filter(Boolean);
  const byId = new Map();
  for (const card of cards) {
    if (!byId.has(card.id)) byId.set(card.id, card);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) ||
        numberOrZero(right.priority) - numberOrZero(left.priority) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, 12);
}

function focusCard(card = {}, source) {
  if (!card.id) return null;
  return {
    id: card.id,
    source,
    kind: card.kind ?? null,
    status: card.status ?? card.state ?? "unknown",
    title: card.title ?? card.id,
    repo: card.repo ?? null,
    ownerAgentId: card.ownerAgentId ?? null,
    priority: numberOrZero(card.priority),
    nextActions: arrayValue(card.nextActions)
      .map((action) => String(action))
      .filter(Boolean)
      .slice(0, 5),
    links: objectValue(card.links),
    updatedAt: card.updatedAt ?? null,
  };
}

function compactActions(actions) {
  return arrayValue(actions).map((action) => ({
    id: action.id ?? action.action ?? "inspect",
    priority: numberOrZero(action.priority),
    blocking: action.blocking === true,
    method: action.method ?? null,
    href: action.href ?? null,
    reason: action.reason ?? null,
    source: action.source ?? null,
    ...(action.cardIds ? { cardIds: arrayValue(action.cardIds) } : {}),
    ...(action.requiredActions
      ? { requiredActions: arrayValue(action.requiredActions) }
      : {}),
  }));
}

function compareActions(left, right) {
  return (
    Boolean(right.blocking) - Boolean(left.blocking) ||
    actionRank(left) - actionRank(right) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function actionRank(action = {}) {
  return 100 - numberOrZero(action.priority);
}

function statusRank(status) {
  return (
    {
      "needs-human": 0,
      failed: 1,
      blocked: 2,
      "needs-triage": 3,
      running: 4,
      ready: 5,
      waiting: 6,
    }[status] ?? 10
  );
}

function pathWithQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function requiredAgentId(value) {
  const normalized = value == null ? "" : String(value).trim();
  if (!normalized) throw new TypeError("Agent cockpit requires agentId");
  return normalized;
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
