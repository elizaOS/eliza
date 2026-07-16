import { buildBatchEligibilityIndex } from "./integration-plan.js";
import { scheduleQueue } from "./policy.js";
import { buildWorkflowView } from "./workflow-view.js";

const COLUMN_DEFINITIONS = Object.freeze([
  {
    id: "needs-human",
    title: "Needs Human",
    description: "Approval or input is required before an agent can continue.",
  },
  {
    id: "triage",
    title: "Triage",
    description: "Stale, unhealthy, or unclear work needs owner attention.",
  },
  {
    id: "blocked",
    title: "Blocked",
    description:
      "Policy, review, checks, conflicts, or quarantine are blocking progress.",
  },
  {
    id: "failed",
    title: "Failed",
    description: "A run or merge lane failed and needs recovery.",
  },
  {
    id: "running",
    title: "Running",
    description: "An agent or steward worker is actively moving this forward.",
  },
  {
    id: "ready",
    title: "Ready",
    description: "Ready to claim, batch, or merge.",
  },
  {
    id: "waiting",
    title: "Waiting",
    description:
      "Waiting on checks, review, scheduling, or other passive state.",
  },
  {
    id: "done",
    title: "Done",
    description: "Terminal run cards kept for recent context.",
  },
]);

const STATUS_TO_COLUMN = Object.freeze({
  "needs-human": "needs-human",
  "needs-triage": "triage",
  blocked: "blocked",
  failed: "failed",
  running: "running",
  ready: "ready",
  waiting: "waiting",
  done: "done",
  merged: "done",
  closed: "done",
  finished: "done",
  cancelled: "done",
});

export function buildProjectBoard({
  queueItems = [],
  workItems = [],
  workCycles = [],
  workModules = [],
  workProgress = null,
  claims = [],
  runs = [],
  approvals = [],
  humanRequests = [],
  readiness = null,
  now = new Date().toISOString(),
  repo,
  ownerAgentId,
  includeEmptyColumns = true,
  boardId = "eliza-agent-work",
  title = "Eliza Agent Work",
  policy,
  integrationConfig = {},
} = {}) {
  const workflow = buildWorkflowView({
    queueItems,
    workItems,
    workCycles,
    workModules,
    workProgress,
    claims,
    runs,
    approvals,
    humanRequests,
    readiness,
    now,
  });
  const filters = normalizeFilters({ repo, ownerAgentId });
  const scheduled = scheduleQueue(
    queueItems.filter((item) => matchesQueueFilters(item, filters)),
    policy,
  );
  const batchEligibility = buildBatchEligibilityIndex({
    scheduled,
    config: integrationConfig,
  });
  const cards = workflow.cards
    .filter((card) => matchesFilters(card, filters))
    .map((card) =>
      boardCard(card, {
        batchEligibility:
          batchEligibility.index.get(queueCardIdentity(card)) ?? null,
      }),
    );
  const columns = buildColumns(cards, { includeEmptyColumns });
  const lanes = summarizeLanes(cards);
  const agents = summarizeAgents(cards);

  return {
    id: boardId,
    title,
    computedAt: workflow.computedAt,
    filters,
    readiness: workflow.readiness,
    counts: {
      cards: cards.length,
      columns: columns.length,
      needsHuman: countColumn(columns, "needs-human"),
      triage: countColumn(columns, "triage"),
      blocked: countColumn(columns, "blocked"),
      failed: countColumn(columns, "failed"),
      running: countColumn(columns, "running"),
      ready: countColumn(columns, "ready"),
      waiting: countColumn(columns, "waiting"),
      done: countColumn(columns, "done"),
      workCycles: workflow.counts.workCycles,
      workModules: workflow.counts.workModules,
    },
    columns,
    lanes,
    agents,
    work: workflow.work,
    mergeQueue: {
      lanes: lanes.map(mergeLaneSummary),
    },
    source: {
      workflowCounts: workflow.counts,
      inboxCounts: {
        approvals: workflow.inbox.approvals.length,
        humanRequests: workflow.inbox.humanRequests.length,
        staleClaims: workflow.inbox.staleClaims.length,
        failedRuns: workflow.inbox.failedRuns.length,
      },
    },
  };
}

