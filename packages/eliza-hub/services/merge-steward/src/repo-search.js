export const DEFAULT_REPO_SEARCH_LIMITS = Object.freeze({
  maxResults: 20,
  maxDocuments: 250,
  maxSnippets: 3,
  maxFieldLength: 4000,
});

const KIND_HINTS = Object.freeze({
  actions_log: [
    "action",
    "actions",
    "ci",
    "check",
    "failure",
    "log",
    "runner",
    "test",
    "workflow",
  ],
  approval: ["approval", "approve", "human", "review"],
  claim: ["claim", "lease", "owner", "owned", "reservation"],
  diff: ["change", "diff", "file", "patch"],
  human_request: ["ask", "blocked", "human", "question", "request"],
  issue: ["issue", "task", "ticket"],
  pull_request: ["branch", "merge", "pr", "pull", "review"],
  run: ["agent", "attempt", "failed", "run", "workflow"],
  signal: ["event", "signal", "webhook"],
  work_cycle: ["cycle", "iteration", "milestone", "sprint", "timeline"],
  work_item: ["agent", "backlog", "board", "kanban", "task", "todo", "work"],
  work_module: ["area", "component", "module", "package", "path", "team"],
  work_page: [
    "agent",
    "decision",
    "docs",
    "note",
    "page",
    "plan",
    "release",
    "runbook",
    "spec",
  ],
  work_view: ["dashboard", "filter", "saved", "spreadsheet", "view"],
});

