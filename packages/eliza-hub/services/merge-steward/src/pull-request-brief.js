import {
  DEFAULT_POLICY,
  evaluateMergePolicy,
  normalizeQueueItem,
} from "./policy.js";
import { buildValidationPlan } from "./validation-plan.js";

const FAILED_CHECK_STATES = new Set([
  "failure",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "timed_out",
]);
const PENDING_CHECK_STATES = new Set([
  "pending",
  "queued",
  "running",
  "in_progress",
  "waiting",
  "requested",
]);
const LOW_SIGNAL_COMMIT_SUBJECTS = new Set([
  "change",
  "changes",
  "cleanup",
  "fix",
  "fixes",
  "fixup",
  "misc",
  "more",
  "oops",
  "temp",
  "try",
  "tweak",
  "update",
  "updates",
  "wip",
  "work",
]);
const LOW_SIGNAL_COMMIT_WARN_COUNT = 3;
const LOW_SIGNAL_COMMIT_BLOCK_COUNT = 5;
const LOW_SIGNAL_COMMIT_BLOCK_RATIO = 0.6;
const COMMIT_MESSAGE_SAMPLE_LIMIT = 8;

export function buildPullRequestBrief({
  queueItem = {},
  policy = DEFAULT_POLICY,
  now = new Date().toISOString(),
  ciAnalysis = null,
  validationPlan = null,
  validationCommands,
  requestedValidationCommands,
  allowBroadValidationCommands = false,
  validationLimits,
  submissionGate = null,
  reviewAssignment = null,
} = {}) {
  const item = normalizeQueueItem(queueItem);
  const decision = evaluateMergePolicy(queueItem, policy);
  const checks = checkBrief(item, policy);
  const change = changeBrief(item);
  const commitHygiene = commitHygieneBrief(item);
  const validationBudget = validationBudgetBrief({
    item,
    validationPlan,
    validationCommands,
    requestedValidationCommands,
    allowBroadValidationCommands,
    validationLimits,
    now,
  });
  const workReservation = workReservationBrief({ submissionGate });
  const queueDepth = queueDepthBrief({ submissionGate });
  const rateLimit = rateLimitBrief({ submissionGate });
  const riskAreas = riskAreaBrief({ item, decision, policy });
  const verification = verificationBrief({
    item,
    checks,
    decision,
    ciAnalysis,
    validationBudget,
    workReservation,
    queueDepth,
    rateLimit,
    commitHygiene,
  });
  const review = reviewBrief({
    item,
    decision,
    riskAreas,
    verification,
    ciAnalysis,
    workReservation,
    queueDepth,
    rateLimit,
    commitHygiene,
    reviewAssignment,
  });

  return {
    computedAt: now,
    id: itemId(item),
    repo: item.repo || null,
    pullRequestId: item.pullRequestId ?? null,
    title: titleFor(item),
    summary: summaryFor({ item, decision, change, verification, review }),
    sourceBranch: item.sourceBranch || null,
    targetBranch: item.targetBranch || null,
    ownerAgentId: item.ownerAgentId ?? null,
    authorKind: item.authorKind,
    queueState: item.queueState,
    mergeDecision: {
      allowed: decision.allowed,
      state: decision.state,
      blockers: decision.blockers,
      requiredActions: decision.requiredActions,
    },
    change,
    risk: {
      ...decision.risk,
      areas: riskAreas,
    },
    conflict: decision.conflict,
    commitHygiene,
    verification,
    validationBudget,
    workReservation,
    queueDepth,
    rateLimit,
    review,
    labels: labelsFor({ decision, verification, review }),
  };
}

function changeBrief(item) {
  const files = stringArray(item.changedFiles);
  const packages = stringArray(item.affectedPackages);

  return {
    changedLines: numberOrZero(item.changedLines),
    fileCount: files.length,
    packageCount: packages.length,
    files: files.slice(0, 25),
    packages,
    topDirectories: topDirectories(files),
  };
}

