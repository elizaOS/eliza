/**
 * Runtime schema module for `@elizaos/scenario-runner/schema`: the final-check key
 * table (FINAL_CHECK_KEYS) and the scenario metadata validators for lanes,
 * execution profiles, tiers, and platform deferrals. Scenario files import
 * these at authoring/load boundaries; types live in the paired index.d.ts.
 */
export const FINAL_CHECK_KEYS = new Map(
  Object.entries({
    custom: ["type", "name", "predicate"],
    actionCalled: ["type", "name", "actionName", "status", "minCount"],
    selectedAction: ["type", "name", "actionName"],
    selectedActionArguments: [
      "type",
      "name",
      "actionName",
      "includesAny",
      "includesAll",
    ],
    modelCallOccurred: [
      "type",
      "name",
      "purpose",
      "includesAny",
      "includesAll",
      "minCount",
      "scenarioId",
    ],
    clarificationRequested: ["type", "name", "expected"],
    interventionRequestExists: ["type", "name", "expected"],
    pushSent: ["type", "name", "channel"],
    pushEscalationOrder: ["type", "name", "channelOrder"],
    pushAcknowledgedSync: ["type", "name", "expected"],
    approvalRequestExists: ["type", "name", "expected", "actionName", "state"],
    approvalStateTransition: ["type", "name", "from", "to", "actionName"],
    noSideEffectOnReject: ["type", "name", "actionName"],
    draftExists: ["type", "name", "channel", "expected"],
    messageDelivered: ["type", "name", "channel", "expected"],
    browserTaskCompleted: ["type", "name", "expected"],
    browserTaskNeedsHuman: ["type", "name", "expected"],
    uploadedAssetExists: ["type", "name", "expected"],
    connectorDispatchOccurred: [
      "type",
      "name",
      "channel",
      "actionName",
      "minCount",
    ],
    durableApprovalObserved: [
      "type",
      "name",
      "observerId",
      "provider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
    ],
    durableDraftObserved: [
      "type",
      "name",
      "observerId",
      "provider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
    ],
    providerEffectObserved: [
      "type",
      "name",
      "observerId",
      "provider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
    ],
    providerNoEffectObserved: [
      "type",
      "name",
      "observerId",
      "provider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
      "intervalCoversScenario",
    ],
    scheduledTaskObserved: [
      "type",
      "name",
      "observerId",
      "provider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
    ],
    memoryWriteOccurred: ["type", "name", "table", "minCount"],
    memoryExists: ["type", "name", "table", "content", "minCount", "expected"],
    goalCountDelta: [
      "type",
      "name",
      "title",
      "titleAliases",
      "delta",
      "expectedStatus",
      "expectedReviewState",
      "expectedGroundingState",
      "requireDescription",
      "requireSuccessCriteria",
      "requireSupportStrategy",
    ],
    judgeRubric: ["type", "name", "rubric", "minimumScore"],
    gmailActionArguments: [
      "type",
      "name",
      "actionName",
      "subaction",
      "operation",
      "fields",
      "minCount",
    ],
    gmailMockRequest: [
      "type",
      "name",
      "method",
      "path",
      "body",
      "expected",
      "minCount",
    ],
    gmailDraftCreated: ["type", "name", "expected"],
    gmailDraftDeleted: ["type", "name", "expected"],
    gmailMessageSent: ["type", "name", "expected"],
    gmailBatchModify: ["type", "name", "expected", "body"],
    gmailApproval: ["type", "name", "state"],
    gmailNoRealWrite: ["type", "name"],
    workflowDispatchOccurred: [
      "type",
      "name",
      "workflowId",
      "expected",
      "minCount",
    ],
    definitionCountDelta: [
      "type",
      "name",
      "title",
      "titleAliases",
      "delta",
      "cadenceKind",
      "requiredSlots",
      "requiredWeekdays",
      "requiredWindows",
      "requiredEveryMinutes",
      "requiredMaxOccurrencesPerDay",
      "expectedTimeZone",
      "expectedDueLocalTimes",
      "forbiddenDueLocalTimes",
      "requireReminderPlan",
      "websiteAccess",
    ],
    reminderIntensity: ["type", "name", "title", "titleAliases", "expected"],
  }).map(([type, keys]) => [type, new Set(keys)]),
);

