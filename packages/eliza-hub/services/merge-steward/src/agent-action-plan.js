export const DEFAULT_AGENT_ACTION_PLAN_LIMITS = Object.freeze({
  maxNextSteps: 8,
  maxInboxCards: 8,
  maxRoutingRecommendations: 5,
  maxSearchResults: 5,
  maxReviewers: 3,
  maxCommands: 5,
});

export function buildAgentActionPlan({
  agentId,
  repo,
  targetBranch,
  proposedItem = null,
  changedFiles,
  affectedPackages,
  bootstrap = null,
  inbox = null,
  routing = null,
  search = null,
  preflight = null,
  validationPlan = null,
  submissionGate = null,
  conflictPrediction = null,
  reviewAssignment = null,
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const normalizedAgentId = requiredString(
    agentId,
    "Agent action plan requires agentId",
  );
  const effectiveLimits = {
    ...DEFAULT_AGENT_ACTION_PLAN_LIMITS,
    ...objectValue(limits),
  };
  const proposed = normalizeProposed({
    proposedItem,
    repo,
    targetBranch,
    ownerAgentId: normalizedAgentId,
    changedFiles,
    affectedPackages,
  });
  const checks = checksFor({
    bootstrap,
    preflight,
    validationPlan,
    conflictPrediction,
    submissionGate,
    reviewAssignment,
    proposed,
  });
  const decision = decisionFor({
    checks,
    proposed,
    inbox,
    routing,
  });
  const nextSteps = nextStepsFor({
    checks,
    decision,
    proposed,
    bootstrap,
    inbox,
    routing,
    search,
    preflight,
    validationPlan,
    submissionGate,
    conflictPrediction,
    reviewAssignment,
    limits: effectiveLimits,
  });

  return {
    computedAt: now,
    readOnly: true,
    agentId: normalizedAgentId,
    mode: proposed ? "proposed_work" : "situational_awareness",
    filters: {
      repo: stringOrNull(repo ?? proposed?.repo ?? bootstrap?.repo),
      targetBranch: stringOrNull(targetBranch ?? proposed?.targetBranch),
    },
    proposed,
    decision,
    summary: {
      checkCount: checks.length,
      blockingCheckCount: checks.filter((check) => check.status === "fail")
        .length,
      warningCheckCount: checks.filter((check) => check.status === "warn")
        .length,
      nextStepCount: nextSteps.length,
      inboxCardCount: numberOrZero(inbox?.counts?.cards),
      routingRecommendationCount: numberOrZero(
        routing?.counts?.recommendations,
      ),
      searchResultCount: numberOrZero(search?.summary?.returnedResults),
    },
    checks,
    nextSteps,
    context: contextFor({
      bootstrap,
      inbox,
      routing,
      search,
      preflight,
      validationPlan,
      submissionGate,
      conflictPrediction,
      reviewAssignment,
      limits: effectiveLimits,
    }),
    labels: labelsFor({ decision, checks, proposed }),
  };
}

function checksFor({
  bootstrap,
  preflight,
  validationPlan,
  conflictPrediction,
  submissionGate,
  reviewAssignment,
  proposed,
}) {
  return [
    identityCheck(bootstrap),
    proposed
      ? decisionCheck({
          id: "work_preflight",
          title: "Work preflight",
          decision: preflight?.decision,
          allowedKey: "allowed",
          passState: "ready",
          absentReason: "No proposed work preflight was computed.",
        })
      : null,
    proposed
      ? decisionCheck({
          id: "validation_budget",
          title: "Validation budget",
          decision: validationPlan?.decision,
          allowedKey: "allowed",
          passState: "scoped",
          absentReason: "No validation plan was computed.",
        })
      : null,
    proposed ? conflictCheck(conflictPrediction) : null,
    proposed
      ? decisionCheck({
          id: "submission_gate",
          title: "Submission gate",
          decision: submissionGate?.decision,
          allowedKey: "allowed",
          passState: "allowed",
          absentReason: "No submission gate was computed.",
        })
      : null,
    proposed ? reviewCheck(reviewAssignment) : null,
  ].filter(Boolean);
}

function identityCheck(bootstrap) {
  const identity = bootstrap?.identity ?? {};
  const state = stringOrNull(identity.state) ?? "unknown";
  const blocked = state.includes("blocked") || state === "unknown";
  return {
    id: "agent_identity",
    title: "Agent identity",
    status: blocked ? "fail" : "pass",
    state,
    reason: blocked
      ? "Agent identity is not ready for autonomous Git work."
      : "Agent identity is known to the steward.",
    blockers: blocked ? ["agent_identity_not_ready"] : [],
    warnings: [],
    requiredActions: blocked ? ["register_agent_identity"] : [],
    evidence: {
      known: identity.known === true,
      state,
      registrySummary: identity.registrySummary ?? null,
    },
  };
}

function decisionCheck({
  id,
  title,
  decision,
  allowedKey,
  passState,
  absentReason,
}) {
  if (!decision) {
    return {
      id,
      title,
      status: "warn",
      state: "missing",
      reason: absentReason,
      blockers: [],
      warnings: ["missing_evidence"],
      requiredActions: [],
      evidence: {},
    };
  }

  const allowed = decision[allowedKey] === true;
  const state =
    stringOrNull(decision.state) ?? (allowed ? passState : "blocked");
  const warnings = stringArray(decision.warnings);
  return {
    id,
    title,
    status: allowed
      ? state === "watch" || warnings.length > 0
        ? "warn"
        : "pass"
      : "fail",
    state,
    reason:
      stringOrNull(decision.reason) ??
      (allowed ? `${title} passed.` : `${title} blocked.`),
    blockers: stringArray(decision.blockers),
    warnings,
    requiredActions: stringArray(decision.requiredActions),
    evidence: {
      score: numberOrNull(decision.score),
    },
  };
}

function conflictCheck(conflictPrediction) {
  const prediction = conflictPrediction?.prediction;
  if (!prediction) {
    return {
      id: "patch_conflict_prediction",
      title: "Patch conflict prediction",
      status: "warn",
      state: "missing",
      reason: "No patch conflict prediction was computed.",
      blockers: [],
      warnings: ["missing_evidence"],
      requiredActions: [],
      evidence: {},
    };
  }

  return {
    id: "patch_conflict_prediction",
    title: "Patch conflict prediction",
    status:
      prediction.safeToStart === false
        ? "fail"
        : prediction.state === "watch"
          ? "warn"
          : "pass",
    state: prediction.state ?? "unknown",
    reason: prediction.reason ?? "Patch conflict prediction completed.",
    blockers: stringArray(prediction.blockers),
    warnings: stringArray(prediction.warnings),
    requiredActions: stringArray(prediction.requiredActions),
    evidence: {
      score: numberOrNull(prediction.score),
      level: prediction.level ?? null,
      overlappingFiles: numberOrZero(
        conflictPrediction?.overlaps?.files?.length,
      ),
      overlappingPackages: numberOrZero(
        conflictPrediction?.overlaps?.packages?.length,
      ),
    },
  };
}

function reviewCheck(reviewAssignment) {
  const decision = reviewAssignment?.decision;
  if (!decision) {
    return {
      id: "review_assignment",
      title: "Review assignment",
      status: "warn",
      state: "missing",
      reason: "No review assignment was computed.",
      blockers: [],
      warnings: ["missing_evidence"],
      requiredActions: [],
      evidence: {},
    };
  }

  return {
    id: "review_assignment",
    title: "Review assignment",
    status:
      decision.assignmentReady === false
        ? "fail"
        : decision.reviewRequired
          ? "warn"
          : "pass",
    state: decision.state ?? "unknown",
    reason: decision.reason ?? "Review assignment completed.",
    blockers: stringArray(decision.blockers),
    warnings: stringArray(decision.warnings),
    requiredActions: stringArray(decision.requiredActions),
    evidence: {
      suggestedReviewerCount: numberOrZero(decision.suggestedReviewerCount),
      minimumReviewers: numberOrZero(decision.minimumReviewers),
    },
  };
}

function decisionFor({ checks, proposed, inbox, routing }) {
  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const blockers = uniqueStrings(
    failed.flatMap((check) =>
      check.blockers.length > 0 ? check.blockers : [check.id],
    ),
  );
  const warningIds = uniqueStrings(
    warnings.flatMap((check) =>
      check.warnings.length > 0 ? check.warnings : [check.id],
    ),
  );
  const requiredActions = uniqueStrings(
    checks.flatMap((check) => check.requiredActions),
  );
  const hasActionableWork =
    numberOrZero(inbox?.counts?.cards) > 0 ||
    numberOrZero(routing?.counts?.recommendations) > 0;
  const submission = checks.find((check) => check.id === "submission_gate");
  const preflight = checks.find((check) => check.id === "work_preflight");
  const conflict = checks.find(
    (check) => check.id === "patch_conflict_prediction",
  );
  const validation = checks.find((check) => check.id === "validation_budget");
  const review = checks.find((check) => check.id === "review_assignment");
  const canStart = proposed
    ? failed.every(
        (check) =>
          ![
            "agent_identity",
            "work_preflight",
            "patch_conflict_prediction",
          ].includes(check.id),
      )
    : failed.length === 0 && hasActionableWork;
  const canSubmit = proposed
    ? failed.length === 0 &&
      submission?.status !== "fail" &&
      validation?.status !== "fail" &&
      review?.status !== "fail" &&
      preflight?.status !== "fail" &&
      conflict?.status !== "fail"
    : false;
  const state = stateFor({
    proposed,
    failed,
    warnings,
    hasActionableWork,
    canSubmit,
  });

  return {
    state,
    canStart,
    canSubmit,
    reason: reasonFor({ state, failed, warnings, proposed, hasActionableWork }),
    blockers,
    warnings: warningIds,
    requiredActions,
  };
}

function stateFor({
  proposed,
  failed,
  warnings,
  hasActionableWork,
  canSubmit,
}) {
  if (failed.length > 0) return "blocked";
  if (warnings.length > 0) return "watch";
  if (proposed && canSubmit) return "ready_to_submit";
  if (proposed) return "ready_to_start";
  if (hasActionableWork) return "ready";
  return "idle";
}

function reasonFor({ state, failed, warnings, proposed, hasActionableWork }) {
  if (failed.length > 0) return failed[0].reason;
  if (warnings.length > 0) return warnings[0].reason;
  if (state === "ready_to_submit")
    return "Proposed work passes steward gates and is ready for PR submission.";
  if (proposed) return "Proposed work is clear to start.";
  if (hasActionableWork)
    return "Agent has actionable Eliza Hub work available.";
  return "No immediate agent action is required.";
}

function nextStepsFor({
  checks,
  decision,
  proposed,
  bootstrap,
  inbox,
  routing,
  search,
  validationPlan,
  submissionGate,
  reviewAssignment,
  limits,
}) {
  const steps = [];
  const failed = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");

  for (const check of [...failed, ...warnings]) {
    for (const action of check.requiredActions) {
      steps.push(
        step({
          id: `${check.id}:${action}`,
          title: humanizeAction(action),
          action,
          priority: check.status === "fail" ? "blocking" : "watch",
          source: check.id,
          reason: check.reason,
        }),
      );
    }
  }

  if (steps.length === 0 && proposed) {
    for (const command of recommendedCommands(validationPlan).slice(
      0,
      limits.maxCommands,
    )) {
      steps.push(
        step({
          id: `validation:${command.command}`,
          title: "Run scoped validation",
          action: "run_validation_command",
          priority: "required",
          source: "validation_budget",
          reason:
            command.reason ??
            "Run a scoped validation command before submission.",
          command: command.command,
        }),
      );
    }

    for (const reviewer of arrayValue(
      reviewAssignment?.suggestedReviewers,
    ).slice(0, limits.maxReviewers)) {
      steps.push(
        step({
          id: `review:${reviewer.agentId}`,
          title: "Assign reviewer",
          action: "assign_suggested_reviewer",
          priority: "required",
          source: "review_assignment",
          reason:
            reviewer.reasons?.[0] ??
            "Reviewer matches the proposed change surface.",
          agentId: reviewer.agentId,
        }),
      );
    }

    if (submissionGate?.decision?.allowed === true) {
      steps.push(
        step({
          id: "submission:create_pull_request",
          title: "Create or update pull request",
          action: "create_or_update_pull_request",
          priority: "required",
          source: "submission_gate",
          reason: submissionGate.decision.reason,
        }),
      );
    }
  }

  if (steps.length === 0) {
    for (const action of arrayValue(bootstrap?.nextActions).slice(
      0,
      limits.maxNextSteps,
    )) {
      steps.push(
        step({
          id: `bootstrap:${action.id ?? action.action ?? steps.length + 1}`,
          title:
            action.title ??
            humanizeAction(
              action.id ?? action.action ?? "inspect_agent_bootstrap",
            ),
          action: action.action ?? action.id ?? "inspect_agent_bootstrap",
          priority: action.blocking ? "blocking" : "suggested",
          source: "agent_bootstrap",
          reason: action.reason ?? null,
          link: action.link ?? null,
        }),
      );
    }
  }

  if (steps.length === 0) {
    for (const recommendation of arrayValue(routing?.recommendations).slice(
      0,
      limits.maxRoutingRecommendations,
    )) {
      steps.push(
        step({
          id: `routing:${recommendation.id ?? recommendation.itemId ?? recommendation.agentId ?? steps.length + 1}`,
          title: "Claim routed work",
          action: "claim_suggested_assignment",
          priority: "suggested",
          source: "agent_routing",
          reason:
            recommendation.reason ?? "Routing model found work for this agent.",
          itemId: recommendation.itemId ?? null,
        }),
      );
    }
  }

  if (steps.length === 0) {
    for (const card of arrayValue(inbox?.cards).slice(
      0,
      limits.maxInboxCards,
    )) {
      steps.push(
        step({
          id: `inbox:${card.id ?? steps.length + 1}`,
          title: card.title ?? "Inspect inbox card",
          action: "inspect_inbox_card",
          priority: card.blocking ? "blocking" : "suggested",
          source: "agent_inbox",
          reason: card.reason ?? card.summary ?? null,
          itemId: card.itemId ?? card.queueItemId ?? null,
        }),
      );
    }
  }

  if (steps.length === 0) {
    for (const result of arrayValue(search?.results).slice(
      0,
      limits.maxSearchResults,
    )) {
      steps.push(
        step({
          id: `search:${result.kind}:${result.id ?? result.rank}`,
          title: result.title ?? "Inspect matching repo context",
          action: "inspect_repo_context",
          priority: "suggested",
          source: "repo_search",
          reason: result.summary ?? null,
          url: result.url ?? null,
        }),
      );
    }
  }

  if (steps.length === 0 && decision.state === "idle") {
    steps.push(
      step({
        id: "idle:wait_for_assignment",
        title: "Wait for assignment",
        action: "wait_for_assignment",
        priority: "optional",
        source: "agent_action_plan",
        reason: "No claimable or routed work is currently available.",
      }),
    );
  }

  return dedupeSteps(steps)
    .slice(0, limits.maxNextSteps)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
    }));
}

