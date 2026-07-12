export const FLEET_COORDINATION_VERSION = 1;

const BOARD_COLUMNS = Object.freeze([
  {
    id: "todo",
    title: "Todo",
    workItemStates: ["backlog", "ready"],
    ownerOnly: false,
  },
  {
    id: "claimed",
    title: "Claimed",
    workItemStates: ["claimed"],
    ownerOnly: false,
  },
  {
    id: "in_progress",
    title: "In progress",
    workItemStates: ["in_progress", "merge_queue"],
    ownerOnly: false,
  },
  {
    id: "needs_agent_verify",
    title: "Needs-agent-verify",
    workItemStates: ["needs_human_review"],
    ownerOnly: false,
  },
  {
    id: "needs_human_verify",
    title: "Needs-human-verify",
    workItemStates: ["needs_human_review"],
    ownerOnly: false,
  },
  { id: "done", title: "Done", workItemStates: ["done"], ownerOnly: true },
]);

const CLAIM_STEPS = Object.freeze([
  {
    id: "read_latest_context",
    order: 1,
    action:
      "Read the latest coordination contract, active claims, and board state before starting.",
  },
  {
    id: "claim_card",
    order: 2,
    action:
      "Create or renew a durable claim and mark the matching work item as claimed before mutating files or shared resources.",
  },
  {
    id: "start_work",
    order: 3,
    action: "Move the card to in_progress only when active work begins.",
  },
  {
    id: "attach_evidence",
    order: 4,
    action:
      "Attach PR links, logs, screenshots or recordings, domain artifacts, and validation output to the work item or PR.",
  },
  {
    id: "handoff_for_verify",
    order: 5,
    action:
      "Move finished work to needs_human_verify or needs_agent_verify; only the owner closes the push as done.",
  },
  {
    id: "release_or_pick_next",
    order: 6,
    action:
      "If blocked longer than the configured threshold, release or explain the claim and pick another card.",
  },
]);

const EVIDENCE_ROWS = Object.freeze([
  "screenshots_or_recording",
  "logs",
  "real_llm_trajectories",
  "domain_artifacts",
  "ci_or_local_commands",
]);

const SHARED_LEVERS = Object.freeze([
  {
    id: "prod_deploy",
    title: "Production deploys and main promotion",
    resourceKind: "deploy",
    resourceId: "production",
    exclusive: true,
    auditRequired: true,
  },
  {
    id: "staging_environment",
    title: "Staging environment, env vars, secrets, and seeded data",
    resourceKind: "environment",
    resourceId: "staging",
    exclusive: true,
    auditRequired: true,
  },
  {
    id: "production_database",
    title: "Production database writes",
    resourceKind: "database",
    resourceId: "production",
    exclusive: true,
    auditRequired: true,
  },
  {
    id: "dns_repo_settings",
    title: "DNS, Cloudflare, repository settings, and rulesets",
    resourceKind: "settings",
    resourceId: "dns-repo-rulesets",
    exclusive: true,
    auditRequired: true,
  },
  {
    id: "physical_devices",
    title: "Physical devices and attached debug bridges",
    resourceKind: "device",
    resourceId: "seeker-phone",
    exclusive: true,
    auditRequired: false,
  },
  {
    id: "runner_capacity",
    title: "Worker secrets and CI runner capacity",
    resourceKind: "runner",
    resourceId: "ci-capacity",
    exclusive: true,
    auditRequired: true,
  },
]);

export function buildFleetCoordination({
  repo,
  ownerAgentId,
  claims = [],
  now = new Date().toISOString(),
  config = {},
} = {}) {
  const normalizedRepo = stringOrNull(repo);
  const normalizedOwnerAgentId = stringOrNull(ownerAgentId);
  const blockedAfterMinutes = positiveInteger(
    config.fleet?.blockedAfterMinutes,
    30,
  );
  const staleClaimAfterMinutes = positiveInteger(
    config.fleet?.staleClaimAfterMinutes,
    30,
  );
  const sharedLevers = SHARED_LEVERS.map((lever) =>
    sharedLeverState({
      lever,
      claims,
      repo: normalizedRepo,
      ownerAgentId: normalizedOwnerAgentId,
      now,
    }),
  );

  return {
    version: FLEET_COORDINATION_VERSION,
    computedAt: now,
    filters: {
      repo: normalizedRepo,
      ownerAgentId: normalizedOwnerAgentId,
    },
    identity: {
      laneTagRequired: true,
      laneTagExample: normalizedOwnerAgentId
        ? `[${normalizedOwnerAgentId}]`
        : "[agent-id]",
      oneRunningContextPerLaneTag: true,
      signEveryComment: true,
    },
    surfaces: {
      workBoard: {
        source: "eliza_work",
        cardType: "work_item",
        columns: BOARD_COLUMNS.map((column) => ({ ...column })),
        doneOwnerOnly: true,
      },
      issues: {
        purpose: "actionable_cards_only",
        rule: "Open one scoped issue or work item per bug, feature, or task.",
      },
      coordinationThread: {
        purpose: "standups_claims_handoffs_incidents",
        oneClaimOneThread: true,
        useRepliesForUpdates: true,
      },
      pullRequests: {
        purpose: "work_and_evidence",
        coordinationSideTalk: "avoid",
      },
    },
    claimProtocol: {
      blockedAfterMinutes,
      staleClaimAfterMinutes,
      steps: CLAIM_STEPS.map((step) => ({ ...step })),
      transitions: BOARD_COLUMNS.map((column) => ({
        id: column.id,
        title: column.title,
        ownerOnly: column.ownerOnly,
        workItemStates: [...column.workItemStates],
      })),
      evidenceRows: [...EVIDENCE_ROWS],
    },
    sharedLevers,
    nextActions: nextActionsFor({
      sharedLevers,
      ownerAgentId: normalizedOwnerAgentId,
    }),
  };
}

