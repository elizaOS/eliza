/** Dependency-free authoring contract for scenario definitions, turns, and final checks. */

export type CapturedAction = {
  actionName: string;
  /** Independent observation of the configured mock API boundary, not action-reported success. */
  apiEffects?: string[];
  parameters?: unknown;
  result?: {
    success?: boolean;
    data?: unknown;
    values?: unknown;
    text?: string;
    message?: string;
    error?: string;
    screenshot?: string;
    frontendScreenshot?: string;
    path?: string;
    exists?: boolean;
    raw?: unknown;
  };
  error?: {
    message?: string;
  };
};

export type ScenarioTurnExecution = {
  actionsCalled: CapturedAction[];
  /** Registered action validation outcome; this is evidence, never an action call. */
  validation?: {
    actionName: string;
    accepted: boolean;
    expected: "accepted" | "rejected";
  };
  responseText?: string;
  statusCode?: number;
  responseBody?: unknown;
};

export type ScenarioCheckResult =
  | string
  | undefined
  | Promise<string | undefined>;

export type ScenarioAssertResponse =
  | ((text: string) => ScenarioCheckResult)
  | ((status: number, body: unknown) => ScenarioCheckResult);

export type ApprovalRequestState =
  | "pending"
  | "approved"
  | "executing"
  | "done"
  | "rejected"
  | "expired";

export type CapturedApprovalRequest = {
  id: string;
  state: ApprovalRequestState;
  actionName: string;
  source?: string;
  command?: string;
  channel?: string;
  payload?: unknown;
  createdAt?: string;
  decidedAt?: string;
};

export type CapturedConnectorDispatch = {
  channel: string;
  actionName?: string;
  payload?: unknown;
  sentAt?: string;
  delivered?: boolean;
};

export type CapturedMemoryWrite = {
  table: string;
  entityId?: string;
  roomId?: string;
  worldId?: string;
  content?: unknown;
  createdAt?: string;
};

export type CapturedStateTransition = {
  subject: string;
  from?: string;
  to: string;
  actionName?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  at?: string;
};

export type CapturedArtifact = {
  source: string;
  actionName?: string;
  kind: string;
  label?: string;
  detail?: string;
  data?: unknown;
  createdAt?: string;
};

export type ScenarioContext = {
  runtime?: unknown;
  apiBaseUrl?: string;
  scenarioId?: string;
  runId?: string;
  now?: string;
  /**
   * Primary (default) scenario room + simulated owner entity, set by the
   * executor before seeds run. Seeds and custom checks use these to write
   * and read state attributed to the owner's conversation (e.g. plain-text
   * memory seeds land as durable facts in this room for this entity).
   */
  primaryRoomId?: string;
  primaryUserId?: string;
  /** Runtime IDs keyed by the logical identifiers authored in `rooms`. */
  roomIds?: Record<string, string>;
  worldIds?: Record<string, string>;
  /** Canonical principal IDs keyed by `rooms[].entity`. */
  entityIds?: Record<string, string>;
  /** Distinct connector principal IDs keyed by `rooms[].account`. */
  accountEntityIds?: Record<string, string>;
  /** Per-room topology for seeds that need the room's account principal/world. */
  roomWorldIds?: Record<string, string>;
  roomEntityIds?: Record<string, string>;
  actionsCalled: CapturedAction[];
  turns?: ScenarioTurnExecution[];
  approvalRequests?: CapturedApprovalRequest[];
  connectorDispatches?: CapturedConnectorDispatch[];
  memoryWrites?: CapturedMemoryWrite[];
  stateTransitions?: CapturedStateTransition[];
  artifacts?: CapturedArtifact[];
};

/**
 * Seed steps the runner actually applies (`src/seeds.ts` +
 * `runCustomSeeds` in `src/executor.ts`). This union is closed on purpose:
 * unsupported seeds are rejected instead of manufacturing coverage.
 */