function contextFor({
  bootstrap,
  inbox,
  routing,
  search,
  preflight,
  validationPlan,
  submissionGate,
  conflictPrediction,
  reviewAssignment,
  limits,
}) {
  return {
    bootstrap: bootstrap
      ? {
          identity: bootstrap.identity ?? null,
          policyHints: bootstrap.policyHints ?? null,
          links: bootstrap.links ?? null,
        }
      : null,
    inbox: inbox
      ? {
          computedAt: inbox.computedAt ?? null,
          counts: inbox.counts ?? {},
          cards: arrayValue(inbox.cards)
            .slice(0, limits.maxInboxCards)
            .map(cardSummary),
        }
      : null,
    routing: routing
      ? {
          computedAt: routing.computedAt ?? null,
          counts: routing.counts ?? {},
          recommendations: arrayValue(routing.recommendations).slice(
            0,
            limits.maxRoutingRecommendations,
          ),
        }
      : null,
    search: search
      ? {
          computedAt: search.computedAt ?? null,
          query: search.query ?? "",
          summary: search.summary ?? {},
          results: arrayValue(search.results)
            .slice(0, limits.maxSearchResults)
            .map(searchResultSummary),
        }
      : null,
    preflight: preflight
      ? {
          decision: preflight.decision ?? null,
          labels: preflight.labels ?? [],
        }
      : null,
    validationPlan: validationPlan
      ? {
          summary: validationPlan.summary ?? {},
          decision: validationPlan.decision ?? null,
          recommendedCommands: recommendedCommands(validationPlan).slice(
            0,
            limits.maxCommands,
          ),
          labels: validationPlan.labels ?? [],
        }
      : null,
    submissionGate: submissionGate
      ? {
          summary: submissionGate.summary ?? {},
          decision: submissionGate.decision ?? null,
          labels: submissionGate.labels ?? [],
        }
      : null,
    conflictPrediction: conflictPrediction
      ? {
          prediction: conflictPrediction.prediction ?? null,
          recommendedPlan: conflictPrediction.recommendedPlan ?? null,
          labels: conflictPrediction.labels ?? [],
        }
      : null,
    reviewAssignment: reviewAssignment
      ? {
          decision: reviewAssignment.decision ?? null,
          suggestedReviewers: arrayValue(
            reviewAssignment.suggestedReviewers,
          ).slice(0, limits.maxReviewers),
          humanReviewHints: reviewAssignment.humanReviewHints ?? [],
          labels: reviewAssignment.labels ?? [],
        }
      : null,
  };
}

