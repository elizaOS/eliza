const RELEASE_SECTIONS = Object.freeze([
  { key: "breaking", title: "Breaking Changes" },
  { key: "security", title: "Security" },
  { key: "features", title: "Features" },
  { key: "fixes", title: "Fixes" },
  { key: "performance", title: "Performance" },
  { key: "docs", title: "Documentation" },
  { key: "tests", title: "Tests" },
  { key: "chores", title: "Chores" },
]);

const SECTION_BY_KEY = new Map(
  RELEASE_SECTIONS.map((section) => [section.key, section]),
);
const DEFAULT_SECTION_KEY = "chores";

export function buildReleaseNotes({
  items = [],
  repo,
  targetBranch,
  from,
  to,
  version,
  title,
  now = new Date().toISOString(),
} = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const normalizedRange = normalizeRange({ from, to });
  const filters = {
    repo: stringOrNull(repo),
    targetBranch: stringOrNull(targetBranch),
  };
  const excluded = [];
  const included = [];

  for (const [index, raw] of sourceItems.entries()) {
    const item = normalizeReleaseItem(raw, index);
    const exclusionReason = exclusionReasonFor(item, {
      filters,
      range: normalizedRange,
    });
    if (exclusionReason) {
      excluded.push({
        id: item.id,
        pullRequestId: item.pullRequestId,
        reason: exclusionReason,
      });
      continue;
    }
    included.push(item);
  }

  included.sort(compareReleaseItems);

  const sections = RELEASE_SECTIONS.map((section) => ({
    ...section,
    items: included.filter((item) => item.category === section.key),
  })).filter((section) => section.items.length > 0);

  const packages = countByMany(
    included,
    (item) => (item.packages.length > 0 ? item.packages : ["unscoped"]),
    "packageName",
  );
  const agents = countByOne(
    included.filter((item) => item.authorKind === "agent" || item.ownerAgentId),
    (item) => item.ownerAgentId || "unknown-agent",
    "ownerAgentId",
  );
  const risks = countByOne(
    included,
    (item) => item.riskLevel || "unknown",
    "level",
  );
  const releaseTitle = titleFor({
    title,
    version,
    repo: filters.repo,
    targetBranch: filters.targetBranch,
  });
  const summary = summaryFor({
    included,
    excluded,
    sections,
    packages,
    agents,
  });

  const notes = {
    computedAt: now,
    title: releaseTitle,
    version: stringOrNull(version),
    repo: filters.repo,
    targetBranch: filters.targetBranch,
    range: normalizedRange,
    summary,
    sections,
    packages,
    agents,
    risks,
    markdown: "",
    validation: {
      sourceItemCount: sourceItems.length,
      includedItemCount: included.length,
      excludedItemCount: excluded.length,
      excluded,
      warnings: warningsFor({ included, excluded, range: normalizedRange }),
    },
  };

  notes.markdown = renderReleaseNotesMarkdown(notes);
  return notes;
}

function normalizeReleaseItem(input, index) {
  const labels = stringArray(input?.labels);
  const title =
    stringOrNull(input?.title ?? input?.pullRequestTitle ?? input?.name) ??
    `PR ${input?.pullRequestId ?? input?.id ?? index + 1}`;
  const repo = stringOrNull(input?.repo);
  const pullRequestId = normalizedPullRequestId(
    input?.pullRequestId ?? input?.number ?? input?.id,
  );
  const id =
    stringOrNull(input?.id) ??
    (repo && pullRequestId !== null
      ? `${repo}#${pullRequestId}`
      : `release-item:${index + 1}`);
  const packages = uniqueStrings(input?.affectedPackages ?? input?.packages);
  const files = uniqueStrings(
    input?.changedFiles ?? input?.affectedPaths ?? input?.paths,
  );
  const mergedAt = stringOrNull(input?.mergedAt ?? input?.merged_at);
  const updatedAt = stringOrNull(input?.updatedAt ?? input?.updated_at);
  const createdAt = stringOrNull(input?.createdAt ?? input?.created_at);
  const category = releaseCategoryFor({ title, labels, files });

  return {
    id,
    repo,
    pullRequestId,
    title,
    summary: stringOrNull(
      input?.commitSummary ?? input?.releaseSummary ?? input?.summary,
    ),
    category,
    categoryTitle:
      SECTION_BY_KEY.get(category)?.title ??
      SECTION_BY_KEY.get(DEFAULT_SECTION_KEY).title,
    authorKind: stringOrNull(input?.authorKind) ?? "unknown",
    ownerAgentId: stringOrNull(input?.ownerAgentId),
    targetBranch: stringOrNull(input?.targetBranch ?? input?.baseBranch),
    sourceBranch: stringOrNull(input?.sourceBranch ?? input?.headBranch),
    labels,
    packages,
    files,
    changedLines: numberOrZero(input?.changedLines),
    riskLevel: stringOrNull(input?.risk?.level ?? input?.riskLevel),
    merged: isMerged(input),
    mergedAt,
    updatedAt,
    createdAt,
    sortTime: mergedAt ?? updatedAt ?? createdAt ?? null,
    url: stringOrNull(input?.url ?? input?.htmlUrl ?? input?.pullRequestUrl),
    mergeCommitSha: stringOrNull(
      input?.mergeCommitSha ?? input?.merge_commit_sha,
    ),
  };
}

