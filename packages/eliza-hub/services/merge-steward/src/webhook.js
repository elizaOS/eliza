import { createHmac, timingSafeEqual } from "node:crypto";

export const EVENT_HEADER_NAMES = [
  "x-forgejo-event",
  "x-gitea-event",
  "x-gogs-event",
  "x-github-event",
];

export const EVENT_TYPE_HEADER_NAMES = [
  "x-forgejo-event-type",
  "x-gitea-event-type",
  "x-gogs-event-type",
  "x-github-event-type",
];

export const DELIVERY_HEADER_NAMES = [
  "x-forgejo-delivery",
  "x-gitea-delivery",
  "x-gogs-delivery",
  "x-github-delivery",
];

export const SIGNATURE_HEADER_NAMES = [
  "x-forgejo-signature",
  "x-gitea-signature",
  "x-gogs-signature",
  "x-hub-signature-256",
];

const SHA256_HEX_LENGTH = 64;

export class WebhookSignatureError extends Error {
  constructor(message = "Invalid Forgejo webhook signature") {
    super(message);
    this.name = "WebhookSignatureError";
    this.statusCode = 401;
  }
}

export class WebhookPayloadError extends Error {
  constructor(message = "Invalid Forgejo webhook payload") {
    super(message);
    this.name = "WebhookPayloadError";
    this.statusCode = 400;
  }
}

export function getHeader(headers, name) {
  if (!headers || !name) {
    return undefined;
  }

  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : undefined;
    }

    return value === undefined || value === null ? undefined : String(value);
  }

  return undefined;
}

export function firstHeader(headers, names) {
  for (const name of names) {
    const value = getHeader(headers, name);
    if (value !== undefined && value !== "") {
      return value;
    }
  }

  return undefined;
}

export function extractForgejoWebhookHeaders(headers = {}) {
  return {
    deliveryId: firstHeader(headers, DELIVERY_HEADER_NAMES) ?? null,
    event: firstHeader(headers, EVENT_HEADER_NAMES) ?? null,
    eventType: firstHeader(headers, EVENT_TYPE_HEADER_NAMES) ?? null,
    signature: firstHeader(headers, SIGNATURE_HEADER_NAMES) ?? null,
  };
}

export function validateForgejoWebhookSignature({
  headers = {},
  body,
  secret,
}) {
  if (!secret) {
    return false;
  }

  const headerValue = firstHeader(headers, SIGNATURE_HEADER_NAMES);
  const actualDigest = normalizeSha256Signature(headerValue);
  if (!actualDigest) {
    return false;
  }

  const expectedDigest = createHmac("sha256", secret)
    .update(toRawBody(body))
    .digest("hex");
  const actual = Buffer.from(actualDigest, "hex");
  const expected = Buffer.from(expectedDigest, "hex");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertForgejoWebhookSignature({ headers = {}, body, secret }) {
  if (!validateForgejoWebhookSignature({ headers, body, secret })) {
    throw new WebhookSignatureError();
  }
}

export function parseForgejoWebhookBody(rawBody) {
  try {
    const payload = JSON.parse(toRawBody(rawBody).toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WebhookPayloadError(
        "Forgejo webhook payload must be a JSON object",
      );
    }

    return payload;
  } catch (error) {
    // error-policy:J3 untrusted webhook body: parse failure becomes a typed
    // WebhookPayloadError the HTTP boundary maps to 400
    if (error instanceof WebhookPayloadError) {
      throw error;
    }

    throw new WebhookPayloadError("Forgejo webhook payload is not valid JSON");
  }
}

export function parseForgejoWebhook({ headers = {}, rawBody, secret }) {
  assertForgejoWebhookSignature({ headers, body: rawBody, secret });
  return normalizeForgejoWebhook({
    headers,
    payload: parseForgejoWebhookBody(rawBody),
  });
}

export function normalizeForgejoWebhook({ headers = {}, payload }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WebhookPayloadError(
      "Forgejo webhook payload must be a JSON object",
    );
  }

  const headerInfo = extractForgejoWebhookHeaders(headers);
  const forgejoEvent = headerInfo.event;
  const forgejoEventType = headerInfo.eventType;
  const trigger = forgejoEventType || forgejoEvent || inferTrigger(payload);
  const pullRequest = normalizePullRequest(
    payload.pull_request,
    payload.number,
  );
  const status = normalizeStatus(payload);
  const workflow = normalizeWorkflow(payload);
  const kind = normalizeKind(trigger, payload);
  const action = normalizeAction(trigger, payload);

  return {
    source: "forgejo",
    type: normalizeInternalType({ trigger, kind, action, payload }),
    kind,
    action,
    deliveryId: headerInfo.deliveryId,
    forgejoEvent,
    forgejoEventType,
    repository: normalizeRepository(payload.repository),
    actor: normalizeUser(payload.sender || payload.pusher),
    pullRequest,
    issue: normalizeIssue(payload.issue),
    comment: normalizeComment(payload.comment),
    review: normalizeReview(payload.review, trigger),
    status,
    workflow,
    labels: normalizeLabels(
      payload.pull_request?.labels || payload.issue?.labels,
    ),
    labelChanges: normalizeLabelChanges(payload.changes),
    commitSha:
      payload.commit_id ||
      payload.sha ||
      pullRequest?.head?.sha ||
      status?.sha ||
      null,
    raw: payload,
  };
}