function labelsFor({ decision, checks, proposed }) {
  return uniqueStrings([
    `agent-action-plan:${decision.state}`,
    proposed
      ? "agent-action-plan:proposed-work"
      : "agent-action-plan:situational",
    ...checks.map((check) => `agent-action-plan:${check.id}:${check.status}`),
    ...(decision.canStart ? ["agent-action-plan:can-start"] : []),
    ...(decision.canSubmit ? ["agent-action-plan:can-submit"] : []),
  ]);
}

function normalizeProposed({
  proposedItem,
  repo,
  targetBranch,
  ownerAgentId,
  changedFiles,
  affectedPackages,
}) {
  const item = objectValue(proposedItem);
  const files = uniqueStrings(
    changedFiles ?? item?.changedFiles ?? item?.paths,
  );
  const packages = uniqueStrings(
    affectedPackages ?? item?.affectedPackages ?? item?.packages,
  );
  if (!item && files.length === 0 && packages.length === 0) return null;
  return {
    id: item?.id ?? null,
    repo: stringOrNull(repo ?? item?.repo),
    targetBranch: stringOrNull(targetBranch ?? item?.targetBranch),
    sourceBranch: stringOrNull(item?.sourceBranch),
    pullRequestId: item?.pullRequestId ?? item?.number ?? null,
    ownerAgentId,
    authorKind: item?.authorKind ?? "agent",
    title: stringOrNull(item?.title ?? item?.summary),
    changedFiles: files,
    affectedPackages: packages,
    changedLines: numberOrZero(item?.changedLines),
  };
}