function riskAreaBrief({ item, decision, policy }) {
  const files = stringArray(item.changedFiles);
  const areas = [];

  for (const file of decision.risk.sensitiveFiles ?? []) {
    areas.push(
      area(
        "sensitive_path",
        file,
        "high",
        "Requires human approval before merge.",
      ),
    );
  }

  for (const file of files) {
    if (isWorkflowPath(file)) {
      areas.push(
        area("workflow", file, "high", "Changes CI or automation behavior."),
      );
    } else if (isMigrationPath(file)) {
      areas.push(
        area(
          "database_migration",
          file,
          "high",
          "Changes database migration state.",
        ),
      );
    } else if (isEnvPath(file)) {
      areas.push(
        area(
          "environment",
          file,
          "high",
          "Touches environment or secret-shaped config.",
        ),
      );
    } else if (isLockfile(file)) {
      areas.push(
        area(
          "lockfile",
          file,
          "medium",
          "May create dependency or integration conflicts.",
        ),
      );
    }
  }

  if (numberOrZero(item.changedLines) > policy.maxMediumRiskChangedLines) {
    areas.push(
      area(
        "large_change",
        `${item.changedLines} lines`,
        "high",
        "Large diff should be split or reviewed carefully.",
      ),
    );
  } else if (numberOrZero(item.changedLines) > policy.maxLowRiskChangedLines) {
    areas.push(
      area(
        "medium_change",
        `${item.changedLines} lines`,
        "medium",
        "Moderate diff size increases review risk.",
      ),
    );
  }

  if (files.length > 25) {
    areas.push(
      area(
        "many_files",
        `${files.length} files`,
        "medium",
        "Touches many files.",
      ),
    );
  }

  return uniqueAreas(areas);
}

function verificationBrief({
  item,
  checks,
  decision,
  ciAnalysis,
  validationBudget,
  workReservation,
  queueDepth,
  rateLimit,
  commitHygiene,
}) {
  const missing = [];
  if (item.authorKind === "agent" && !item.hasExecutionPlan)
    missing.push("execution_plan");
  if (item.authorKind === "agent" && !item.hasValidationPlan)
    missing.push("validation_plan");
  if (item.authorKind === "agent" && !item.hasIssueLink)
    missing.push("task_link");
  if (
    item.authorKind === "agent" &&
    decision.requiredActions.includes("attach_agent_run_receipt")
  ) {
    missing.push("agent_run_receipt");
  }
  if (checks.failed.length > 0) missing.push("green_checks");
  if (checks.missing.length > 0) missing.push("required_checks");
  if ((ciAnalysis?.summary?.failedLogs ?? 0) > 0)
    missing.push("ci_failure_triage");
  if (validationBudget?.state === "blocked")
    missing.push("scoped_validation_budget");
  if (validationBudget?.state === "needs_validation_plan")
    missing.push("validation_commands");
  if (workReservation && workReservation.state !== "covered")
    missing.push("work_reservation");
  if (queueDepth?.state === "blocked") missing.push("queue_depth");
  if (rateLimit?.state === "blocked") missing.push("submission_rate");
  if (commitHygiene?.state === "needs_summary") missing.push("commit_summary");

  return {
    hasIssueLink: item.hasIssueLink,
    hasExecutionPlan: item.hasExecutionPlan,
    hasValidationPlan: item.hasValidationPlan,
    hasHumanApproval: item.hasHumanApproval,
    agentRunState: item.agentRun?.state ?? null,
    checks,
    missing: [...new Set(missing)],
    validationBudget,
    workReservation,
    queueDepth,
    rateLimit,
    commitHygiene,
    ci: ciAnalysis
      ? {
          primaryCategory: ciAnalysis.summary?.primaryCategory ?? null,
          maxSeverity: ciAnalysis.summary?.maxSeverity ?? null,
          retryable: ciAnalysis.summary?.retryable ?? null,
          nextAction: ciAnalysis.summary?.nextAction ?? null,
        }
      : null,
  };
}

function checkBrief(item, policy) {
  const successStates = new Set(
    stringArray(
      policy.successCheckStates ?? DEFAULT_POLICY.successCheckStates,
    ).map(normalizeStatus),
  );
  const checkResults =
    item.checkResults && typeof item.checkResults === "object"
      ? item.checkResults
      : {};
  const checks = stringArray(item.requiredChecks).map((name) => {
    const state = normalizeStatus(checkResults[name]);
    return {
      name,
      state: state || null,
      status: checkStatus({ state, successStates }),
    };
  });

  return {
    required: checks.map((check) => check.name),
    passed: checks.filter((check) => check.status === "passed"),
    failed: checks.filter((check) => check.status === "failed"),
    pending: checks.filter((check) => check.status === "pending"),
    missing: checks.filter((check) => check.status === "missing"),
  };
}

