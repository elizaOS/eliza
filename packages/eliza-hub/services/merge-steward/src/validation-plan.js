export const DEFAULT_VALIDATION_PLAN_LIMITS = Object.freeze({
  maxBroadCommands: 0,
  maxEstimatedCost: 7,
  maxRecommendations: 6,
});

const INTENT_PRIORITY = Object.freeze({
  typecheck: 0,
  test: 1,
  build: 2,
  lint: 3,
  format: 4,
  unknown: 5,
});

const ROOT_RUNNER_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint)\b/i;
const TURBO_PATTERN = /\bturbo\b/i;
const TSC_PATTERN = /(?:^|\s)tsc(?:\s|$)/i;
const BUN_BUILD_PATTERN = /\bbun\s+build\b/i;
const SCOPED_PATTERN =
  /(?:--filter(?:=|\s+)\S+|--scope(?:=|\s+)\S+|--workspace(?:=|\s+)\S+|(?:^|\s)-w\s+\S+|--project(?:=|\s+)\S+|(?:^|\s)-p\s+\S+|--affected\b|--changed\b|--since(?:=|\s+)\S+|packages\/[^\s]+)/i;

export function buildValidationPlan({
  repo,
  ownerAgentId,
  queueItem = null,
  changedFiles = queueItem?.changedFiles,
  affectedPackages = queueItem?.affectedPackages,
  commands,
  requestedCommands,
  allowBroadCommands = false,
  limits = {},
  now = new Date().toISOString(),
} = {}) {
  const effectiveLimits = {
    ...DEFAULT_VALIDATION_PLAN_LIMITS,
    ...objectValue(limits),
  };
  const files = uniqueStrings(changedFiles);
  const packages = inferPackages({
    affectedPackages,
    changedFiles: files,
  });
  const inputCommands = uniqueStrings(commands ?? requestedCommands);
  const commandAnalyses = inputCommands.map((command, index) =>
    analyzeCommand({
      command,
      index,
      allowBroadCommands,
    }),
  );
  const recommendedCommands = recommendCommands({
    packages,
    changedFiles: files,
    intents: commandAnalyses.map((command) => command.intent),
    maxRecommendations: effectiveLimits.maxRecommendations,
  });
  const decision = decisionFor({
    commands: commandAnalyses,
    recommendedCommands,
    allowBroadCommands,
    limits: effectiveLimits,
  });

  return {
    computedAt: now,
    repo: repo ?? queueItem?.repo ?? null,
    ownerAgentId: ownerAgentId ?? queueItem?.ownerAgentId ?? null,
    changedFiles: files,
    affectedPackages: packages,
    summary: {
      commandCount: commandAnalyses.length,
      broadCommandCount: commandAnalyses.filter(
        (command) => command.scope === "broad",
      ).length,
      scopedCommandCount: commandAnalyses.filter(
        (command) => command.scope === "scoped",
      ).length,
      maxEstimatedCost: maxNumber(
        commandAnalyses.map((command) => command.estimatedCost),
        0,
      ),
      recommendedStrategy: recommendedStrategyFor({
        packages,
        files,
        commands: commandAnalyses,
      }),
    },
    decision,
    commands: commandAnalyses,
    recommendedCommands,
    labels: labelsFor(decision),
  };
}

function analyzeCommand({ command, index, allowBroadCommands }) {
  const text = compact(command);
  const intent = classifyIntent(text);
  const scoped = isScopedCommand(text);
  const broadReasons = broadReasonsFor(text, { intent, scoped });
  const scope =
    broadReasons.length > 0 ? "broad" : scoped ? "scoped" : "unknown";
  const estimatedCost = estimatedCostFor({ intent, scope, text });
  const status =
    broadReasons.length > 0 && allowBroadCommands !== true
      ? "blocked"
      : estimatedCost >= 8
        ? "warn"
        : "ok";
  const requiredActions =
    broadReasons.length > 0 && allowBroadCommands !== true
      ? ["replace_with_scoped_validation", "avoid_broad_ci_on_shared_runner"]
      : estimatedCost >= 8
        ? ["confirm_runner_capacity"]
        : [];

  return {
    id: `validation-command-${index + 1}`,
    command: text,
    intent,
    scope,
    status,
    estimatedCost,
    reasons: broadReasons,
    requiredActions,
  };
}

function broadReasonsFor(command, { intent, scoped }) {
  const reasons = [];
  if (scoped) return reasons;

  if (
    TURBO_PATTERN.test(command) &&
    ["typecheck", "build", "test", "lint"].includes(intent)
  ) {
    reasons.push("turbo_without_package_filter");
  }

  if (
    ROOT_RUNNER_PATTERN.test(command) &&
    ["typecheck", "build", "test"].includes(intent)
  ) {
    reasons.push("root_package_script_without_workspace_scope");
  }

  if (TSC_PATTERN.test(command)) {
    reasons.push("tsc_without_project_scope");
  }

  if (
    BUN_BUILD_PATTERN.test(command) &&
    !/\b(?:src|packages|apps|services)\//.test(command)
  ) {
    reasons.push("bun_build_without_entry_scope");
  }

  return uniqueStrings(reasons);
}

function classifyIntent(command) {
  if (/\btypecheck\b/i.test(command) || TSC_PATTERN.test(command))
    return "typecheck";
  if (/\btest\b/i.test(command)) return "test";
  if (/\bbuild\b/i.test(command)) return "build";
  if (/\blint\b/i.test(command)) return "lint";
  if (/\bformat\b|\bprettier\b/i.test(command)) return "format";
  return "unknown";
}