function cardSummary(card) {
  return {
    id: card.id ?? null,
    title: card.title ?? null,
    lane: card.lane ?? card.column ?? null,
    priority: card.priority ?? null,
    itemId: card.itemId ?? card.queueItemId ?? null,
    blocking: card.blocking === true,
  };
}

function searchResultSummary(result) {
  return {
    rank: result.rank ?? null,
    kind: result.kind ?? null,
    id: result.id ?? null,
    title: result.title ?? null,
    score: result.score ?? null,
    url: result.url ?? null,
    snippets: result.snippets ?? [],
  };
}

function recommendedCommands(validationPlan) {
  return arrayValue(
    validationPlan?.decision?.recommendedCommands ??
      validationPlan?.recommendedCommands,
  );
}

function step({
  id,
  title,
  action,
  priority,
  source,
  reason = null,
  link = null,
  url = null,
  command = null,
  agentId = null,
  itemId = null,
}) {
  return {
    id,
    title,
    action,
    priority,
    source,
    reason,
    link,
    url,
    command,
    agentId,
    itemId,
  };
}

function dedupeSteps(steps) {
  const seen = new Set();
  const output = [];
  for (const item of steps) {
    const key = item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function humanizeAction(action) {
  return String(action ?? "act")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function requiredString(value, message) {
  const normalized = stringOrNull(value);
  if (!normalized) throw new TypeError(message);
  return normalized;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function stringArray(value) {
  return uniqueStrings(arrayValue(value));
}

function uniqueStrings(value) {
  return [
    ...new Set(
      arrayValue(value)
        .map((item) => stringOrNull(item))
        .filter(Boolean),
    ),
  ];
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
