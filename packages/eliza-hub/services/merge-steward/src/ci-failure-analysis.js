const SEVERITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

const FAILURE_RULES = Object.freeze([
  rule({
    category: "secret_missing",
    severity: "critical",
    retryable: false,
    requiresHuman: true,
    title: "Secret or credential is missing",
    actions: ["inject_or_rotate_secret", "verify_secret_scope", "rerun_check"],
    patterns: [
      /secret .*not found/i,
      /missing (?:required )?(?:secret|token|credential|api key)/i,
      /(?:unauthorized|forbidden|invalid token|bad credentials|authentication failed)/i,
      /(?:401|403)\s+(?:unauthorized|forbidden)/i,
    ],
  }),
  rule({
    category: "runner_infra",
    severity: "high",
    retryable: true,
    requiresHuman: false,
    title: "Runner infrastructure failed",
    actions: ["retry_check", "inspect_runner_pool", "verify_runner_isolation"],
    patterns: [
      /cannot connect to the docker daemon/i,
      /\/var\/run\/docker\.sock/i,
      /no space left on device/i,
      /runner .* (?:lost|offline|disconnected)/i,
      /failed to start container/i,
    ],
  }),
  rule({
    category: "infra_flake",
    severity: "medium",
    retryable: true,
    requiresHuman: false,
    title: "External infrastructure or network flake",
    actions: [
      "retry_check",
      "watch_for_repeat_failure",
      "route_to_infra_if_repeated",
    ],
    patterns: [
      /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i,
      /network .*timed? out/i,
      /TLS handshake timeout/i,
      /\b(?:502|503|504)\b/,
      /rate limit exceeded/i,
    ],
  }),
  rule({
    category: "timeout",
    severity: "medium",
    retryable: true,
    requiresHuman: false,
    title: "Check timed out",
    actions: [
      "retry_check",
      "split_slow_job",
      "inspect_recent_runtime_regression",
    ],
    patterns: [
      /timed out/i,
      /deadline exceeded/i,
      /cancelled after/i,
      /exceeded .* timeout/i,
    ],
  }),
  rule({
    category: "dependency_install",
    severity: "high",
    retryable: false,
    requiresHuman: false,
    title: "Dependency installation failed",
    actions: ["fix_dependency_install", "verify_lockfile", "rerun_check"],
    patterns: [
      /npm ERR!/i,
      /pnpm .*ERR/i,
      /yarn .*error/i,
      /lockfile .*out.of.date/i,
      /cannot find module/i,
      /package .* not found/i,
    ],
  }),
  rule({
    category: "typecheck_failure",
    severity: "high",
    retryable: false,
    requiresHuman: false,
    title: "Typecheck failed",
    actions: ["fix_type_error", "rerun_typecheck"],
    patterns: [
      /\bTS\d{4}\b/,
      /typecheck failed/i,
      /typescript .*error/i,
      /\btsc\b.*(?:failed|error)/i,
    ],
  }),
  rule({
    category: "lint_failure",
    severity: "medium",
    retryable: false,
    requiresHuman: false,
    title: "Lint or formatting failed",
    actions: ["fix_lint", "run_formatter", "rerun_check"],
    patterns: [
      /\beslint\b/i,
      /\bprettier\b/i,
      /lint(?:er)? .*failed/i,
      /no-unused-vars/i,
      /format(?:ting)? check failed/i,
    ],
  }),
  rule({
    category: "test_failure",
    severity: "high",
    retryable: false,
    requiresHuman: false,
    title: "Test assertion failed",
    actions: ["inspect_failed_test", "fix_regression", "rerun_test_job"],
    patterns: [
      /^\s*FAIL\b/im,
      /\bAssertionError\b/i,
      /\bExpected\b.*\bReceived\b/is,
      /\btests?\b.*\bfailed\b/i,
      /\bnot ok\b/i,
    ],
  }),
  rule({
    category: "build_failure",
    severity: "high",
    retryable: false,
    requiresHuman: false,
    title: "Build failed",
    actions: ["inspect_build_output", "fix_build_regression", "rerun_build"],
    patterns: [
      /build failed/i,
      /compilation failed/i,
      /\b(?:vite|webpack|rollup|esbuild)\b.*(?:error|failed)/i,
    ],
  }),
  rule({
    category: "merge_conflict",
    severity: "high",
    retryable: false,
    requiresHuman: false,
    title: "Branch or integration merge conflict",
    actions: [
      "rebase_or_update_branch",
      "resolve_conflict",
      "rerun_integration",
    ],
    patterns: [
      /merge conflict/i,
      /CONFLICT \(/,
      /could not apply .* patch/i,
      /automatic merge failed/i,
    ],
  }),
]);

export function buildCiFailureAnalysis({
  queueItem = null,
  queueItemId = null,
  repo,
  pullRequestId,
  ownerAgentId,
  checks = [],
  logs = [],
  now = new Date().toISOString(),
} = {}) {
  const context = normalizeContext({
    queueItem,
    queueItemId,
    repo,
    pullRequestId,
    ownerAgentId,
  });
  const entries = normalizeEntries({ checks, logs });
  const analyses =
    entries.length > 0
      ? entries.map((entry, index) => analyzeEntry({ entry, index, context }))
      : [analyzeEntry({ entry: emptyEntry(), index: 0, context })];
  const failedAnalyses = analyses.filter(
    (analysis) => analysis.category !== "passed",
  );
  const categories = countBy(failedAnalyses, (analysis) => analysis.category);
  const maxSeverity =
    highestSeverity(failedAnalyses.map((analysis) => analysis.severity)) ??
    "info";
  const primary = [...failedAnalyses].sort(compareAnalyses)[0] ?? null;

  return {
    computedAt: now,
    queueItem: context.queueItem,
    summary: {
      totalLogs: analyses.length,
      failedLogs: failedAnalyses.length,
      primaryCategory: primary?.category ?? "passed",
      maxSeverity,
      retryable:
        failedAnalyses.length > 0 &&
        failedAnalyses.every((analysis) => analysis.retryable === true),
      requiresHuman: failedAnalyses.some(
        (analysis) => analysis.requiresHuman === true,
      ),
      categories,
      nextAction: primary?.suggestedActions?.[0] ?? "none",
    },
    analyses,
    recommendations: failedAnalyses
      .map(recommendationFor)
      .sort(compareRecommendations),
  };
}

function analyzeEntry({ entry, index, context }) {
  const text = entry.text;
  const status = normalizeStatus(entry.status ?? entry.conclusion);
  const matched = firstMatchingRule(text);
  const passed = !matched && isSuccessStatus(status);
  const rule = matched ?? unknownRule({ status, text });
  const evidence = evidenceFor({
    text,
    patterns: rule.patterns,
    annotations: entry.annotations,
  });
  const category = passed ? "passed" : rule.category;
  const severity = passed ? "info" : rule.severity;

  return {
    id: entry.id ?? `ci-analysis-${index + 1}`,
    checkName: entry.name ?? entry.checkName ?? `check-${index + 1}`,
    status: status || null,
    category,
    severity,
    confidence: passed ? 1 : confidenceFor({ rule, evidence }),
    retryable: passed ? false : rule.retryable,
    requiresHuman: passed ? false : rule.requiresHuman,
    likelyOwnerAgentId: entry.ownerAgentId ?? context.ownerAgentId,
    title: passed ? "Check passed" : rule.title,
    summary: summaryFor({ entry, category, rule, context, evidence }),
    suggestedActions: passed ? [] : [...rule.actions],
    evidence,
    impact: {
      paths: context.paths,
      packages: context.packages,
    },
  };
}

function firstMatchingRule(text) {
  return FAILURE_RULES.find((candidate) =>
    candidate.patterns.some((pattern) => pattern.test(text)),
  );
}

function unknownRule({ status, text }) {
  const failed = isFailureStatus(status) || text.trim() !== "";
  return rule({
    category: failed ? "unknown_failure" : "missing_log",
    severity: failed ? "medium" : "low",
    retryable: false,
    requiresHuman: false,
    title: failed ? "CI failed without a known signature" : "CI log is missing",
    actions: failed
      ? ["inspect_ci_failure", "attach_full_log", "rerun_check"]
      : ["attach_full_log"],
    patterns: [],
  });
}

function evidenceFor({ text, patterns, annotations = [] }) {
  const evidence = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (evidence.length >= 5) return;
    if (patterns.some((pattern) => pattern.test(line))) {
      evidence.push({
        line: index + 1,
        text: compactLine(line),
      });
    }
  });

  for (const annotation of annotations) {
    if (evidence.length >= 5) break;
    const message = annotation?.message ?? annotation?.text;
    if (!message) continue;
    evidence.push({
      line: Number.isFinite(Number(annotation.line))
        ? Number(annotation.line)
        : null,
      path: annotation.path ?? annotation.file ?? null,
      text: compactLine(message),
    });
  }

  if (evidence.length === 0 && text.trim()) {
    const firstMeaningfulLine = lines.find((line) => line.trim());
    if (firstMeaningfulLine) {
      evidence.push({
        line: lines.indexOf(firstMeaningfulLine) + 1,
        text: compactLine(firstMeaningfulLine),
      });
    }
  }

  return evidence;
}

