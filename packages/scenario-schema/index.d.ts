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
      apply?: (ctx: ScenarioContext) => ScenarioCheckResult;
      by?: string;
      connector?: string;
      provider?: string;
      state?: string;
      capabilities?: string[];
      scopes?: string[];
      limit?: number;
      [key: string]: unknown;
    };

export type ScenarioJudgeRubric = {
  rubric: string;
  minimumScore?: number;
  label?: string;
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
  responseJudge?: ScenarioJudgeRubric;
  plannerJudge?: ScenarioJudgeRubric;
  [key: string]: unknown;
};

export type ScenarioFinalCheck =
  | {
      type: "custom";
      name: string;
      predicate: (ctx: ScenarioContext) => ScenarioCheckResult;
      [key: string]: unknown;
    }
  | {
      type: "actionCalled";
      actionName: string;
      status?: string;
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "selectedAction";
      actionName: string | string[];
      [key: string]: unknown;
    }
  | {
      type: "selectedActionArguments";
      actionName: string | string[];
      includesAny?: Array<string | RegExp>;
      includesAll?: Array<string | RegExp>;
      [key: string]: unknown;
    }
  | {
      type: "clarificationRequested";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "interventionRequestExists";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "pushSent";
      channel: string | string[];
      [key: string]: unknown;
    }
  | {
      type: "pushEscalationOrder";
      channelOrder: string[];
      [key: string]: unknown;
    }
  | {
      type: "pushAcknowledgedSync";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "approvalRequestExists";
      expected?: boolean;
      actionName?: string | string[];
      state?: ApprovalRequestState | ApprovalRequestState[];
      [key: string]: unknown;
    }
  | {
      type: "approvalStateTransition";
      from: ApprovalRequestState;
      to: ApprovalRequestState;
      actionName?: string | string[];
      [key: string]: unknown;
    }
  | {
      type: "noSideEffectOnReject";
      actionName: string | string[];
      [key: string]: unknown;
    }
  | {
      type: "draftExists";
      channel?: string | string[];
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "messageDelivered";
      channel?: string | string[];
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "browserTaskCompleted";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "browserTaskNeedsHuman";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "uploadedAssetExists";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "connectorDispatchOccurred";
      channel: string | string[];
      actionName?: string | string[];
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "memoryWriteOccurred";
      table: string | string[];
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "gmailActionArguments";
      actionName?: string | string[];
      subaction?: string | string[];
      operation?: string | string[];
      fields?: Record<string, unknown>;
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "gmailMockRequest";
      method?: string | string[];
      path?: string | string[];
      body?: Record<string, unknown>;
      expected?: boolean;
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "gmailDraftCreated";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "gmailDraftDeleted";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "gmailMessageSent";
      expected?: boolean;
      [key: string]: unknown;
    }
  | {
      type: "gmailBatchModify";
      expected?: boolean;
      body?: Record<string, unknown>;
      [key: string]: unknown;
    }
  | {
      type: "gmailApproval";
      state: "pending" | "confirmed" | "canceled" | "cancelled";
      [key: string]: unknown;
    }
  | {
      type: "gmailNoRealWrite";
      [key: string]: unknown;
    }
  | {
      type: "workflowDispatchOccurred";
      workflowId?: string;
      expected?: boolean;
      minCount?: number;
      [key: string]: unknown;
    }
  | {
      type: "judgeRubric";
      name: string;
      rubric: string;
      minimumScore?: number;
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export type ScenarioDefinition = {
  id: string;
  title: string;
  domain: string;
  status?: "active" | "pending";
  turns: ScenarioTurn[];
  seed?: ScenarioSeedStep[];
  finalChecks?: ScenarioFinalCheck[];
  [key: string]: unknown;
};

export declare const FINAL_CHECK_KEYS: ReadonlyMap<string, ReadonlySet<string>>;

export function scenario<const T extends ScenarioDefinition>(value: T): T;