function validateStrictFinalCheck(check, index) {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    throw new Error(`finalChecks[${index}] must be an object`);
  }
  const type = check.type;
  if (typeof type !== "string") {
    throw new Error(`finalChecks[${index}] missing string type`);
  }
  const allowed = FINAL_CHECK_KEYS.get(type);
  if (!allowed) {
    throw new Error(
      `finalChecks[${index}] has unknown type "${type}". Known types: ${[
        ...FINAL_CHECK_KEYS.keys(),
      ].join(", ")}`,
    );
  }
  const unknownKeys = Object.keys(check).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `finalChecks[${index}] type "${type}" has unknown field(s): ${unknownKeys.join(", ")}`,
    );
  }
}

/** Lane assumed for any scenario that does not declare one. */
export const DEFAULT_SCENARIO_LANE = "live-only";

/**
 * Execution profile assumed for legacy scenario definitions. Simulated runs
 * exercise the runtime but are never provider-evidence publishable.
 */
export const DEFAULT_SCENARIO_EXECUTION_PROFILE = "simulated";

const SCENARIO_LANES = new Set(["pr-deterministic", "live-only"]);
const SCENARIO_EXECUTION_PROFILES = new Set([
  "simulated",
  "provider-qualified",
]);
const SCENARIO_TIERS = new Set(["T1", "T2", "T3", "T4"]);
const SCENARIO_STATUSES = new Set(["active", "pending"]);

/** Resolve a scenario's effective lane, applying {@link DEFAULT_SCENARIO_LANE}. */
export function scenarioLane(value) {
  const lane = value?.lane;
  if (lane === undefined) {
    return DEFAULT_SCENARIO_LANE;
  }
  if (!SCENARIO_LANES.has(lane)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid lane "${lane}"; expected one of ${[...SCENARIO_LANES].join(", ")}`,
    );
  }
  return lane;
}

/** Return whether a value is a supported scenario execution profile. */
export function isScenarioExecutionProfile(value) {
  return typeof value === "string" && SCENARIO_EXECUTION_PROFILES.has(value);
}

/**
 * Resolve a scenario's execution profile. Provider-qualified scenarios are
 * live-only because deterministic lanes cannot produce provider evidence.
 */
export function scenarioExecutionProfile(value) {
  const executionProfile = value?.executionProfile;
  if (executionProfile === undefined) {
    return DEFAULT_SCENARIO_EXECUTION_PROFILE;
  }
  if (!isScenarioExecutionProfile(executionProfile)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid executionProfile "${executionProfile}"; expected one of ${[...SCENARIO_EXECUTION_PROFILES].join(", ")}`,
    );
  }
  if (
    executionProfile === "provider-qualified" &&
    scenarioLane(value) !== "live-only"
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" declares executionProfile "provider-qualified" but lane "${scenarioLane(value)}"; provider-qualified scenarios must be live-only`,
    );
  }
  return executionProfile;
}

/** Resolve and validate the optional persona-scenario complexity tier. */
export function scenarioTier(value) {
  const tier = value?.tier;
  if (tier === undefined) {
    return undefined;
  }
  if (!SCENARIO_TIERS.has(tier)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid tier "${tier}"; expected one of ${[...SCENARIO_TIERS].join(", ")}`,
    );
  }
  return tier;
}

function validateScenarioStatus(value) {
  const status = value?.status;
  if (status === undefined) {
    return undefined;
  }
  if (!SCENARIO_STATUSES.has(status)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid status "${status}"; expected one of ${[...SCENARIO_STATUSES].join(", ")}`,
    );
  }
  return status;
}

