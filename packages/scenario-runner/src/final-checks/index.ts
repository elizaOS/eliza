/**
 * Registry of finalCheck handlers keyed by the discriminator string from
 * `ScenarioFinalCheck.type`. Unknown kinds are not failures — they're logged
 * as "unknown-kind" in the report so older scenarios keep working when new
 * check types are introduced.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-schema";
import { actionMatchesScenarioExpectation } from "../action-families.ts";
import type { FinalCheckReport, FinalCheckStatus } from "../types.ts";

export interface FinalCheckHandlerContext {
  runtime: IAgentRuntime;
  ctx: ScenarioContext;
}

export type FinalCheckOutcome =
  | { status: "passed"; detail: string }
  | { status: "failed"; detail: string }
  | { status: "skipped-dependency-missing"; detail: string };

export type FinalCheckHandler = (
  check: ScenarioFinalCheck,
  ctx: FinalCheckHandlerContext,
) => Promise<FinalCheckOutcome> | FinalCheckOutcome;

const HANDLERS = new Map<string, FinalCheckHandler>();

export function registerFinalCheckHandler(
  type: string,
  handler: FinalCheckHandler,
): void {
  HANDLERS.set(type, handler);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}

function matchesActionName(
  value: string,
  accepted: string | string[] | undefined,
): boolean {
  if (accepted === undefined) {
    return true;
  }
  return actionMatchesScenarioExpectation(value, toArray(accepted));
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasBrowserTaskCompletedValue(value: unknown): boolean {
  const record = toRecord(value);
  if (!record) {
    return false;
  }
  const browserTask = toRecord(record.browserTask);
  if (browserTask?.completed === true) {
    return true;
  }
  const cancellation = toRecord(record.cancellation);
  if (cancellation?.status === "completed") {
    return true;
  }
  const session = toRecord(record.session);
  return session?.status === "done";
}

function hasBrowserTaskNeedsHumanValue(value: unknown): boolean {
  const record = toRecord(value);
  if (!record) {
    return false;
  }
  const browserTask = toRecord(record.browserTask);
  if (browserTask?.needsHuman === true) {
    return true;
  }
  const cancellation = toRecord(record.cancellation);
  if (
    typeof cancellation?.status === "string" &&
    [
      "awaiting_confirmation",
      "needs_login",
      "needs_mfa",
      "needs_user_choice",
      "retention_offer",
      "phone_only",
      "chat_only",
      "blocked",
    ].includes(cancellation.status)
  ) {
    return true;
  }
  const session = toRecord(record.session);
  return session?.status === "awaiting_confirmation";
}

function actionArtifactsPresent(action: ScenarioContext["actionsCalled"][number]): boolean {
  const result = action.result;
  if (!result) {
    return false;
  }
  if (
    typeof result.screenshot === "string" ||
    typeof result.frontendScreenshot === "string" ||
    typeof result.path === "string"
  ) {
    return true;
  }
  const raw = toRecord(result.raw);
  const data = toRecord(result.data);
  const browserTask = toRecord(data?.browserTask);
  const nestedArtifacts = Array.isArray(browserTask?.artifacts)
    ? browserTask.artifacts
    : Array.isArray(data?.artifacts)
      ? data.artifacts
      : null;
  return (
    Array.isArray(raw?.attachments) ||
    Array.isArray(nestedArtifacts) && nestedArtifacts.length > 0
  );
}

function actionBlob(action: ScenarioContext["actionsCalled"][number]): string {
  const parts = [action.actionName];
  if (action.parameters) parts.push(JSON.stringify(action.parameters));
  if (action.result?.data) parts.push(JSON.stringify(action.result.data));
  if (action.result?.values) parts.push(JSON.stringify(action.result.values));
  if (action.result?.text) parts.push(action.result.text);
  return parts.join(" | ").toLowerCase();
}

function actionDraftCandidate(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const values = toRecord(action.result?.values);
  const data = toRecord(action.result?.data);
  if (values?.draft === true || data?.draft === true) {
    return true;
  }
  if (data?.gmailDraft || data?.inboxDraft) {
    return true;
  }
  return false;
}

function actionDeliveredCandidate(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const blob = actionBlob(action);
  if (actionDraftCandidate(action)) {
    return false;
  }
  if (action.result?.success !== true) {
    return false;
  }
  return (
    /\bsent\b|\bdelivered\b|\bsending\b/.test(blob) ||
    /"status":"sent"|messageid|sid/.test(blob)
  );
}

function actionMatchesChannelExpectation(
  action: ScenarioContext["actionsCalled"][number],
  channels: string[],
): boolean {
  if (channels.length === 0) {
    return true;
  }
  const blob = actionBlob(action);
  return channels.some((channel) => blob.includes(channel.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

registerFinalCheckHandler("custom", async (check, { ctx }) => {
  const { predicate } = check as { predicate?: unknown };
  if (typeof predicate !== "function") {
    return { status: "failed", detail: "custom check missing predicate" };
  }
  const result = await (predicate as (c: ScenarioContext) => unknown)(ctx);
  if (result === undefined || result === null) {
    return { status: "passed", detail: "predicate returned undefined" };
  }
  return { status: "failed", detail: String(result) };
});

registerFinalCheckHandler("actionCalled", (check, { ctx }) => {
  const { actionName, status, minCount } = check as {
    actionName: string;
    status?: string;
    minCount?: number;
  };
  const calls = ctx.actionsCalled.filter((a) =>
    actionMatchesScenarioExpectation(a.actionName, [actionName]),
  );
  const min = typeof minCount === "number" ? minCount : 1;
  if (calls.length < min) {
    return {
      status: "failed",
      detail: `expected ${min} call(s) to ${actionName}, saw ${calls.length}. Called: ${ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"}`,
    };
  }
  if (status === "success") {
    const ok = calls.some((c) => c.result?.success === true);
    if (!ok) {
      return {
        status: "failed",
        detail: `${actionName} was called but none succeeded.`,
      };
    }
  }
  return { status: "passed", detail: `${actionName} called ${calls.length}x` };
});

registerFinalCheckHandler("selectedAction", (check, { ctx }) => {
  const { actionName } = check as { actionName: string | string[] };
  const accepted = toArray(actionName);
  const match = ctx.actionsCalled.find((a) =>
    actionMatchesScenarioExpectation(a.actionName, accepted),
  );
  if (!match) {
    return {
      status: "failed",
      detail: `no selected action in [${accepted.join(",")}]. Called: ${ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"}`,
    };
  }
  return { status: "passed", detail: `selected ${match.actionName}` };
});

registerFinalCheckHandler("selectedActionArguments", (check, { ctx }) => {
  const { actionName, includesAny, includesAll } = check as {
    actionName: string | string[];
    includesAny?: Array<string | RegExp>;
    includesAll?: Array<string | RegExp>;
  };
  const accepted = toArray(actionName);
  const matched = ctx.actionsCalled.filter((a) =>
    actionMatchesScenarioExpectation(a.actionName, accepted),
  );
  if (matched.length === 0) {
    return {
      status: "failed",
      detail: `no actions matched [${accepted.join(",")}]`,
    };
  }
  const blob = matched
    .map((m) => {
      const parts = [m.actionName];
      if (m.parameters) parts.push(JSON.stringify(m.parameters));
      if (m.result?.text) parts.push(m.result.text);
      return parts.join(" ");
    })
    .join(" | ");
  if (includesAll?.length) {
    for (const pattern of includesAll) {
      if (!matchesPattern(blob, pattern)) {
        return {
          status: "failed",
          detail: `arguments missing ${String(pattern)}. Blob: ${blob.slice(0, 300)}`,
        };
      }
    }
  }
  if (includesAny?.length) {
    const ok = includesAny.some((p) => matchesPattern(blob, p));
    if (!ok) {
      return {
        status: "failed",
        detail: `arguments missing any of [${includesAny.map(String).join(",")}]. Blob: ${blob.slice(0, 300)}`,
      };
    }
  }
  return { status: "passed", detail: "action arguments match" };
});

registerFinalCheckHandler("memoryWriteOccurred", (check, { ctx }) => {
  const { table, minCount } = check as {
    table: string | string[];
    minCount?: number;
  };
  const tables = toArray(table);
  const writes = ctx.memoryWrites ?? [];
  const matched = writes.filter((w) =>
    tables.length === 0 ? true : tables.includes(w.table),
  );
  const min = typeof minCount === "number" ? minCount : 1;
  if (matched.length < min) {
    return {
      status: "failed",
      detail: `expected ${min} write(s) to [${tables.join(",")}]; saw ${matched.length} of ${writes.length} total.`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} write(s) to [${tables.join(",")}]`,
  };
});

registerFinalCheckHandler(
  "approvalRequestExists",
  (check, { ctx }) => {
    if (ctx.approvalRequests === undefined) {
      return {
        status: "skipped-dependency-missing",
        detail: "no approval queue service registered",
      };
    }
    const { expected, actionName, state } = check as {
      expected?: boolean;
      actionName?: string | string[];
      state?: string | string[];
    };
    const filtered = ctx.approvalRequests.filter((request) => {
      if (!matchesActionName(request.actionName, actionName)) {
        return false;
      }
      if (state === undefined) {
        return true;
      }
      return toArray(state).includes(request.state);
    });
    const want = expected ?? true;
    const any = filtered.length > 0;
    if (any === want) {
      return {
        status: "passed",
        detail: `${filtered.length} matching approval request(s)`,
      };
    }
    if (!any) {
      return {
        status: "failed",
        detail: "approval queue registered but no matching requests were captured",
      };
    }
    return {
      status: "failed",
      detail: `expected approvalRequestExists=${want}, saw ${filtered.length} matching request(s)`,
    };
  },
);

registerFinalCheckHandler("approvalStateTransition", (check, { ctx }) => {
  const { from, to, actionName } = check as {
    from: string;
    to: string;
    actionName?: string | string[];
  };
  const matched = (ctx.stateTransitions ?? []).filter((transition) => {
    if (transition.subject !== "approval") {
      return false;
    }
    if (transition.from !== from || transition.to !== to) {
      return false;
    }
    return matchesActionName(transition.actionName ?? "", actionName);
  });
  if (matched.length > 0) {
    return {
      status: "passed",
      detail: `approval transition ${from}->${to} captured ${matched.length}x`,
    };
  }
  return {
    status: "failed",
    detail: `expected approval transition ${from}->${to} but saw ${(ctx.stateTransitions ?? []).length} total transition(s)`,
  };
});

registerFinalCheckHandler("pushSent", (check, { ctx }) => {
  if (ctx.connectorDispatches === undefined) {
    return {
      status: "skipped-dependency-missing",
      detail: "no connector dispatcher registered",
    };
  }
  const { channel } = check as { channel: string | string[] };
  const channels = toArray(channel);
  const hit = ctx.connectorDispatches.filter((d) =>
    channels.includes(d.channel),
  );
  if (hit.length === 0) {
    return {
      status: "failed",
      detail: `no push sent on [${channels.join(",")}]`,
    };
  }
  return { status: "passed", detail: `${hit.length} push(es)` };
});

registerFinalCheckHandler("pushEscalationOrder", (check, { ctx }) => {
  const { channelOrder } = check as { channelOrder: string[] };
  const seen = (ctx.connectorDispatches ?? [])
    .filter((dispatch) => dispatch.delivered !== false)
    .map((dispatch) => dispatch.channel);
  let cursor = 0;
  for (const channel of seen) {
    if (channel === channelOrder[cursor]) {
      cursor += 1;
      if (cursor === channelOrder.length) {
        break;
      }
    }
  }
  if (cursor === channelOrder.length) {
    return {
      status: "passed",
      detail: `push order matched [${channelOrder.join(" -> ")}]`,
    };
  }
  return {
    status: "failed",
    detail: `expected push order [${channelOrder.join(" -> ")}], saw [${seen.join(" -> ") || "(none)"}]`,
  };
});

registerFinalCheckHandler("pushAcknowledgedSync", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    ctx.actionsCalled.some((action) => {
      if (action.actionName !== "INTENT_SYNC") {
        return false;
      }
      const blob = actionBlob(action);
      return action.result?.success === true && blob.includes("acknowledge");
    }) ||
    (ctx.stateTransitions ?? []).some(
      (transition) =>
        transition.subject === "intent" && transition.to === "acknowledged",
    );
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `pushAcknowledgedSync=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected pushAcknowledgedSync=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("clarificationRequested", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const expectedValue = expected ?? true;
  const anyClarify = ctx.actionsCalled.some(
    (a) =>
      /clarif/i.test(a.actionName) ||
      (typeof a.result?.text === "string" && /clarif/i.test(a.result.text)),
  );
  if (anyClarify === expectedValue) {
    return {
      status: "passed",
      detail: `clarification ${expectedValue ? "requested" : "absent"}`,
    };
  }
  return {
    status: "failed",
    detail: `expected clarificationRequested=${expectedValue}, saw ${anyClarify}`,
  };
});

registerFinalCheckHandler("interventionRequestExists", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const want = expected ?? true;
  const any = (ctx.stateTransitions ?? []).some(
    (t) => t.subject === "intervention",
  );
  if (any === want) {
    return {
      status: "passed",
      detail: `intervention=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected interventionRequestExists=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("draftExists", (check, { ctx }) => {
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const channels = toArray(channel);
  const any = ctx.actionsCalled.some(
    (action) =>
      actionDraftCandidate(action) &&
      actionMatchesChannelExpectation(action, channels),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `draftExists=${want}` };
  }
  return {
    status: "failed",
    detail: `expected draftExists=${want} for [${channels.join(",") || "*"}], saw ${any}`,
  };
});

registerFinalCheckHandler("messageDelivered", (check, { ctx }) => {
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const channels = toArray(channel);
  const dispatchDelivered = (ctx.connectorDispatches ?? []).some((dispatch) => {
    if (dispatch.delivered !== true) {
      return false;
    }
    return channels.length === 0 || channels.includes(dispatch.channel);
  });
  const actionDelivered = ctx.actionsCalled.some(
    (action) =>
      actionDeliveredCandidate(action) &&
      actionMatchesChannelExpectation(action, channels),
  );
  const any = dispatchDelivered || actionDelivered;
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `messageDelivered=${want}` };
  }
  return {
    status: "failed",
    detail: `expected messageDelivered=${want} for [${channels.join(",") || "*"}], saw ${any}`,
  };
});

registerFinalCheckHandler("connectorDispatchOccurred", (check, { ctx }) => {
  const { channel, actionName, minCount } = check as {
    channel: string | string[];
    actionName?: string | string[];
    minCount?: number;
  };
  const channels = toArray(channel);
  const matchedDispatches = (ctx.connectorDispatches ?? []).filter((dispatch) => {
    if (channels.length > 0 && !channels.includes(dispatch.channel)) {
      return false;
    }
    return matchesActionName(dispatch.actionName ?? "", actionName);
  });
  const matchedActions = ctx.actionsCalled.filter(
    (action) =>
      actionMatchesChannelExpectation(action, channels) &&
      matchesActionName(action.actionName, actionName) &&
      actionDeliveredCandidate(action),
  );
  const count = matchedDispatches.length + matchedActions.length;
  const want = typeof minCount === "number" ? minCount : 1;
  if (count >= want) {
    return {
      status: "passed",
      detail: `connector dispatch matched ${count}x on [${channels.join(",") || "*"}]`,
    };
  }
  return {
    status: "failed",
    detail: `expected at least ${want} connector dispatch(es) on [${channels.join(",") || "*"}], saw ${count}`,
  };
});

registerFinalCheckHandler("noSideEffectOnReject", (check, { ctx }) => {
  const { actionName } = check as { actionName: string | string[] };
  const matchingActions = ctx.actionsCalled.filter((action) =>
    matchesActionName(action.actionName, actionName),
  );
  const rejected = matchingActions.some((action) => {
    const params = toRecord(action.parameters);
    return params?.confirmed === false;
  });
  if (!rejected) {
    return {
      status: "failed",
      detail: `no rejected action found for [${toArray(actionName).join(",")}]`,
    };
  }
  const completed = matchingActions.some((action) =>
    hasBrowserTaskCompletedValue(action.result?.data) ||
    hasBrowserTaskCompletedValue(action.result?.raw),
  );
  const artifacts = matchingActions.some((action) => actionArtifactsPresent(action));
  if (completed || artifacts) {
    return {
      status: "failed",
      detail: "reject path still produced a completion or artifact side effect",
    };
  }
  return {
    status: "passed",
    detail: "reject path produced no completion or artifact side effects",
  };
});

registerFinalCheckHandler("browserTaskCompleted", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    ctx.actionsCalled.some(
      (action) =>
        hasBrowserTaskCompletedValue(action.result?.data) ||
        hasBrowserTaskCompletedValue(action.result?.raw),
    ) ||
    (ctx.stateTransitions ?? []).some(
      (transition) =>
        transition.subject === "browser_task" && transition.to === "completed",
    );
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `browserTaskCompleted=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected browserTaskCompleted=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("browserTaskNeedsHuman", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    ctx.actionsCalled.some(
      (action) =>
        hasBrowserTaskNeedsHumanValue(action.result?.data) ||
        hasBrowserTaskNeedsHumanValue(action.result?.raw),
    ) ||
    (ctx.stateTransitions ?? []).some(
      (transition) =>
        transition.subject === "browser_task" && transition.to === "needs_human",
    );
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `browserTaskNeedsHuman=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected browserTaskNeedsHuman=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("uploadedAssetExists", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    (ctx.artifacts ?? []).length > 0 ||
    ctx.actionsCalled.some((action) => actionArtifactsPresent(action));
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `uploadedAssetExists=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected uploadedAssetExists=${want}, saw ${any}`,
  };
});

// judgeRubric is handled inline by the executor so it can reuse the live LLM
// without threading the runtime through the generic handler registry.
registerFinalCheckHandler("judgeRubric", () => ({
  status: "passed",
  detail: "deferred to executor (inline judge pass)",
}));

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runFinalCheck(
  check: ScenarioFinalCheck,
  handlerCtx: FinalCheckHandlerContext,
): Promise<FinalCheckReport> {
  const type = (check as { type?: string }).type ?? "unknown";
  const name = (check as { name?: string }).name ?? type;
  const handler = HANDLERS.get(type);
  if (!handler) {
    return {
      label: name,
      type,
      status: "unknown-kind" satisfies FinalCheckStatus,
      detail: `no handler registered for type "${type}" — check skipped (not a failure)`,
    };
  }
  const outcome = await handler(check, handlerCtx);
  return {
    label: name,
    type,
    status: outcome.status,
    detail: outcome.detail,
  };
}