function exclusionReasonFor(item, { filters, range }) {
  if (!item.merged) return "not_merged";
  if (filters.repo && item.repo !== filters.repo) return "repo_mismatch";
  if (filters.targetBranch && item.targetBranch !== filters.targetBranch)
    return "target_branch_mismatch";
  if ((range.from || range.to) && !item.sortTime)
    return "missing_merged_timestamp_for_range";
  if (
    range.from &&
    item.sortTime &&
    Date.parse(item.sortTime) < Date.parse(range.from)
  )
    return "before_range";
  if (
    range.to &&
    item.sortTime &&
    Date.parse(item.sortTime) > Date.parse(range.to)
  )
    return "after_range";
  return null;
}

function isMerged(input) {
  const state = String(
    input?.pullRequestState ?? input?.state ?? input?.queueState ?? "",
  ).toLowerCase();
  return (
    input?.pullRequestMerged === true ||
    Boolean(input?.mergedAt ?? input?.merged_at) ||
    state === "merged" ||
    state === "done"
  );
}

function releaseCategoryFor({ title, labels, files }) {
  const labelSet = new Set(labels.map((label) => label.toLowerCase()));
  const normalizedTitle = title.toLowerCase();

  if (
    hasAny(labelSet, ["breaking", "breaking-change", "semver-major"]) ||
    normalizedTitle.includes("breaking")
  )
    return "breaking";
  if (
    hasAny(labelSet, ["security", "vulnerability", "cve"]) ||
    files.some((file) => /(^|\/)(auth|security)\//.test(file))
  )
    return "security";
  if (
    hasAny(labelSet, ["feature", "enhancement", "feat"]) ||
    /^feat(\(.+\))?:/.test(normalizedTitle)
  )
    return "features";
  if (
    hasAny(labelSet, ["bug", "bugfix", "fix"]) ||
    /^fix(\(.+\))?:/.test(normalizedTitle)
  )
    return "fixes";
  if (
    hasAny(labelSet, ["performance", "perf"]) ||
    /^perf(\(.+\))?:/.test(normalizedTitle)
  )
    return "performance";
  if (
    hasAny(labelSet, ["docs", "documentation"]) ||
    /^docs(\(.+\))?:/.test(normalizedTitle) ||
    (files.length > 0 && files.every((file) => file.endsWith(".md")))
  ) {
    return "docs";
  }
  if (
    hasAny(labelSet, ["test", "tests"]) ||
    /^test(\(.+\))?:/.test(normalizedTitle)
  )
    return "tests";
  return DEFAULT_SECTION_KEY;
}

function hasAny(set, values) {
  return values.some((value) => set.has(value));
}

function compareReleaseItems(left, right) {
  const leftTime = left.sortTime ? Date.parse(left.sortTime) : 0;
  const rightTime = right.sortTime ? Date.parse(right.sortTime) : 0;
  return (
    rightTime - leftTime ||
    String(left.pullRequestId ?? left.id).localeCompare(
      String(right.pullRequestId ?? right.id),
    )
  );
}

function countByMany(items, valuesFor, keyName) {
  const counts = new Map();
  for (const item of items) {
    for (const value of valuesFor(item)) {
      const key = String(value);
      const existing = counts.get(key) ?? {
        [keyName]: key,
        count: 0,
        pullRequestIds: [],
      };
      existing.count += 1;
      if (item.pullRequestId !== null)
        existing.pullRequestIds.push(item.pullRequestId);
      counts.set(key, existing);
    }
  }
  return sortedCounts(counts);
}

function countByOne(items, valueFor, keyName) {
  const counts = new Map();
  for (const item of items) {
    const key = String(valueFor(item));
    const existing = counts.get(key) ?? {
      [keyName]: key,
      count: 0,
      pullRequestIds: [],
    };
    existing.count += 1;
    if (item.pullRequestId !== null)
      existing.pullRequestIds.push(item.pullRequestId);
    counts.set(key, existing);
  }
  return sortedCounts(counts);
}

function sortedCounts(counts) {
  return [...counts.values()]
    .map((item) => ({
      ...item,
      pullRequestIds: item.pullRequestIds.sort(
        (left, right) => Number(left) - Number(right),
      ),
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        String(Object.values(left)[0]).localeCompare(
          String(Object.values(right)[0]),
        ),
    );
}

function summaryFor({ included, excluded, sections, packages, agents }) {
  return {
    totalMergedPullRequests: included.length,
    excludedPullRequests: excluded.length,
    agentPullRequests: included.filter(
      (item) => item.authorKind === "agent" || item.ownerAgentId,
    ).length,
    humanPullRequests: included.filter((item) => item.authorKind === "human")
      .length,
    sectionCount: sections.length,
    packageCount: packages.length,
    agentCount: agents.length,
    topPackage: packages[0]?.packageName ?? null,
    topAgent: agents[0]?.ownerAgentId ?? null,
  };
}

function warningsFor({ included, excluded, range }) {
  const warnings = [];
  if (included.length === 0) warnings.push("no_merged_pull_requests");
  if (
    excluded.some(
      (item) => item.reason === "missing_merged_timestamp_for_range",
    )
  ) {
    warnings.push("range_filter_skipped_items_without_merged_timestamps");
  }
  if (!range.from && !range.to) warnings.push("unbounded_release_range");
  return warnings;
}

function titleFor({ title, version, repo, targetBranch }) {
  if (stringOrNull(title)) return stringOrNull(title);
  if (stringOrNull(version)) return `Release ${stringOrNull(version)}`;
  if (repo && targetBranch) return `${repo} ${targetBranch} release notes`;
  if (repo) return `${repo} release notes`;
  return "Release notes";
}

function renderReleaseNotesMarkdown(notes) {
  const lines = [`# ${notes.title}`, ""];
  if (notes.version) lines.push(`Version: ${notes.version}`, "");
  if (notes.repo || notes.targetBranch) {
    lines.push(
      `Scope: ${[notes.repo, notes.targetBranch].filter(Boolean).join(" / ")}`,
      "",
    );
  }
  lines.push(`Merged PRs: ${notes.summary.totalMergedPullRequests}`);
  if (notes.summary.agentPullRequests > 0)
    lines.push(`Agent PRs: ${notes.summary.agentPullRequests}`);
  if (notes.summary.topPackage)
    lines.push(`Top package: ${notes.summary.topPackage}`);
  lines.push("");

  if (notes.sections.length === 0) {
    lines.push("No merged pull requests matched this release window.", "");
  } else {
    for (const section of notes.sections) {
      lines.push(`## ${section.title}`);
      for (const item of section.items) {
        lines.push(`- ${releaseLineFor(item)}`);
      }
      lines.push("");
    }
  }

  if (notes.agents.length > 0) {
    lines.push("## Agent Contributions");
    for (const agent of notes.agents) {
      lines.push(`- ${agent.ownerAgentId}: ${agent.count} PR(s)`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function releaseLineFor(item) {
  const pr = item.pullRequestId !== null ? `#${item.pullRequestId}` : item.id;
  const scope =
    item.packages.length > 0 ? ` (${item.packages.join(", ")})` : "";
  const agent = item.ownerAgentId ? ` - ${item.ownerAgentId}` : "";
  const summary = item.summary ? `: ${item.summary}` : "";
  return `${item.title} (${pr})${scope}${agent}${summary}`;
}

function normalizeRange({ from, to }) {
  return {
    from: stringOrNull(from),
    to: stringOrNull(to),
  };
}

function normalizedPullRequestId(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}

function stringArray(value) {
  if (!value) return [];
  if (value instanceof Set) return [...value].map(String).filter(Boolean);
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item))
    .filter(Boolean);
}

function uniqueStrings(value) {
  return [...new Set(stringArray(value))].sort();
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
