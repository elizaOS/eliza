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
type DefinitionCountRequiredSlot = {
  label?: string;
  minuteOfDay?: number;
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
 * - `pr-deterministic`: runs on every PR under the deterministic LLM proxy
 *   (`SCENARIO_USE_LLM_PROXY=1`) with zero credentials. A scenario may only
 *   claim this lane if it passes keyless — no live external service, no secret,
 *   and every LLM call is either backed by a registered proxy fixture or
 *   satisfied by the proxy's default reply.
 * - `live-only`: needs live model credentials and/or external connector
 *   services and runs only in the credentialed live lane. This is the default
 *   for any scenario that does not declare a lane.
 */
export type ScenarioLane = "pr-deterministic" | "live-only";
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
   *   LLM proxy + Mockoon connectors (zero external cost).
   * - `live-only`: requires real provider/connector credentials; runs only in
   *   the scheduled live lanes.
   * Declare it as a string literal — the scenario tooling reads it statically.
   * Absent means `live-only` (see {@link DEFAULT_SCENARIO_LANE}).
   */
  lane?: ScenarioLane;
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
  /** Plugins that must be registered before the scenario runs (skip otherwise). */
  requires?: { plugins?: string[] };
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

/** Resolve a scenario's effective lane, applying {@link DEFAULT_SCENARIO_LANE}. */
export declare function scenarioLane(value: ScenarioDefinition): ScenarioLane;

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