function normalizeSha256Signature(value) {
  if (!value) {
    return null;
  }

  const signature = String(value).trim().toLowerCase();
  const digest = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (!/^[a-f0-9]+$/.test(digest) || digest.length !== SHA256_HEX_LENGTH) {
    return null;
  }

  return digest;
}

function toRawBody(body) {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }

  throw new TypeError(
    "Forgejo webhook signature validation requires the raw request body",
  );
}

function inferTrigger(payload) {
  if (payload.workflow_run) {
    return "workflow_run";
  }

  if (payload.workflow_job) {
    return "workflow_job";
  }

  if (payload.state && payload.sha && payload.context) {
    return "status";
  }

  if (payload.pull_request && payload.comment) {
    return "pull_request_comment";
  }

  if (payload.pull_request && payload.review) {
    return `pull_request_review_${payload.review.type || "comment"}`;
  }

  if (payload.pull_request) {
    return "pull_request";
  }

  if (payload.issue && payload.is_pull) {
    return "pull_request_comment";
  }

  return "unknown";
}

function normalizeKind(trigger, payload) {
  if (trigger === "status") {
    return "status";
  }

  if (trigger === "workflow_run" || trigger === "workflow_job") {
    return trigger;
  }

  if (trigger === "issue_comment" && payload.is_pull) {
    return "pull_request_comment";
  }

  if (trigger === "pull_request_comment") {
    return "pull_request_comment";
  }

  if (trigger?.startsWith("pull_request_review")) {
    return "pull_request_review";
  }

  if (trigger === "pull_request_label") {
    return "pull_request_label";
  }

  if (trigger?.startsWith("pull_request")) {
    return "pull_request";
  }

  return "unknown";
}

function normalizeAction(trigger, payload) {
  if (trigger === "status") {
    return payload.state || "updated";
  }

  if (trigger === "workflow_run") {
    return payload.action || payload.workflow_run?.status || "updated";
  }

  if (trigger === "workflow_job") {
    return payload.action || payload.workflow_job?.status || "updated";
  }

  if (trigger === "pull_request_sync") {
    return "synchronized";
  }

  if (trigger?.startsWith("pull_request_review")) {
    return (
      payload.review?.type ||
      payload.action ||
      trigger.replace("pull_request_review_", "")
    );
  }

  if (
    trigger === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged
  ) {
    return "merged";
  }

  return payload.action || "updated";
}

function normalizeInternalType({ trigger, kind, action, payload }) {
  if (kind === "pull_request_review") {
    return `pull_request_review.${action}`;
  }

  if (kind === "pull_request_comment") {
    return `pull_request_comment.${action}`;
  }

  if (kind === "pull_request_label") {
    return `pull_request_label.${action}`;
  }

  if (kind === "status") {
    return `status.${payload.state || action}`;
  }

  if (kind === "workflow_run") {
    return `workflow_run.${action}`;
  }

  if (kind === "workflow_job") {
    return `workflow_job.${action}`;
  }

  if (kind === "pull_request") {
    return `pull_request.${action}`;
  }

  return `${trigger || "unknown"}.${action || "updated"}`;
}

function normalizeRepository(repository) {
  if (!repository) {
    return null;
  }

  const owner = normalizeUser(repository.owner);
  const fullName =
    repository.full_name || joinFullName(owner?.login, repository.name);

  return {
    id: repository.id ?? null,
    owner: owner?.login ?? owner?.username ?? null,
    name: repository.name ?? null,
    fullName,
    private: repository.private ?? null,
    fork: repository.fork ?? null,
    defaultBranch: repository.default_branch ?? null,
    htmlUrl: repository.html_url ?? null,
    cloneUrl: repository.clone_url ?? null,
    sshUrl: repository.ssh_url ?? null,
  };
}

