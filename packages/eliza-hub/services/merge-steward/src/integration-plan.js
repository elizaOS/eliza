import { scheduleQueue } from "./policy.js";

const DEFAULT_MAX_BATCH_SIZE = 4;

export function buildIntegrationPlan({ items = [], policy, config = {} } = {}) {
  const scheduled = scheduleQueue(items, policy);
  const selection = selectIntegrationCandidates(scheduled, config);
  const plans = selection.candidates.map((item, index) =>
    buildPlanForItem({ item, index, config }),
  );

  return {
    enabled: config.enabled === true,
    dryRun: config.dryRun !== false,
    strategy: selection.batch.enabled ? "batch" : "single-pr",
    batch: selection.batch,
    branchPrefix: config.branchPrefix ?? "eliza-queue",
    queuedCount: scheduled.length,
    planCount: plans.length,
    plans,
    skippedItems: selection.skippedItems,
    skipped: scheduled.length === 0,
    reason: scheduled.length === 0 ? "no_ready_items" : null,
  };
}

export function buildBatchEligibilityIndex({
  scheduled = [],
  config = {},
} = {}) {
  const selection = selectIntegrationCandidates(scheduled, config);
  const selectedKeys = new Set(selection.candidates.map(queueItemIdentity));
  const skippedByKey = new Map(
    selection.skippedItems.map((item) => [queueItemIdentity(item), item]),
  );
  const index = new Map();

  for (const item of scheduled) {
    const key = queueItemIdentity(item);
    const skipped = skippedByKey.get(key);
    index.set(key, {
      key,
      eligible: selectedKeys.has(key),
      selected: selectedKeys.has(key),
      reason: selectedKeys.has(key)
        ? "selected"
        : (skipped?.reason ?? "not_selected"),
      mode: selection.batch.mode,
      batchingEnabled: selection.batch.enabled,
      maxBatchSize: selection.batch.maxBatchSize,
      selectedCount: selection.batch.selectedCount,
      skippedCount: selection.batch.skippedCount,
    });
  }

  return {
    index,
    selectedItemIds: selection.candidates.map(
      (item) => item.id ?? queueItemIdentity(item),
    ),
    skippedItems: selection.skippedItems,
    batch: selection.batch,
  };
}

export function selectIntegrationCandidates(scheduled = [], config = {}) {
  if (scheduled.length === 0) {
    return {
      candidates: [],
      skippedItems: [],
      batch: {
        enabled: false,
        mode: "safe-disjoint",
        maxBatchSize: 0,
        selectedCount: 0,
        skippedCount: 0,
        reason: "no_ready_items",
      },
    };
  }

  const lead = scheduled[0];
  const batchEnabled =
    config.allowBatching === true ||
    lead.policySnapshot?.queueMode === "batched";
  if (!batchEnabled) {
    return {
      candidates: [lead],
      skippedItems: scheduled
        .slice(1)
        .map((item) => skippedItem(item, "serialized_queue")),
      batch: {
        enabled: false,
        mode: "safe-disjoint",
        maxBatchSize: 1,
        selectedCount: 1,
        skippedCount: Math.max(0, scheduled.length - 1),
      },
    };
  }

  const maxBatchSize = batchMaxSize({ config, item: lead });
  if (!isLowRiskBatchItem(lead)) {
    return {
      candidates: [lead],
      skippedItems: scheduled
        .slice(1)
        .map((item) => skippedItem(item, "lead_item_not_batch_safe")),
      batch: {
        enabled: true,
        mode: "safe-disjoint",
        maxBatchSize,
        selectedCount: 1,
        skippedCount: Math.max(0, scheduled.length - 1),
        policyQueueMode: lead.policySnapshot?.queueMode ?? null,
      },
    };
  }

  const selected = [];
  const skippedItems = [];
  const impact = {
    paths: new Set(),
    packages: new Set(),
  };

  for (const item of scheduled) {
    const reason = batchSkipReason({
      lead,
      item,
      selected,
      impact,
      maxBatchSize,
    });
    if (reason) {
      skippedItems.push(skippedItem(item, reason));
      continue;
    }

    selected.push(item);
    addImpact(impact, itemImpact(item));
  }

  return {
    candidates: selected.length ? selected : [lead],
    skippedItems,
    batch: {
      enabled: true,
      mode: "safe-disjoint",
      maxBatchSize,
      selectedCount: selected.length || 1,
      skippedCount: skippedItems.length,
      policyQueueMode: lead.policySnapshot?.queueMode ?? null,
    },
  };
}

