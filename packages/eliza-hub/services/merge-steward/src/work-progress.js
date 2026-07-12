const DONE_STATES = new Set(["done"]);
const BLOCKED_STATES = new Set(["blocked", "needs_human_review"]);
const ACTIVE_STATES = new Set(["claimed", "in_progress", "merge_queue"]);
const READY_STATES = new Set(["ready", "backlog"]);

export function buildWorkProgress({
  workItems = [],
  cycles = [],
  modules = [],
  repo,
  ownerAgentId,
  now = new Date().toISOString(),
} = {}) {
  const filters = {
    repo: stringOrNull(repo),
    ownerAgentId: stringOrNull(ownerAgentId),
  };
  const scopedItems = arrayValue(workItems).filter((item) =>
    matchesScope(item, filters),
  );
  const scopedCycles = arrayValue(cycles).filter((cycle) =>
    matchesScope(cycle, filters),
  );
  const scopedModules = arrayValue(modules).filter((module) =>
    matchesScope(module, filters),
  );

  return {
    computedAt: now,
    filters,
    summary: {
      ...progressForItems(scopedItems),
      cycles: scopedCycles.length,
      modules: scopedModules.length,
    },
    cycles: scopedCycles.sort(compareWorkScopes).map((cycle) => {
      const cycleItems = scopedItems.filter(
        (item) => item.cycleId === cycle.id,
      );
      return {
        ...workScopeSummary(cycle),
        progress: progressForItems(cycleItems),
      };
    }),
    modules: scopedModules.sort(compareWorkScopes).map((module) => {
      const moduleItems = scopedItems.filter(
        (item) => item.moduleId === module.id,
      );
      return {
        ...workScopeSummary(module),
        progress: progressForItems(moduleItems),
      };
    }),
    unscoped: {
      all: progressForItems(
        scopedItems.filter((item) => !item.cycleId && !item.moduleId),
      ),
      cycles: progressForItems(scopedItems.filter((item) => !item.cycleId)),
      modules: progressForItems(scopedItems.filter((item) => !item.moduleId)),
    },
  };
}

function progressForItems(items = []) {
  const scopedItems = arrayValue(items);
  const byState = {};
  const ownerAgentIds = new Set();
  const packages = new Set();
  let done = 0;
  let blocked = 0;
  let active = 0;
  let ready = 0;
  let latestUpdatedAt = null;

  for (const item of scopedItems) {
    const state = item.state ?? "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
    if (DONE_STATES.has(state)) done += 1;
    if (BLOCKED_STATES.has(state)) blocked += 1;
    if (ACTIVE_STATES.has(state)) active += 1;
    if (READY_STATES.has(state)) ready += 1;
    if (item.ownerAgentId) ownerAgentIds.add(item.ownerAgentId);
    for (const packageName of arrayValue(item.packages)) {
      packages.add(String(packageName));
    }
    latestUpdatedAt = maxIso(latestUpdatedAt, item.updatedAt ?? item.createdAt);
  }

  return {
    total: scopedItems.length,
    byState,
    done,
    blocked,
    active,
    ready,
    percentComplete:
      scopedItems.length > 0
        ? Math.round((done / scopedItems.length) * 100)
        : 0,
    ownerAgentIds: [...ownerAgentIds].sort(),
    packages: [...packages].sort(),
    latestUpdatedAt,
  };
}

function workScopeSummary(scope = {}) {
  return {
    id: scope.id,
    repo: scope.repo ?? null,
    state: scope.state ?? null,
    title: scope.title ?? scope.id ?? null,
    summary: scope.summary ?? null,
    ownerAgentId: scope.ownerAgentId ?? null,
    startAt: scope.startAt ?? null,
    endAt: scope.endAt ?? null,
    paths: arrayValue(scope.paths),
    packages: arrayValue(scope.packages),
    labels: arrayValue(scope.labels),
    updatedAt: scope.updatedAt ?? scope.createdAt ?? null,
  };
}

function matchesScope(value = {}, filters = {}) {
  if (filters.repo && value.repo !== filters.repo) return false;
  if (filters.ownerAgentId && value.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function compareWorkScopes(left, right) {
  return (
    String(right.updatedAt ?? right.createdAt ?? "").localeCompare(
      String(left.updatedAt ?? left.createdAt ?? ""),
    ) ||
    String(left.title ?? left.id ?? "").localeCompare(
      String(right.title ?? right.id ?? ""),
    ) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function maxIso(left, right) {
  if (!right) return left;
  if (!left) return right;
  return String(right).localeCompare(String(left)) > 0 ? right : left;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}