function buildColumns(cards, { includeEmptyColumns }) {
  const columnCards = new Map(
    COLUMN_DEFINITIONS.map((column) => [column.id, []]),
  );
  for (const card of cards) {
    columnCards.get(card.columnId).push(card);
  }

  return COLUMN_DEFINITIONS.map((definition, index) => ({
    ...definition,
    order: index,
    count: columnCards.get(definition.id).length,
    cards: columnCards.get(definition.id),
  })).filter((column) => includeEmptyColumns || column.count > 0);
}

function boardCard(card, { batchEligibility = null } = {}) {
  const columnId = columnForStatus(card.status, card.queueState);
  return {
    id: card.id,
    kind: card.kind,
    columnId,
    status: card.status,
    title: card.title,
    repo: card.repo,
    pullRequestId: card.pullRequestId,
    targetBranch: card.targetBranch,
    laneKey:
      card.laneKey ?? `${card.repo ?? "unknown"}:${card.targetBranch ?? ""}`,
    ownerAgentId: card.ownerAgentId,
    priority: card.priority,
    queueState: card.queueState,
    batchEligibility: columnId === "ready" ? batchEligibility : null,
    runState: card.runState,
    workItem: card.workItem ?? null,
    cycleId: card.workItem?.cycleId ?? null,
    moduleId: card.workItem?.moduleId ?? null,
    stack: card.stack ?? null,
    claims: card.claims,
    approvals: card.approvals,
    humanRequests: card.humanRequests,
    runs: card.runs,
    links: card.links ?? {},
    nextActions: card.nextActions,
    updatedAt: card.updatedAt,
    sortKey: sortKey({
      columnId,
      priority: card.priority,
      updatedAt: card.updatedAt,
      id: card.id,
    }),
  };
}

function columnForStatus(status, queueState) {
  const normalizedStatus = String(status ?? "").toLowerCase();
  const normalizedQueueState = String(queueState ?? "").toLowerCase();
  if (STATUS_TO_COLUMN[normalizedStatus])
    return STATUS_TO_COLUMN[normalizedStatus];
  if (
    normalizedQueueState.startsWith("blocked") ||
    normalizedQueueState === "quarantined"
  )
    return "blocked";
  if (normalizedQueueState.startsWith("waiting")) return "waiting";
  if (normalizedQueueState === "queued" || normalizedQueueState === "ready")
    return "ready";
  if (
    normalizedQueueState === "running" ||
    normalizedQueueState === "building_integration"
  )
    return "running";
  return "waiting";
}

function summarizeLanes(cards) {
  const lanes = new Map();
  for (const card of cards) {
    const key =
      card.laneKey ?? `${card.repo ?? "unknown"}:${card.targetBranch ?? ""}`;
    const lane = lanes.get(key) ?? {
      key,
      repo: card.repo ?? null,
      targetBranch: card.targetBranch ?? null,
      total: 0,
      needsHuman: 0,
      triage: 0,
      blocked: 0,
      failed: 0,
      running: 0,
      ready: 0,
      waiting: 0,
      done: 0,
      ownerAgentIds: new Set(),
      cards: [],
    };
    lane.total += 1;
    lane[camelColumn(card.columnId)] += 1;
    if (card.ownerAgentId) lane.ownerAgentIds.add(card.ownerAgentId);
    lane.cards.push(card);
    lanes.set(key, lane);
  }

  return [...lanes.values()]
    .map((lane) => ({
      key: lane.key,
      repo: lane.repo,
      targetBranch: lane.targetBranch,
      total: lane.total,
      needsHuman: lane.needsHuman,
      triage: lane.triage,
      blocked: lane.blocked,
      failed: lane.failed,
      running: lane.running,
      ready: lane.ready,
      waiting: lane.waiting,
      done: lane.done,
      ownerAgentIds: [...lane.ownerAgentIds].sort(),
      leadCardId: leadCard(lane.cards)?.id ?? null,
      needsHumanCardIds: lane.cards
        .filter((card) => card.columnId === "needs-human")
        .map((card) => card.id),
      readyCardIds: lane.cards
        .filter((card) => card.columnId === "ready")
        .map((card) => card.id),
      batchCandidateCardIds: lane.cards
        .filter(
          (card) =>
            card.columnId === "ready" &&
            card.batchEligibility?.selected === true,
        )
        .map((card) => card.id),
      batchSkippedCards: lane.cards
        .filter(
          (card) =>
            card.columnId === "ready" &&
            card.batchEligibility &&
            card.batchEligibility.selected !== true,
        )
        .map((card) => ({
          id: card.id,
          repo: card.repo,
          pullRequestId: card.pullRequestId,
          targetBranch: card.targetBranch,
          reason: card.batchEligibility.reason,
        })),
      runningCardIds: lane.cards
        .filter((card) => card.columnId === "running")
        .map((card) => card.id),
      blockedCardIds: lane.cards
        .filter(
          (card) =>
            card.columnId === "blocked" ||
            card.columnId === "triage" ||
            card.columnId === "failed",
        )
        .map((card) => card.id),
      attentionCardIds: lane.cards
        .filter(
          (card) =>
            card.columnId === "needs-human" ||
            card.columnId === "blocked" ||
            card.columnId === "triage" ||
            card.columnId === "failed",
        )
        .map((card) => card.id),
    }))
    .sort(
      (left, right) =>
        String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
        String(left.targetBranch ?? "").localeCompare(
          String(right.targetBranch ?? ""),
        ),
    );
}