function validateScenarioRequirements(value) {
  const requires = value?.requires;
  if (requires === undefined) {
    return;
  }
  if (
    requires === null ||
    typeof requires !== "object" ||
    Array.isArray(requires)
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid requires; expected { plugins?: string[], services?: string[], credentials?: string[], os?: string }`,
    );
  }
  const knownKeys = ["plugins", "services", "credentials", "os"];
  const unknownKeys = Object.keys(requires).filter(
    (key) => !knownKeys.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has unknown requires field(s): ${unknownKeys.join(", ")}`,
    );
  }
  if (
    requires.os !== undefined &&
    (typeof requires.os !== "string" || requires.os.trim().length === 0)
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid requires.os; expected a non-empty string`,
    );
  }
  for (const key of ["plugins", "services", "credentials"]) {
    const requirements = requires[key];
    if (requirements === undefined) {
      continue;
    }
    if (
      !Array.isArray(requirements) ||
      requirements.some(
        (requirement) =>
          typeof requirement !== "string" || requirement.trim().length === 0,
      )
    ) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" has invalid requires.${key}; expected non-empty strings`,
      );
    }
  }
}

const SCENARIO_MODEL_FIXTURE_TYPES = new Set([
  "TEXT_NANO",
  "TEXT_SMALL",
  "TEXT_MEDIUM",
  "TEXT_LARGE",
  "TEXT_MEGA",
  "RESPONSE_HANDLER",
  "ACTION_PLANNER",
  "REASONING_SMALL",
  "REASONING_LARGE",
  "TEXT_COMPLETION",
]);