export type ScenarioSeedStep =
  | {
      type: "advanceClock";
      by: string;
      name?: string;
    }
  | {
      type: "custom";
      name?: string;
      apply: (
        ctx: ScenarioContext,
      ) => ScenarioCheckResult | Promise<ScenarioCheckResult>;
    }
  | {
      type: "todo";
      name?: string;
      title?: string;
      description?: string;
      dueIso?: string;
      priority?: number | string;
      isUrgent?: boolean;
      state?: string;
    }
  | {
      type: "contact";
      name?: string;
      notes?: string;
      categories?: string[];
      tags?: string[];
      handles?: Array<Record<string, unknown>>;
      followupThresholdDays?: number;
      relationshipStatus?: string;
      relationshipGoal?: string;
      lastContactedAt?: string;
    }
  | {
      type: "memory";
      name?: string;
      /** Logical `rooms[].id`, or an already-resolved runtime room UUID. */
      roomId?: string;
      content?: Record<string, unknown>;
    }
  | {
      type: "gmailInbox";
      name?: string;
      account?: string;
      fixture?: string;
      fixtures?: string[];
      requiredMessageIds?: string[];
      clearLedger?: boolean;
      faultInjection?: Record<string, unknown>;
    }
  | {
      type: "connectorStatus" | "connectorAuthSession" | "transportFault";
      name?: string;
      connector?: string;
      provider?: string;
      state?: string;
      capabilities?: string[];
      scopes?: string[];
      limit?: number;
    };

export type ScenarioCleanupStep =
  | {
      type: "gmailDeleteDrafts";
      name?: string;
    }
  | {
      type: "selfControlClearBlocks";
      name?: string;
      profile?: string;
    }
  | {
      type: "custom";
      name?: string;
      apply?: (
        ctx: ScenarioContext,
      ) => ScenarioCheckResult | Promise<ScenarioCheckResult>;
    };

export type ScenarioJudgeRubric = {
  rubric: string;
  minimumScore?: number;
  label?: string;
};

type CheckBase<Type extends string> = {
  type: Type;
  name?: string;
};

type StringMatcher = string | string[];
type TurnMatcher = string | RegExp;
type TrustedObservationFilters = {
  observerId?: StringMatcher;
  provider?: StringMatcher;
  /** Production connector/account namespace, which may differ from the external receipt namespace. */
  connectorProvider?: StringMatcher;
  accountId?: StringMatcher;
  operation?: StringMatcher;
  resourceId?: StringMatcher;
  state?: StringMatcher;
  minCount?: number;
  transitionGroupId?: string;
  transitionIndex?: number;
  trajectoryPhase?: "proposal" | "approval" | "completion";
};
type DefinitionCountRequiredSlot = {
  label?: string;
  minuteOfDay?: number;
};
type DefinitionCountForbiddenDueLocalTime = {
  hour: number;
  minute?: number;
  timeZone?: string;
};
type DefinitionCountExpectedDueLocalTime = {
  hour: number;
  minute?: number;
  timeZone?: string;
};
type DefinitionCountWebsiteAccess = {
  groupKey?: string;
  websites?: string[];
  unlockMode?: string;
  unlockDurationMinutes?: number;
  callbackKey?: string | null;
  reason?: string;
};

/**
 * A single scenario turn. This type is closed (no index signature) on
 * purpose: every key here is consumed by the executor, so a typo'd assertion
 * key (`acceptedActions`, `includesAny`, ...) is a type error instead of a
 * silently ignored no-op assertion.
 */
