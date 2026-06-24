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
  plannerText?: string;
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
  now?: string;
  actionsCalled: CapturedAction[];
  turns?: ScenarioTurnExecution[];
  approvalRequests?: CapturedApprovalRequest[];
  connectorDispatches?: CapturedConnectorDispatch[];
  memoryWrites?: CapturedMemoryWrite[];
  stateTransitions?: CapturedStateTransition[];
  artifacts?: CapturedArtifact[];
};

export type ScenarioSeedStep =
  | {
      type: "advanceClock";
      by: string;
      name?: string;
      [key: string]: unknown;
    }
  | {
      type: string;
      name?: string;
      apply?: (
        ctx: ScenarioContext,
      ) => ScenarioCheckResult | Promise<ScenarioCheckResult>;
      by?: string;
      connector?: string;
      provider?: string;
      state?: string;
      capabilities?: string[];
      scopes?: string[];
      limit?: number;
      [key: string]: unknown;
    };

export type ScenarioCleanupStep =
  | {
      type: "gmailDeleteDrafts";
      name?: string;
      [key: string]: unknown;
    }
  | {
      type: "selfControlClearBlocks";
      name?: string;
      profile?: string;
      [key: string]: unknown;
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

export type ScenarioTurn = {
  kind?: string;
  name: string;
  text?: string;
  method?: string;
  path?: string;
  body?: unknown;
  expectedStatus?: number;
  worker?: string;
  now?: string;
  options?: Record<string, unknown>;
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
  plannerJudge?: ScenarioJudgeRubric;
  [key: string]: unknown;
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

export type ScenarioDefinition = {
  id: string;
  title: string;
  domain: string;
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
  turns: ScenarioTurn[];
  seed?: ScenarioSeedStep[];
  cleanup?: ScenarioCleanupStep[];
  finalChecks?: ScenarioFinalCheck[];
  [key: string]: unknown;
};

export declare const FINAL_CHECK_KEYS: ReadonlyMap<string, ReadonlySet<string>>;

/** Lane assumed for any scenario that does not declare one. */
export declare const DEFAULT_SCENARIO_LANE: ScenarioLane;

/** Resolve a scenario's effective lane, applying {@link DEFAULT_SCENARIO_LANE}. */
export declare function scenarioLane(value: ScenarioDefinition): ScenarioLane;

export function scenario<const T extends ScenarioDefinition>(value: T): T;
