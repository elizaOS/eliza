const DEFAULT_CLAIMABLE_ACTIONS = Object.freeze([
  "release_or_renew_stale_claim",
  "route_failed_checks",
  "rebase_or_update_branch",
  "coordinate_overlapping_prs",
  "resolve_policy_blocker",
  "wait_for_checks",
  "enter_merge_queue",
  "inspect",
]);

const ACTION_RANK = Object.freeze({
  release_or_renew_stale_claim: 0,
  route_failed_checks: 1,
  rebase_or_update_branch: 2,
  coordinate_overlapping_prs: 3,
  resolve_policy_blocker: 4,
  wait_for_checks: 5,
  enter_merge_queue: 6,
  inspect: 7,
});

const RESOURCE_KIND_RANK = Object.freeze({
  pull_request: 0,
  package: 1,
  path: 2,
  queue_item: 3,
});

export function buildAgentClaimCandidates({
  insights,
  ownerAgentId,
  action,
  resourceKind,
  includeOtherOwners = false,
} = {}) {
  if (!ownerAgentId) {
    throw new TypeError("Agent claim routing requires ownerAgentId");
  }

  const preferredAction = action ? String(action) : null;
  const preferredResourceKind = resourceKind ? String(resourceKind) : null;
  return (insights?.items ?? [])
    .map((item) =>
      candidateForItem({
        item,
        ownerAgentId: String(ownerAgentId),
        preferredAction,
        preferredResourceKind,
        includeOtherOwners,
      }),
    )
    .filter(Boolean)
    .sort(compareCandidates);
}

export function buildClaimFromCandidate(candidate, { ownerAgentId, now } = {}) {
  if (!candidate?.resource?.kind || !candidate?.resource?.id) {
    throw new TypeError("Agent claim candidate requires a resource");
  }
  if (!ownerAgentId) {
    throw new TypeError("Agent claim requires ownerAgentId");
  }

  return {
    repo: candidate.repo,
    resourceKind: candidate.resource.kind,
    resourceId: candidate.resource.id,
    ownerAgentId: String(ownerAgentId),
    taskId: candidate.taskId ?? null,
    paths: candidate.resource.paths,
    metadata: {
      source: "agent-claim-next",
      action: candidate.action,
      itemId: candidate.itemId,
      pullRequestId: candidate.pullRequestId,
      targetBranch: candidate.targetBranch,
      reason: candidate.reason,
      selectedAt: now ?? null,
    },
  };
}

function candidateForItem({
  item,
  ownerAgentId,
  preferredAction,
  preferredResourceKind,
  includeOtherOwners,
}) {
  if (!item?.id || !item.repo) return null;
  if (
    !includeOtherOwners &&
    item.ownerAgentId &&
    item.ownerAgentId !== ownerAgentId
  )
    return null;
  if (item.human?.openApprovals > 0 || item.human?.openRequests > 0)
    return null;
  if (
    item.claims?.active?.some(
      (claim) => claim.ownerAgentId && claim.ownerAgentId !== ownerAgentId,
    )
  )
    return null;

  const action =
    preferredAction ?? firstClaimableAction(item.nextActions ?? []);
  if (!action || !DEFAULT_CLAIMABLE_ACTIONS.includes(action)) return null;
  if (preferredAction && !(item.nextActions ?? []).includes(preferredAction))
    return null;

  const resource = selectResource({ item, action, preferredResourceKind });
  if (!resource) return null;

  return {
    id: `candidate:${item.id}:${resource.kind}:${resource.id}`,
    itemId: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId ?? null,
    targetBranch: item.targetBranch ?? null,
    ownerAgentId: item.ownerAgentId ?? null,
    suggestedOwnerAgentId: item.suggestedOwnerAgentId ?? null,
    priority: numberOrZero(item.priority),
    action,
    reason: reasonForAction(action),
    resource,
    taskId: item.taskId ?? null,
    risk: item.risk ?? null,
    conflict: item.conflict ?? null,
    blockers: item.decision?.blockers ?? [],
    nextActions: item.nextActions ?? [],
  };
}