export type ScenarioTurn = {
  kind?: string;
  name: string;
  text?: string;
  /** For `message` turns, extra content fields merged into the sent message. */
  content?: Record<string, unknown>;
  /** For `action` turns, the registered action to invoke directly. */
  actionName?: string;
  /**
   * Expected result of the registered action's validation phase. Defaults to
   * `"accepted"`. Use `"rejected"` to prove invalid input is refused through
   * the runtime action registry without calling the handler.
   */
  expectedValidation?: "accepted" | "rejected";
  /** For multi-room scenarios, the `rooms[].id` this turn is sent to. */
  room?: string;
  /**
   * Optional authenticated sender for a message turn in a shared room. The
   * executor materializes a distinct connector principal and stamps bot
   * authorship as trusted memory metadata; never simulate speakers with text
   * labels inside one user's message.
   */
  sender?: {
    id: string;
    name: string;
    kind: "human" | "bot";
  };
  method?: string;
  path?: string;
  /** Optional request headers for API turns; values support scenario templates. */
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * For API turns, capture response-body fields for later templates.
   * Example: `{ scopedToken: "scopedToken" }` then `{{capture:scopedToken}}`.
   */
  captures?: Record<string, string>;
  /**
   * Field names or dot-paths to redact from persisted reports/viewers. The
   * in-memory responseBody passed to assertions and captures remains raw.
   */
  redactResponseFields?: string[];
  expectedStatus?: number;
  durationMs?: number;
  /**
   * For `wait` turns, a bounded state predicate. The executor evaluates it
   * immediately and then until it returns true or the turn timeout expires.
   */
  until?: (ctx: ScenarioContext) => boolean | Promise<boolean>;
  /** Poll interval for a state-backed `wait` turn. Defaults to 25 ms. */
  pollIntervalMs?: number;
  /** Per-turn override of the executor's turn timeout (ms). */
  timeoutMs?: number;
  worker?: string;
  now?: string;
  options?: Record<string, unknown>;
  /**
   * For `voice` turns: the inline voice scenario + optional service overrides.
   * Validated and typed at the runtime boundary in `src/voice-turn.ts`
   * (`VoiceScenarioTurn`); kept structural here so the schema package stays
   * dependency-free.
   */
  voiceScenario?: unknown;
  voiceServices?: unknown;
  allowVoiceSkip?: boolean;
  assertResponse?: ScenarioAssertResponse;
  assertTurn?: (turn: ScenarioTurnExecution) => ScenarioCheckResult;
  expectedActions?: string[];
  responseIncludesAny?: TurnMatcher[];
  responseIncludesAll?: TurnMatcher[];
  responseExcludes?: TurnMatcher[];
  forbiddenActions?: string[];
  plannerIncludesAll?: TurnMatcher[];
  plannerIncludesAny?: TurnMatcher[];
  plannerExcludes?: TurnMatcher[];
  responseJudge?: ScenarioJudgeRubric;
};

