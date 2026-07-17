const DEFAULT_TARGET_BRANCH = "main";

export function buildRepositoryProtectionAudit({
  repo,
  targetBranch,
  policy = null,
  live = null,
  config = {},
  requireLive = false,
  now = new Date().toISOString(),
} = {}) {
  const policyDetails = normalizePolicy({ repo, policy, config });
  const branch = String(
    targetBranch ??
      policyDetails.protectedBranches[0] ??
      arrayValue(config.protectedBranches)[0] ??
      DEFAULT_TARGET_BRANCH,
  );
  const liveDetails = normalizeLive({
    live,
    targetBranch: branch,
    requiredChecks: policyDetails.requiredChecks,
    requireLive,
  });
  const checks = [
    repoPolicyPresentCheck(policyDetails),
    queuePolicyEnabledCheck(policyDetails),
    protectedBranchesConfiguredCheck(policyDetails, branch),
    requiredChecksConfiguredCheck(policyDetails),
    trustedActorsConfiguredCheck(policyDetails),
    forkPolicyCheck(policyDetails),
    liveBranchProtectionCheck(liveDetails, requireLive),
    liveRequiredChecksCheck(liveDetails, requireLive),
  ];
  const decision = decisionFor(checks);

  return {
    computedAt: now,
    repo: policyDetails.repo,
    targetBranch: branch,
    status: decision.status,
    productionReady: decision.productionReady,
    summary: decision.summary,
    counts: {
      protectedBranches: policyDetails.protectedBranches.length,
      requiredChecks: policyDetails.requiredChecks.length,
      trustedActors: policyDetails.trustedActors.length,
      liveProtectedBranches: liveDetails.protections.length,
      matchingLiveProtections: liveDetails.matchingProtections.length,
      missingLiveBranches: liveDetails.missingBranches.length,
      missingRequiredChecks: liveDetails.missingRequiredChecks.length,
    },
    checks,
    labels: labelsFor(decision, checks),
    requiredActions: unique(checks.flatMap((check) => check.requiredActions)),
    policy: policyDetails,
    live: liveDetails,
  };
}

export function branchPatternMatches(pattern, branch) {
  const normalizedPattern = stringValue(pattern);
  const normalizedBranch = stringValue(branch);
  if (!normalizedPattern || !normalizedBranch) return false;
  if (normalizedPattern === normalizedBranch) return true;

  return globPatternToRegExp(normalizedPattern).test(normalizedBranch);
}

function normalizePolicy({ repo, policy, config }) {
  const persisted = Boolean(
    policy && typeof policy === "object" && policy.repo,
  );
  const policyObject = objectValue(policy);
  const protectedBranches = unique(
    arrayValue(
      policyObject.protectedBranches ?? policyObject.protected_branches,
      config.protectedBranches,
    ),
  );
  const requiredChecks = unique(
    arrayValue(
      policyObject.requiredChecks ?? policyObject.required_checks,
      config.requiredChecks,
    ),
  );
  const trustedActors = unique(
    arrayValue(policyObject.trustedActors ?? policyObject.trusted_actors),
  );

  return {
    persisted,
    repo: String(policyObject.repo ?? repo ?? ""),
    queueMode: stringValue(
      policyObject.queueMode ?? policyObject.queue_mode ?? "serialized",
    ),
    protectedBranches,
    requiredChecks,
    trustedActors,
    allowForks: booleanValue(
      policyObject.allowForks ?? policyObject.allow_forks,
      false,
    ),
    updatedAt: policyObject.updatedAt ?? policyObject.updated_at ?? null,
    source: persisted ? "repo_policy" : "process_config",
  };
}

function normalizeLive({ live, targetBranch, requiredChecks, requireLive }) {
  const liveObject = objectValue(live);
  const protections = liveProtectionsFrom(liveObject)
    .map(normalizeLiveProtection)
    .filter((protection) => {
      return Boolean(
        protection.pattern ||
          protection.requiredChecks.length ||
          Object.keys(protection.flags).length,
      );
    });
  const matchingProtections = protections.filter((protection) =>
    branchPatternMatches(protection.pattern, targetBranch),
  );
  const liveRequiredChecks = unique(
    matchingProtections.flatMap((protection) => protection.requiredChecks),
  );
  const missingRequiredChecks = requiredChecks.filter(
    (check) => !liveRequiredChecks.includes(check),
  );
  const available = liveObject.available === true;
  const matchingBranchMissing =
    available && targetBranch && matchingProtections.length === 0;

  return {
    available,
    required: requireLive === true,
    source: liveObject.source ?? "forgejo",
    checked: liveObject.checked === true || available,
    error: liveObject.error ?? null,
    unavailableReason: liveObject.reason ?? null,
    protections,
    matchingProtections,
    missingBranches: matchingBranchMissing ? [targetBranch] : [],
    requiredChecks: liveRequiredChecks,
    missingRequiredChecks,
  };
}