function firstClaimableAction(actions) {
  return (
    [...actions]
      .sort(
        (left, right) =>
          actionRank(left) - actionRank(right) ||
          String(left).localeCompare(String(right)),
      )
      .find((action) => DEFAULT_CLAIMABLE_ACTIONS.includes(action)) ?? null
  );
}

function selectResource({ item, action, preferredResourceKind }) {
  const choices = resourceChoices(item, action);
  if (preferredResourceKind) {
    return (
      choices.find((choice) => choice.kind === preferredResourceKind) ?? null
    );
  }
  return choices[0] ?? null;
}

function resourceChoices(item, action) {
  const paths = arrayValue(item.duplicateRisk?.sharedPaths).length
    ? arrayValue(item.duplicateRisk?.sharedPaths)
    : arrayValue(item.checks?.failed).length
      ? arrayValue(item.checks.failed).map((check) => `check:${check.name}`)
      : itemPaths(item);
  const packages = arrayValue(item.duplicateRisk?.sharedPackages).length
    ? arrayValue(item.duplicateRisk?.sharedPackages)
    : itemPackages(item);
  const pullRequest =
    item.pullRequestId != null
      ? [
          {
            kind: "pull_request",
            id: String(item.pullRequestId),
            paths: itemPaths(item),
          },
        ]
      : [];
  const queueItem = item.id
    ? [
        {
          kind: "queue_item",
          id: String(item.id),
          paths: itemPaths(item),
        },
      ]
    : [];
  const packageResources = packages.map((packageName) => ({
    kind: "package",
    id: packageName,
    paths: itemPaths(item),
  }));
  const pathResources = paths.map((path) => ({
    kind: "path",
    id: path,
    paths: itemPaths(item),
  }));

  if (action === "coordinate_overlapping_prs") {
    return [
      ...packageResources,
      ...pathResources,
      ...pullRequest,
      ...queueItem,
    ];
  }
  if (action === "release_or_renew_stale_claim") {
    const staleClaim = item.claims?.stale?.[0];
    if (staleClaim?.resourceKind && staleClaim?.resourceId) {
      return [
        {
          kind: staleClaim.resourceKind,
          id: staleClaim.resourceId,
          paths: itemPaths(item),
        },
        ...pullRequest,
        ...packageResources,
        ...pathResources,
        ...queueItem,
      ];
    }
  }
  if (
    [
      "route_failed_checks",
      "rebase_or_update_branch",
      "resolve_policy_blocker",
      "wait_for_checks",
      "enter_merge_queue",
    ].includes(action)
  ) {
    return [
      ...pullRequest,
      ...packageResources,
      ...pathResources,
      ...queueItem,
    ];
  }
  return [...packageResources, ...pathResources, ...pullRequest, ...queueItem];
}

function reasonForAction(action) {
  return (
    {
      release_or_renew_stale_claim: "stale claim needs recovery",
      route_failed_checks: "failed checks need an owner",
      rebase_or_update_branch: "branch is stale",
      coordinate_overlapping_prs: "overlapping PRs need coordination",
      resolve_policy_blocker: "policy blocker needs work",
      wait_for_checks: "checks need monitoring",
      enter_merge_queue: "ready for merge queue",
      inspect: "manual inspection requested",
    }[action] ?? "agent work is claimable"
  );
}

function compareCandidates(left, right) {
  return (
    actionRank(left.action) - actionRank(right.action) ||
    right.priority - left.priority ||
    resourceKindRank(left.resource.kind) -
      resourceKindRank(right.resource.kind) ||
    String(left.itemId).localeCompare(String(right.itemId)) ||
    String(left.resource.id).localeCompare(String(right.resource.id))
  );
}

function actionRank(action) {
  return ACTION_RANK[action] ?? ACTION_RANK.inspect;
}

function resourceKindRank(kind) {
  return RESOURCE_KIND_RANK[kind] ?? 9;
}

function itemPaths(item) {
  return [
    ...new Set([
      ...arrayValue(item.impact?.paths),
      ...arrayValue(item.duplicateRisk?.sharedPaths),
    ]),
  ].sort();
}

function itemPackages(item) {
  return [
    ...new Set(
      [
        ...arrayValue(item.impact?.packages),
        ...arrayValue(item.duplicateRisk?.sharedPackages),
      ].map(String),
    ),
  ].sort();
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
