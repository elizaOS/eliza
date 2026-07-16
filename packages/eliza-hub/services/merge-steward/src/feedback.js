import { ForgejoApiError } from "./forgejo-client.js";
import { QUEUE_STATES } from "./policy.js";

const MANAGED_AGENT_LABELS = Object.freeze([
  "agent:claimed",
  "agent:branch-unowned",
  "agent:duplicate-risk",
  "agent:needs-human",
  "agent:queue-throttled",
  "agent:queue-watch",
  "agent:rate-throttled",
  "agent:rate-watch",
  "agent:stale",
  "agent:stale-claim",
  "agent:unreserved-work",
]);

const SUBMISSION_GATE_AGENT_LABELS = new Set([
  "agent:branch-unowned",
  "agent:queue-throttled",
  "agent:queue-watch",
  "agent:rate-throttled",
  "agent:rate-watch",
  "agent:unreserved-work",
]);

export function buildForgejoFeedback({
  item,
  decision,
  comment,
  event,
  config = {},
  claims = [],
  submissionGate = null,
} = {}) {
  const skipReason = skipFeedbackReason(event, config);
  if (skipReason) {
    return {
      valid: false,
      reason: skipReason,
      operations: [],
    };
  }

  if (!item?.repo || !item.pullRequestId) {
    return {
      valid: false,
      reason: "missing_repo_or_pull_request",
      operations: [],
    };
  }

  let repo;
  try {
    repo = parseRepoFullName(item.repo);
  } catch {
    // error-policy:J3 malformed repo name on the item becomes an explicit
    // invalid feedback plan
    return {
      valid: false,
      reason: "invalid_repo",
      operations: [],
    };
  }

  const desiredLabels =
    config.syncLabels === false
      ? []
      : labelsForDecision(decision, { item, claims, submissionGate });
  const currentLabels = new Set(item.labels ?? []);
  const desiredLabelSet = new Set(desiredLabels);
  const addLabels = desiredLabels.filter((label) => !currentLabels.has(label));
  const removeLabels = [...currentLabels].filter(
    (label) => isManagedFeedbackLabel(label) && !desiredLabelSet.has(label),
  );
  const shouldComment =
    config.postComments !== false && shouldPostCommentForEvent(event);
  const feedback = {
    valid: true,
    repo,
    issueNumber: item.pullRequestId,
    desiredLabels,
    addLabels,
    removeLabels,
    comment: shouldComment ? comment : null,
  };

  return {
    ...feedback,
    operations: plannedOperations(feedback),
  };
}

export async function applyForgejoFeedback({
  client,
  feedback,
  dryRun = true,
} = {}) {
  if (!feedback?.valid) {
    return {
      enabled: true,
      skipped: true,
      reason: feedback?.reason ?? "invalid_feedback",
      dryRun,
      operations: [],
    };
  }

  const operations = plannedOperations(feedback);
  if (dryRun) {
    return {
      enabled: true,
      dryRun: true,
      operations,
    };
  }

  if (!client) {
    return {
      enabled: true,
      skipped: true,
      reason: "forgejo_client_unconfigured",
      dryRun: false,
      operations,
    };
  }

  const applied = [];

  for (const label of feedback.removeLabels) {
    try {
      await client.removeIssueLabel(feedback.repo, feedback.issueNumber, label);
      applied.push({ type: "remove_label", label });
    } catch (error) {
      // error-policy:J4 label already absent (404) is the desired end state and
      // is recorded as skipped; anything else rethrows
      if (!isNotFound(error)) throw error;
      applied.push({
        type: "remove_label",
        label,
        skipped: true,
        reason: "label_not_present",
      });
    }
  }

  if (feedback.addLabels.length > 0) {
    await client.addIssueLabels(
      feedback.repo,
      feedback.issueNumber,
      feedback.addLabels,
    );
    applied.push({ type: "add_labels", labels: feedback.addLabels });
  }

  if (feedback.comment) {
    const comments = await client.listIssueComments(
      feedback.repo,
      feedback.issueNumber,
    );
    if (
      Array.isArray(comments) &&
      comments.some((entry) => entry?.body === feedback.comment)
    ) {
      applied.push({
        type: "create_comment",
        skipped: true,
        reason: "duplicate_comment",
      });
    } else {
      await client.createIssueComment(
        feedback.repo,
        feedback.issueNumber,
        feedback.comment,
      );
      applied.push({ type: "create_comment" });
    }
  }

  return {
    enabled: true,
    dryRun: false,
    operations,
    applied,
  };
}

