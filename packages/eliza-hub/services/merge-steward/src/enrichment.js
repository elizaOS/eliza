import { detectAgentPlanSignals } from "./agent-plan.js";

export async function enrichQueueItem({ client, item, config = {} } = {}) {
  if (!config.enabled) {
    return {
      enabled: false,
    };
  }

  if (!item?.repo || !item.pullRequestId) {
    return {
      enabled: true,
      skipped: true,
      reason: "missing_repo_or_pull_request",
    };
  }

  if (!client) {
    return {
      enabled: true,
      skipped: true,
      reason: "forgejo_client_unconfigured",
    };
  }

  try {
    return await fetchQueueEnrichment({ client, item, config });
  } catch (error) {
    // error-policy:J1 Forgejo enrichment boundary: failure becomes an explicit
    // skipped result with the error attached; the steward records it instead of
    // treating the item as enriched
    return {
      enabled: true,
      skipped: true,
      reason: "forgejo_enrichment_failed",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown Forgejo enrichment error",
        status: error?.status ?? null,
      },
    };
  }
}

export function buildEnrichmentPatch({
  item = {},
  pullRequest,
  files,
  reviews,
  statuses,
  combinedStatus,
  config = {},
} = {}) {
  const labels = labelNames(pullRequest?.labels);
  const statusSource =
    Array.isArray(combinedStatus?.statuses) &&
    combinedStatus.statuses.length > 0
      ? combinedStatus.statuses
      : (statuses ?? []);
  const checkResults = checksFromStatuses(statusSource);
  const headSha = refSha(pullRequest?.head) ?? item.headSha ?? null;
  const targetBranch = refBranch(pullRequest?.base) ?? item.targetBranch ?? "";
  const sourceBranch = refBranch(pullRequest?.head) ?? item.sourceBranch ?? "";
  const title = pullRequest?.title ?? item.title ?? "";
  const body = pullRequest?.body ?? "";
  const planSignals = detectAgentPlanSignals(
    `${title}\n${body}`,
    config.agentRunReceipt,
  );
  const authorKind = authorKindFromUser(
    pullRequest?.user ?? pullRequest?.author,
  );
  const ownerAgentId = agentIdFromLabels(labels) ?? item.ownerAgentId ?? null;
  const reviewList = Array.isArray(reviews) ? reviews : null;
  const fileList = Array.isArray(files) ? files : null;
  const latestReviews = reviewList ? latestReviewStates(reviewList) : [];
  const reviewSatisfied = hasApprovedReview(latestReviews);
  const humanApproved = hasHumanApproval(latestReviews);
  const changedFiles = fileList
    ? fileList.map(filePath).filter(Boolean)
    : undefined;
  const requiredChecks = config.requiredChecks?.length
    ? config.requiredChecks
    : Object.keys(checkResults);

  return dropUndefined({
    repo: item.repo,
    pullRequestId:
      pullRequest?.number ?? pullRequest?.index ?? item.pullRequestId,
    sourceBranch,
    targetBranch,
    headSha,
    authorKind: authorKind || item.authorKind,
    ownerAgentId,
    taskId: taskIdFromText(`${title}\n${body}`) ?? item.taskId,
    changedFiles,
    changedLines: fileList ? changedLineCount(fileList) : undefined,
    labels: labels.length ? labels : undefined,
    pullRequestState: pullRequest?.state,
    pullRequestDraft: pullRequest?.draft ?? pullRequest?.is_draft,
    pullRequestMerged: pullRequest?.merged,
    pullRequestMergeable: pullRequest?.mergeable,
    hasIssueLink: hasIssueLink(`${title}\n${body}`) || item.hasIssueLink,
    ...planSignals,
    hasHumanApproval: reviewList ? humanApproved : undefined,
    agentKnown: Boolean(ownerAgentId) || authorKind !== "agent",
    reviewSatisfied: reviewList ? reviewSatisfied : undefined,
    headShaMatches: item.headSha ? item.headSha === headSha : true,
    requiredChecks,
    checkResults,
    targetProtected: protectedBranches(config).includes(targetBranch),
  });
}

async function fetchQueueEnrichment({ client, item, config }) {
  const repo = parseRepoFullName(item.repo);
  const pullRequest = await client.getPullRequest(repo, item.pullRequestId);
  const headSha = refSha(pullRequest?.head) ?? item.headSha;
  const headShaMatches = item.headSha ? item.headSha === headSha : true;
  const statusSha = headShaMatches ? headSha : null;
  const [files, reviews, statuses, combinedStatus] = await Promise.all([
    paginated(
      (query) => client.listPullRequestFiles(repo, item.pullRequestId, query),
      config,
    ),
    paginated(
      (query) => client.listPullRequestReviews(repo, item.pullRequestId, query),
      config,
    ),
    statusSha
      ? paginated(
          (query) => client.listCommitStatuses(repo, statusSha, query),
          config,
        )
      : [],
    statusSha
      ? optional(() => client.getCombinedCommitStatus(repo, statusSha), null)
      : null,
  ]);
  const patch = buildEnrichmentPatch({
    item,
    pullRequest,
    files,
    reviews,
    statuses,
    combinedStatus,
    config,
  });

  return {
    enabled: true,
    skipped: false,
    patch: {
      ...patch,
      headShaMatches,
      checkResults: headShaMatches ? patch.checkResults : {},
    },
  };
}

