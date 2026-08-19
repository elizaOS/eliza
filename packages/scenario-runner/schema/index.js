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

/** Evidence boundary assumed for legacy simulated scenario definitions. */
export const DEFAULT_SCENARIO_EVIDENCE_CLASS = "simulated";

/** Certification claim assumed when a scenario does not declare one. */
export const DEFAULT_SCENARIO_CERTIFICATION_CLASS = "none";

const SCENARIO_LANES = new Set(["pr-deterministic", "live-only"]);
const SCENARIO_EXECUTION_PROFILES = new Set([
  "simulated",
  "provider-qualified",
]);
const SCENARIO_EVIDENCE_CLASSES = new Set([
  "simulated",
  "runtime-observed",
  "provider-observed",
  "native-device-observed",
  "webhook-ingress-observed",
]);
const SCENARIO_CERTIFICATION_CLASSES = new Set([
  "none",
  "runtime-contract",
  "provider",
  "native-device",
  "webhook-ingress",
]);
const EXTERNAL_SCENARIO_EVIDENCE_CLASSES = new Set([
  "provider-observed",
  "native-device-observed",
  "webhook-ingress-observed",
]);
const REQUIRED_EVIDENCE_CLASS_BY_CERTIFICATION = {
  "runtime-contract": "runtime-observed",
  provider: "provider-observed",
  "native-device": "native-device-observed",
  "webhook-ingress": "webhook-ingress-observed",
};
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

/** Resolve and validate the boundary that produced a scenario's evidence. */
export function scenarioEvidenceClass(value) {
  const evidenceClass = value?.evidenceClass;
  if (evidenceClass === undefined) {
    return scenarioExecutionProfile(value) === "provider-qualified"
      ? "provider-observed"
      : DEFAULT_SCENARIO_EVIDENCE_CLASS;
  }
  if (!SCENARIO_EVIDENCE_CLASSES.has(evidenceClass)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid evidenceClass "${evidenceClass}"; expected one of ${[...SCENARIO_EVIDENCE_CLASSES].join(", ")}`,
    );
  }
  return evidenceClass;
}

/**
 * Resolve and validate the highest certification a passing scenario may
 * describe. Classification never substitutes for signed or live evidence.
 */
export function scenarioCertificationClass(value) {
  const certificationClass =
    value?.certificationClass ?? DEFAULT_SCENARIO_CERTIFICATION_CLASS;
  if (!SCENARIO_CERTIFICATION_CLASSES.has(certificationClass)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid certificationClass "${certificationClass}"; expected one of ${[...SCENARIO_CERTIFICATION_CLASSES].join(", ")}`,
    );
  }

  const evidenceClass = scenarioEvidenceClass(value);
  const lane = scenarioLane(value);
  const executionProfile = scenarioExecutionProfile(value);
  if (
    lane === "pr-deterministic" &&
    EXTERNAL_SCENARIO_EVIDENCE_CLASSES.has(evidenceClass)
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" declares ${evidenceClass} evidence in lane "pr-deterministic"; deterministic scenarios cannot claim provider, native-device, or webhook-ingress evidence`,
    );
  }
  if (
    EXTERNAL_SCENARIO_EVIDENCE_CLASSES.has(evidenceClass) &&
    executionProfile !== "provider-qualified"
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" evidenceClass "${evidenceClass}" requires executionProfile "provider-qualified"`,
    );
  }
  const certificationLanguage = `${value?.id ?? ""} ${value?.title ?? ""}`;
  if (
    certificationClass === "none" &&
    /\bcertif(?:y|ies|ied|ying|ication|ications)\b/i.test(certificationLanguage)
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" uses certification language but does not declare certificationClass`,
    );
  }

  const requiredEvidenceClass =
    REQUIRED_EVIDENCE_CLASS_BY_CERTIFICATION[certificationClass];
  if (requiredEvidenceClass && evidenceClass !== requiredEvidenceClass) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" certificationClass "${certificationClass}" requires evidenceClass "${requiredEvidenceClass}", received "${evidenceClass}"`,
    );
  }
  return certificationClass;
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
    // Certification labels must match the evidence and execution boundaries.
    scenarioCertificationClass(value);
    // Validate optional LifeOps/persona tier metadata when authored.
    scenarioTier(value);
    // Validate pending/active inventory status before loader filtering relies on it.
    validateScenarioStatus(value);
    // Required services are a runtime preflight contract, not an implicit
    // consequence of whichever plugin happened to register them first.
    validateScenarioRequirements(value);
    // Validate the deferral shape (and lane compatibility) eagerly too.
    scenarioDeferral(value);
  }
  return value;
}
