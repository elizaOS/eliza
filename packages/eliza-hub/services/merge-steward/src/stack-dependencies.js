const SUCCESSFUL_DEPENDENCY_STATES = new Set(["merged"]);
const FAILED_DEPENDENCY_STATES = new Set([
  "closed",
  "cancelled",
  "failed",
  "integration_failed",
]);

export function buildStackDependencyGraph({ queueItems = [] } = {}) {
  const items = queueItems
    .filter((item) => item && typeof item === "object")
    .map(normalizeStackItem)
    .sort(compareStackItems);
  const byId = new Map(items.map((item) => [item.id, item]));
  const byPullRequest = new Map(
    items
      .map((item) => [pullRequestKey(item), item])
      .filter(([, item]) => item.repo && item.pullRequestId != null),
  );
  const byBranch = new Map(
    items
      .map((item) => [branchKey(item.repo, item.sourceBranch), item])
      .filter(([key]) => key),
  );
  const edges = buildEdges({ items, byId, byPullRequest, byBranch });
  const dependents = reverseEdges(edges);
  const cycleItems = detectCycleItems(edges);
  const summaries = items.map((item) =>
    itemDependencySummary({
      item,
      edges,
      dependents,
      byId,
      cycleItems,
    }),
  );
  const summaryById = new Map(
    summaries.map((summary) => [summary.id, summary]),
  );
  const stacks = connectedComponents({ items, edges, dependents })
    .filter((component) => component.length > 1)
    .map((component, index) =>
      stackSummary({ component, index, edges, dependents, summaryById, byId }),
    )
    .sort(compareStacks);
  const stackedItemIds = new Set(stacks.flatMap((stack) => stack.itemIds));

  return {
    stackCount: stacks.length,
    stackedItemCount: stackedItemIds.size,
    blockedItemCount: summaries.filter(
      (summary) => summary.stackBlocked === true,
    ).length,
    missingDependencyCount: summaries.reduce(
      (count, summary) => count + summary.missingDependencies.length,
      0,
    ),
    cycleCount: stacks.filter((stack) => stack.cycleDetected === true).length,
    stacks,
    items: summaries,
  };
}

export function applyStackDependencyEvidence(queueItems = []) {
  const items = queueItems.filter((item) => item && typeof item === "object");
  if (items.length === 0) return [];

  const graph = buildStackDependencyGraph({ queueItems: items });
  const summariesById = new Map(
    graph.items.map((summary) => [summary.id, summary]),
  );

  return items.map((item) => {
    const summary = summariesById.get(normalizeStackItem(item).id);
    const evidence = stackDependencyEvidence(summary);
    if (!evidence)
      return item.stackDependency ? item : { ...item, stackDependency: null };
    return {
      ...item,
      stackDependency: evidence,
    };
  });
}

function normalizeStackItem(item) {
  const repo = stringOrNull(item.repo);
  const pullRequestId =
    item.pullRequestId ?? item.number ?? item.prNumber ?? null;
  const id =
    stringOrNull(item.id) ??
    (repo && pullRequestId != null ? `${repo}#${pullRequestId}` : null);
  return {
    raw: item,
    id:
      id ??
      `item:${stableString(item.sourceBranch ?? item.targetBranch ?? JSON.stringify(item))}`,
    repo,
    pullRequestId,
    sourceBranch: stringOrNull(
      item.sourceBranch ?? item.headBranch ?? item.head?.ref,
    ),
    targetBranch: stringOrNull(
      item.targetBranch ?? item.baseBranch ?? item.base?.ref,
    ),
    ownerAgentId: stringOrNull(item.ownerAgentId),
    queueState: stringOrNull(item.queueState),
    explicitDependencies: explicitDependenciesFor(item),
  };
}