function reviewBrief({
  item,
  decision,
  riskAreas,
  verification,
  ciAnalysis,
  workReservation,
  queueDepth,
  rateLimit,
  commitHygiene,
  reviewAssignment,
}) {
  const required =
    decision.risk.level === "high" ||
    decision.conflict.level === "high" ||
    riskAreas.some((area) => area.severity === "high") ||
    verification.validationBudget?.state === "blocked" ||
    workReservation?.state === "blocked" ||
    queueDepth?.state === "blocked" ||
    rateLimit?.state === "blocked" ||
    commitHygiene?.state === "needs_summary" ||
    verification.missing.includes("ci_failure_triage") ||
    decision.blockers.includes("review_required");
  const suggestedActions = [
    ...decision.requiredActions,
    ...verification.missing.map((missing) => `provide_${missing}`),
    ...(verification.validationBudget?.requiredActions ?? []),
    ...(workReservation?.requiredActions ?? []),
    ...(queueDepth?.requiredActions ?? []),
    ...(rateLimit?.requiredActions ?? []),
    ...(commitHygiene?.requiredActions ?? []),
    ...(ciAnalysis?.summary?.nextAction &&
    ciAnalysis.summary.nextAction !== "none"
      ? [ciAnalysis.summary.nextAction]
      : []),
  ];

  return {
    required,
    reason: reviewReason({ decision, riskAreas, verification }),
    suggestedOwnerAgentId: item.ownerAgentId ?? null,
    suggestedReviewers: Array.isArray(reviewAssignment?.suggestedReviewers)
      ? reviewAssignment.suggestedReviewers
          .map((reviewer) => reviewer.agentId)
          .filter(Boolean)
      : [],
    assignment: reviewAssignment
      ? {
          state: reviewAssignment.decision?.state ?? null,
          assignmentReady: reviewAssignment.decision?.assignmentReady === true,
          suggestedReviewerCount:
            reviewAssignment.decision?.suggestedReviewerCount ??
            reviewAssignment.suggestedReviewers?.length ??
            0,
          suggestedReviewers: Array.isArray(reviewAssignment.suggestedReviewers)
            ? reviewAssignment.suggestedReviewers.map((reviewer) => ({
                agentId: reviewer.agentId,
                score: reviewer.score,
                reasons: reviewer.reasons,
              }))
            : [],
          humanReviewHints: Array.isArray(reviewAssignment.humanReviewHints)
            ? reviewAssignment.humanReviewHints
            : [],
          labels: Array.isArray(reviewAssignment.labels)
            ? reviewAssignment.labels
            : [],
        }
      : null,
    suggestedActions: [...new Set(suggestedActions)],
    reviewerHints: reviewerHintsFor({ item, riskAreas }),
  };
}

function reviewReason({ decision, riskAreas, verification }) {
  if (verification.validationBudget?.state === "blocked")
    return "validation_budget_blocked";
  if (verification.workReservation?.state === "blocked")
    return "work_reservation_blocked";
  if (verification.queueDepth?.state === "blocked")
    return "queue_depth_blocked";
  if (verification.rateLimit?.state === "blocked")
    return "submission_rate_blocked";
  if (verification.commitHygiene?.state === "needs_summary")
    return "commit_summary_required";
  if (verification.missing.includes("ci_failure_triage"))
    return "ci_failure_needs_triage";
  if (decision.risk.level === "high") return "high_risk_change";
  if (decision.conflict.level === "high") return "high_conflict_likelihood";
  if (riskAreas.some((area) => area.kind === "sensitive_path"))
    return "sensitive_paths";
  if (verification.missing.length > 0) return "missing_verification";
  if (decision.blockers.includes("review_required"))
    return "maintainer_review_required";
  return "standard_review";
}

function reviewerHintsFor({ item, riskAreas }) {
  const hints = new Set();
  if (item.ownerAgentId) hints.add(`agent:${item.ownerAgentId}`);
  for (const packageName of stringArray(item.affectedPackages))
    hints.add(`package:${packageName}`);
  for (const area of riskAreas) {
    if (area.kind === "workflow") hints.add("maintainer:ci");
    if (area.kind === "database_migration") hints.add("maintainer:database");
    if (area.kind === "environment") hints.add("maintainer:security");
    if (area.kind === "sensitive_path") hints.add("maintainer:security");
  }
  return [...hints].sort();
}

