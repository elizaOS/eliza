const DEFAULT_ALLOWED_KINDS = Object.freeze([
  "pull_request",
  "pull_request_label",
  "pull_request_review",
  "pull_request_comment",
  "status",
  "workflow_run",
  "workflow_job",
]);

const PR_EVENT_KINDS = new Set([
  "pull_request",
  "pull_request_label",
  "pull_request_review",
  "pull_request_comment",
]);
const CLOSED_PR_ACTIONS = new Set(["closed", "merged"]);

export function gateForgejoEvent(event, config = {}) {
  if (config.enabled !== true) {
    return allow("event_gate_disabled");
  }

  if (!event?.repository?.fullName) {
    return block("missing_repository");
  }

  const repositories = config.repositories ?? [];
  if (
    repositories.length > 0 &&
    !repositories.includes(event.repository.fullName)
  ) {
    return block("repository_not_allowed");
  }

  const allowedKinds = config.allowedKinds?.length
    ? config.allowedKinds
    : DEFAULT_ALLOWED_KINDS;
  if (!allowedKinds.includes(event.kind)) {
    return block("event_kind_not_allowed");
  }

  if (PR_EVENT_KINDS.has(event.kind)) {
    if (!event.pullRequest) {
      return block("pull_request_missing");
    }

    const state = String(event.pullRequest.state ?? "").toLowerCase();
    if (state && state !== "open" && !CLOSED_PR_ACTIONS.has(event.action)) {
      return block("pull_request_not_open");
    }

    if (config.allowForkPullRequests !== true && isForkPullRequest(event)) {
      return block("fork_pull_request_blocked");
    }
  }

  if (
    event.kind === "pull_request_comment" &&
    isCommentCommand(event, config)
  ) {
    const trustedActors = config.trustedActors ?? [];
    if (
      trustedActors.length > 0 &&
      !trustedActors.includes(event.actor?.login)
    ) {
      return block("comment_command_unauthorized");
    }
  }

  return allow("event_gate_allowed");
}

function allow(reason) {
  return {
    allowed: true,
    action: "allow",
    reason,
  };
}

function block(reason) {
  return {
    allowed: false,
    action: "block",
    reason,
  };
}

function isForkPullRequest(event) {
  const baseRepo = event.pullRequest?.base?.repo;
  const headRepo = event.pullRequest?.head?.repo;
  if (headRepo?.fork === true) return true;
  if (
    baseRepo?.fullName &&
    headRepo?.fullName &&
    baseRepo.fullName !== headRepo.fullName
  )
    return true;
  return false;
}

function isCommentCommand(event, config) {
  const body = String(event.comment?.body ?? "").trim();
  if (!body) return false;
  const prefixes = config.commentCommandPrefixes?.length
    ? config.commentCommandPrefixes
    : ["/eliza", "/steward"];
  return prefixes.some((prefix) => body.startsWith(prefix));
}
