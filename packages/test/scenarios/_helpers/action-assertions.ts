import type {
  ApprovalRequestState,
  CapturedAction,
  CapturedApprovalRequest,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
  ScenarioCheckResult,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-schema";
import {
  actionMatchesScenarioExpectation,
  actionsAreScenarioEquivalent,
} from "../../../packages/scenario-runner/src/action-families.ts";

type Pattern = string | RegExp;

type ActionExpectation = {
  acceptedActions: string[];
  description: string;
  includesAny?: Pattern[];
  includesAll?: Pattern[];
  minCount?: number;
};

type ApprovalExpectation = {
  description: string;
  actionName?: string | string[];
  state?: ApprovalRequestState | ApprovalRequestState[];
  minCount?: number;
};

type ApprovalTransitionExpectation = {
  description: string;
  from: ApprovalRequestState;
  to: ApprovalRequestState;
  actionName?: string | string[];
};

type ConnectorDispatchExpectation = {
  description: string;
  channel: string | string[];
  actionName?: string | string[];
  minCount?: number;
  payloadIncludesAny?: Pattern[];
};

type MemoryWriteExpectation = {
  description: string;
  table: string | string[];
  minCount?: number;
  contentIncludesAny?: Pattern[];
};

type StateTransitionExpectation = {
  description: string;
  subject: string;
  to: string;
  from?: string;
};

type NoSideEffectExpectation = {
  description: string;
  actionName: string | string[];
  channels?: string[];
};

type RubricExpectation = {
  name: string;
  description?: string;
  threshold: number;
};

function actionBlob(action: CapturedAction): string {
  const parts: string[] = [action.actionName];
  if (action.parameters) {
    parts.push(JSON.stringify(action.parameters));
  }
  if (action.result?.data) {
    parts.push(JSON.stringify(action.result.data));
  }
  if (action.result?.values) {
    parts.push(JSON.stringify(action.result.values));
  }
  if (action.result?.text) {
    parts.push(action.result.text);
  }
  if (action.error?.message) {
    parts.push(action.error.message);
  }
  return parts.join(" | ");
}

function matchesPattern(value: string, pattern: Pattern): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}

function normalizeChannelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function channelMatches(
  candidate: string | undefined,
  filters: string[],
): boolean {
  if (filters.length === 0) {
    return true;
  }
  if (!candidate) {
    return false;
  }
  const normalizedCandidate = normalizeChannelKey(candidate);
  return filters.some(
    (filter) => normalizeChannelKey(filter) === normalizedCandidate,
  );
}

function describeActionSet(actions: CapturedAction[]): string {
  return actions.map((action) => action.actionName).join(", ") || "(none)";
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function actionMatches(
  candidate: string | undefined,
  filters: string[],
): boolean {
  if (filters.length === 0) {
    return true;
  }
  if (!candidate) {
    return false;
  }
  return actionMatchesScenarioExpectation(candidate, filters);
}

function validateActionExpectation(
  actions: CapturedAction[],
  expectation: ActionExpectation,
): ScenarioCheckResult {
  const matched = actions.filter((action) =>
    actionMatchesScenarioExpectation(
      action.actionName,
      expectation.acceptedActions,
    ),
  );
  const minCount = expectation.minCount ?? 1;
  if (matched.length < minCount) {
    return `Expected ${expectation.description} via [${expectation.acceptedActions.join(", ")}] but got ${describeActionSet(actions)}.`;
  }

  const blobs = matched.map((action) => actionBlob(action)).join(" || ");
  for (const pattern of expectation.includesAll ?? []) {
    if (!matchesPattern(blobs, pattern)) {
      return `Expected ${expectation.description} payload to include ${String(pattern)}. Payloads: ${blobs}`;
    }
  }

  if (expectation.includesAny?.length) {
    const hasAny = expectation.includesAny.some((pattern) =>
      matchesPattern(blobs, pattern),
    );
    if (!hasAny) {
      return `Expected ${expectation.description} payload to include one of [${expectation.includesAny.map(String).join(", ")}]. Payloads: ${blobs}`;
    }
  }

  return undefined;
}

export function expectTurnToCallAction(expectation: ActionExpectation) {
  return (turn: ScenarioTurnExecution): ScenarioCheckResult =>
    validateActionExpectation(turn.actionsCalled, expectation);
}

export function expectScenarioToCallAction(expectation: ActionExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult =>
    validateActionExpectation(ctx.actionsCalled, expectation);
}

/**
 * Side-effect assertion: an approval queue request was created with the
 * expected actionName / state. Reads from `ScenarioContext.approvalRequests`
 * which the runner populates from the live approval queue table (no mocks).
 */
export function expectApprovalRequest(expectation: ApprovalExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const requests = ctx.approvalRequests ?? [];
    const actionFilters = toArray(expectation.actionName);
    const stateFilters = toArray(expectation.state);
    const matched = requests.filter((request: CapturedApprovalRequest) => {
      if (!actionMatches(request.actionName, actionFilters)) {
        return false;
      }
      if (stateFilters.length > 0 && !stateFilters.includes(request.state)) {
        return false;
      }
      return true;
    });
    const minCount = expectation.minCount ?? 1;
    if (matched.length < minCount) {
      return `Expected ${expectation.description}: at least ${minCount} approval request(s) matching action=[${actionFilters.join(",") || "*"}] state=[${stateFilters.join(",") || "*"}], saw ${matched.length} of ${requests.length} total.`;
    }
    return undefined;
  };
}