export function buildPlanForItem({ item, index = 0, config = {} } = {}) {
  const branchPrefix = config.branchPrefix ?? "eliza-queue";
  const integrationBranch = integrationBranchName({
    branchPrefix,
    item,
    index,
  });
  const requiredChecks = item.requiredChecks ?? [];

  return {
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    queuePosition: item.queuePosition ?? index + 1,
    targetBranch: item.targetBranch,
    sourceBranch: item.sourceBranch,
    headSha: item.headSha ?? null,
    integrationBranch,
    requiredChecks,
    risk: item.risk ?? null,
    conflict: item.conflict ?? null,
    actions: [
      {
        type: "ensure_integration_branch",
        branch: integrationBranch,
        from: item.targetBranch,
        mode: config.branchMode ?? "reset",
      },
      {
        type: "merge_pr_head_into_integration",
        sourceBranch: item.sourceBranch,
        headSha: item.headSha ?? null,
      },
      {
        type: "wait_for_checks",
        branch: integrationBranch,
        requiredChecks,
      },
      {
        type: "merge_original_pull_request",
        pullRequestId: item.pullRequestId,
        expectedHeadSha: item.headSha ?? null,
      },
    ],
  };
}

export function integrationBranchName({
  branchPrefix = "eliza-queue",
  item = {},
  index = 0,
} = {}) {
  const repoSlug = slug(`${item.repo ?? "repo"}`);
  const targetSlug = slug(item.targetBranch ?? "target");
  const pullRequestId = slug(item.pullRequestId ?? index + 1);
  return `${trimSlashes(branchPrefix)}/${targetSlug}/${repoSlug}-pr-${pullRequestId}`;
}

function slug(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function trimSlashes(value) {
  return String(value).replace(/^\/+|\/+$/g, "") || "eliza-queue";
}

function batchSkipReason({ lead, item, selected, impact, maxBatchSize }) {
  if (selected.length >= maxBatchSize) return "max_batch_size";
  if (item.repo !== lead.repo || item.targetBranch !== lead.targetBranch)
    return "different_queue_lane";
  if (!isLowRiskBatchItem(item))
    return selected.length === 0
      ? "lead_item_not_batch_safe"
      : "item_not_batch_safe";

  const nextImpact = itemImpact(item);
  if (selected.length > 0 && !hasKnownImpact(nextImpact))
    return "unknown_batch_impact";
  if (
    overlaps(impact.paths, nextImpact.paths) ||
    overlaps(impact.packages, nextImpact.packages)
  ) {
    return "batch_impact_overlap";
  }

  return null;
}

function isLowRiskBatchItem(item) {
  return item.risk?.level === "low" && item.conflict?.level === "low";
}

function itemImpact(item) {
  const paths = arrayValue(item.affectedPaths).length
    ? arrayValue(item.affectedPaths)
    : arrayValue(item.changedFiles);
  return {
    paths,
    packages: arrayValue(item.affectedPackages),
  };
}

function addImpact(impact, nextImpact) {
  for (const path of nextImpact.paths) impact.paths.add(path);
  for (const packageName of nextImpact.packages)
    impact.packages.add(packageName);
}

function hasKnownImpact(impact) {
  return impact.paths.length > 0 || impact.packages.length > 0;
}

function overlaps(left, right) {
  return right.some((value) => left.has(value));
}

function batchMaxSize({ config, item }) {
  const values = [
    positiveInteger(config.maxBatchSize),
    positiveInteger(item.policySnapshot?.policy?.maxBatchSize),
    DEFAULT_MAX_BATCH_SIZE,
  ].filter((value) => Number.isInteger(value) && value > 0);
  return Math.max(1, Math.min(...values));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function skippedItem(item, reason) {
  return {
    id: item.id ?? queueItemIdentity(item),
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    targetBranch: item.targetBranch,
    reason,
  };
}

function queueItemIdentity(item) {
  if (item.repo && item.pullRequestId != null)
    return `${item.repo}#${item.pullRequestId}`;
  return String(item.id ?? "");
}