function buildEdges({ items, byId, byPullRequest, byBranch }) {
  const edges = new Map();
  for (const item of items) {
    const dependencies = new Map();
    const branchDependency = byBranch.get(
      branchKey(item.repo, item.targetBranch),
    );
    if (branchDependency && branchDependency.id !== item.id) {
      dependencies.set(
        branchDependency.id,
        dependencyRef(branchDependency, "target_branch"),
      );
    }

    for (const dependency of item.explicitDependencies) {
      const resolved = resolveDependency({
        dependency,
        item,
        byId,
        byPullRequest,
        byBranch,
      });
      const key = resolved?.id ?? missingDependencyId(item, dependency);
      if (key && key !== item.id) {
        dependencies.set(
          key,
          resolved ?? {
            id: key,
            repo: dependency.repo ?? item.repo ?? null,
            pullRequestId: dependency.pullRequestId ?? null,
            source: dependency.source,
            missing: true,
            ref: dependency.ref ?? null,
          },
        );
      }
    }

    edges.set(item.id, [...dependencies.values()].sort(compareDependencyRefs));
  }
  return edges;
}

function explicitDependenciesFor(item) {
  const values = [
    item.basePullRequestId,
    item.parentPullRequestId,
    item.stack?.parentPullRequestId,
    ...arrayValue(item.dependsOnPullRequestIds),
    ...arrayValue(item.dependsOnPrs),
    ...arrayValue(item.dependsOn),
    ...arrayValue(item.dependencies),
    ...arrayValue(item.stack?.dependsOn),
  ];
  return values.flatMap(normalizeDependencyRef);
}

function normalizeDependencyRef(value) {
  if (value == null || value === "") return [];
  if (typeof value === "number")
    return [{ pullRequestId: value, source: "explicit" }];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const prMatch = /^(.+)?#(\d+)$/.exec(trimmed);
    if (prMatch) {
      return [
        {
          repo: stringOrNull(prMatch[1]),
          pullRequestId: Number(prMatch[2]),
          ref: trimmed,
          source: "explicit",
        },
      ];
    }
    if (/^\d+$/.test(trimmed))
      return [
        { pullRequestId: Number(trimmed), ref: trimmed, source: "explicit" },
      ];
    return [{ branch: trimmed, ref: trimmed, source: "explicit" }];
  }
  if (typeof value === "object") {
    const pullRequestId =
      value.pullRequestId ?? value.prNumber ?? value.number ?? null;
    const branch = stringOrNull(
      value.branch ?? value.sourceBranch ?? value.ref,
    );
    const id = stringOrNull(value.id);
    return [
      {
        id,
        repo: stringOrNull(value.repo),
        pullRequestId: pullRequestId == null ? null : pullRequestId,
        branch,
        ref:
          value.ref ??
          id ??
          branch ??
          (pullRequestId == null ? null : String(pullRequestId)),
        source: stringOrNull(value.source) ?? "explicit",
      },
    ];
  }
  return [];
}

function resolveDependency({
  dependency,
  item,
  byId,
  byPullRequest,
  byBranch,
}) {
  if (dependency.id && byId.has(dependency.id))
    return dependencyRef(byId.get(dependency.id), dependency.source);
  const repo = dependency.repo ?? item.repo;
  if (repo && dependency.pullRequestId != null) {
    const matched = byPullRequest.get(`${repo}#${dependency.pullRequestId}`);
    if (matched) return dependencyRef(matched, dependency.source);
  }
  if (repo && dependency.branch) {
    const matched = byBranch.get(branchKey(repo, dependency.branch));
    if (matched) return dependencyRef(matched, dependency.source);
  }
  return null;
}