function labelsFor({ decision, verification, review }) {
  const labels = [
    `risk:${decision.risk.level}`,
    `conflict:${decision.conflict.level}`,
  ];

  if (review.required) labels.push("needs-human");
  labels.push(...(review.assignment?.labels ?? []));
  if (verification.missing.length > 0) labels.push("needs-verification");
  if (verification.validationBudget?.state === "blocked")
    labels.push("validation:broad-blocked");
  if (verification.validationBudget?.state === "watch")
    labels.push("validation:watch");
  if (verification.workReservation?.state === "blocked")
    labels.push("reservation:missing", "agent:unreserved-work");
  if (verification.workReservation?.state === "missing")
    labels.push("reservation:watch", "agent:unreserved-work");
  if (verification.queueDepth?.state === "blocked")
    labels.push("queue:flood-blocked", "agent:queue-throttled");
  if (verification.queueDepth?.state === "watch")
    labels.push("queue:watch", "agent:queue-watch");
  if (verification.rateLimit?.state === "blocked")
    labels.push("rate:blocked", "agent:rate-throttled");
  if (verification.rateLimit?.state === "watch")
    labels.push("rate:watch", "agent:rate-watch");
  if (verification.commitHygiene?.state === "needs_summary")
    labels.push("commits:needs-summary", "agent:commit-noise");
  if (verification.commitHygiene?.state === "watch")
    labels.push("commits:watch");
  if (decision.allowed && verification.missing.length === 0)
    labels.push("merge-ready");
  return [...new Set(labels)];
}

function commitHygieneBrief(item) {
  const commits = Array.isArray(item.commits) ? item.commits : [];
  if (commits.length === 0) return null;

  const summaries = commits
    .map((commit) => commitSummaryFor(commit))
    .filter((commit) => commit.message);
  const total = summaries.length;
  if (total === 0) return null;

  const lowSignal = summaries.filter((commit) => commit.lowSignal);
  const repeatedMessages = repeatedCommitMessages(summaries);
  const repeatedMessageCount = repeatedMessages.reduce(
    (count, item) => count + item.count,
    0,
  );
  const lowSignalRatio = total > 0 ? lowSignal.length / total : 0;
  const providedSummary = item.commitSummary ?? null;
  const hasProvidedSummary = Boolean(providedSummary);
  const needsSummary =
    !hasProvidedSummary &&
    (lowSignal.length >= LOW_SIGNAL_COMMIT_BLOCK_COUNT ||
      (total >= LOW_SIGNAL_COMMIT_BLOCK_COUNT &&
        lowSignalRatio >= LOW_SIGNAL_COMMIT_BLOCK_RATIO) ||
      repeatedMessageCount >= LOW_SIGNAL_COMMIT_BLOCK_COUNT);
  const watch =
    !hasProvidedSummary &&
    !needsSummary &&
    (lowSignal.length >= LOW_SIGNAL_COMMIT_WARN_COUNT ||
      repeatedMessageCount >= LOW_SIGNAL_COMMIT_WARN_COUNT);
  const state = hasProvidedSummary
    ? "summary_provided"
    : needsSummary
      ? "needs_summary"
      : watch
        ? "watch"
        : "clean";

  return {
    state,
    evidenceAvailable: true,
    total,
    lowSignalCount: lowSignal.length,
    lowSignalRatio: Number(lowSignalRatio.toFixed(2)),
    repeatedMessageCount,
    lowSignalMessages: lowSignal
      .map((commit) => commit.subject)
      .slice(0, COMMIT_MESSAGE_SAMPLE_LIMIT),
    repeatedMessages: repeatedMessages.slice(0, COMMIT_MESSAGE_SAMPLE_LIMIT),
    providedSummary,
    requiredActions: needsSummary
      ? ["provide_commit_summary", "squash_or_rollup_low_signal_commits"]
      : watch
        ? ["watch_commit_noise"]
        : [],
    recommendation: commitHygieneRecommendation({
      state,
      lowSignal,
      repeatedMessages,
      total,
    }),
  };
}

function commitSummaryFor(commit) {
  const message = String(commit?.message ?? "").trim();
  const subject = normalizedCommitSubject(message);
  return {
    sha: commit?.sha ?? null,
    message,
    subject,
    lowSignal: isLowSignalCommitSubject(subject),
  };
}

function normalizedCommitSubject(message) {
  const firstLine = String(message ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
  return firstLine
    .replace(/^[a-z][a-z0-9-]*(?:\([^)]+\))?!?:\s+/i, "")
    .trim()
    .toLowerCase();
}