export type ScenarioFinalCheck =
  | (CheckBase<"custom"> & {
      name: string;
      predicate: (ctx: ScenarioContext) => ScenarioCheckResult;
    })
  | (CheckBase<"actionCalled"> & {
      actionName: string;
      status?: string;
      minCount?: number;
    })
  | (CheckBase<"selectedAction"> & {
      actionName: StringMatcher;
    })
  | (CheckBase<"selectedActionArguments"> & {
      actionName: StringMatcher;
      includesAny?: Array<string | RegExp>;
      includesAll?: Array<string | RegExp>;
    })
  | (CheckBase<"modelCallOccurred"> & {
      purpose?: StringMatcher;
      includesAny?: Array<string | RegExp>;
      includesAll?: Array<string | RegExp>;
      minCount?: number;
      scenarioId?: string;
    })
  | (CheckBase<"clarificationRequested"> & {
      expected?: boolean;
    })
  | (CheckBase<"interventionRequestExists"> & {
      expected?: boolean;
    })
  | (CheckBase<"pushSent"> & {
      channel: StringMatcher;
    })
  | (CheckBase<"pushEscalationOrder"> & {
      channelOrder: string[];
    })
  | (CheckBase<"pushAcknowledgedSync"> & {
      expected?: boolean;
    })
  | (CheckBase<"approvalRequestExists"> & {
      expected?: boolean;
      actionName?: StringMatcher;
      state?: ApprovalRequestState | ApprovalRequestState[];
    })
  | (CheckBase<"approvalStateTransition"> & {
      from: ApprovalRequestState;
      to: ApprovalRequestState;
      actionName?: StringMatcher;
    })
  | (CheckBase<"noSideEffectOnReject"> & {
      actionName: StringMatcher;
    })
  | (CheckBase<"draftExists"> & {
      channel?: StringMatcher;
      expected?: boolean;
    })
  | (CheckBase<"messageDelivered"> & {
      channel?: StringMatcher;
      expected?: boolean;
    })
  | (CheckBase<"browserTaskCompleted"> & {
      expected?: boolean;
    })
  | (CheckBase<"browserTaskNeedsHuman"> & {
      expected?: boolean;
    })
  | (CheckBase<"uploadedAssetExists"> & {
      expected?: boolean;
    })
  | (CheckBase<"connectorDispatchOccurred"> & {
      channel: StringMatcher;
      actionName?: StringMatcher;
      minCount?: number;
    })
  | (CheckBase<"durableApprovalObserved"> & TrustedObservationFilters)
  | (CheckBase<"durableDraftObserved"> & TrustedObservationFilters)
  | (CheckBase<"providerEffectObserved"> & TrustedObservationFilters)
  | (CheckBase<"providerNoEffectObserved"> &
      TrustedObservationFilters & {
        /** Require the observation window to cover the full scenario. Defaults to true. */
        intervalCoversScenario?: boolean;
        intervalEndsBeforeReferencedStage?: boolean;
      })
  | (CheckBase<"scheduledTaskObserved"> & TrustedObservationFilters)
  | (CheckBase<"memoryWriteOccurred"> & {
      table: StringMatcher;
      minCount?: number;
    })
  | (CheckBase<"memoryExists"> & {
      table?: StringMatcher;
      content?: unknown;
      minCount?: number;
      expected?: boolean;
    })
  | (CheckBase<"goalCountDelta"> & {
      title: string;
      titleAliases?: string[];
      delta?: number;
      expectedStatus?: string;
      expectedReviewState?: string;
      expectedGroundingState?: string;
      requireDescription?: boolean;
      requireSuccessCriteria?: boolean;
      requireSupportStrategy?: boolean;
    })
  | (CheckBase<"gmailActionArguments"> & {
      actionName?: StringMatcher;
      subaction?: StringMatcher;
      operation?: StringMatcher;
      fields?: Record<string, unknown>;
      minCount?: number;
    })
  | (CheckBase<"gmailMockRequest"> & {
      method?: StringMatcher;
      path?: StringMatcher;
      body?: Record<string, unknown>;
      expected?: boolean;
      minCount?: number;
    })
  | (CheckBase<"gmailDraftCreated"> & {
      expected?: boolean;
    })
  | (CheckBase<"gmailDraftDeleted"> & {
      expected?: boolean;
    })
  | (CheckBase<"gmailMessageSent"> & {
      expected?: boolean;
    })
  | (CheckBase<"gmailBatchModify"> & {
      expected?: boolean;
      body?: Record<string, unknown>;
    })
  | (CheckBase<"gmailApproval"> & {
      state: "pending" | "confirmed" | "canceled" | "cancelled";
    })
  | CheckBase<"gmailNoRealWrite">
  | (CheckBase<"workflowDispatchOccurred"> & {
      workflowId?: string;
      expected?: boolean;
      minCount?: number;
    })
  | (CheckBase<"definitionCountDelta"> & {
      title: string;
      titleAliases?: string[];
      delta?: number;
      cadenceKind?: "once" | "daily" | "weekly" | "times_per_day" | "interval";
      requiredSlots?: DefinitionCountRequiredSlot[];
      requiredWeekdays?: number[];
      requiredWindows?: string[];
      requiredEveryMinutes?: number;
      requiredMaxOccurrencesPerDay?: number;
      expectedTimeZone?: string;
      expectedDueLocalTimes?: DefinitionCountExpectedDueLocalTime[];
      forbiddenDueLocalTimes?: DefinitionCountForbiddenDueLocalTime[];
      requireReminderPlan?: boolean;
      websiteAccess?: DefinitionCountWebsiteAccess;
    })
  | (CheckBase<"reminderIntensity"> & {
      title: string;
      titleAliases?: string[];
      expected:
        | "minimal"
        | "normal"
        | "persistent"
        | "high_priority_only"
        | "escalated";
    })
  | (CheckBase<"judgeRubric"> & {
      name: string;
      rubric: string;
      minimumScore?: number;
    });

/**
 * Which CI lane a scenario runs in.
 *
 * - `pr-deterministic`: runs on every PR under the deterministic model provider
 *   (`SCENARIO_USE_DETERMINISTIC_MODEL=1`) with zero credentials. A scenario may only
 *   claim this lane if it passes keyless — no live external service, no secret,
 *   and every LLM call is either backed by a registered proxy fixture or
 *   satisfied by the proxy's default reply.
 * - `live-only`: needs live model credentials and/or external connector
 *   services and runs only in the credentialed live lane. This is the default
 *   for any scenario that does not declare a lane.
 */
