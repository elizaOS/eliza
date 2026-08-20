/** Dependency-free authoring contract for scenario definitions, turns, and final checks. */

export type CapturedAction = {
  actionName: string;
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
 * a seed type outside it is silently ignored by the runner, so declaring it
 * here would only manufacture false coverage.
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
  accountId?: StringMatcher;
  operation?: StringMatcher;
  resourceId?: StringMatcher;
  state?: StringMatcher;
  minCount?: number;
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
  /** For multi-room scenarios, the `rooms[].id` this turn is sent to. */
  room?: string;
  method?: string;
  path?: string;
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
  account?: string;
  title?: string;
  source?: string;
  channelType?: string;
};

/**
 * Live-only personality expectation consumed by
 * `scripts/personality-bench-bridge.mjs` (not by the runner itself).
 */
export type ScenarioPersonalityExpect = {
  bucket: string;
  directiveTurn?: number;
  checkTurns?: number[];
  options?: Record<string, unknown>;
  judgeKwargs?: Record<string, unknown>;
};

/** Runtime capabilities that must be ready before scenario turns execute. */
export type ScenarioRequirements = {
  /** Plugin packages that the runner may load when they are not registered. */
  plugins?: readonly string[];
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
   * Not read by the runner — `packages/scripts/run-scenarios-isolated.mjs`
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

export declare const FINAL_CHECK_KEYS: ReadonlyMap<string, ReadonlySet<string>>;

/** Lane assumed for any scenario that does not declare one. */
export declare const DEFAULT_SCENARIO_LANE: ScenarioLane;

/** Execution profile assumed for legacy scenario definitions. */
export declare const DEFAULT_SCENARIO_EXECUTION_PROFILE: "simulated";

/** Resolve a scenario's effective lane, applying {@link DEFAULT_SCENARIO_LANE}. */
export declare function scenarioLane(value: ScenarioDefinition): ScenarioLane;

/** Return whether a value is a supported scenario execution profile. */
export declare function isScenarioExecutionProfile(
  value: unknown,
): value is ScenarioExecutionProfile;

/**
 * Resolve a scenario's execution profile, applying
 * {@link DEFAULT_SCENARIO_EXECUTION_PROFILE}. Provider-qualified scenarios
 * must use the `live-only` lane.
 */
export declare function scenarioExecutionProfile(
  value: ScenarioDefinition,
): ScenarioExecutionProfile;

/** Resolve and validate the optional persona-scenario complexity tier. */
export declare function scenarioTier(
  value: Omit<ScenarioDefinition, "tier"> & { tier?: unknown },
): ScenarioTier | undefined;

/**
 * Resolve a scenario's platform-gated deferral, or `null` when it is not
 * deferred. Throws if `deferred` is malformed or paired with a
 * `pr-deterministic` lane. (#10757)
 */
export declare function scenarioDeferral(
  value: Omit<ScenarioDefinition, "deferred"> & { deferred?: unknown },
): ScenarioDeferral | null;

export function scenario<const T extends ScenarioDefinition>(value: T): T;
