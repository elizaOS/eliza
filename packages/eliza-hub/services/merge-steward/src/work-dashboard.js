import { buildWorkProgress } from "./work-progress.js";

const BUILT_IN_VIEWS = Object.freeze([
  {
    id: "builtin:needs-human",
    title: "Needs Human",
    kind: "kanban",
    filters: { state: ["needs_human_review"] },
  },
  {
    id: "builtin:blocked",
    title: "Blocked",
    kind: "kanban",
    filters: { state: ["blocked"] },
  },
  {
    id: "builtin:ready",
    title: "Ready",
    kind: "kanban",
    filters: { state: ["backlog", "ready"] },
  },
  {
    id: "builtin:active",
    title: "Active",
    kind: "kanban",
    filters: { state: ["claimed", "in_progress", "merge_queue"] },
  },
  {
    id: "builtin:done",
    title: "Done",
    kind: "list",
    filters: { state: ["done"] },
  },
  {
    id: "builtin:unscoped",
    title: "Unscoped",
    kind: "list",
    filters: { unscoped: true },
  },
]);

export function buildWorkDashboard({
  workItems = [],
  cycles = [],
  modules = [],
  views = [],
  pages = [],
  progress,
  repo,
  ownerAgentId,
  now = new Date().toISOString(),
  maxItemIds = 50,
} = {}) {
  const itemIdLimit = positiveInteger(maxItemIds, 50);
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
  const scopedPages = arrayValue(pages)
    .filter((page) => page.state !== "archived")
    .filter((page) => matchesScope(page, filters));
  const scopedViews = arrayValue(views)
    .filter((view) => view.state !== "archived")
    .filter((view) => matchesViewScope(view, filters));

  const builtInViews = BUILT_IN_VIEWS.map((view) =>
    viewSnapshot({
      view,
      items: scopedItems,
      cycles: scopedCycles,
      modules: scopedModules,
      pages: scopedPages,
      maxItemIds: itemIdLimit,
      builtIn: true,
    }),
  );
  const savedViews = scopedViews.map((view) =>
    viewSnapshot({
      view,
      items: scopedItems,
      cycles: scopedCycles,
      modules: scopedModules,
      pages: scopedPages,
      maxItemIds: itemIdLimit,
      builtIn: false,
    }),
  );

  return {
    computedAt: now,
    filters,
    summary: {
      workItems: scopedItems.length,
      cycles: scopedCycles.length,
      modules: scopedModules.length,
      pages: scopedPages.length,
      savedViews: savedViews.length,
      needsHuman:
        builtInViews.find((view) => view.id === "builtin:needs-human")?.count ??
        0,
      blocked:
        builtInViews.find((view) => view.id === "builtin:blocked")?.count ?? 0,
      ready:
        builtInViews.find((view) => view.id === "builtin:ready")?.count ?? 0,
      active:
        builtInViews.find((view) => view.id === "builtin:active")?.count ?? 0,
      done: builtInViews.find((view) => view.id === "builtin:done")?.count ?? 0,
      unscoped:
        builtInViews.find((view) => view.id === "builtin:unscoped")?.count ?? 0,
    },
    progress:
      progress ??
      buildWorkProgress({
        workItems: scopedItems,
        cycles: scopedCycles,
        modules: scopedModules,
        repo: filters.repo,
        ownerAgentId: filters.ownerAgentId,
        now,
      }),
    views: {
      builtIn: builtInViews,
      saved: savedViews,
    },
  };
}