function validateScenarioModelFixtures(value) {
  const declaration = value?.modelFixtures;
  if (declaration === undefined) return;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid modelFixtures`,
    );
  }
  if (declaration.mode === "model-free") {
    const unknownKeys = Object.keys(declaration).filter(
      (key) => !["mode", "reason"].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" model-free declaration has unknown field(s): ${unknownKeys.join(", ")}`,
      );
    }
    if (
      typeof declaration.reason !== "string" ||
      declaration.reason.trim().length === 0
    ) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" model-free declaration requires a reason`,
      );
    }
    const modelBackedTurns = Array.isArray(value?.turns)
      ? value.turns
          .filter((turn) =>
            ["message", "voice", "tick"].includes(turn?.kind ?? "message"),
          )
          .map(
            (turn) => `${turn?.name ?? "<unnamed>"}:${turn?.kind ?? "message"}`,
          )
      : [];
    const modelBackedChecks = Array.isArray(value?.finalChecks)
      ? value.finalChecks
          .filter((check) => check?.type === "judgeRubric")
          .map((check) => check?.name ?? check?.type)
      : [];
    if (modelBackedTurns.length > 0 || modelBackedChecks.length > 0) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" declares model-free but contains model-backed work: ${[...modelBackedTurns, ...modelBackedChecks].join(", ")}`,
      );
    }
    return;
  }
  const declarationUnknownKeys = Object.keys(declaration).filter(
    (key) => !["mode", "fixtures"].includes(key),
  );
  if (declarationUnknownKeys.length > 0) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" fixture declaration has unknown field(s): ${declarationUnknownKeys.join(", ")}`,
    );
  }
  if (declaration.mode !== "fixtures" || !Array.isArray(declaration.fixtures)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" modelFixtures must declare mode fixtures or model-free`,
    );
  }
  const names = new Set();
  for (const [index, fixture] of declaration.fixtures.entries()) {
    if (
      !fixture ||
      typeof fixture !== "object" ||
      typeof fixture.name !== "string" ||
      !fixture.name.trim()
    ) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" modelFixtures.fixtures[${index}] requires a name`,
      );
    }
    if (names.has(fixture.name)) {
      throw new Error(
        `scenario "${value?.id ?? "<unknown>"}" has duplicate model fixture "${fixture.name}"`,
      );
    }
    names.add(fixture.name);
    const unknownFixtureKeys = Object.keys(fixture).filter(
      (key) =>
        !["name", "match", "response", "cardinality", "behavior"].includes(key),
    );
    if (unknownFixtureKeys.length > 0) {
      throw new Error(
        `scenario model fixture "${fixture.name}" has unknown field(s): ${unknownFixtureKeys.join(", ")}`,
      );
    }
    if (
      !fixture.match ||
      typeof fixture.match !== "object" ||
      fixture.match.modelType === undefined
    ) {
      throw new Error(
        `scenario model fixture "${fixture.name}" requires an exact modelType matcher`,
      );
    }
    const modelTypes = Array.isArray(fixture.match.modelType)
      ? fixture.match.modelType
      : [fixture.match.modelType];
    if (
      modelTypes.length === 0 ||
      modelTypes.some(
        (modelType) => typeof modelType !== "string" || !modelType.trim(),
      )
    ) {
      throw new Error(
        `scenario model fixture "${fixture.name}" requires non-empty modelType strings`,
      );
    }
    const unsupportedModelTypes = modelTypes.filter(
      (modelType) => !SCENARIO_MODEL_FIXTURE_TYPES.has(modelType),
    );
    if (unsupportedModelTypes.length > 0) {
      throw new Error(
        `scenario model fixture "${fixture.name}" has unsupported modelType value(s): ${unsupportedModelTypes.join(", ")}`,
      );
    }
    for (const key of ["input", "prompt"]) {
      const matcher = fixture.match[key];
      if (matcher === undefined) continue;
      if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid ${key} matcher`,
        );
      }
      const matcherKeys = Object.keys(matcher);
      if (
        matcherKeys.filter((candidate) =>
          ["exact", "includes", "pattern"].includes(candidate),
        ).length !== 1
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" ${key} matcher must declare exactly one of exact, includes, or pattern`,
        );
      }
      if ("flags" in matcher && !("pattern" in matcher)) {
        throw new Error(
          `scenario model fixture "${fixture.name}" ${key}.flags requires pattern`,
        );
      }
      try {
        if ("pattern" in matcher) new RegExp(matcher.pattern, matcher.flags);
      } catch (error) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid ${key} pattern: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      fixture.match.toolNames !== undefined &&
      (!Array.isArray(fixture.match.toolNames) ||
        fixture.match.toolNames.some(
          (name) => typeof name !== "string" || !name.trim(),
        ))
    ) {
      throw new Error(
        `scenario model fixture "${fixture.name}" has invalid toolNames`,
      );
    }
    const cardinality = fixture.cardinality;
    if (cardinality !== undefined && cardinality !== "any") {
      if (typeof cardinality === "number") {
        if (!Number.isSafeInteger(cardinality) || cardinality < 0) {
          throw new Error(
            `scenario model fixture "${fixture.name}" has invalid cardinality`,
          );
        }
      } else if (
        !cardinality ||
        typeof cardinality !== "object" ||
        Array.isArray(cardinality)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid cardinality`,
        );
      } else {
        const min = cardinality.min ?? 1;
        const max = cardinality.max ?? Number.POSITIVE_INFINITY;
        if (
          !Number.isSafeInteger(min) ||
          min < 0 ||
          !(
            max === Number.POSITIVE_INFINITY ||
            (Number.isSafeInteger(max) && max >= min)
          )
        ) {
          throw new Error(
            `scenario model fixture "${fixture.name}" has invalid cardinality bounds`,
          );
        }
      }
    }
    if (
      fixture.response === undefined &&
      !fixture.behavior?.error &&
      !fixture.behavior?.waitForAbort
    ) {
      throw new Error(
        `scenario model fixture "${fixture.name}" requires response, error, or waitForAbort`,
      );
    }
    if (fixture.response !== undefined) {
      if (
        !fixture.response ||
        typeof fixture.response !== "object" ||
        Array.isArray(fixture.response)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid response`,
        );
      }
      if (
        fixture.response.json !== undefined &&
        ["text", "toolCalls", "finishReason", "usage"].some(
          (key) => fixture.response[key] !== undefined,
        )
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" response.json is exclusive`,
        );
      }
      if (
        fixture.response.toolCalls !== undefined &&
        (!Array.isArray(fixture.response.toolCalls) ||
          fixture.response.toolCalls.some(
            (toolCall) =>
              !toolCall ||
              typeof toolCall !== "object" ||
              typeof toolCall.name !== "string" ||
              !toolCall.name.trim() ||
              !toolCall.arguments ||
              typeof toolCall.arguments !== "object" ||
              Array.isArray(toolCall.arguments),
          ))
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid toolCalls`,
        );
      }
    }
    if (fixture.behavior !== undefined) {
      const behavior = fixture.behavior;
      if (
        !behavior ||
        typeof behavior !== "object" ||
        Array.isArray(behavior)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid behavior`,
        );
      }
      if (
        behavior.latencyMs !== undefined &&
        (!Number.isSafeInteger(behavior.latencyMs) || behavior.latencyMs < 0)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid latencyMs`,
        );
      }
      if (
        behavior.stream !== undefined &&
        (!behavior.stream ||
          !Number.isSafeInteger(behavior.stream.chunkSize) ||
          behavior.stream.chunkSize <= 0 ||
          !Number.isSafeInteger(behavior.stream.intervalMs) ||
          behavior.stream.intervalMs < 0)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid stream behavior`,
        );
      }
    }
  }
}