function recommendationFor(analysis) {
  return {
    type: "ci_failure",
    severity: analysis.severity,
    action: analysis.suggestedActions[0] ?? "inspect_ci_failure",
    checkName: analysis.checkName,
    category: analysis.category,
    ownerAgentId: analysis.likelyOwnerAgentId,
    title: analysis.title,
    evidence: analysis.evidence.map((item) => item.text),
  };
}

function summaryFor({ entry, category, rule, context, evidence }) {
  const check = entry.name ?? entry.checkName ?? "CI check";
  const owner = entry.ownerAgentId ?? context.ownerAgentId;
  const ownerText = owner ? ` Route to ${owner}.` : "";
  const evidenceText = evidence[0]?.text
    ? ` First evidence: ${evidence[0].text}`
    : "";
  return `${check}: ${rule.title} (${category}).${ownerText}${evidenceText}`;
}

function normalizeContext({
  queueItem,
  queueItemId,
  repo,
  pullRequestId,
  ownerAgentId,
}) {
  const item = queueItem && typeof queueItem === "object" ? queueItem : {};
  return {
    ownerAgentId: ownerAgentId ?? item.ownerAgentId ?? null,
    paths: stringArray(item.changedFiles),
    packages: stringArray(item.affectedPackages),
    queueItem: {
      id: item.id ?? queueItemId ?? null,
      repo: item.repo ?? repo ?? null,
      pullRequestId: item.pullRequestId ?? pullRequestId ?? null,
      targetBranch: item.targetBranch ?? null,
      sourceBranch: item.sourceBranch ?? null,
      ownerAgentId: ownerAgentId ?? item.ownerAgentId ?? null,
    },
  };
}