export function buildWorkViewEvaluation({
  view,
  workItems = [],
  cycles = [],
  modules = [],
  pages = [],
  repo,
  ownerAgentId,
  now = new Date().toISOString(),
  maxItems = 100,
  maxPages = 50,
} = {}) {
  const normalizedView =
    view && typeof view === "object" && !Array.isArray(view) ? view : null;
  if (!normalizedView?.id && !normalizedView?.title) {
    throw new TypeError("Work view evaluation requires a view");
  }

  const filters = {
    repo: stringOrNull(repo ?? normalizedView.repo),
    ownerAgentId: stringOrNull(ownerAgentId ?? normalizedView.ownerAgentId),
  };
  const itemLimit = positiveInteger(maxItems, 100);
  const pageLimit = positiveInteger(maxPages, 50);
  const scopedItems = arrayValue(workItems).filter((item) =>
    matchesScope(item, filters),
  );
  const scopedCycles = arrayValue(cycles).filter((cycle) =>
    matchesScope(cycle, filters),
  );
  const scopedModules = arrayValue(modules).filter((module) =>
    matchesScope(module, filters),
  );
  const scopedPages = arrayValue(pages)
    .filter((page) => page.state !== "archived")
    .filter((page) => matchesScope(page, filters));
  const viewFacts = evaluateViewFacts({
    view: normalizedView,
    items: scopedItems,
    cycles: scopedCycles,
    modules: scopedModules,
    pages: scopedPages,
    maxItemIds: itemLimit,
  });
  const rows = viewFacts.matchedItems.slice(0, itemLimit).map((item) =>
    workItemRow({
      item,
      cycles: scopedCycles,
      modules: scopedModules,
      pages: viewFacts.matchedPages,
    }),
  );
  const pageRows = viewFacts.matchedPages.slice(0, pageLimit).map(pageRow);

  return {
    computedAt: now,
    filters,
    view: {
      id: normalizedView.id ?? null,
      title: normalizedView.title ?? null,
      kind: normalizedView.kind ?? "list",
      builtIn: normalizedView.builtIn === true,
      query: normalizedView.query ?? null,
      filters: viewFacts.filters,
      layout: normalizedView.layout ?? {},
    },
    summary: {
      totalItems: viewFacts.matchedItems.length,
      returnedItems: rows.length,
      totalPages: viewFacts.matchedPages.length,
      returnedPages: pageRows.length,
      truncated: viewFacts.matchedItems.length > itemLimit,
      pagesTruncated: viewFacts.matchedPages.length > pageLimit,
      progress: summarizeItems(viewFacts.matchedItems),
    },
    snapshot: viewFacts.snapshot,
    columns: columnsForView({ view: normalizedView, rows }),
    rows,
    pages: pageRows,
    cycles: scopedCycles
      .filter((cycle) => viewFacts.cycleIds.has(cycle.id))
      .map(scopeChip),
    modules: scopedModules
      .filter((module) => viewFacts.moduleIds.has(module.id))
      .map(scopeChip),
    nextActions: nextActionsForEvaluation({
      view: normalizedView,
      rows,
      pages: pageRows,
      summary: viewFacts.snapshot.progress,
    }),
  };
}

function viewSnapshot({
  view,
  items,
  cycles,
  modules,
  pages,
  maxItemIds,
  builtIn,
}) {
  return evaluateViewFacts({
    view,
    items,
    cycles,
    modules,
    pages,
    maxItemIds,
    builtIn,
  }).snapshot;
}