function sharedLeverState({ lever, claims, repo, ownerAgentId, now }) {
  const matchingClaims = arrayValue(claims)
    .filter((claim) => claimMatchesLever(claim, lever, repo))
    .map((claim) => compactClaim(claim, now))
    .sort((left, right) =>
      claimSortKey(left).localeCompare(claimSortKey(right)),
    );
  const activeClaims = matchingClaims.filter(
    (claim) => claim.status === "active",
  );
  const staleClaims = matchingClaims.filter(
    (claim) => claim.status === "stale",
  );
  const blockingClaim =
    activeClaims.find(
      (claim) => !ownerAgentId || claim.ownerAgentId !== ownerAgentId,
    ) ?? null;
  const ownClaim = ownerAgentId
    ? (activeClaims.find((claim) => claim.ownerAgentId === ownerAgentId) ??
      staleClaims.find((claim) => claim.ownerAgentId === ownerAgentId) ??
      null)
    : null;

  return {
    ...lever,
    claimRequired: true,
    state: blockingClaim
      ? "claimed_by_other"
      : ownClaim
        ? ownClaim.status === "stale"
          ? "own_claim_stale"
          : "claimed_by_self"
        : "available",
    activeClaim: blockingClaim ?? ownClaim ?? activeClaims[0] ?? null,
    activeClaimCount: activeClaims.length,
    staleClaimCount: staleClaims.length,
    requiredAction: blockingClaim
      ? "wait_or_coordinate_with_claim_owner"
      : ownClaim?.status === "stale"
        ? "renew_or_release_claim"
        : ownClaim
          ? "finish_and_release_claim"
          : "claim_before_mutating",
  };
}

function claimMatchesLever(claim, lever, repo) {
  if (
    !claim ||
    claim.resourceKind !== lever.resourceKind ||
    String(claim.resourceId) !== lever.resourceId
  )
    return false;
  if (!repo) return true;
  return claim.repo === repo || claim.repo === "global";
}

function compactClaim(claim, now) {
  return {
    id: claim.id ?? null,
    repo: claim.repo ?? null,
    ownerAgentId: claim.ownerAgentId ?? null,
    resourceKind: claim.resourceKind ?? null,
    resourceId: claim.resourceId ?? null,
    status:
      claim.status === "active" && isExpired(claim.expiresAt, now)
        ? "stale"
        : (claim.status ?? "unknown"),
    expiresAt: claim.expiresAt ?? null,
    updatedAt: claim.updatedAt ?? claim.createdAt ?? null,
  };
}

function nextActionsFor({ sharedLevers, ownerAgentId }) {
  const actions = [];
  const blockedLevers = sharedLevers.filter(
    (lever) => lever.state === "claimed_by_other",
  );
  const staleOwnLevers = sharedLevers.filter(
    (lever) => lever.state === "own_claim_stale",
  );

  if (blockedLevers.length > 0) {
    actions.push({
      id: "coordinate_shared_lever_claims",
      priority: 80,
      blocking: true,
      reason: "Another active lane owns at least one shared lever.",
      leverIds: blockedLevers.map((lever) => lever.id),
    });
  }

  if (staleOwnLevers.length > 0) {
    actions.push({
      id: "renew_or_release_shared_lever_claims",
      priority: 70,
      blocking: false,
      reason: "This lane has stale shared-lever claims.",
      leverIds: staleOwnLevers.map((lever) => lever.id),
    });
  }

  actions.push({
    id: "claim_work_before_branch",
    priority: 40,
    blocking: false,
    reason: ownerAgentId
      ? "Create a durable claim and Work item before opening or updating agent-owned Git work."
      : "Agents should create a durable claim and Work item before opening or updating Git work.",
  });

  actions.push({
    id: "attach_evidence_before_verify",
    priority: 30,
    blocking: false,
    reason:
      "Move work to verification only after evidence rows are attached or explicitly marked not applicable.",
  });

  return actions.sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
  );
}

function claimSortKey(claim) {
  return [
    claim.status === "active" ? "0" : "1",
    claim.expiresAt ?? "",
    claim.ownerAgentId ?? "",
    claim.id ?? "",
  ].join(":");
}

function isExpired(expiresAt, now) {
  return Boolean(
    expiresAt && String(expiresAt).localeCompare(String(now)) <= 0,
  );
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function stringOrNull(value) {
  if (value == null) return null;
  const string = String(value).trim();
  return string ? string : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