/**
 * Side-effect assertion: the approval queue contains a request that
 * transitioned `from` → `to`. Verifies the state machine actually moved,
 * not just that a final state exists. Inspects
 * `ScenarioContext.stateTransitions` populated by the live runner.
 */
export function expectApprovalStateTransition(
  expectation: ApprovalTransitionExpectation,
) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const transitions = ctx.stateTransitions ?? [];
    const actionFilters = toArray(expectation.actionName);
    const matched = transitions.filter(
      (transition: CapturedStateTransition) => {
        if (transition.subject !== "approval") {
          return false;
        }
        if (transition.from !== expectation.from) {
          return false;
        }
        if (transition.to !== expectation.to) {
          return false;
        }
        return true;
      },
    );
    if (matched.length === 0) {
      return `Expected ${expectation.description}: approval transition ${expectation.from}→${expectation.to} (action=[${actionFilters.join(",") || "*"}]), saw ${transitions.length} transitions of any kind.`;
    }
    return undefined;
  };
}

/**
 * Side-effect assertion: the connector dispatcher was invoked for one of the
 * specified channels. Reads from `ScenarioContext.connectorDispatches`,
 * populated by the live dispatcher's instrumentation hook (real connector,
 * captured invocation log).
 */
export function expectConnectorDispatch(
  expectation: ConnectorDispatchExpectation,
) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const dispatches = ctx.connectorDispatches ?? [];
    const channels = toArray(expectation.channel);
    const actionFilters = toArray(expectation.actionName);
    const matched = dispatches.filter((dispatch: CapturedConnectorDispatch) => {
      if (!channelMatches(dispatch.channel, channels)) {
        return false;
      }
      if (!actionMatches(dispatch.actionName, actionFilters)) {
        return false;
      }
      return true;
    });
    const minCount = expectation.minCount ?? 1;
    if (matched.length < minCount) {
      return `Expected ${expectation.description}: at least ${minCount} dispatch(es) on channels [${channels.join(",") || "*"}], saw ${matched.length} of ${dispatches.length} total.`;
    }
    if (expectation.payloadIncludesAny?.length) {
      const blob = matched
        .map((dispatch) =>
          dispatch.payload === undefined
            ? ""
            : JSON.stringify(dispatch.payload),
        )
        .join(" || ");
      const hasAny = expectation.payloadIncludesAny.some((pattern) =>
        matchesPattern(blob, pattern),
      );
      if (!hasAny) {
        return `Expected ${expectation.description}: dispatch payload to include one of [${expectation.payloadIncludesAny.map(String).join(", ")}]. Payload: ${blob}`;
      }
    }
    return undefined;
  };
}