function itemDependencySummary({ item, edges, dependents, byId, cycleItems }) {
  const dependencies = edges.get(item.id) ?? [];
  const dependencyStatuses = dependencies.map((dependency) =>
    dependencyStatus(dependency, byId),
  );
  const blockingDependencies = dependencyStatuses.filter(
    (dependency) => dependency.state !== "merged",
  );
  const missingDependencies = dependencyStatuses.filter(
    (dependency) => dependency.state === "missing",
  );
  const failedDependencies = dependencyStatuses.filter(
    (dependency) => dependency.state === "failed",
  );
  const pendingDependencies = dependencyStatuses.filter(
    (dependency) => dependency.state === "pending",
  );
  const directDependents = dependents.get(item.id) ?? [];
  const cycleDetected = cycleItems.has(item.id);
  const stackBlocked = blockingDependencies.length > 0 || cycleDetected;
  const state = stackStateFor({
    item,
    dependencyStatuses,
    directDependents,
    stackBlocked,
    missingDependencies,
    failedDependencies,
    cycleDetected,
  });

  return {
    id: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    sourceBranch: item.sourceBranch,
    targetBranch: item.targetBranch,
    ownerAgentId: item.ownerAgentId,
    queueState: item.queueState,
    state,
    stackBlocked,
    canMergeAfterDependencies:
      !stackBlocked && !FAILED_DEPENDENCY_STATES.has(item.queueState),
    dependencies: dependencyStatuses,
    dependents: directDependents.map((id) =>
      dependencyStatus({ id, source: "dependent" }, byId),
    ),
    blockingDependencies,
    missingDependencies,
    failedDependencies,
    pendingDependencies,
    cycleDetected,
    requiredActions: requiredActionsFor({
      state,
      stackBlocked,
      missingDependencies,
      failedDependencies,
      pendingDependencies,
      cycleDetected,
    }),
    nextActions: nextActionsFor({
      state,
      stackBlocked,
      missingDependencies,
      failedDependencies,
      pendingDependencies,
      cycleDetected,
    }),
  };
}

function stackSummary({
  component,
  index,
  edges,
  dependents,
  summaryById,
  byId,
}) {
  const ordered = topologicalOrder(component, edges);
  const summaries = ordered.itemIds
    .map((id) => summaryById.get(id))
    .filter(Boolean);
  const rootItemIds = component
    .filter(
      (id) =>
        !arrayValue(edges.get(id)).some((dependency) =>
          component.includes(dependency.id),
        ),
    )
    .sort();
  const leafItemIds = component
    .filter(
      (id) =>
        !arrayValue(dependents.get(id)).some((dependent) =>
          component.includes(dependent),
        ),
    )
    .sort();
  const missingDependencyCount = summaries.reduce(
    (count, item) => count + item.missingDependencies.length,
    0,
  );
  const blockedItemIds = summaries
    .filter((item) => item.stackBlocked)
    .map((item) => item.id);
  const failedDependencyCount = summaries.reduce(
    (count, item) => count + item.failedDependencies.length,
    0,
  );
  const nextMergeItem =
    summaries.find(
      (item) =>
        item.canMergeAfterDependencies === true &&
        !SUCCESSFUL_DEPENDENCY_STATES.has(item.queueState),
    ) ?? null;
  const repo = summaries[0]?.repo ?? null;
  const rootTargetBranch =
    rootItemIds.map((id) => byId.get(id)?.targetBranch).find(Boolean) ?? null;

  return {
    id: stackId({ repo, rootTargetBranch, rootItemIds, index }),
    repo,
    rootTargetBranch,
    state: stackHealth({
      summaries,
      blockedItemIds,
      missingDependencyCount,
      failedDependencyCount,
      cycleDetected: ordered.cycleDetected,
    }),
    cycleDetected: ordered.cycleDetected,
    itemIds: summaries.map((item) => item.id),
    pullRequests: summaries.map((item) => ({
      repo: item.repo,
      pullRequestId: item.pullRequestId,
      state: item.state,
      queueState: item.queueState,
    })),
    rootItemIds,
    leafItemIds,
    blockedItemIds,
    missingDependencyCount,
    failedDependencyCount,
    nextMergeItemId: nextMergeItem?.id ?? null,
    requiredActions: unique(
      summaries.flatMap((item) => item.requiredActions),
    ).sort(),
  };
}

