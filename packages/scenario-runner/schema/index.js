/**
 * Runtime schema module for `@elizaos/scenario-runner/schema`: the final-check key
 * table (FINAL_CHECK_KEYS) and the `scenario` / `scenarioLane` / `scenarioDeferral`
 * validators that scenario files import to declare and validate their definitions.
 * Types live in the paired index.d.ts.
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

const SCENARIO_LANES = new Set(["pr-deterministic", "live-only"]);
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
    // Validate optional LifeOps/persona tier metadata when authored.
    scenarioTier(value);
    // Validate pending/active inventory status before loader filtering relies on it.
    validateScenarioStatus(value);
    // Validate the deferral shape (and lane compatibility) eagerly too.
    scenarioDeferral(value);
  }
  return value;
}