export type ScenarioLane = "pr-deterministic" | "live-only";
/**
 * `simulated` runs may use fixtures, mocks, or deterministic services and are
 * never publishable as provider evidence. `provider-qualified` runs must be
 * backed by trusted durable/provider observers and hashed trajectories.
 */
export type ScenarioExecutionProfile = "simulated" | "provider-qualified";
export type ScenarioEvidenceScope =
  | "runner-fixture"
  | "domain-contract"
  | "model-behavior"
  | "connector-contract"
  | "provider-certification";
export type ScenarioTier = "T1" | "T2" | "T3" | "T4";

/**
 * A platform-gated deferral on a live-only scenario: it cannot run in any
 * current lane because the platform/runner it needs does not exist yet. Keeps
 * the scenario visible-but-deferred in the corpus inventory. (#10757)
 */
export type ScenarioDeferral = {
  /** Why the scenario cannot run yet (e.g. "needs SelfControl.app on macOS"). */
  reason: string;
  /** Self-hosted runner label that would unblock it, e.g. `eliza-e2e-macos`. */
  runner?: string;
};

/** A room a multi-room scenario message turn can target (`turns[].room`). */
export type ScenarioRoomSpec = {
  id?: string;
  /** Logical world key. Rooms with the same key share a deterministic world. */
  world?: string;
  /**
   * Connector-account key. Preserves the legacy behavior of coalescing rooms
   * that use the same account when no explicit canonical entity is supplied.
   */
  account?: string;
  /**
   * Canonical logical entity key. Distinct connector accounts naming the same
   * entity become separate principals linked through the real identity graph.
   */
  entity?: string;
  title?: string;
  source?: string;
  channelType?: string;
};

/**
 * Personality expectation metadata for external evaluators. The scenario
 * runner preserves this authoring contract but does not evaluate it.
 */
export type ScenarioPersonalityExpect = {
  bucket: string;
  expectedBehavior?: string;
  judgeMode?: string;
  forbiddenContent?: string[];
  requiredContent?: string[];
  directiveTurn?: number;
  checkTurns?: number[];
  options?: Record<string, unknown>;
  judgeKwargs?: Record<string, unknown>;
};

/** Runtime capabilities that must be ready before scenario turns execute. */
export type ScenarioRequirements = {
  /** Import specifiers for plugin packages the runner loads before execution. */
  plugins?: readonly string[];
  /** Plugin names that this scenario's seed registers locally. */
  fixturePlugins?: readonly string[];
  /**
   * Service types whose startup must complete successfully before execution.
   * Services omitted here are optional even when a required plugin declares them.
   */
  services?: readonly string[];
  /**
   * Named credential slots (e.g. `1password:eliza-e2e-autofill`) the live lane
   * must provision before this scenario is eligible; corpora-specific runners
   * interpret the slot names.
   */
  credentials?: readonly string[];
  /** Host platform the scenario needs (e.g. `macos`); other platforms defer it. */
  os?: string;
};

/** Serializable text matcher shared by in-process and wire model fixtures. */
export type ScenarioModelTextMatcher =
  | { exact: string }
  | { includes: string }
  | { pattern: string; flags?: string };

export type ScenarioModelToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ScenarioTextModelType =
  | "TEXT_NANO"
  | "TEXT_SMALL"
  | "TEXT_MEDIUM"
  | "TEXT_LARGE"
  | "TEXT_MEGA"
  | "RESPONSE_HANDLER"
  | "ACTION_PLANNER"
  | "REASONING_SMALL"
  | "REASONING_LARGE"
  | "TEXT_COMPLETION";