function stackDependencyEvidence(summary) {
  if (!summary || summary.state === "independent") return null;
  return {
    source: "stack_dependency_graph",
    state: summary.state,
    stackBlocked: summary.stackBlocked === true,
    canMergeAfterDependencies: summary.canMergeAfterDependencies === true,
    cycleDetected: summary.cycleDetected === true,
    dependencies: summary.dependencies,
    dependents: summary.dependents,
    blockingDependencies: summary.blockingDependencies,
    missingDependencies: summary.missingDependencies,
    failedDependencies: summary.failedDependencies,
    pendingDependencies: summary.pendingDependencies,
    requiredActions: summary.requiredActions,
    nextActions: summary.nextActions,
  };
}

function dependencyStatus(dependency, byId) {
  const item = byId.get(dependency.id);
  if (!item || dependency.missing === true) {
    return {
      id: dependency.id,
      repo: dependency.repo ?? null,
      pullRequestId: dependency.pullRequestId ?? null,
      state: "missing",
      source: dependency.source,
    };
  }
  const queueState = item.queueState ?? "unknown";
  return {
    id: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    sourceBranch: item.sourceBranch,
    targetBranch: item.targetBranch,
    queueState,
    state: SUCCESSFUL_DEPENDENCY_STATES.has(queueState)
      ? "merged"
      : FAILED_DEPENDENCY_STATES.has(queueState)
        ? "failed"
        : "pending",
    source: dependency.source,
  };
}

function stackStateFor({
  item,
  dependencyStatuses,
  directDependents,
  stackBlocked,
  missingDependencies,
  failedDependencies,
  cycleDetected,
}) {
  if (SUCCESSFUL_DEPENDENCY_STATES.has(item.queueState)) return "merged";
  if (FAILED_DEPENDENCY_STATES.has(item.queueState)) return "terminal";
  if (cycleDetected) return "cycle";
  if (missingDependencies.length > 0) return "missing_dependency";
  if (failedDependencies.length > 0) return "broken_dependency";
  if (stackBlocked) return "waiting_on_stack";
  if (dependencyStatuses.length > 0) return "ready_in_stack";
  if (directDependents.length > 0) return "stack_root";
  return "independent";
}

function requiredActionsFor({
  state,
  stackBlocked,
  missingDependencies,
  failedDependencies,
  pendingDependencies,
  cycleDetected,
}) {
  const actions = [];
  if (cycleDetected || state === "cycle") actions.push("repair_stack_cycle");
  if (missingDependencies.length > 0)
    actions.push("link_missing_stack_dependencies");
  if (failedDependencies.length > 0)
    actions.push("repair_or_recreate_failed_stack_parent");
  if (pendingDependencies.length > 0 || stackBlocked)
    actions.push("merge_stack_parents_first");
  if (actions.length === 0 && state === "ready_in_stack")
    actions.push("merge_after_parent_lands");
  return unique(actions);
}

function nextActionsFor({
  state,
  stackBlocked,
  missingDependencies,
  failedDependencies,
  pendingDependencies,
  cycleDetected,
}) {
  const actions = [];
  if (cycleDetected || state === "cycle") actions.push("fix_stack_cycle");
  if (missingDependencies.length > 0)
    actions.push("attach_or_remove_missing_dependency");
  if (failedDependencies.length > 0)
    actions.push("restore_failed_stack_parent");
  if (pendingDependencies.length > 0 || stackBlocked)
    actions.push("wait_for_stack_parent");
  if (state === "ready_in_stack") actions.push("enter_merge_queue");
  if (state === "stack_root") actions.push("merge_stack_root");
  if (actions.length === 0) actions.push("none");
  return unique(actions);
}

function connectedComponents({ items, edges, dependents }) {
  const seen = new Set();
  const components = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    const stack = [item.id];
    const component = [];
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      component.push(id);
      for (const dependency of arrayValue(edges.get(id))) {
        if (!seen.has(dependency.id) && edges.has(dependency.id))
          stack.push(dependency.id);
      }
      for (const dependent of arrayValue(dependents.get(id))) {
        if (!seen.has(dependent)) stack.push(dependent);
      }
    }
    components.push(component.sort());
  }
  return components;
}