/**
 * Side-effect assertion: a memory row was written to the named table during
 * the scenario. Reads from `ScenarioContext.memoryWrites`, captured live
 * from the runtime adapter (no mocks).
 */
export function expectMemoryWrite(expectation: MemoryWriteExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const writes = ctx.memoryWrites ?? [];
    const tables = toArray(expectation.table);
    const matched = writes.filter((write: CapturedMemoryWrite) =>
      tables.length === 0 ? true : tables.includes(write.table),
    );
    const minCount = expectation.minCount ?? 1;
    if (matched.length < minCount) {
      return `Expected ${expectation.description}: at least ${minCount} memory write(s) to [${tables.join(",") || "*"}], saw ${matched.length} of ${writes.length} total.`;
    }
    if (expectation.contentIncludesAny?.length) {
      const blob = matched
        .map((write) =>
          write.content === undefined ? "" : JSON.stringify(write.content),
        )
        .join(" || ");
      const hasAny = expectation.contentIncludesAny.some((pattern) =>
        matchesPattern(blob, pattern),
      );
      if (!hasAny) {
        return `Expected ${expectation.description}: memory content to include one of [${expectation.contentIncludesAny.map(String).join(", ")}].`;
      }
    }
    return undefined;
  };
}

/**
 * Side-effect assertion: a non-approval state machine transitioned to a
 * specific state (eg. delivery=delivered, browser-task=needs-human).
 */
export function expectStateTransition(expectation: StateTransitionExpectation) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const transitions = ctx.stateTransitions ?? [];
    const matched = transitions.filter(
      (transition: CapturedStateTransition) => {
        if (transition.subject !== expectation.subject) {
          return false;
        }
        if (
          expectation.from !== undefined &&
          transition.from !== expectation.from
        ) {
          return false;
        }
        if (transition.to !== expectation.to) {
          return false;
        }
        return true;
      },
    );
    if (matched.length === 0) {
      return `Expected ${expectation.description}: ${expectation.subject} transition ${expectation.from ?? "*"}→${expectation.to}, saw ${transitions.length} transitions.`;
    }
    return undefined;
  };
}

/**
 * Side-effect *absence* assertion: when an action was rejected, no connector
 * dispatch happened for it. Used by approval-gated scenarios to prove the
 * gate held — the negative space is the assertion.
 */
export function expectNoSideEffectOnReject(
  expectation: NoSideEffectExpectation,
) {
  return (ctx: ScenarioContext): ScenarioCheckResult => {
    const actionFilters = toArray(expectation.actionName);
    const requests = ctx.approvalRequests ?? [];
    const rejectedActions = new Set(
      requests
        .filter((request) => request.state === "rejected")
        .map((request) => request.actionName),
    );
    const dispatches = ctx.connectorDispatches ?? [];
    const offending = dispatches.filter((dispatch) => {
      if (!actionMatches(dispatch.actionName, actionFilters)) {
        return false;
      }
      if (
        expectation.channels?.length &&
        !channelMatches(dispatch.channel, expectation.channels)
      ) {
        return false;
      }
      const dispatchAction = dispatch.actionName ?? "";
      return (
        actionMatchesScenarioExpectation(dispatchAction, actionFilters) &&
        Array.from(rejectedActions).some((actionName) =>
          actionsAreScenarioEquivalent(dispatchAction, actionName),
        )
      );
    });
    if (offending.length > 0) {
      return `Expected ${expectation.description}: rejected action(s) [${actionFilters.join(",")}] should NOT dispatch, but ${offending.length} dispatch(es) occurred.`;
    }
    return undefined;
  };
}

/**
 * Marker for the LLM-judge rubric assertion. The actual scoring happens in
 * the live runner against the real provider; this helper records the rubric
 * so the contract test can verify presence and the runner can pick it up
 * via the `judgeRubric` finalCheck entry.
 */
export function judgeRubric(expectation: RubricExpectation): {
  type: "judgeRubric";
  name: string;
  rubric: string;
  minimumScore: number;
} {
  return {
    type: "judgeRubric",
    name: expectation.name,
    rubric: expectation.description ?? expectation.name,
    minimumScore: expectation.threshold,
  };
}