function normalizeEntries({ checks, logs }) {
  return [
    ...arrayValue(checks).map(normalizeEntry),
    ...arrayValue(logs).map(normalizeEntry),
  ];
}

function normalizeEntry(value) {
  if (typeof value === "string") {
    return {
      text: value,
      status: null,
      annotations: [],
    };
  }

  const object = value && typeof value === "object" ? value : {};
  return {
    ...object,
    name:
      object.name ??
      object.checkName ??
      object.jobName ??
      object.workflowName ??
      null,
    status: object.status ?? object.conclusion ?? object.state ?? null,
    text: [
      object.log,
      object.logs,
      object.output,
      object.error,
      object.stderr,
      object.stdout,
    ]
      .filter((part) => part !== undefined && part !== null)
      .join("\n"),
    annotations: arrayValue(object.annotations),
  };
}

function emptyEntry() {
  return {
    name: "ci",
    status: "failure",
    text: "",
    annotations: [],
  };
}

function confidenceFor({ rule, evidence }) {
  if (rule.category === "unknown_failure" || rule.category === "missing_log")
    return 0.2;
  if (evidence.length >= 2) return 0.9;
  if (evidence.length === 1) return 0.75;
  return 0.5;
}

function compareAnalyses(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    Number(right.confidence) - Number(left.confidence) ||
    String(left.checkName).localeCompare(String(right.checkName))
  );
}

function compareRecommendations(left, right) {
  return (
    severityRank(left.severity) - severityRank(right.severity) ||
    String(left.checkName).localeCompare(String(right.checkName))
  );
}

function highestSeverity(values) {
  return (
    values.sort((left, right) => severityRank(left) - severityRank(right))[0] ??
    null
  );
}

function severityRank(value) {
  return SEVERITY_RANK[value] ?? SEVERITY_RANK.info;
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizeStatus(value) {
  return value === undefined || value === null
    ? ""
    : String(value).trim().toLowerCase();
}

function isSuccessStatus(value) {
  return ["success", "passed", "ok", "completed"].includes(
    normalizeStatus(value),
  );
}

function isFailureStatus(value) {
  return [
    "failure",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "timed_out",
  ].includes(normalizeStatus(value));
}

function stringArray(value) {
  return arrayValue(value)
    .map((item) => String(item))
    .filter(Boolean);
}

function arrayValue(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function compactLine(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function rule(definition) {
  return Object.freeze({
    ...definition,
    patterns: Object.freeze(definition.patterns),
    actions: Object.freeze(definition.actions),
  });
}