async function paginated(fetchPage, config = {}) {
  const limit = config.pageLimit ?? 50;
  const maxPages = config.maxPages ?? 10;
  const items = [];

  for (let page = 1; page <= maxPages; page += 1) {
    let pageItems;
    try {
      pageItems = await fetchPage({ page, limit });
    } catch {
      // error-policy:J4 page fetch failure yields null ("unknown"), which
      // buildEnrichmentPatch maps to undefined signal fields — deliberately
      // distinct from an empty list
      return null;
    }
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;

    items.push(...pageItems);
    if (pageItems.length < limit) break;
  }

  return items;
}

async function optional(fn, fallback) {
  try {
    return await fn();
  } catch {
    // error-policy:J4 optional enrichment source: failure yields the
    // caller-chosen "unknown" fallback, never a fabricated value
    return fallback;
  }
}

function parseRepoFullName(fullName) {
  const [owner, repo, ...rest] = String(fullName).split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new TypeError("Forgejo enrichment requires repo in owner/name form");
  }
  return { owner, repo };
}

function filePath(file) {
  if (typeof file === "string") return file;
  return file?.filename ?? file?.name ?? file?.path ?? null;
}

function changedLineCount(files = []) {
  return files.reduce((total, file) => {
    const additions = numeric(file?.additions);
    const deletions = numeric(file?.deletions);
    const changes = numeric(file?.changes);
    return total + (additions || deletions ? additions + deletions : changes);
  }, 0);
}

function checksFromStatuses(statuses = []) {
  const results = {};
  for (const status of statuses) {
    const context = status?.context ?? status?.name;
    const state = status?.state ?? status?.status ?? status?.conclusion;
    if (context && state && results[context] === undefined) {
      results[context] = normalizeCheckState(state);
    }
  }
  return results;
}

function normalizeCheckState(state) {
  const normalized = String(state ?? "").toLowerCase();
  if (
    normalized === "success" ||
    normalized === "skipped" ||
    normalized === "neutral"
  )
    return normalized;
  if (normalized === "completed") return "success";
  if (
    normalized === "failure" ||
    normalized === "failed" ||
    normalized === "error"
  )
    return "failure";
  return normalized || "pending";
}

function latestReviewStates(reviews = []) {
  const states = new Map();
  for (const review of reviews) {
    const reviewer = reviewUserId(review);
    if (!reviewer) continue;

    const current = states.get(reviewer);
    if (!current || reviewSortValue(review) >= reviewSortValue(current)) {
      states.set(reviewer, review);
    }
  }
  return [...states.values()];
}

function hasApprovedReview(reviews = []) {
  return reviews.some((review) => {
    return normalizeReviewState(review) === "approved";
  });
}

function hasHumanApproval(reviews = []) {
  return reviews.some((review) => {
    if (normalizeReviewState(review) !== "approved") return false;
    return authorKindFromUser(review?.reviewer ?? review?.user) === "human";
  });
}

function normalizeReviewState(review) {
  const state = String(review?.state ?? review?.type ?? "").toLowerCase();
  if (state === "approve" || state === "approved") return "approved";
  if (
    state === "request_changes" ||
    state === "requested_changes" ||
    state === "changes_requested"
  ) {
    return "changes_requested";
  }
  if (state === "dismissed" || state === "stale") return "dismissed";
  return state;
}

function reviewUserId(review) {
  const user = review?.reviewer ?? review?.user;
  return user?.login ?? user?.username ?? user?.id ?? null;
}

function reviewSortValue(review) {
  const timestamp = Date.parse(
    review?.submitted_at ??
      review?.submittedAt ??
      review?.updated_at ??
      review?.updatedAt ??
      review?.created_at ??
      review?.createdAt ??
      "",
  );
  if (Number.isFinite(timestamp)) return timestamp;
  return Number.isFinite(review?.id) ? review.id : 0;
}

function labelNames(labels = []) {
  return Array.isArray(labels)
    ? labels
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter(Boolean)
    : [];
}

function agentIdFromLabels(labels = []) {
  for (const label of labels) {
    const match = /^agent:(.+)$/.exec(label);
    if (
      match &&
      !["owned", "stale", "needs-human", "duplicate-risk"].includes(match[1])
    ) {
      return match[1];
    }
  }
  return null;
}

function authorKindFromUser(user) {
  const login = user?.login ?? user?.username ?? "";
  if (/agent|codex|bot/i.test(login)) return "agent";
  if (/bot/i.test(user?.type ?? "")) return "bot";
  return login ? "human" : "unknown";
}

function refBranch(ref) {
  return ref?.ref ?? ref?.branch ?? null;
}

function refSha(ref) {
  return ref?.sha ?? ref?.head_sha ?? null;
}

function hasIssueLink(text) {
  return /(?:#\d+|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+|task[-_ ]?[a-z0-9-]+)/i.test(
    text,
  );
}

function taskIdFromText(text) {
  const taskMatch = /(task[-_ ][a-z0-9-]+)/i.exec(text);
  if (taskMatch) return taskMatch[1].replace(/\s+/g, "-");
  const issueMatch = /#(\d+)/.exec(text);
  return issueMatch ? `issue-${issueMatch[1]}` : null;
}

function protectedBranches(config = {}) {
  return config.protectedBranches?.length ? config.protectedBranches : [];
}

function numeric(value) {
  const number = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : 0;
}

function dropUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}