export type ScenarioModelFixture = {
  name: string;
  match: {
    modelType: ScenarioTextModelType | readonly ScenarioTextModelType[];
    input?: ScenarioModelTextMatcher;
    prompt?: ScenarioModelTextMatcher;
    toolNames?: readonly string[];
    responseSchema?: unknown;
  };
  response?: {
    text?: string;
    json?: unknown;
    toolCalls?: readonly ScenarioModelToolCall[];
    finishReason?: string;
    thought?: string;
    messageToUser?: string;
    completed?: boolean;
    usage?: { promptTokens: number; completionTokens: number };
  };
  /** Defaults to exactly once for scenario manifests. */
  cardinality?: number | "any" | { min?: number; max?: number };
  behavior?: {
    latencyMs?: number;
    stream?: { chunkSize: number; intervalMs: number };
    error?: { message: string; code?: string; status?: number; type?: string };
    waitForAbort?: boolean;
  };
};

export type ScenarioModelFixtureDeclaration =
  | {
      mode: "fixtures";
      fixtures: readonly ScenarioModelFixture[];
    }
  | {
      mode: "model-free";
      /** Why the scenario intentionally never enters a model-backed path. */
      reason: string;
    };

export type ScenarioDefinition = {
  id: string;
  title: string;
  domain: string;
  description?: string;
  tags?: readonly string[];
  /**
   * Persona-scenario complexity tier.
   * - `T1`: extraction and normalization.
   * - `T2`: multi-turn flow with realistic friction.
   * - `T3`: longitudinal journey with durable state.
   * - `T4`: adversarial or boundary-condition behavior.
   */
  tier?: ScenarioTier;
  status?: "active" | "pending";
  /**
   * CI lane this scenario is eligible for.
   * - `pr-deterministic`: runs keyless on every PR through the deterministic
   *   model provider + Mockoon connectors (zero external cost).
   * - `live-only`: requires real provider/connector credentials; runs only in
   *   the scheduled live lanes.
   * Declare it as a string literal — the scenario tooling reads it statically.
   * Absent means `live-only` (see {@link DEFAULT_SCENARIO_LANE}).
   */
  lane?: ScenarioLane;
  /**
   * Evidence trust boundary for this scenario. Absent preserves existing
   * scenarios by resolving to `simulated`; simulated results are never
   * publishable as provider evidence.
   */
  executionProfile?: ScenarioExecutionProfile;
  /** Closed classification of what this scenario can truthfully claim. */
  evidenceScope?: ScenarioEvidenceScope;
  /**
   * Platform-gated deferral. Present only on `live-only` scenarios that cannot
   * run in any current lane because the platform/runner they need does not exist
   * yet (e.g. a macOS SelfControl shard awaiting an `eliza-e2e-macos` runner).
   * Keeps the scenario visible in the corpus inventory as a distinct "deferred
   * platform-gated" class. (#10757)
   */
  deferred?: ScenarioDeferral;
  /**
   * Authoring metadata: the isolation level this scenario was written for.
   * Not read by the runner — `packages/scripts/run-scenarios-isolated.ts`
   * isolates every scenario per process regardless.
   */
  isolation?: "per-scenario" | "shared-runtime" | "worker";
  /** Plugins and service capabilities required before the scenario runs. */
  requires?: ScenarioRequirements;
  /** Strict model contract. There is no default/fallback completion. */
  modelFixtures?: ScenarioModelFixtureDeclaration;
  rooms?: ScenarioRoomSpec[];
  /** Personality corpus metadata (live-only judge bridge). */
  scope?: "user" | "mixed";
  personalityExpect?: ScenarioPersonalityExpect;
  /** Connector-certification corpus metadata (`connector-certification/_factory.ts`). */
  connector?: string;
  axis?: string;
  /** Mockoon mock services the connector-certification lane boots for this scenario. */
  mockoon?: string[];
  turns: readonly ScenarioTurn[];
  seed?: ScenarioSeedStep[];
  cleanup?: ScenarioCleanupStep[];
  finalChecks?: ScenarioFinalCheck[];
  /** Set by the loader when edge-case expansion is enabled — not authored. */
  edgeVariant?: string;
  baseScenarioId?: string;
};
/**
 * Runtime schema module for `@elizaos/testing`: the final-check key
 * table (FINAL_CHECK_KEYS) and the scenario metadata validators for lanes,
 * execution profiles, tiers, and platform deferrals. Scenario files import
 * these at authoring/load boundaries; types and validators share this module.
 */