function evaluateViewFacts({
  view,
  items,
  cycles,
  modules,
  pages,
  maxItemIds,
  builtIn = false,
}) {
  const filters = normalizeViewFilters(view.filters);
  const matchedItems = items.filter((item) =>
    matchesViewFilters(item, filters, view.query),
  );
  const cycleIds = new Set(
    matchedItems.map((item) => item.cycleId).filter(Boolean),
  );
  const moduleIds = new Set(
    matchedItems.map((item) => item.moduleId).filter(Boolean),
  );
  const itemIds = new Set(matchedItems.map((item) => item.id).filter(Boolean));
  const matchedPages = pages.filter(
    (page) =>
      itemIds.has(page.workItemId) ||
      (page.cycleId && cycleIds.has(page.cycleId)) ||
      (page.moduleId && moduleIds.has(page.moduleId)),
  );

  return {
    filters,
    matchedItems,
    matchedPages,
    cycleIds,
    moduleIds,
    snapshot: {
      id: view.id,
      title: view.title,
      kind: view.kind ?? "list",
      builtIn,
      repo: view.repo ?? null,
      ownerAgentId: view.ownerAgentId ?? null,
      query: view.query ?? null,
      filters,
      count: matchedItems.length,
      itemIds: matchedItems.slice(0, maxItemIds).map((item) => item.id),
      pageIds: matchedPages.slice(0, maxItemIds).map((page) => page.id),
      truncated: matchedItems.length > maxItemIds,
      pagesTruncated: matchedPages.length > maxItemIds,
      cycleIds: [...cycleIds].sort(),
      moduleIds: [...moduleIds].sort(),
      cycles: cycles.filter((cycle) => cycleIds.has(cycle.id)).map(scopeChip),
      modules: modules
        .filter((module) => moduleIds.has(module.id))
        .map(scopeChip),
      progress: summarizeItems(matchedItems),
      updatedAt: view.updatedAt ?? view.createdAt ?? null,
    },
  };
}

function workItemRow({ item, cycles, modules, pages }) {
  return {
    id: item.id,
    title: item.title ?? item.id,
    state: item.state ?? null,
    kind: item.kind ?? null,
    priority: item.priority ?? 0,
    ownerAgentId: item.ownerAgentId ?? null,
    repo: item.repo ?? null,
    targetBranch: item.targetBranch ?? null,
    taskId: item.taskId ?? null,
    issueId: item.issueId ?? null,
    pullRequestId: item.pullRequestId ?? null,
    cycle: scopeChip(cycles.find((cycle) => cycle.id === item.cycleId)),
    module: scopeChip(modules.find((module) => module.id === item.moduleId)),
    paths: arrayValue(item.paths),
    packages: arrayValue(item.packages),
    labels: arrayValue(item.labels),
    pageIds: pages
      .filter((page) => page.workItemId === item.id)
      .map((page) => page.id)
      .sort(),
    updatedAt: item.updatedAt ?? item.createdAt ?? null,
  };
}

function pageRow(page) {
  return {
    id: page.id,
    title: page.title ?? page.id,
    kind: page.kind ?? null,
    state: page.state ?? null,
    workItemId: page.workItemId ?? null,
    cycleId: page.cycleId ?? null,
    moduleId: page.moduleId ?? null,
    updatedAt: page.updatedAt ?? page.createdAt ?? null,
  };
}

function columnsForView({ view, rows }) {
  const layoutColumns = arrayValue(view.layout?.columns ?? view.columns)
    .map((column) =>
      typeof column === "string" ? { id: column, title: column } : column,
    )
    .filter((column) => column?.id);
  const columns =
    layoutColumns.length > 0
      ? layoutColumns
      : [...new Set(rows.map((row) => row.state ?? "unknown"))]
          .sort()
          .map((state) => ({ id: state, title: titleCase(state) }));

  return columns.map((column) => ({
    id: column.id,
    title: column.title ?? titleCase(column.id),
    itemIds: rows
      .filter((row) => (row.state ?? "unknown") === column.id)
      .map((row) => row.id),
    count: rows.filter((row) => (row.state ?? "unknown") === column.id).length,
  }));
}

function nextActionsForEvaluation({ view, rows, pages, summary }) {
  const actions = [];
  if (rows.length === 0) {
    actions.push("relax_view_filters_or_create_matching_work");
  }
  if (summary?.byState?.blocked > 0) {
    actions.push("triage_blocked_work");
  }
  if (summary?.byState?.needs_human_review > 0) {
    actions.push("resolve_human_review_items");
  }
  if ((view.kind ?? "list") === "kanban" && rows.length > 0) {
    actions.push("review_column_flow");
  }
  if (pages.length > 0) {
    actions.push("read_linked_work_pages");
  }
  return uniqueStrings(actions);
}

