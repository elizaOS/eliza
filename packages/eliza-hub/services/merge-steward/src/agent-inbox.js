import { buildProjectBoard } from "./project-board.js";

const ACTION_ORDER = Object.freeze([
  "decide_approval",
  "answer_human_request",
  "recover_or_release_stale_work",
  "resolve_policy_blocker",
  "add_agent_plan",
  "claim_work_item",
  "continue_work_item",
  "claim_or_merge_queue_lane",
  "watch_run",
  "inspect_work_item",
  "inspect",
]);

export function buildAgentInbox({
  ownerAgentId,
  repo,
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
  policy,
  integrationConfig = {},
} = {}) {
  const agentId = ownerAgentId ? String(ownerAgentId) : null;
  const filters = {
    repo: repo ? String(repo) : null,
    ownerAgentId: agentId,
  };
  const board = buildProjectBoard({
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
    repo: filters.repo,
    ownerAgentId: filters.ownerAgentId,
    includeEmptyColumns: false,
    boardId: agentId ? `eliza-agent:${agentId}` : "eliza-agent",
    title: agentId ? `Eliza Agent ${agentId}` : "Eliza Agent",
    policy,
    integrationConfig,
  });
  const cards = board.columns.flatMap((column) => column.cards);
  const agentClaims = claims
    .filter((claim) => matchesClaim(claim, filters))
    .map((claim) => claimSummary(claim, now));
  const activeClaims = agentClaims.filter((claim) => claim.status === "active");
  const staleClaims = agentClaims.filter((claim) => claim.status === "stale");

  return {
    agentId,
    computedAt: board.computedAt,
    filters,
    readiness: board.readiness,
    counts: {
      cards: cards.length,
      needsHuman: board.counts.needsHuman,
      triage: board.counts.triage,
      blocked: board.counts.blocked,
      failed: board.counts.failed,
      running: board.counts.running,
      ready: board.counts.ready,
      waiting: board.counts.waiting,
      activeClaims: activeClaims.length,
      staleClaims: staleClaims.length,
      openApprovals: cards.reduce(
        (count, card) => count + card.approvals.length,
        0,
      ),
      openHumanRequests: cards.reduce(
        (count, card) => count + card.humanRequests.length,
        0,
      ),
    },
    nextActions: summarizeNextActions(cards),
    claims: {
      active: activeClaims,
      stale: staleClaims,
    },
    cards,
    lanes: board.lanes,
    work: board.work,
    mergeQueue: board.mergeQueue,
  };
}

function summarizeNextActions(cards) {
  const actions = new Map();
  for (const card of cards) {
    for (const action of card.nextActions) {
      const summary = actions.get(action) ?? {
        action,
        count: 0,
        cardIds: [],
      };
      summary.count += 1;
      summary.cardIds.push(card.id);
      actions.set(action, summary);
    }
  }

  return [...actions.values()].sort(
    (left, right) =>
      actionRank(left.action) - actionRank(right.action) ||
      left.action.localeCompare(right.action),
  );
}

function matchesClaim(claim, filters) {
  if (filters.ownerAgentId && claim.ownerAgentId !== filters.ownerAgentId)
    return false;
  if (filters.repo && claim.repo !== filters.repo) return false;
  return true;
}

function claimSummary(claim, now) {
  return {
    id: claim.id,
    repo: claim.repo ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    ownerAgentId: claim.ownerAgentId ?? null,
    status:
      claim.status === "active" && isExpired(claim.expiresAt, now)
        ? "stale"
        : (claim.status ?? "unknown"),
    taskId: claim.taskId ?? null,
    paths: Array.isArray(claim.paths) ? claim.paths.filter(Boolean) : [],
    expiresAt: claim.expiresAt ?? null,
    updatedAt: claim.updatedAt ?? claim.createdAt ?? null,
  };
}

function actionRank(action) {
  const index = ACTION_ORDER.indexOf(action);
  return index >= 0 ? index : ACTION_ORDER.length;
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