/**
 * Resolve a scenario's platform-gated deferral, if any. A deferred scenario is
 * a live-only scenario that additionally cannot run in any current lane because
 * the platform/runner it needs does not exist yet (e.g. a macOS SelfControl
 * shard awaiting an `eliza-e2e-macos` self-hosted runner). It stays visible in
 * the corpus inventory as a distinct "deferred platform-gated" class rather than
 * being conflated with ordinary live-only coverage. Returns `null` when the
 * scenario is not deferred. (#10757)
 */
export function scenarioDeferral(value) {
  const deferred = value?.deferred;
  if (deferred === undefined || deferred === null) {
    return null;
  }
  if (
    typeof deferred !== "object" ||
    typeof deferred.reason !== "string" ||
    deferred.reason.trim().length === 0
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has an invalid \`deferred\`; expected { reason: string, runner?: string }`,
    );
  }
  // A deferred scenario is inherently unrunnable in any current lane, so it must
  // never masquerade as a keyless PR-deterministic scenario.
  if (scenarioLane(value) === "pr-deterministic") {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" is marked \`deferred\` but declares lane "pr-deterministic"; deferred scenarios must be live-only`,
    );
  }
  return {
    reason: deferred.reason,
    ...(typeof deferred.runner === "string" ? { runner: deferred.runner } : {}),
  };
}

export function scenario(value) {
  if (value && typeof value === "object") {
    if (Array.isArray(value.finalChecks)) {
      value.finalChecks.forEach(validateStrictFinalCheck);
    }
    // Validate the lane eagerly so a typo fails at definition time, not in CI.
    scenarioLane(value);
    // Provider evidence cannot be claimed by a deterministic execution profile.
    scenarioExecutionProfile(value);
    // Validate optional LifeOps/persona tier metadata when authored.
    scenarioTier(value);
    // Validate pending/active inventory status before loader filtering relies on it.
    validateScenarioStatus(value);
    // Required services are a runtime preflight contract, not an implicit
    // consequence of whichever plugin happened to register them first.
    validateScenarioRequirements(value);
    validateScenarioModelFixtures(value);
    // Validate the deferral shape (and lane compatibility) eagerly too.
    scenarioDeferral(value);
  }
  return value;
}