function matchesViewFilters(item, filters, query) {
  if (filters.unscoped && (item.cycleId || item.moduleId)) return false;
  if (filters.state.length > 0 && !filters.state.includes(item.state))
    return false;
  if (filters.kind.length > 0 && !filters.kind.includes(item.kind))
    return false;
  if (
    filters.ownerAgentId.length > 0 &&
    !filters.ownerAgentId.includes(item.ownerAgentId)
  )
    return false;
  if (filters.cycleId.length > 0 && !filters.cycleId.includes(item.cycleId))
    return false;
  if (filters.moduleId.length > 0 && !filters.moduleId.includes(item.moduleId))
    return false;
  if (!includesAll(arrayValue(item.labels), filters.labels)) return false;
  if (!includesAll(arrayValue(item.packages), filters.packages)) return false;
  if (!matchesQuery(item, query)) return false;
  return true;
}

function normalizeViewFilters(filters = {}) {
  return {
    state: uniqueStrings(filters.state ?? filters.states),
    kind: uniqueStrings(filters.kind ?? filters.kinds),
    ownerAgentId: uniqueStrings(
      filters.ownerAgentId ?? filters.ownerAgentIds ?? filters.owner_agent_id,
    ),
    cycleId: uniqueStrings(
      filters.cycleId ?? filters.cycleIds ?? filters.cycle_id,
    ),
    moduleId: uniqueStrings(
      filters.moduleId ?? filters.moduleIds ?? filters.module_id,
    ),
    labels: uniqueStrings(filters.labels ?? filters.label),
    packages: uniqueStrings(filters.packages ?? filters.package),
    unscoped: filters.unscoped === true,
  };
}

function summarizeItems(items) {
  const byState = {};
  const ownerAgentIds = new Set();
  const packages = new Set();
  let latestUpdatedAt = null;

  for (const item of items) {
    const state = item.state ?? "unknown";
    byState[state] = (byState[state] ?? 0) + 1;
    if (item.ownerAgentId) ownerAgentIds.add(item.ownerAgentId);
    for (const packageName of arrayValue(item.packages)) {
      packages.add(String(packageName));
    }
    latestUpdatedAt = maxIso(latestUpdatedAt, item.updatedAt ?? item.createdAt);
  }

  return {
    total: items.length,
    byState,
    ownerAgentIds: [...ownerAgentIds].sort(),
    packages: [...packages].sort(),
    latestUpdatedAt,
  };
}

function scopeChip(scope = {}) {
  if (!scope?.id) return null;
  return {
    id: scope.id,
    title: scope.title ?? scope.id,
    state: scope.state ?? null,
    ownerAgentId: scope.ownerAgentId ?? null,
  };
}

function matchesScope(value = {}, filters = {}) {
  if (filters.repo && value.repo !== filters.repo) return false;
  if (filters.ownerAgentId && value.ownerAgentId !== filters.ownerAgentId)
    return false;
  return true;
}

function matchesViewScope(view = {}, filters = {}) {
  if (filters.repo && view.repo && view.repo !== filters.repo) return false;
  if (
    filters.ownerAgentId &&
    view.ownerAgentId &&
    view.ownerAgentId !== filters.ownerAgentId
  )
    return false;
  return true;
}

function matchesQuery(item, query) {
  const normalizedQuery = stringOrNull(query);
  if (!normalizedQuery) return true;
  const haystack = [
    item.id,
    item.title,
    item.summary,
    item.taskId,
    item.issueId,
    item.pullRequestId,
    ...arrayValue(item.labels),
    ...arrayValue(item.packages),
    ...arrayValue(item.paths),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return normalizedQuery
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function includesAll(values, required) {
  if (required.length === 0) return true;
  const valueSet = new Set(values.map((value) => String(value)));
  return required.every((value) => valueSet.has(value));
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function titleCase(value) {
  return String(value ?? "unknown")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