function topologicalOrder(component, edges) {
  const remaining = new Set(component);
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) =>
        arrayValue(edges.get(id)).every(
          (dependency) => !remaining.has(dependency.id),
        ),
      )
      .sort();
    if (ready.length === 0) {
      ordered.push(...[...remaining].sort());
      return { itemIds: ordered, cycleDetected: true };
    }
    for (const id of ready) {
      remaining.delete(id);
      ordered.push(id);
    }
  }
  return { itemIds: ordered, cycleDetected: false };
}

function detectCycleItems(edges) {
  const cycleItems = new Set();
  const visiting = new Set();
  const visited = new Set();

  function visit(id, path = []) {
    if (visiting.has(id)) {
      for (const itemId of path.slice(path.indexOf(id))) cycleItems.add(itemId);
      cycleItems.add(id);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of arrayValue(edges.get(id))) {
      if (edges.has(dependency.id)) visit(dependency.id, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of edges.keys()) visit(id);
  return cycleItems;
}

function reverseEdges(edges) {
  const dependents = new Map();
  for (const [id, dependencies] of edges) {
    if (!dependents.has(id)) dependents.set(id, []);
    for (const dependency of dependencies) {
      dependents.set(
        dependency.id,
        [...(dependents.get(dependency.id) ?? []), id].sort(),
      );
    }
  }
  return dependents;
}

function dependencyRef(item, source) {
  return {
    id: item.id,
    repo: item.repo,
    pullRequestId: item.pullRequestId,
    sourceBranch: item.sourceBranch,
    targetBranch: item.targetBranch,
    source,
  };
}

function missingDependencyId(item, dependency) {
  if (dependency.id) return dependency.id;
  if ((dependency.repo ?? item.repo) && dependency.pullRequestId != null) {
    return `${dependency.repo ?? item.repo}#${dependency.pullRequestId}`;
  }
  if (dependency.branch)
    return `missing:${item.repo ?? "repo"}:${dependency.branch}`;
  return null;
}

function stackHealth({
  summaries,
  blockedItemIds,
  missingDependencyCount,
  failedDependencyCount,
  cycleDetected,
}) {
  if (cycleDetected) return "cycle";
  if (missingDependencyCount > 0) return "missing_dependency";
  if (failedDependencyCount > 0) return "broken_dependency";
  if (summaries.every((item) => item.state === "merged")) return "merged";
  if (blockedItemIds.length > 0) return "waiting";
  return "ready";
}

function stackId({ repo, rootTargetBranch, rootItemIds, index }) {
  const root = rootItemIds[0] ?? `stack-${index + 1}`;
  return `stack:${slugFor(repo ?? "repo")}:${slugFor(rootTargetBranch ?? "branch")}:${slugFor(root)}`;
}

function pullRequestKey(item) {
  return item.repo && item.pullRequestId != null
    ? `${item.repo}#${item.pullRequestId}`
    : null;
}

function branchKey(repo, branch) {
  return repo && branch ? `${repo}:${branch}` : null;
}

function compareDependencyRefs(left, right) {
  return (
    String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
    numeric(left.pullRequestId) - numeric(right.pullRequestId) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareStackItems(left, right) {
  return (
    String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
    numeric(left.pullRequestId) - numeric(right.pullRequestId) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function compareStacks(left, right) {
  return (
    String(left.repo ?? "").localeCompare(String(right.repo ?? "")) ||
    String(left.rootTargetBranch ?? "").localeCompare(
      String(right.rootTargetBranch ?? ""),
    ) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function stringOrNull(value) {
  return value == null || value === "" ? null : String(value);
}

function stableString(value) {
  return String(value).replace(/\s+/g, "-").slice(0, 80);
}

function slugFor(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "value";
}

function arrayValue(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function unique(values = []) {
  return [
    ...new Set(
      values
        .filter((value) => value != null && value !== "")
        .map((value) => String(value)),
    ),
  ];
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}
