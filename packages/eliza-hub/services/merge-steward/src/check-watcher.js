export async function waitForRequiredChecks({
  client,
  repo,
  ref,
  requiredChecks = [],
  config = {},
  sleep = defaultSleep,
} = {}) {
  if (!client) {
    return {
      status: "skipped",
      reason: "forgejo_client_unconfigured",
      attempts: 0,
      requiredChecks,
      checkResults: {},
      checkDetails: {},
    };
  }

  if (!repo || !ref) {
    return {
      status: "skipped",
      reason: "missing_repo_or_ref",
      attempts: 0,
      requiredChecks,
      checkResults: {},
      checkDetails: {},
    };
  }

  if (requiredChecks.length === 0 && config.allowEmptyRequiredChecks !== true) {
    return {
      status: "blocked",
      reason: "required_checks_missing",
      attempts: 0,
      requiredChecks,
      checkResults: {},
      checkDetails: {},
    };
  }

  const repoObject = parseRepo(repo);
  const maxAttempts = Math.max(
    1,
    Number.parseInt(config.checkPollAttempts ?? 1, 10) || 1,
  );
  const intervalMs = config.checkPollIntervalMs ?? 0;
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { checkResults, checkDetails } = await readCheckResultDetails({
      client,
      repo: repoObject,
      ref,
    });
    const evaluation = evaluateRequiredChecks({ requiredChecks, checkResults });
    last = {
      ...evaluation,
      attempts: attempt,
      requiredChecks,
      checkResults,
      checkDetails,
    };

    if (evaluation.status === "passed") return last;
    if (evaluation.status === "failed" && config.failFast !== false)
      return last;
    if (attempt < maxAttempts && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    ...last,
    status: last?.status === "failed" ? "failed" : "timed_out",
    reason: last?.status === "failed" ? last.reason : "checks_not_complete",
  };
}

export function evaluateRequiredChecks({
  requiredChecks = [],
  checkResults = {},
} = {}) {
  const missing = [];
  const pending = [];
  const failing = [];

  for (const check of requiredChecks) {
    const state = checkResults[check];
    if (!state) {
      missing.push(check);
    } else if (isSuccess(state)) {
    } else if (isFailure(state)) {
      failing.push(check);
    } else {
      pending.push(check);
    }
  }

  if (failing.length > 0) {
    return {
      status: "failed",
      reason: "checks_failed",
      missing,
      pending,
      failing,
    };
  }

  if (missing.length > 0 || pending.length > 0) {
    return {
      status: "pending",
      reason: "checks_not_complete",
      missing,
      pending,
      failing,
    };
  }

  return {
    status: "passed",
    reason: null,
    missing,
    pending,
    failing,
  };
}

export async function readCheckResults({ client, repo, ref } = {}) {
  const { checkResults } = await readCheckResultDetails({ client, repo, ref });
  return checkResults;
}

export async function readCheckResultDetails({ client, repo, ref } = {}) {
  let combinedStatus = null;
  try {
    combinedStatus = await client.getCombinedCommitStatus(repo, ref);
  } catch {
    // error-policy:J4 combined-status endpoint may be unavailable on this
    // Forgejo; fall through to per-commit statuses, and the poller reports a
    // structured timeout if checks never appear
    combinedStatus = null;
  }

  if (
    Array.isArray(combinedStatus?.statuses) &&
    combinedStatus.statuses.length > 0
  ) {
    return checksFromStatuses(combinedStatus.statuses);
  }

  let statuses = [];
  try {
    statuses = await client.listCommitStatuses(repo, ref);
  } catch {
    // error-policy:J4 status listing unavailable reads as "checks pending";
    // waitForRequiredChecks surfaces a structured timeout/failed result, never
    // a fabricated pass
    statuses = [];
  }
  return checksFromStatuses(statuses);
}

function checksFromStatuses(statuses = []) {
  const checkResults = {};
  const checkDetails = {};
  for (const status of statuses) {
    const context = status?.context ?? status?.name;
    const state = status?.state ?? status?.status ?? status?.conclusion;
    if (context && state && checkResults[context] === undefined) {
      const normalizedState = normalizeCheckState(state);
      const targetUrl =
        status?.target_url ??
        status?.targetUrl ??
        status?.html_url ??
        status?.web_url ??
        null;
      checkResults[context] = normalizedState;
      checkDetails[context] = {
        state: normalizedState,
        rawState: state,
        targetUrl,
        runId:
          status?.run_id ??
          status?.runId ??
          status?.workflow_run_id ??
          status?.workflowRunId ??
          actionsRunId(targetUrl),
        description: status?.description ?? null,
        id: status?.id ?? null,
      };
    }
  }
  return { checkResults, checkDetails };
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

function parseRepo(repo) {
  if (typeof repo === "object" && repo?.owner && (repo.repo || repo.name)) {
    return repo;
  }

  const [owner, name, ...rest] = String(repo ?? "").split("/");
  if (!owner || !name || rest.length > 0) {
    throw new TypeError("Check watcher requires repo in owner/name form");
  }
  return { owner, repo: name };
}

function actionsRunId(value) {
  const match = /\/actions\/runs\/([^/?#]+)/u.exec(String(value ?? ""));
  return match?.[1] ?? null;
}

function isSuccess(state) {
  return ["success", "skipped", "neutral"].includes(state);
}

function isFailure(state) {
  return ["failure", "failed", "error"].includes(state);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