export function labelsForDecision(
  decision = {},
  { item = {}, claims = [], submissionGate = null } = {},
) {
  return unique([
    queueLabelForState(decision.state),
    decision.risk?.level ? `risk:${decision.risk.level}` : null,
    ...ownerLabelsFor(item, claims),
    ...claimLabelsFor(claims),
    ...submissionGateLabelsFor(submissionGate),
    needsHuman(decision) ? "agent:needs-human" : null,
    decision.blockers?.includes("stale_target") ? "agent:stale" : null,
  ]);
}

export function isManagedFeedbackLabel(label) {
  return (
    /^queue:/.test(label) ||
    /^risk:/.test(label) ||
    /^agent-owner:/.test(label) ||
    /^agent-submit:/.test(label) ||
    /^validation:/.test(label) ||
    /^reservation:/.test(label) ||
    /^rate:/.test(label) ||
    /^branch:/.test(label) ||
    MANAGED_AGENT_LABELS.includes(label)
  );
}

export function skipFeedbackReason(event, config = {}) {
  if (!event) return null;
  if (event.kind === "pull_request_comment") return "comment_event";

  const stewardUsername = config.stewardUsername;
  const actor = event.actor?.login ?? event.actor?.username;
  if (
    stewardUsername &&
    actor &&
    actor.toLowerCase() === stewardUsername.toLowerCase()
  ) {
    return "steward_originated_event";
  }

  return null;
}

function queueLabelForState(state) {
  if (state === QUEUE_STATES.READY) return "queue:ready";
  if (state === QUEUE_STATES.QUEUED) return "queue:queued";
  if (state === QUEUE_STATES.BUILDING_INTEGRATION) return "queue:building";
  if (state === QUEUE_STATES.MERGED) return "queue:merged";
  return "queue:blocked";
}

function needsHuman(decision = {}) {
  const blockers = new Set(decision.blockers ?? []);
  const requiredActions = new Set(decision.requiredActions ?? []);
  return (
    blockers.has("review_required") ||
    blockers.has("unknown_agent") ||
    blockers.has("sensitive_paths_need_human") ||
    requiredActions.has("maintainer_review") ||
    requiredActions.has("human_triage") ||
    requiredActions.has("human_approval_for_sensitive_paths")
  );
}

function ownerLabelsFor(item = {}, claims = []) {
  return unique([
    item.ownerAgentId ? `agent-owner:${labelValue(item.ownerAgentId)}` : null,
    ...claims.map((claim) =>
      claim.ownerAgentId
        ? `agent-owner:${labelValue(claim.ownerAgentId)}`
        : null,
    ),
  ]);
}

function claimLabelsFor(claims = []) {
  const relevant = claims.filter((claim) => claim?.status === "active");
  if (relevant.length === 0) return [];
  if (relevant.some((claim) => claimExpired(claim)))
    return ["agent:stale-claim"];
  return ["agent:claimed"];
}

function submissionGateLabelsFor(gate) {
  const state = gate?.decision?.state ?? gate?.state;
  return unique([
    state ? `agent-submit:${labelValue(state)}` : null,
    ...stringArray(gate?.labels).filter(isSubmissionGateFeedbackLabel),
  ]);
}

function isSubmissionGateFeedbackLabel(label) {
  return (
    /^queue:/.test(label) ||
    /^validation:/.test(label) ||
    /^reservation:/.test(label) ||
    /^rate:/.test(label) ||
    /^branch:/.test(label) ||
    SUBMISSION_GATE_AGENT_LABELS.has(label)
  );
}

function claimExpired(claim) {
  if (!claim?.expiresAt) return false;
  const timestamp = Date.parse(claim.expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function labelValue(value) {
  return (
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function shouldPostCommentForEvent(event) {
  if (!event) return true;
  return !["status", "workflow_run", "workflow_job"].includes(event.kind);
}

function plannedOperations(feedback) {
  const operations = [];
  for (const label of feedback.removeLabels ?? []) {
    operations.push({ type: "remove_label", label });
  }
  if (feedback.addLabels?.length > 0) {
    operations.push({ type: "add_labels", labels: feedback.addLabels });
  }
  if (feedback.comment) {
    operations.push({ type: "create_comment" });
  }
  return operations;
}

function parseRepoFullName(fullName) {
  const [owner, repo, ...rest] = String(fullName).split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new TypeError("Forgejo feedback requires repo in owner/name form");
  }
  return { owner, repo };
}

function isNotFound(error) {
  return error instanceof ForgejoApiError && error.status === 404;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stringArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item))
    .filter(Boolean);
}