function normalizePullRequest(pullRequest, fallbackNumber) {
  if (!pullRequest) {
    return null;
  }

  return {
    id: pullRequest.id ?? null,
    number: pullRequest.number ?? pullRequest.index ?? fallbackNumber ?? null,
    title: pullRequest.title ?? null,
    body: pullRequest.body ?? pullRequest.description ?? null,
    state: pullRequest.state ?? null,
    draft: pullRequest.draft ?? pullRequest.is_draft ?? null,
    merged: pullRequest.merged ?? null,
    mergeable: pullRequest.mergeable ?? null,
    htmlUrl: pullRequest.html_url ?? null,
    diffUrl: pullRequest.diff_url ?? null,
    patchUrl: pullRequest.patch_url ?? null,
    author: normalizeUser(pullRequest.user),
    base: normalizePullRequestRef(pullRequest.base),
    head: normalizePullRequestRef(pullRequest.head),
    labels: normalizeLabels(pullRequest.labels),
    createdAt: pullRequest.created_at ?? null,
    updatedAt: pullRequest.updated_at ?? null,
    closedAt: pullRequest.closed_at ?? null,
    mergedAt: pullRequest.merged_at ?? null,
  };
}

function normalizePullRequestRef(ref) {
  if (!ref) {
    return null;
  }

  return {
    label: ref.label ?? null,
    branch: ref.ref ?? null,
    sha: ref.sha ?? null,
    repoId: ref.repo_id ?? ref.repo?.id ?? null,
    repo: normalizeRepository(ref.repo),
  };
}

function normalizeIssue(issue) {
  if (!issue) {
    return null;
  }

  return {
    id: issue.id ?? null,
    number: issue.number ?? issue.index ?? null,
    title: issue.title ?? null,
    state: issue.state ?? null,
    htmlUrl: issue.html_url ?? null,
    author: normalizeUser(issue.user),
    labels: normalizeLabels(issue.labels),
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    closedAt: issue.closed_at ?? null,
  };
}

function normalizeComment(comment) {
  if (!comment) {
    return null;
  }

  return {
    id: comment.id ?? null,
    htmlUrl: comment.html_url ?? null,
    body: comment.body ?? null,
    author: normalizeUser(comment.user),
    createdAt: comment.created_at ?? null,
    updatedAt: comment.updated_at ?? null,
  };
}

function normalizeReview(review, trigger) {
  if (!review && !trigger?.startsWith("pull_request_review")) {
    return null;
  }

  return {
    id: review?.id ?? null,
    type: review?.type || trigger?.replace("pull_request_review_", "") || null,
    state: review?.state ?? null,
    body: review?.body ?? null,
    commitSha: review?.commit_id ?? review?.commit_sha ?? null,
    reviewer: normalizeUser(review?.reviewer || review?.user),
    submittedAt: review?.submitted_at ?? null,
  };
}

function normalizeStatus(payload) {
  if (!(payload.state && payload.sha && payload.context)) {
    return null;
  }

  return {
    id: payload.id ?? null,
    sha: payload.sha,
    state: payload.state,
    context: payload.context,
    description: payload.description ?? null,
    targetUrl: payload.target_url ?? null,
    createdAt: payload.created_at ?? null,
    updatedAt: payload.updated_at ?? null,
    commit: payload.commit ?? null,
  };
}

function normalizeWorkflow(payload) {
  if (payload.workflow_run) {
    return {
      kind: "run",
      action: payload.action ?? null,
      workflow: payload.workflow ?? null,
      run: payload.workflow_run,
      job: null,
    };
  }

  if (payload.workflow_job) {
    return {
      kind: "job",
      action: payload.action ?? null,
      workflow: payload.workflow ?? null,
      run: null,
      job: payload.workflow_job,
    };
  }

  return null;
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels.map(normalizeLabel).filter(Boolean);
}

function normalizeLabel(label) {
  if (!label) {
    return null;
  }

  if (typeof label === "string") {
    return {
      id: null,
      name: label,
      color: null,
      description: null,
    };
  }

  return {
    id: label.id ?? null,
    name: label.name ?? null,
    color: label.color ?? null,
    description: label.description ?? null,
  };
}

function normalizeLabelChanges(changes) {
  if (!changes || typeof changes !== "object") {
    return {
      added: [],
      removed: [],
    };
  }

  const labels = changes.labels || changes.label || {};

  return {
    added: normalizeLabels(labels.added || labels.additions || []),
    removed: normalizeLabels(labels.removed || labels.deletions || []),
  };
}

function normalizeUser(user) {
  if (!user) {
    return null;
  }

  const login = user.login ?? user.username ?? user.name ?? null;

  return {
    id: user.id ?? null,
    login,
    username: user.username ?? login,
    fullName: user.full_name ?? null,
    email: user.email ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

function joinFullName(owner, name) {
  return owner && name ? `${owner}/${name}` : null;
}