function isLowSignalCommitSubject(subject) {
  if (!subject) return true;
  if (subject.length <= 4) return true;
  if (LOW_SIGNAL_COMMIT_SUBJECTS.has(subject)) return true;
  if (/^(wip|fixup!?|squash!?)(\s|$)/i.test(subject)) return true;
  if (
    /^(fix|update|change|cleanup|tweak|more|work)\s*(again|more|\d+)?$/i.test(
      subject,
    )
  )
    return true;
  return false;
}

function repeatedCommitMessages(commits) {
  const counts = new Map();
  for (const commit of commits) {
    const key = commit.subject;
    if (!key) continue;
    const existing = counts.get(key) ?? { message: key, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  return [...counts.values()]
    .filter((item) => item.count > 1)
    .sort(
      (left, right) =>
        right.count - left.count || left.message.localeCompare(right.message),
    );
}

function commitHygieneRecommendation({
  state,
  lowSignal,
  repeatedMessages,
  total,
}) {
  if (state === "summary_provided")
    return "Commit rollup supplied; review can use the provided summary.";
  if (state === "needs_summary") {
    return `Provide a reviewer-facing commit rollup before review; ${lowSignal.length} of ${total} commit message(s) are low signal.`;
  }
  if (state === "watch") {
    return repeatedMessages.length > 0
      ? "Watch repeated or low-signal commit messages and add a rollup if the PR grows."
      : "Watch low-signal commit messages and add a rollup if the PR grows.";
  }
  return "Commit messages are reviewable.";
}

function validationBudgetBrief({
  item,
  validationPlan,
  validationCommands,
  requestedValidationCommands,
  allowBroadValidationCommands,
  validationLimits,
  now,
}) {
  const suppliedPlan = objectValue(validationPlan);
  const plan =
    suppliedPlan ??
    (validationCommands || requestedValidationCommands
      ? buildValidationPlan({
          repo: item.repo,
          ownerAgentId: item.ownerAgentId,
          changedFiles: item.changedFiles,
          affectedPackages: item.affectedPackages,
          commands: validationCommands,
          requestedCommands: requestedValidationCommands,
          allowBroadCommands: allowBroadValidationCommands,
          limits: validationLimits,
          now,
        })
      : null);

  if (!plan) return null;

  const decision = plan.decision ?? {};
  return {
    allowed: decision.allowed === true,
    state: decision.state ?? "unknown",
    reason: decision.reason ?? null,
    blockers: stringArray(decision.blockers),
    warnings: stringArray(decision.warnings),
    requiredActions: stringArray(decision.requiredActions),
    broadCommandCount: numberOrZero(plan.summary?.broadCommandCount),
    scopedCommandCount: numberOrZero(plan.summary?.scopedCommandCount),
    recommendedCommands: Array.isArray(plan.recommendedCommands)
      ? plan.recommendedCommands
          .map((command) => ({
            command: String(command.command ?? ""),
            intent: command.intent ?? null,
            scope: command.scope ?? null,
            package: command.package ?? null,
            reason: command.reason ?? null,
          }))
          .filter((command) => command.command)
      : [],
    labels: stringArray(plan.labels),
  };
}

function workReservationBrief({ submissionGate }) {
  const gate = Array.isArray(submissionGate?.gates)
    ? submissionGate.gates.find((item) => item.name === "work_reservation")
    : null;
  if (!gate) return null;

  const evidence =
    gate.evidence && typeof gate.evidence === "object" ? gate.evidence : {};
  return {
    allowed: gate.status !== "fail",
    state: workReservationState(gate.status),
    reason: gate.reason ?? null,
    required: evidence.required === true,
    activeClaimCount: numberOrZero(evidence.activeClaimCount),
    coveredFiles: stringArray(evidence.coveredFiles),
    coveredPackages: stringArray(evidence.coveredPackages),
    missingFiles: stringArray(evidence.missingFiles),
    missingPackages: stringArray(evidence.missingPackages),
    requiredActions: stringArray(gate.requiredActions),
  };
}

function queueDepthBrief({ submissionGate }) {
  const gate = Array.isArray(submissionGate?.gates)
    ? submissionGate.gates.find((item) => item.name === "queue_depth_limit")
    : null;
  if (!gate) return null;

  const evidence =
    gate.evidence && typeof gate.evidence === "object" ? gate.evidence : {};
  return {
    allowed: gate.status !== "fail",
    state: queueDepthState(gate.status),
    reason: gate.reason ?? null,
    queueItems: numberOrZero(evidence.queueItems),
    ready: numberOrZero(evidence.ready),
    runningQueueItems: numberOrZero(evidence.runningQueueItems),
    blockedQueueItems: numberOrZero(evidence.blockedQueueItems),
    maxQueuedWork: numberOrZero(evidence.maxQueuedWork),
    warnQueuedWork: numberOrZero(evidence.warnQueuedWork),
    requiredActions: stringArray(gate.requiredActions),
  };
}

function rateLimitBrief({ submissionGate }) {
  const gate = Array.isArray(submissionGate?.gates)
    ? submissionGate.gates.find((item) => item.name === "submission_rate_limit")
    : null;
  if (!gate) return null;

  const evidence =
    gate.evidence && typeof gate.evidence === "object" ? gate.evidence : {};
  return {
    allowed: gate.status !== "fail",
    state: rateLimitState(gate.status),
    reason: gate.reason ?? null,
    evidenceAvailable: evidence.evidenceAvailable === true,
    recentSubmissions: numberOrZero(evidence.recentSubmissions),
    recentPullRequestIds: stringArray(evidence.recentPullRequestIds),
    maxRecentSubmissions: numberOrZero(evidence.maxRecentSubmissions),
    warnRecentSubmissions: numberOrZero(evidence.warnRecentSubmissions),
    recentSubmissionWindowMinutes: numberOrZero(
      evidence.recentSubmissionWindowMinutes,
    ),
    requiredActions: stringArray(gate.requiredActions),
  };
}

function rateLimitState(status) {
  if (status === "pass") return "within_limit";
  if (status === "fail") return "blocked";
  if (status === "warn") return "watch";
  return "unknown";
}

function queueDepthState(status) {
  if (status === "pass") return "within_limit";
  if (status === "fail") return "blocked";
  if (status === "warn") return "watch";
  return "unknown";
}

function workReservationState(status) {
  if (status === "pass") return "covered";
  if (status === "fail") return "blocked";
  if (status === "warn") return "missing";
  return "unknown";
}

function summaryFor({ item, decision, change, verification, review }) {
  const repo = item.repo || "unknown repo";
  const pr = item.pullRequestId ? `#${item.pullRequestId}` : "PR";
  const packages =
    change.packages.length > 0 ? ` across ${change.packages.join(", ")}` : "";
  const status = decision.allowed
    ? "ready for queue"
    : `blocked by ${decision.blockers.join(", ") || "policy"}`;
  const verificationText =
    verification.missing.length > 0
      ? ` Missing: ${verification.missing.join(", ")}.`
      : " Verification is complete.";
  const reviewText = review.required
    ? " Human review is required."
    : " Standard review is enough.";

  return `${repo} ${pr} touches ${change.fileCount} file(s)${packages}; ${status}.${verificationText}${reviewText}`;
}

function titleFor(item) {
  const repo = item.repo || "repo";
  const pr = item.pullRequestId ? `#${item.pullRequestId}` : "PR";
  return `${repo} ${pr} review brief`;
}

function topDirectories(files) {
  const counts = new Map();
  for (const file of files) {
    const directory = directoryKey(file);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.path.localeCompare(right.path),
    )
    .slice(0, 10);
}

function directoryKey(file) {
  const parts = String(file).split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, Math.min(3, parts.length - 1)).join("/");
}

function checkStatus({ state, successStates }) {
  if (!state) return "missing";
  if (successStates.has(state)) return "passed";
  if (FAILED_CHECK_STATES.has(state)) return "failed";
  if (PENDING_CHECK_STATES.has(state)) return "pending";
  return "pending";
}

function area(kind, path, severity, reason) {
  return { kind, path, severity, reason };
}

function uniqueAreas(areas) {
  const seen = new Set();
  return areas.filter((item) => {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isWorkflowPath(file) {
  return (
    file.startsWith(".github/workflows/") ||
    file.startsWith(".forgejo/workflows/")
  );
}

function isMigrationPath(file) {
  return file.includes("/migrations/");
}

function isEnvPath(file) {
  return /(^|\/)\.env/.test(file);
}

function isLockfile(file) {
  return (
    file.endsWith("bun.lock") ||
    file.endsWith("package-lock.json") ||
    file.endsWith("pnpm-lock.yaml")
  );
}

function itemId(item) {
  if (item.repo && item.pullRequestId)
    return `${item.repo}#${item.pullRequestId}`;
  if (item.id) return String(item.id);
  return null;
}

function stringArray(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item))
    .filter(Boolean);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function normalizeStatus(value) {
  return value === undefined || value === null
    ? ""
    : String(value).trim().toLowerCase();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
