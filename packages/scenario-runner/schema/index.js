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
    // Validate the deferral shape (and lane compatibility) eagerly too.
    scenarioDeferral(value);
  }
  return value;
}