export const FINAL_CHECK_KEYS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map(
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
      "connectorProvider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
      "transitionGroupId",
      "transitionIndex",
      "trajectoryPhase",
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
      "connectorProvider",
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
      "connectorProvider",
      "accountId",
      "operation",
      "resourceId",
      "state",
      "minCount",
      "intervalCoversScenario",
      "intervalEndsBeforeReferencedStage",
      "trajectoryPhase",
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

function validateStrictFinalCheck(check: ScenarioFinalCheck, index: number) {
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

/** Conservative behavioral claim assumed for legacy scenario definitions. */
export const DEFAULT_SCENARIO_EVIDENCE_SCOPE = "runner-fixture";

const SCENARIO_LANES = new Set(["pr-deterministic", "live-only"]);
const SCENARIO_EXECUTION_PROFILES = new Set([
  "simulated",
  "provider-qualified",
]);
const SCENARIO_EVIDENCE_SCOPES = new Set([
  "runner-fixture",
  "domain-contract",
  "model-behavior",
  "connector-contract",
  "provider-certification",
]);
const SCENARIO_EVIDENCE_SCOPE_LABELS = new Map([
  ["runner-fixture", "runner fixture (diagnostic only)"],
  ["domain-contract", "domain contract (not provider evidence)"],
  ["model-behavior", "model behavior (not provider evidence)"],
  ["connector-contract", "connector contract (simulated provider boundary)"],
  [
    "provider-certification",
    "provider certification (qualified external evidence)",
  ],
]);
const SCENARIO_TIERS = new Set(["T1", "T2", "T3", "T4"]);
const SCENARIO_STATUSES = new Set(["active", "pending"]);

/** Resolve a scenario's effective lane, applying {@link DEFAULT_SCENARIO_LANE}. */
export function scenarioLane(
  value: Pick<ScenarioDefinition, "id" | "lane">,
): ScenarioLane {
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
export function isScenarioExecutionProfile(
  value: unknown,
): value is ScenarioExecutionProfile {
  return typeof value === "string" && SCENARIO_EXECUTION_PROFILES.has(value);
}

/**
 * Resolve a scenario's execution profile. Provider-qualified scenarios are
 * live-only because deterministic lanes cannot produce provider evidence.
 */
export function scenarioExecutionProfile(
  value: ScenarioDefinition,
): ScenarioExecutionProfile {
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

/** Return whether a value belongs to the closed evidence-scope vocabulary. */
export function isScenarioEvidenceScope(
  value: unknown,
): value is ScenarioEvidenceScope {
  return typeof value === "string" && SCENARIO_EVIDENCE_SCOPES.has(value);
}

/** Resolve the behavioral claim without allowing provider trust inflation. */
export function scenarioEvidenceScope(
  value: ScenarioDefinition,
): ScenarioEvidenceScope {
  const evidenceScope = value?.evidenceScope ?? DEFAULT_SCENARIO_EVIDENCE_SCOPE;
  if (!isScenarioEvidenceScope(evidenceScope)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid evidenceScope "${evidenceScope}"; expected one of ${[...SCENARIO_EVIDENCE_SCOPES].join(", ")}`,
    );
  }
  const executionProfile = scenarioExecutionProfile(value);
  if (
    (evidenceScope === "provider-certification") !==
    (executionProfile === "provider-qualified")
  ) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has incompatible evidenceScope "${evidenceScope}" and executionProfile "${executionProfile}"; provider certification requires provider-qualified execution and provider-qualified execution requires provider-certification scope`,
    );
  }
  return evidenceScope;
}

/** Return the report label that states the scope's trust limit explicitly. */
export function scenarioEvidenceScopeLabel(
  value: ScenarioEvidenceScope,
): string {
  if (!isScenarioEvidenceScope(value)) {
    throw new Error(`invalid scenario evidence scope "${String(value)}"`);
  }
  return SCENARIO_EVIDENCE_SCOPE_LABELS.get(value) ?? value;
}

/** Resolve and validate the optional persona-scenario complexity tier. */
export function scenarioTier(
  value: Omit<ScenarioDefinition, "tier"> & { tier?: unknown },
): ScenarioTier | undefined {
  const tier = value?.tier;
  if (tier === undefined) {
    return undefined;
  }
  if (typeof tier !== "string" || !SCENARIO_TIERS.has(tier)) {
    throw new Error(
      `scenario "${value?.id ?? "<unknown>"}" has invalid tier "${tier}"; expected one of ${[...SCENARIO_TIERS].join(", ")}`,
    );
  }
  return tier as ScenarioTier;
}

function validateScenarioStatus(value: ScenarioDefinition) {
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

function validateScenarioRequirements(value: ScenarioDefinition) {
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
      `scenario "${value?.id ?? "<unknown>"}" has invalid requires; expected { plugins?: string[], fixturePlugins?: string[], services?: string[], credentials?: string[], os?: string }`,
    );
  }
  const knownKeys = [
    "plugins",
    "fixturePlugins",
    "services",
    "credentials",
    "os",
  ];
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
  for (const key of [
    "plugins",
    "fixturePlugins",
    "services",
    "credentials",
  ] as const) {
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

function validateScenarioModelFixtures(value: ScenarioDefinition) {
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
        (modelType: unknown) =>
          typeof modelType !== "string" || !modelType.trim(),
      )
    ) {
      throw new Error(
        `scenario model fixture "${fixture.name}" requires non-empty modelType strings`,
      );
    }
    const unsupportedModelTypes = modelTypes.filter(
      (modelType: unknown) =>
        typeof modelType !== "string" ||
        !SCENARIO_MODEL_FIXTURE_TYPES.has(modelType),
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
          (name: unknown) => typeof name !== "string" || !name.trim(),
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
      const unknownResponseKeys = Object.keys(fixture.response).filter(
        (key) =>
          ![
            "json",
            "text",
            "toolCalls",
            "finishReason",
            "thought",
            "messageToUser",
            "completed",
            "usage",
          ].includes(key),
      );
      if (unknownResponseKeys.length > 0) {
        throw new Error(
          `scenario model fixture "${fixture.name}" response has unknown field(s): ${unknownResponseKeys.join(", ")}`,
        );
      }
      if (
        fixture.response.json !== undefined &&
        [
          "text",
          "toolCalls",
          "finishReason",
          "thought",
          "messageToUser",
          "completed",
          "usage",
        ].some((key) => fixture.response[key] !== undefined)
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" response.json is exclusive`,
        );
      }
      for (const key of ["text", "finishReason", "thought", "messageToUser"]) {
        if (
          fixture.response[key] !== undefined &&
          typeof fixture.response[key] !== "string"
        ) {
          throw new Error(
            `scenario model fixture "${fixture.name}" has invalid response.${key}`,
          );
        }
      }
      if (
        fixture.response.completed !== undefined &&
        typeof fixture.response.completed !== "boolean"
      ) {
        throw new Error(
          `scenario model fixture "${fixture.name}" has invalid response.completed`,
        );
      }
      if (
        fixture.response.toolCalls !== undefined &&
        (!Array.isArray(fixture.response.toolCalls) ||
          fixture.response.toolCalls.some(
            (toolCall: ScenarioModelToolCall) =>
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
export function scenarioDeferral(
  value: Omit<ScenarioDefinition, "deferred"> & { deferred?: unknown },
): ScenarioDeferral | null {
  const deferred = value?.deferred;
  if (deferred === undefined || deferred === null) {
    return null;
  }
  if (
    typeof deferred !== "object" ||
    !("reason" in deferred) ||
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
    ...("runner" in deferred && typeof deferred.runner === "string"
      ? { runner: deferred.runner }
      : {}),
  };
}

export function scenario<const T extends ScenarioDefinition>(value: T): T {
  if (value && typeof value === "object") {
    if (Array.isArray(value.finalChecks)) {
      value.finalChecks.forEach(validateStrictFinalCheck);
    }
    // Validate the lane eagerly so a typo fails at definition time, not in CI.
    scenarioLane(value);
    // Provider evidence cannot be claimed by a deterministic execution profile.
    scenarioExecutionProfile(value);
    scenarioEvidenceScope(value);
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