function repoPolicyPresentCheck(policy) {
  if (policy.persisted) {
    return pass("repo_policy_present", "Durable repository policy exists.", {
      repo: policy.repo,
      source: policy.source,
    });
  }
  return fail(
    "repo_policy_present",
    "high",
    "No durable repository policy exists for this repo.",
    {
      repo: policy.repo,
      fallbackSource: policy.source,
    },
    ["create_repo_policy"],
  );
}

function queuePolicyEnabledCheck(policy) {
  if (policy.queueMode === "disabled") {
    return fail(
      "queue_policy_enabled",
      "high",
      "Repository merge queue policy is disabled.",
      {
        queueMode: policy.queueMode,
      },
      ["enable_repo_queue_policy"],
    );
  }
  return pass(
    "queue_policy_enabled",
    "Repository merge queue policy is enabled.",
    {
      queueMode: policy.queueMode,
    },
  );
}

function protectedBranchesConfiguredCheck(policy, targetBranch) {
  if (policy.protectedBranches.length === 0) {
    return fail(
      "protected_branches_configured",
      "critical",
      "No protected branch patterns are configured.",
      {},
      ["configure_protected_branches"],
    );
  }
  if (
    !policy.protectedBranches.some((pattern) =>
      branchPatternMatches(pattern, targetBranch),
    )
  ) {
    return fail(
      "protected_branches_configured",
      "critical",
      "Target branch is not covered by repository policy.",
      {
        targetBranch,
        protectedBranches: policy.protectedBranches,
      },
      ["add_target_branch_protection_policy"],
    );
  }
  return pass(
    "protected_branches_configured",
    "Target branch is covered by repository policy.",
    {
      targetBranch,
      protectedBranches: policy.protectedBranches,
    },
  );
}

function requiredChecksConfiguredCheck(policy) {
  if (policy.requiredChecks.length === 0) {
    return fail(
      "required_checks_configured",
      "critical",
      "No required checks are configured for this repo.",
      {},
      ["configure_required_checks"],
    );
  }
  return pass("required_checks_configured", "Required checks are configured.", {
    requiredChecks: policy.requiredChecks,
  });
}

function trustedActorsConfiguredCheck(policy) {
  if (policy.trustedActors.length === 0) {
    return warn(
      "trusted_actors_configured",
      "medium",
      "No trusted agent actors are configured for this repo.",
      {},
      ["configure_trusted_agent_actors"],
    );
  }
  return pass(
    "trusted_actors_configured",
    "Trusted agent actors are configured.",
    {
      trustedActors: policy.trustedActors,
    },
  );
}

function forkPolicyCheck(policy) {
  if (policy.allowForks === true) {
    return warn(
      "fork_policy_reviewed",
      "medium",
      "Fork pull requests are allowed and need an explicit isolation review.",
      {
        allowForks: true,
      },
      ["review_fork_pull_request_policy"],
    );
  }
  return pass(
    "fork_policy_reviewed",
    "Fork pull requests are disabled for the protected path.",
    {
      allowForks: false,
    },
  );
}

function liveBranchProtectionCheck(live, requireLive) {
  if (!live.available) {
    const details = {
      source: live.source,
      checked: live.checked,
      error: live.error,
      unavailableReason: live.unavailableReason,
    };
    if (requireLive) {
      return fail(
        "live_branch_protection_verified",
        "critical",
        "Live Forgejo branch protection could not be verified.",
        details,
        ["configure_forgejo_token_and_verify_branch_protection"],
      );
    }
    return warn(
      "live_branch_protection_verified",
      "medium",
      "Live Forgejo branch protection has not been verified.",
      details,
      ["verify_live_branch_protection_before_cutover"],
    );
  }
  if (live.missingBranches.length > 0) {
    return fail(
      "live_branch_protection_verified",
      "critical",
      "Live Forgejo branch protection is missing for the target branch.",
      {
        missingBranches: live.missingBranches,
        source: live.source,
      },
      ["configure_forgejo_branch_protection"],
    );
  }
  return pass(
    "live_branch_protection_verified",
    "Live Forgejo branch protection covers the target branch.",
    {
      source: live.source,
      matchingPatterns: live.matchingProtections.map(
        (protection) => protection.pattern,
      ),
    },
  );
}