function summarizeAgents(cards) {
  const agents = new Map();
  for (const card of cards) {
    const agentId = card.ownerAgentId;
    if (!agentId) continue;
    const summary = agents.get(agentId) ?? {
      agentId,
      total: 0,
      needsHuman: 0,
      triage: 0,
      blocked: 0,
      failed: 0,
      running: 0,
      ready: 0,
      waiting: 0,
      done: 0,
      cardIds: [],
    };
    summary.total += 1;
    summary[camelColumn(card.columnId)] += 1;
    summary.cardIds.push(card.id);
    agents.set(agentId, summary);
  }

  return [...agents.values()].sort((left, right) =>
    left.agentId.localeCompare(right.agentId),
  );
}

function mergeLaneSummary(lane) {
  const actionableCardIds = [
    ...lane.needsHumanCardIds,
    ...lane.readyCardIds,
    ...lane.runningCardIds,
    ...lane.blockedCardIds,
  ];
  return {
    key: lane.key,
    repo: lane.repo,
    targetBranch: lane.targetBranch,
    state:
      lane.running > 0
        ? "busy"
        : lane.needsHuman + lane.blocked + lane.triage + lane.failed > 0
          ? "needs-attention"
          : lane.ready > 0
            ? "ready"
            : "waiting",
    leadCardId: lane.leadCardId,
    needsHumanCardIds: lane.needsHumanCardIds,
    readyCardIds: lane.readyCardIds,
    runningCardIds: lane.runningCardIds,
    blockedCardIds: lane.blockedCardIds,
    attentionCardIds: lane.attentionCardIds,
    batchCandidateCardIds: lane.running > 0 ? [] : lane.batchCandidateCardIds,
    batchSkippedCards: lane.batchSkippedCards,
    actionableCardIds,
    ownerAgentIds: lane.ownerAgentIds,
  };
}

function leadCard(cards) {
  return (
    [...cards].sort((left, right) => {
      return (
        columnRank(left.columnId) - columnRank(right.columnId) ||
        right.priority - left.priority ||
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        ) ||
        String(left.id).localeCompare(String(right.id))
      );
    })[0] ?? null
  );
}

function matchesFilters(card, filters) {
  if (filters.repo && card.repo !== filters.repo) return false;
  if (filters.ownerAgentId && card.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function matchesQueueFilters(item, filters) {
  if (filters.repo && item.repo !== filters.repo) return false;
  if (filters.ownerAgentId && item.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function normalizeFilters({ repo, ownerAgentId }) {
  return {
    repo: repo ? String(repo) : null,
    ownerAgentId: ownerAgentId ? String(ownerAgentId) : null,
  };
}

function countColumn(columns, id) {
  return columns.find((column) => column.id === id)?.count ?? 0;
}

function sortKey({ columnId, priority, updatedAt, id }) {
  return [
    String(columnRank(columnId)).padStart(2, "0"),
    String(999999 - numberOrZero(priority)).padStart(6, "0"),
    updatedAt ?? "",
    id ?? "",
  ].join(":");
}

function columnRank(columnId) {
  const index = COLUMN_DEFINITIONS.findIndex(
    (column) => column.id === columnId,
  );
  return index >= 0 ? index : COLUMN_DEFINITIONS.length;
}

function camelColumn(columnId) {
  return columnId === "needs-human" ? "needsHuman" : columnId;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function queueCardIdentity(card) {
  if (card.repo && card.pullRequestId != null)
    return `${card.repo}#${card.pullRequestId}`;
  return String(card.queueItemId ?? card.id ?? "").replace(/^queue:/, "");
}