export function buildRepoSearch({
  query,
  q,
  repo,
  targetBranch,
  ownerAgentId,
  kinds,
  queueItems = [],
  workItems = [],
  workCycles = [],
  workModules = [],
  workViews = [],
  workPages = [],
  claims = [],
  runs = [],
  approvals = [],
  humanRequests = [],
  signals = [],
  documents = [],
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const effectiveLimits = normalizeLimits(limits);
  const normalizedQuery = normalizeQuery(query ?? q);
  const filters = {
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
    ownerAgentId: stringOrNull(ownerAgentId),
    kinds: uniqueStrings(kinds),
  };
  const queryModel = buildQueryModel(normalizedQuery);
  const sourceDocuments = buildDocuments({
    queueItems,
    workItems,
    workCycles,
    workModules,
    workViews,
    workPages,
    claims,
    runs,
    approvals,
    humanRequests,
    signals,
    documents,
    limits: effectiveLimits,
  });
  const scored = sourceDocuments
    .filter((document) => matchesFilters(document, filters))
    .map((document) =>
      scoreDocument({ document, queryModel, limits: effectiveLimits }),
    )
    .filter((result) => queryModel.empty || result.score > 0)
    .sort(compareResults);
  const results = scored
    .slice(0, effectiveLimits.maxResults)
    .map((result, index) => ({
      rank: index + 1,
      ...result,
    }));

  return {
    computedAt: now,
    query: normalizedQuery,
    filters,
    summary: {
      searchedDocuments: sourceDocuments.length,
      matchedDocuments: scored.length,
      returnedResults: results.length,
      queryTokens: queryModel.tokens,
    },
    facets: facetsFor(results),
    results,
    labels: labelsFor({ queryModel, results }),
  };
}

function buildDocuments({
  queueItems,
  workItems,
  workCycles,
  workModules,
  workViews,
  workPages,
  claims,
  runs,
  approvals,
  humanRequests,
  signals,
  documents,
  limits,
}) {
  return [
    ...arrayValue(queueItems).map(queueItemDocument),
    ...arrayValue(workItems).map(workItemDocument),
    ...arrayValue(workCycles).map(workCycleDocument),
    ...arrayValue(workModules).map(workModuleDocument),
    ...arrayValue(workViews).map(workViewDocument),
    ...arrayValue(workPages).map(workPageDocument),
    ...arrayValue(claims).map(claimDocument),
    ...arrayValue(runs).map(runDocument),
    ...arrayValue(approvals).map(approvalDocument),
    ...arrayValue(humanRequests).map(humanRequestDocument),
    ...arrayValue(signals).map(signalDocument),
    ...arrayValue(documents).map(externalDocument),
  ]
    .filter(Boolean)
    .slice(0, limits.maxDocuments)
    .map((document) => truncateDocument(document, limits));
}

function queueItemDocument(item) {
  const repo = item.repo ?? null;
  const pullRequestId = item.pullRequestId ?? item.number ?? null;
  const id =
    item.id ??
    (repo && pullRequestId != null ? `${repo}#${pullRequestId}` : null);
  const title =
    item.title ??
    item.summary ??
    (pullRequestId != null
      ? `${repo ?? "repo"} #${pullRequestId}`
      : "queue item");
  const checkResults =
    item.checkResults && typeof item.checkResults === "object"
      ? item.checkResults
      : {};
  return document({
    kind: "pull_request",
    id,
    repo,
    targetBranch: item.targetBranch,
    ownerAgentId: item.ownerAgentId ?? item.suggestedOwnerAgentId,
    title,
    summary: item.summary ?? null,
    url: item.url ?? item.htmlUrl ?? null,
    fields: {
      queueState: item.queueState,
      sourceBranch: item.sourceBranch,
      authorKind: item.authorKind,
      changedFiles: item.changedFiles,
      affectedPackages: item.affectedPackages,
      labels: item.labels,
      requiredChecks: item.requiredChecks,
      checkResults: Object.entries(checkResults).map(
        ([name, state]) => `${name}:${state}`,
      ),
      nextActions: item.nextActions,
      blockers: item.decision?.blockers,
      recommendations: arrayValue(item.recommendations).map((recommendation) =>
        [recommendation.action, recommendation.reason, recommendation.title]
          .filter(Boolean)
          .join(" "),
      ),
      commitSummary: item.commitSummary,
      commits: arrayValue(item.commits).map(
        (commit) => commit.message ?? commit.sha,
      ),
      body: item.body ?? item.description,
    },
    metadata: {
      pullRequestId,
      queueState: item.queueState ?? null,
      priority: numberOrZero(item.priority),
    },
  });
}

function workItemDocument(item) {
  return document({
    kind: "work_item",
    id: item.id ?? null,
    repo: item.repo,
    targetBranch: item.targetBranch,
    ownerAgentId: item.ownerAgentId,
    title: item.title ?? item.id ?? "work item",
    summary: item.summary ?? item.state ?? null,
    url: item.sourceUrl ?? item.url ?? null,
    fields: {
      kind: item.kind,
      state: item.state,
      taskId: item.taskId,
      issueId: item.issueId,
      pullRequestId: item.pullRequestId,
      cycleId: item.cycleId,
      moduleId: item.moduleId,
      paths: item.paths,
      packages: item.packages,
      labels: item.labels,
      metadata: item.metadata,
      createdBy: item.createdBy,
      updatedBy: item.updatedBy,
    },
    metadata: {
      kind: item.kind ?? null,
      state: item.state ?? null,
      priority: numberOrZero(item.priority),
      taskId: item.taskId ?? null,
      issueId: item.issueId ?? null,
      pullRequestId: item.pullRequestId ?? null,
      cycleId: item.cycleId ?? null,
      moduleId: item.moduleId ?? null,
    },
  });
}

function workCycleDocument(cycle) {
  return document({
    kind: "work_cycle",
    id: cycle.id ?? null,
    repo: cycle.repo,
    ownerAgentId: cycle.ownerAgentId,
    title: cycle.title ?? cycle.id ?? "work cycle",
    summary: cycle.summary ?? cycle.state ?? null,
    fields: {
      state: cycle.state,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      metadata: cycle.metadata,
      createdBy: cycle.createdBy,
      updatedBy: cycle.updatedBy,
    },
    metadata: {
      state: cycle.state ?? null,
      startAt: cycle.startAt ?? null,
      endAt: cycle.endAt ?? null,
    },
  });
}

function workModuleDocument(module) {
  return document({
    kind: "work_module",
    id: module.id ?? null,
    repo: module.repo,
    ownerAgentId: module.ownerAgentId,
    title: module.title ?? module.id ?? "work module",
    summary: module.summary ?? module.state ?? null,
    fields: {
      state: module.state,
      paths: module.paths,
      packages: module.packages,
      labels: module.labels,
      metadata: module.metadata,
      createdBy: module.createdBy,
      updatedBy: module.updatedBy,
    },
    metadata: {
      state: module.state ?? null,
      paths: arrayValue(module.paths),
      packages: arrayValue(module.packages),
      labels: arrayValue(module.labels),
    },
  });
}

function workViewDocument(view) {
  return document({
    kind: "work_view",
    id: view.id ?? null,
    repo: view.repo,
    ownerAgentId: view.ownerAgentId,
    title: view.title ?? view.id ?? "work view",
    summary: view.summary ?? view.query ?? view.kind ?? null,
    fields: {
      kind: view.kind,
      state: view.state,
      query: view.query,
      filters: view.filters,
      layout: view.layout,
      columns: view.columns,
      visibility: view.visibility,
      metadata: view.metadata,
      createdBy: view.createdBy,
      updatedBy: view.updatedBy,
    },
    metadata: {
      kind: view.kind ?? null,
      state: view.state ?? null,
      visibility: view.visibility ?? null,
      query: view.query ?? null,
    },
  });
}

function workPageDocument(page) {
  return document({
    kind: "work_page",
    id: page.id ?? null,
    repo: page.repo,
    ownerAgentId: page.ownerAgentId,
    title: page.title ?? page.id ?? "work page",
    summary: page.summary ?? page.kind ?? null,
    url: page.sourceUrl ?? null,
    fields: {
      kind: page.kind,
      state: page.state,
      body: page.body,
      format: page.format,
      workItemId: page.workItemId,
      cycleId: page.cycleId,
      moduleId: page.moduleId,
      taskId: page.taskId,
      issueId: page.issueId,
      pullRequestId: page.pullRequestId,
      tags: page.tags,
      visibility: page.visibility,
      metadata: page.metadata,
      createdBy: page.createdBy,
      updatedBy: page.updatedBy,
    },
    metadata: {
      kind: page.kind ?? null,
      state: page.state ?? null,
      visibility: page.visibility ?? null,
      workItemId: page.workItemId ?? null,
      cycleId: page.cycleId ?? null,
      moduleId: page.moduleId ?? null,
      taskId: page.taskId ?? null,
      issueId: page.issueId ?? null,
      pullRequestId: page.pullRequestId ?? null,
    },
  });
}

function claimDocument(claim) {
  return document({
    kind: "claim",
    id: claim.id ?? null,
    repo: claim.repo,
    ownerAgentId: claim.ownerAgentId,
    title:
      `${claim.resourceKind ?? "resource"} claim ${claim.resourceId ?? ""}`.trim(),
    summary: claim.releaseReason ?? claim.status ?? null,
    fields: {
      resourceKind: claim.resourceKind,
      resourceId: claim.resourceId,
      taskId: claim.taskId,
      branch: claim.branch,
      status: claim.status,
      paths: claim.paths,
      metadata: claim.metadata,
    },
    metadata: {
      status: claim.status ?? null,
      resourceKind: claim.resourceKind ?? null,
      expiresAt: claim.expiresAt ?? null,
    },
  });
}

function runDocument(run) {
  return document({
    kind: "run",
    id: run.id ?? null,
    repo: run.repo,
    targetBranch: run.targetBranch,
    ownerAgentId: run.ownerId ?? run.ownerAgentId,
    title: `run ${run.id ?? run.queueItemId ?? ""}`.trim(),
    summary: run.summary ?? run.status ?? null,
    fields: {
      queueItemId: run.queueItemId,
      pullRequestId: run.pullRequestId,
      sourceBranch: run.sourceBranch,
      ownerKind: run.ownerKind,
      ownerId: run.ownerId,
      runtimeOwnerId: run.runtimeOwnerId,
      status: run.status,
      summary: run.summary,
      error: run.error,
      output: run.output,
    },
    metadata: {
      status: run.status ?? null,
      queueItemId: run.queueItemId ?? null,
      pullRequestId: run.pullRequestId ?? null,
    },
  });
}

function approvalDocument(approval) {
  return document({
    kind: "approval",
    id: approval.id ?? null,
    repo: approval.repo,
    ownerAgentId: approval.requestedBy,
    title: `approval ${approval.id ?? approval.runId ?? ""}`.trim(),
    summary: approval.status ?? null,
    fields: {
      runId: approval.runId,
      nodeId: approval.nodeId,
      status: approval.status,
      request: approval.request,
      allowedActors: approval.allowedActors,
      decision: approval.decision,
      requestedBy: approval.requestedBy,
      decidedBy: approval.decidedBy,
    },
    metadata: {
      status: approval.status ?? null,
      runId: approval.runId ?? null,
    },
  });
}

function humanRequestDocument(request) {
  return document({
    kind: "human_request",
    id: request.id ?? null,
    repo: request.repo,
    ownerAgentId: request.requestedBy,
    title:
      request.title ??
      `human request ${request.id ?? request.runId ?? ""}`.trim(),
    summary: request.prompt ?? request.status ?? null,
    fields: {
      runId: request.runId,
      nodeId: request.nodeId,
      kind: request.kind,
      status: request.status,
      prompt: request.prompt,
      options: request.options,
      response: request.response,
      requestedBy: request.requestedBy,
      respondedBy: request.respondedBy,
    },
    metadata: {
      status: request.status ?? null,
      kind: request.kind ?? null,
      runId: request.runId ?? null,
    },
  });
}

function signalDocument(signal) {
  return document({
    kind: "signal",
    id: signal.id ?? null,
    repo: signal.repo,
    ownerAgentId: signal.actorId,
    title: `signal ${signal.type ?? signal.id ?? ""}`.trim(),
    summary: signal.status ?? null,
    fields: {
      runId: signal.runId,
      correlationKey: signal.correlationKey,
      type: signal.type,
      status: signal.status,
      actorKind: signal.actorKind,
      actorId: signal.actorId,
      payload: signal.payload,
    },
    metadata: {
      type: signal.type ?? null,
      status: signal.status ?? null,
      correlationKey: signal.correlationKey ?? null,
    },
  });
}

function externalDocument(input) {
  const value = objectValue(input) ?? {};
  return document({
    kind: value.kind ?? value.type ?? "document",
    id: value.id ?? value.url ?? null,
    repo: value.repo,
    targetBranch: value.targetBranch,
    ownerAgentId: value.ownerAgentId ?? value.agentId,
    title: value.title ?? value.name ?? value.id ?? value.url ?? "document",
    summary: value.summary ?? value.description ?? null,
    url: value.url ?? value.htmlUrl ?? null,
    fields: {
      body: value.body ?? value.text ?? value.content ?? value.markdown,
      path: value.path,
      paths: value.paths,
      package: value.package,
      packages: value.packages,
      labels: value.labels,
      state: value.state ?? value.status,
      metadata: value.metadata,
    },
    metadata: objectValue(value.metadata) ?? {},
  });
}

function document({
  kind,
  id,
  repo,
  targetBranch,
  ownerAgentId,
  title,
  summary,
  url,
  fields = {},
  metadata = {},
}) {
  const normalizedKind = normalizeKind(kind);
  const normalizedFields = flattenFields(fields);
  return {
    kind: normalizedKind,
    id: id == null ? `${normalizedKind}:${title}` : String(id),
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
    ownerAgentId: stringOrNull(ownerAgentId),
    title: stringOrNull(title) ?? normalizedKind,
    summary: stringOrNull(summary),
    url: stringOrNull(url),
    fields: normalizedFields,
    metadata: objectValue(metadata) ?? {},
    text: searchableText({
      kind: normalizedKind,
      id,
      repo,
      targetBranch,
      ownerAgentId,
      title,
      summary,
      fields: normalizedFields,
      metadata,
    }),
  };
}

function scoreDocument({ document, queryModel, limits }) {
  if (queryModel.empty) {
    return resultFor({
      document,
      score: 1,
      matches: [],
      snippets: [],
    });
  }

  const haystacks = fieldHaystacks(document);
  const matches = [];
  let score = 0;

  if (queryModel.phrase) {
    for (const field of haystacks) {
      if (field.value.includes(queryModel.phrase)) {
        const weight =
          field.name === "title" ? 80 : field.name === "summary" ? 50 : 30;
        score += weight;
        matches.push(match(field.name, queryModel.phrase, weight));
      }
    }
  }

  for (const token of queryModel.tokens) {
    for (const field of haystacks) {
      if (field.value.includes(token)) {
        const weight = tokenWeight(field.name);
        score += weight;
        matches.push(match(field.name, token, weight));
      }
    }
  }

  const kindBoost = kindHintBoost(document.kind, queryModel.tokens);
  if (kindBoost > 0) {
    score += kindBoost;
    matches.push(match("kind", document.kind, kindBoost));
  }

  if (
    document.repo &&
    queryModel.tokens.includes(document.repo.toLowerCase())
  ) {
    score += 15;
    matches.push(match("repo", document.repo, 15));
  }

  return resultFor({
    document,
    score,
    matches: uniqueMatches(matches),
    snippets: snippetsFor({ document, queryModel, limits }),
  });
}

function resultFor({ document, score, matches, snippets }) {
  return {
    kind: document.kind,
    id: document.id,
    repo: document.repo,
    targetBranch: document.targetBranch,
    ownerAgentId: document.ownerAgentId,
    title: redactSensitiveText(document.title),
    summary:
      document.summary == null ? null : redactSensitiveText(document.summary),
    url: document.url,
    score: Number(score.toFixed(2)),
    matches,
    snippets,
    metadata: redactValue(document.metadata),
  };
}

function snippetsFor({ document, queryModel, limits }) {
  const snippets = [];
  const tokens =
    queryModel.tokens.length > 0
      ? queryModel.tokens
      : queryModel.phrase
        ? [queryModel.phrase]
        : [];
  for (const field of fieldHaystacks(document, { preserveOriginal: true })) {
    const token = tokens.find((item) => field.normalized.includes(item));
    if (!token) continue;
    snippets.push({
      field: field.name,
      text: redactSensitiveText(snippetAround(field.original, token)),
    });
    if (snippets.length >= limits.maxSnippets) break;
  }
  return snippets;
}

function fieldHaystacks(document, { preserveOriginal = false } = {}) {
  const fields = [
    ["title", document.title],
    ["summary", document.summary],
    ["repo", document.repo],
    ["targetBranch", document.targetBranch],
    ["ownerAgentId", document.ownerAgentId],
    ...Object.entries(document.fields),
    ...Object.entries(flattenFields(document.metadata)).map(([key, value]) => [
      `metadata.${key}`,
      value,
    ]),
  ];
  return fields
    .map(([name, value]) => {
      const original = stringifyValue(value);
      return {
        name,
        original: preserveOriginal ? original : null,
        normalized: original.toLowerCase(),
        value: original.toLowerCase(),
      };
    })
    .filter((field) => field.value);
}

function flattenFields(fields, prefix = "") {
  const output = {};
  const value = objectValue(fields) ?? {};
  for (const [key, fieldValue] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (fieldValue === undefined || fieldValue === null) continue;
    if (Array.isArray(fieldValue)) {
      output[name] = fieldValue.map(stringifyValue).filter(Boolean).join(" ");
    } else if (typeof fieldValue === "object") {
      Object.assign(output, flattenFields(fieldValue, name));
    } else {
      output[name] = stringifyValue(fieldValue);
    }
  }
  return output;
}

function searchableText({
  kind,
  id,
  repo,
  targetBranch,
  ownerAgentId,
  title,
  summary,
  fields,
  metadata,
}) {
  return [
    kind,
    id,
    repo,
    targetBranch,
    ownerAgentId,
    title,
    summary,
    ...Object.values(fields),
    ...Object.values(flattenFields(metadata)),
  ]
    .map(stringifyValue)
    .join(" ")
    .toLowerCase();
}

function buildQueryModel(query) {
  const tokens = tokenize(query);
  return {
    empty: tokens.length === 0,
    phrase: query.toLowerCase(),
    tokens,
  };
}

function normalizeQuery(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(value) {
  return uniqueStrings(
    String(value ?? "")
      .toLowerCase()
      .match(/[a-z0-9_.@/-]+/g) ?? [],
  ).filter((token) => token.length >= 2);
}

function matchesFilters(document, filters) {
  if (filters.repo && document.repo !== filters.repo) return false;
  if (filters.targetBranch && document.targetBranch !== filters.targetBranch)
    return false;
  if (filters.ownerAgentId && document.ownerAgentId !== filters.ownerAgentId)
    return false;
  if (filters.kinds.length > 0 && !filters.kinds.includes(document.kind))
    return false;
  return true;
}

function truncateDocument(document, limits) {
  const fields = {};
  for (const [key, value] of Object.entries(document.fields)) {
    fields[key] = truncateString(value, limits.maxFieldLength);
  }
  return {
    ...document,
    fields,
    text: truncateString(document.text, limits.maxFieldLength * 4),
  };
}

function facetsFor(results) {
  return {
    kinds: countBy(results, "kind"),
    repos: countBy(
      results.filter((result) => result.repo),
      "repo",
    ),
    ownerAgents: countBy(
      results.filter((result) => result.ownerAgentId),
      "ownerAgentId",
    ),
  };
}

function labelsFor({ queryModel, results }) {
  const labels = [results.length > 0 ? "search:matched" : "search:no-results"];
  if (queryModel.empty) labels.push("search:browse");
  if (results.some((result) => result.kind === "actions_log"))
    labels.push("search:actions-log");
  if (results.some((result) => result.kind === "pull_request"))
    labels.push("search:pull-request");
  return uniqueStrings(labels);
}

function compareResults(left, right) {
  return (
    right.score - left.score ||
    kindRank(left.kind) - kindRank(right.kind) ||
    String(left.id).localeCompare(String(right.id))
  );
}

function kindRank(kind) {
  return (
    {
      pull_request: 0,
      issue: 1,
      actions_log: 2,
      diff: 3,
      run: 4,
      claim: 5,
      human_request: 6,
      approval: 7,
      signal: 8,
    }[kind] ?? 20
  );
}

function tokenWeight(fieldName) {
  if (fieldName === "title") return 24;
  if (fieldName === "summary") return 16;
  if (
    [
      "changedFiles",
      "affectedPackages",
      "paths",
      "packages",
      "path",
      "package",
    ].some((key) => fieldName.endsWith(key))
  )
    return 18;
  if (
    fieldName.includes("check") ||
    fieldName.includes("status") ||
    fieldName.includes("state")
  )
    return 14;
  if (fieldName.startsWith("metadata")) return 8;
  return 6;
}

function kindHintBoost(kind, tokens) {
  const hints = KIND_HINTS[kind] ?? [];
  return tokens.some((token) => hints.includes(token)) ? 12 : 0;
}

function match(field, term, weight) {
  return { field, term, weight };
}

function uniqueMatches(matches) {
  const seen = new Set();
  return matches
    .filter((item) => {
      const key = `${item.field}:${item.term}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.field.localeCompare(right.field) ||
        left.term.localeCompare(right.term),
    );
}

function countBy(values, key) {
  return Object.fromEntries(
    [
      ...values
        .reduce((counts, value) => {
          const countKey = value[key];
          counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
          return counts;
        }, new Map())
        .entries(),
    ].sort(
      (left, right) =>
        right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
    ),
  );
}

function snippetAround(value, token) {
  const text = stringifyValue(value).replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const index = lower.indexOf(token.toLowerCase());
  if (index < 0) return text.slice(0, 180);
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + token.length + 110);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function normalizeKind(value) {
  return (
    String(value ?? "document")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "document"
  );
}

function normalizeLimits(limits) {
  const value = objectValue(limits) ?? {};
  return {
    maxResults: positiveInteger(
      value.maxResults,
      DEFAULT_REPO_SEARCH_LIMITS.maxResults,
    ),
    maxDocuments: positiveInteger(
      value.maxDocuments,
      DEFAULT_REPO_SEARCH_LIMITS.maxDocuments,
    ),
    maxSnippets: positiveInteger(
      value.maxSnippets,
      DEFAULT_REPO_SEARCH_LIMITS.maxSnippets,
    ),
    maxFieldLength: positiveInteger(
      value.maxFieldLength,
      DEFAULT_REPO_SEARCH_LIMITS.maxFieldLength,
    ),
  };
}

function truncateString(value, limit) {
  const text = stringifyValue(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function stringifyValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(stringifyValue).filter(Boolean).join(" ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function redactValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)]),
    );
  }
  return value;
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(
      /\b(?:gh[pousr]_|glpat-|sk-)[A-Za-z0-9_-]{16,}\b/g,
      "[redacted-secret]",
    )
    .replace(
      /\b((?:[A-Z0-9_]*)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)(?:[A-Z0-9_]*)=)[^\s]+/gi,
      "$1[redacted-secret]",
    )
    .replace(/\b(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted-secret]");
}

function uniqueStrings(value) {
  return [
    ...new Set(
      arrayValue(value)
        .map((item) => String(item).trim())
        .filter(Boolean),
    ),
  ].sort();
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}