function liveRequiredChecksCheck(live, requireLive) {
  if (!live.available || live.matchingProtections.length === 0) {
    return requireLive
      ? fail(
          "live_required_checks_verified",
          "critical",
          "Live required checks could not be verified.",
          {
            source: live.source,
            available: live.available,
          },
          ["verify_live_required_checks"],
        )
      : warn(
          "live_required_checks_verified",
          "medium",
          "Live required checks have not been verified.",
          {
            source: live.source,
            available: live.available,
          },
          ["verify_live_required_checks_before_cutover"],
        );
  }
  if (live.missingRequiredChecks.length > 0) {
    return fail(
      "live_required_checks_verified",
      "critical",
      "Live Forgejo branch protection is missing required checks.",
      {
        missingRequiredChecks: live.missingRequiredChecks,
        liveRequiredChecks: live.requiredChecks,
      },
      ["add_missing_live_required_checks"],
    );
  }
  return pass(
    "live_required_checks_verified",
    "Live Forgejo required checks match repository policy.",
    {
      liveRequiredChecks: live.requiredChecks,
    },
  );
}

function decisionFor(checks) {
  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const status =
    failures.length > 0
      ? "blocked"
      : warnings.length > 0
        ? "watch"
        : "protected";

  return {
    status,
    productionReady: status === "protected",
    summary: summaryFor({ status, failures, warnings }),
  };
}

function summaryFor({ status, failures, warnings }) {
  if (status === "blocked")
    return `Repository protection blocked: ${failures[0].reason}`;
  if (status === "watch")
    return `Repository protection needs review: ${warnings[0].reason}`;
  return "Repository protection is verified for live agent merges.";
}

function labelsFor(decision, checks) {
  return unique([
    `repo-protection:${decision.status}`,
    decision.productionReady ? "repo-protection:production-ready" : null,
    checks.some(
      (check) =>
        check.name === "live_branch_protection_verified" &&
        check.status === "fail",
    )
      ? "forgejo-protection:missing"
      : null,
    checks.some(
      (check) =>
        check.name === "live_required_checks_verified" &&
        check.status === "fail",
    )
      ? "checks:missing"
      : null,
    checks.some(
      (check) =>
        check.name === "trusted_actors_configured" && check.status === "warn",
    )
      ? "agents:untrusted"
      : null,
  ]);
}

function normalizeLiveProtection(raw) {
  const value = objectValue(raw);
  return {
    pattern: stringValue(
      value.branch_name ??
        value.branchName ??
        value.name ??
        value.rule_name ??
        value.ruleName ??
        value.pattern ??
        value.glob ??
        value.branch,
    ),
    requiredChecks: unique(checkNamesFrom(value)),
    flags: {
      statusChecksEnabled: booleanValue(
        value.enable_status_check ??
          value.enableStatusCheck ??
          value.required_status_checks?.strict ??
          value.requiredStatusChecks?.strict,
        null,
      ),
      requiredApprovals: numberValue(
        value.required_approvals ?? value.requiredApprovals,
      ),
      blockOnRejectedReviews: booleanValue(
        value.block_on_rejected_reviews ?? value.blockOnRejectedReviews,
        null,
      ),
      blockOnOfficialReviewRequests: booleanValue(
        value.block_on_official_review_requests ??
          value.blockOnOfficialReviewRequests,
        null,
      ),
      enablePush: booleanValue(value.enable_push ?? value.enablePush, null),
      enableForcePush: booleanValue(
        value.enable_force_push ?? value.enableForcePush,
        null,
      ),
    },
  };
}

function liveProtectionsFrom(live) {
  if (Array.isArray(live)) return live;
  for (const key of [
    "protections",
    "branchProtections",
    "branch_protections",
    "data",
    "items",
  ]) {
    if (Array.isArray(live?.[key])) return live[key];
  }
  return [];
}

function checkNamesFrom(value) {
  return unique(
    [
      ...rawArray(value.status_check_contexts),
      ...rawArray(value.statusCheckContexts),
      ...rawArray(value.required_status_checks?.contexts),
      ...rawArray(value.requiredStatusChecks?.contexts),
      ...rawArray(value.required_checks),
      ...rawArray(value.requiredChecks),
      ...rawArray(value.checks),
      ...rawArray(value.contexts),
    ]
      .map(checkName)
      .filter(Boolean),
  );
}

function checkName(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return null;
  return stringValue(
    value.context ?? value.name ?? value.check_name ?? value.checkName,
  );
}

function globPatternToRegExp(pattern) {
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        output += ".*";
        index += 1;
      } else {
        output += "[^/]*";
      }
      continue;
    }
    output += escapeRegExp(character);
  }
  output += "$";
  return new RegExp(output);
}

function pass(name, reason, details = {}) {
  return {
    name,
    status: "pass",
    severity: "info",
    reason,
    details,
    requiredActions: [],
  };
}

function warn(name, severity, reason, details = {}, requiredActions = []) {
  return {
    name,
    status: "warn",
    severity,
    reason,
    details,
    requiredActions,
  };
}

function fail(name, severity, reason, details = {}, requiredActions = []) {
  return {
    name,
    status: "fail",
    severity,
    reason,
    details,
    requiredActions,
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayValue(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return Array.isArray(source)
    ? source.map((item) => stringValue(item)).filter(Boolean)
    : [];
}

function rawArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function booleanValue(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