function isScopedCommand(command) {
  return SCOPED_PATTERN.test(command);
}

function estimatedCostFor({ intent, scope, text }) {
  if (scope === "broad") {
    if (TURBO_PATTERN.test(text) && intent === "build") return 12;
    if (TURBO_PATTERN.test(text) && intent === "typecheck") return 10;
    if (intent === "test") return 9;
    if (intent === "build") return 9;
    return 8;
  }

  if (scope === "scoped") {
    if (intent === "build") return 5;
    if (intent === "test") return 4;
    if (intent === "typecheck") return 3;
    return 2;
  }

  return intent === "unknown" ? 1 : 4;
}

function decisionFor({
  commands,
  recommendedCommands,
  allowBroadCommands,
  limits,
}) {
  if (commands.length === 0) {
    return {
      allowed: false,
      state: "needs_validation_plan",
      reason: "No validation commands were supplied.",
      blockers: ["missing_validation_commands"],
      warnings: [],
      requiredActions: ["choose_scoped_validation_command"],
      allowBroadCommands: allowBroadCommands === true,
    };
  }

  const blocked = commands.filter((command) => command.status === "blocked");
  const broad = commands.filter((command) => command.scope === "broad");
  const overCost = commands.filter(
    (command) => command.estimatedCost > limits.maxEstimatedCost,
  );
  const warnings = commands.filter((command) => command.status === "warn");
  const blockers = [];
  if (blocked.length > limits.maxBroadCommands)
    blockers.push("broad_validation_commands");
  if (overCost.length > 0 && allowBroadCommands !== true)
    blockers.push("validation_cost_over_budget");

  if (blockers.length > 0) {
    return {
      allowed: false,
      state: "blocked",
      reason:
        "Validation plan includes broad or expensive commands that can overload shared runners.",
      blockers,
      warnings: warnings.map((command) => command.id),
      requiredActions: uniqueStrings([
        ...blocked.flatMap((command) => command.requiredActions),
        "use_recommended_scoped_commands",
      ]),
      recommendedCommands,
      allowBroadCommands: allowBroadCommands === true,
    };
  }

  return {
    allowed: true,
    state: broad.length > 0 || warnings.length > 0 ? "watch" : "scoped",
    reason:
      broad.length > 0
        ? "Broad validation commands were explicitly allowed and should be watched."
        : "Validation plan is scoped to the touched surface.",
    blockers: [],
    warnings: warnings.map((command) => command.id),
    requiredActions: warnings.length > 0 ? ["confirm_runner_capacity"] : [],
    recommendedCommands,
    allowBroadCommands: allowBroadCommands === true,
  };
}

function recommendCommands({
  packages,
  changedFiles,
  intents,
  maxRecommendations,
}) {
  const normalizedIntents = uniqueStrings(intents)
    .filter((intent) => intent !== "unknown")
    .sort((left, right) => INTENT_PRIORITY[left] - INTENT_PRIORITY[right]);
  const selectedIntents =
    normalizedIntents.length > 0 ? normalizedIntents : ["typecheck"];
  const recommendations = [];

  for (const packageName of packages.slice(0, 4)) {
    for (const intent of selectedIntents) {
      recommendations.push({
        command: `turbo run ${intent} --filter=${packageFilter(packageName)}`,
        intent,
        scope: "package",
        package: packageName,
        reason:
          "Scope validation to an affected package before using shared runner capacity.",
      });
      if (recommendations.length >= maxRecommendations) return recommendations;
    }
  }

  if (recommendations.length === 0 && changedFiles.length > 0) {
    recommendations.push({
      command: "git diff --check",
      intent: "format",
      scope: "changed_files",
      package: null,
      reason:
        "No package was inferred; start with a lightweight changed-file sanity check.",
    });
  }

  return recommendations;
}

function recommendedStrategyFor({ packages, files, commands }) {
  if (commands.some((command) => command.scope === "broad")) {
    return "replace_broad_commands_with_package_filters";
  }
  if (packages.length > 0) {
    return "run_package_scoped_validation";
  }
  if (files.length > 0) {
    return "run_changed_file_sanity_checks";
  }
  return "provide_changed_files_or_package_scope";
}

function inferPackages({ affectedPackages, changedFiles }) {
  return uniqueStrings([
    ...uniqueStrings(affectedPackages),
    ...changedFiles.flatMap(packageFromPath),
  ]).sort();
}

function packageFromPath(file) {
  const match = String(file).match(/^(?:packages|plugins)\/([^/]+)/);
  if (!match) return [];
  return [match[1]];
}

function packageFilter(packageName) {
  if (packageName.startsWith("@")) return packageName;
  return `@elizaos/${packageName}`;
}

function labelsFor(decision) {
  if (
    !decision.allowed &&
    decision.blockers.includes("missing_validation_commands")
  ) {
    return ["validation:plan-needed"];
  }
  if (!decision.allowed) return ["validation:broad-blocked", "ci:budget"];
  if (decision.state === "watch") return ["validation:watch", "ci:budget"];
  return ["validation:scoped"];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function uniqueStrings(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [
    ...new Set(values.map((item) => String(item).trim()).filter(Boolean)),
  ];
}

function compact(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function maxNumber(values, fallback) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : fallback;
}
