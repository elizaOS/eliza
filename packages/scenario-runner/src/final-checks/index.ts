/**
 * Registry of finalCheck handlers keyed by the discriminator string from
 * `ScenarioFinalCheck.type`. Unknown kinds fail loudly so scenario proof fields
 * cannot be misspelled or silently skipped.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { isLoopbackUrl, toRecord } from "../utils.js";
import {
  FINAL_CHECK_KEYS,
  type ScenarioContext,
  type ScenarioFinalCheck,
} from "@elizaos/scenario-schema";
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
  return toArray(accepted).includes(value);
}

function normalizeChannel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function matchesChannel(
  value: string | undefined,
  accepted: string | string[] | undefined,
): boolean {
  if (accepted === undefined) {
    return true;
  }
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const normalizedValue = normalizeChannel(value);
  return toArray(accepted).some(
    (candidate) => normalizeChannel(candidate) === normalizedValue,
  );
}

function actionParameters(
  action: ScenarioContext["actionsCalled"][number],
): Record<string, unknown> | null {
  const params = toRecord(action.parameters);
  return toRecord(params?.parameters) ?? params;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((candidate) => valuesEqual(actual, candidate));
  }
  if (Array.isArray(actual)) {
    return actual.some((candidate) => valuesEqual(candidate, expected));
  }
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const actualRecord = toRecord(actual);
    const expectedRecord = toRecord(expected);
    if (!actualRecord || !expectedRecord) {
      return false;
    }
    return Object.entries(expectedRecord).every(([key, value]) =>
      valuesEqual(actualRecord[key], value),
    );
  }
  return actual === expected;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    const record = toRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function matchesExpectedFields(
  value: unknown,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  return Object.entries(expected).every(([path, expectedValue]) =>
    valuesEqual(readPath(value, path), expectedValue),
  );
}


type GmailMockRequest = {
  environment?: string;
  method?: string;
  path?: string;
  query?: string;
  body?: unknown;
  createdAt?: string;
};

async function readGmailMockRequests(): Promise<GmailMockRequest[]> {
  const base = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (!isLoopbackUrl(base)) {
    throw new Error(
      "ELIZA_MOCK_GOOGLE_BASE must be a loopback URL for Gmail ledger checks",
    );
  }
  const response = await fetch(`${base}/__mock/requests`);
  if (!response.ok) {
    throw new Error(
      `Gmail mock request ledger returned HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { requests?: unknown };
  return Array.isArray(body.requests)
    ? body.requests.filter(
        (entry): entry is GmailMockRequest =>
          Boolean(entry) && typeof entry === "object",
      )
    : [];
}

function gmailRequestMatches(
  entry: GmailMockRequest,
  filters: {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
  },
): boolean {
  if (
    filters.method !== undefined &&
    !toArray(filters.method).includes(String(entry.method ?? "").toUpperCase())
  ) {
    return false;
  }
  if (
    filters.path !== undefined &&
    !toArray(filters.path).includes(String(entry.path ?? ""))
  ) {
    return false;
  }
  return matchesExpectedFields(entry.body, filters.body);
}

function gmailSendLedgerPaths(): string[] {
  return ["/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/drafts/send"];
}

function hasGmailDraftData(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const data = actionResultData(action);
  return Boolean(data?.gmailDraft);
}

function hasConfirmedGmailSendAction(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const acceptedNames = new Set([
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
    "GMAIL_ACTION",
    "INBOX",
  ]);
  if (!acceptedNames.has(action.actionName)) {
    return false;
  }
  const params = actionParameters(action);
  return (
    params?.confirmed === true ||
    readPath(params, "details.confirmSend") === true
  );
}

function hasRecursiveObjectMatch(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): boolean {
  const record = toRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      return value.some((entry) => hasRecursiveObjectMatch(entry, predicate));
    }
    return false;
  }
  if (predicate(record)) {
    return true;
  }
  return Object.values(record).some((entry) =>
    hasRecursiveObjectMatch(entry, predicate),
  );
}

function actionResultData(
  action: ScenarioContext["actionsCalled"][number],
): Record<string, unknown> | null {
  return toRecord(action.result?.data) ?? toRecord(action.result?.raw);
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

function actionArtifactsPresent(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
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
    (Array.isArray(nestedArtifacts) && nestedArtifacts.length > 0)
  );
}

function actionBlob(action: ScenarioContext["actionsCalled"][number]): string {
  const parts = [action.actionName];
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
  if (action.result?.message) {
    parts.push(action.result.message);
  }
  if (action.error?.message) {
    parts.push(action.error.message);
  }
  return parts.join(" ").toLowerCase();
}

function actionMatchesChannel(
  action: ScenarioContext["actionsCalled"][number],
  channel: string,
): boolean {
  const blob = actionBlob(action);
  if (blob.includes(channel.toLowerCase())) {
    return true;
  }
  switch (channel) {
    case "gmail":
      return [
        "MESSAGE",
        "MESSAGE",
        "MESSAGE",
      ].includes(action.actionName);
    case "discord":
    case "telegram":
    case "signal":
    case "imessage":
    case "whatsapp":
    case "sms":
      return [
        "MESSAGE",
        "MESSAGE",
        "MESSAGE",
      ].includes(action.actionName);
    case "x-dm":
      return [
        "X",
        "MESSAGE",
        "MESSAGE",
      ].includes(action.actionName);
    case "desktop":
    case "mobile":
    case "phone_call":
      return ["VOICE_CALL"].includes(action.actionName);
    default:
      return false;
  }
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
  const calls = ctx.actionsCalled.filter((a) => a.actionName === actionName);
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
  const match = ctx.actionsCalled.find((a) => accepted.includes(a.actionName));
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
    accepted.includes(a.actionName),
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

registerFinalCheckHandler("approvalRequestExists", (check, { ctx }) => {
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
      detail:
        "approval queue registered but no matching requests were captured",
    };
  }
  return {
    status: "failed",
    detail: `expected approvalRequestExists=${want}, saw ${filtered.length} matching request(s)`,
  };
});

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
  if (matched.length === 0) {
    return {
      status: "failed",
      detail: `expected approval transition ${from}->${to}; saw ${(ctx.stateTransitions ?? []).length} transition(s)`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} matching approval transition(s)`,
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
  const seen = (ctx.connectorDispatches ?? []).map(
    (dispatch) => dispatch.channel,
  );
  let cursor = 0;
  for (const channel of channelOrder) {
    const index = seen.indexOf(channel, cursor);
    if (index === -1) {
      return {
        status: "failed",
        detail: `expected push escalation order [${channelOrder.join(",")}], saw [${seen.join(",")}]`,
      };
    }
    cursor = index + 1;
  }
  return {
    status: "passed",
    detail: `push escalation order matched [${channelOrder.join(",")}]`,
  };
});

registerFinalCheckHandler("pushAcknowledgedSync", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any = ctx.actionsCalled.some((action) => {
    const blob = actionBlob(action);
    return /acknowledge/.test(blob) && /sync/.test(blob);
  });
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `pushAcknowledgedSync=${want}` };
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
  const completed = matchingActions.some(
    (action) =>
      hasBrowserTaskCompletedValue(action.result?.data) ||
      hasBrowserTaskCompletedValue(action.result?.raw),
  );
  const artifacts = matchingActions.some((action) =>
    actionArtifactsPresent(action),
  );
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
        transition.subject === "browser_task" &&
        transition.to === "needs_human",
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

registerFinalCheckHandler("draftExists", (check, { ctx }) => {
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const any = ctx.actionsCalled.some((action) => {
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    if (data.gmailDraft && matchesChannel("gmail", channel)) {
      return true;
    }
    return (
      data.draft === true &&
      matchesChannel(data.channel as string | undefined, channel)
    );
  });
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `draftExists=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected draftExists=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("messageDelivered", (check, { ctx }) => {
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const dispatchDelivered = (ctx.connectorDispatches ?? []).some(
    (dispatch) =>
      dispatch.delivered === true && matchesChannel(dispatch.channel, channel),
  );
  const actionDelivered = ctx.actionsCalled.some((action) => {
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    const status = typeof data.status === "string" ? data.status : "";
    return (
      matchesChannel(data.channel as string | undefined, channel) &&
      ["sent", "delivered", "completed"].includes(status.toLowerCase())
    );
  });
  const any = dispatchDelivered || actionDelivered;
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `messageDelivered=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected messageDelivered=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("connectorDispatchOccurred", (check, { ctx }) => {
  const { channel, actionName, minCount } = check as {
    channel: string | string[];
    actionName?: string | string[];
    minCount?: number;
  };
  const dispatchCount = (ctx.connectorDispatches ?? []).filter((dispatch) =>
    matchesChannel(dispatch.channel, channel),
  ).length;
  const actionFallbackCount = ctx.actionsCalled.filter((action) => {
    if (!matchesActionName(action.actionName, actionName)) {
      return false;
    }
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    const status = typeof data.status === "string" ? data.status : "";
    return (
      matchesChannel(data.channel as string | undefined, channel) &&
      ["sent", "delivered", "completed"].includes(status.toLowerCase())
    );
  }).length;
  const total = dispatchCount + actionFallbackCount;
  const want = typeof minCount === "number" ? minCount : 1;
  if (total < want) {
    return {
      status: "failed",
      detail: `expected ${want} connector dispatch(es) on [${toArray(channel).join(",")}], saw ${total}`,
    };
  }
  return {
    status: "passed",
    detail: `${total} connector dispatch(es) on [${toArray(channel).join(",")}]`,
  };
});

registerFinalCheckHandler("gmailActionArguments", (check, { ctx }) => {
  const { actionName, subaction, operation, fields, minCount } = check as {
    actionName?: string | string[];
    subaction?: string | string[];
    operation?: string | string[];
    fields?: Record<string, unknown>;
    minCount?: number;
  };
  const actionNames = actionName ?? [
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
    "MESSAGE",
    "GMAIL_ACTION",
    "INBOX",
  ];
  const matched = ctx.actionsCalled.filter((action) => {
    if (!matchesActionName(action.actionName, actionNames)) {
      return false;
    }
    const params = actionParameters(action);
    if (!params) {
      return false;
    }
    if (
      subaction !== undefined &&
      !toArray(subaction).includes(String(params.subaction ?? ""))
    ) {
      return false;
    }
    const actualOperation =
      params.operation ?? readPath(params, "details.operation");
    if (
      operation !== undefined &&
      !toArray(operation).includes(String(actualOperation ?? ""))
    ) {
      return false;
    }
    return matchesExpectedFields(params, fields);
  });
  const want = typeof minCount === "number" ? minCount : 1;
  if (matched.length < want) {
    return {
      status: "failed",
      detail: `expected ${want} Gmail action(s) with structured arguments; saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} Gmail action(s) matched structured arguments`,
  };
});

registerFinalCheckHandler("gmailMockRequest", async (check) => {
  const { method, path, body, expected, minCount } = check as {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
    expected?: boolean;
    minCount?: number;
  };
  const requests = await readGmailMockRequests();
  const matched = requests.filter((entry) =>
    gmailRequestMatches(entry, { method, path, body }),
  );
  const wantPresent = expected ?? true;
  const wantCount = typeof minCount === "number" ? minCount : 1;
  if (wantPresent) {
    if (matched.length < wantCount) {
      return {
        status: "failed",
        detail: `expected ${wantCount} Gmail mock request(s), saw ${matched.length} of ${requests.length}`,
      };
    }
    return {
      status: "passed",
      detail: `${matched.length} Gmail mock request(s) matched`,
    };
  }
  if (matched.length > 0) {
    return {
      status: "failed",
      detail: `expected no Gmail mock request match, saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: "no matching Gmail mock request observed",
  };
});

registerFinalCheckHandler("gmailDraftCreated", async (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
  const ledgerHit = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
    }),
  );
  const actionHit = ctx.actionsCalled.some((action) =>
    hasGmailDraftData(action),
  );
  const any = ledgerHit || actionHit;
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailDraftCreated=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailDraftCreated=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailDraftDeleted", async (check) => {
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
  const any = requests.some(
    (entry) =>
      String(entry.method ?? "").toUpperCase() === "DELETE" &&
      /^\/gmail\/v1\/users\/me\/drafts\/[^/]+$/.test(String(entry.path ?? "")),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailDraftDeleted=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailDraftDeleted=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailMessageSent", async (check) => {
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
  const any = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: gmailSendLedgerPaths(),
    }),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailMessageSent=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailMessageSent=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailBatchModify", async (check) => {
  const { expected, body } = check as {
    expected?: boolean;
    body?: Record<string, unknown>;
  };
  const requests = await readGmailMockRequests();
  const any = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/messages/batchModify",
      body,
    }),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailBatchModify=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailBatchModify=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailApproval", async (check, { ctx }) => {
  const { state } = check as {
    state: "pending" | "confirmed" | "canceled" | "cancelled";
  };
  if (state === "pending") {
    const any =
      (ctx.approvalRequests ?? []).some(
        (request) =>
          matchesActionName(request.actionName, [
            "MESSAGE",
            "MESSAGE",
            "MESSAGE",
            "GMAIL_ACTION",
            "send_email",
          ]) && request.state === "pending",
      ) ||
      ctx.actionsCalled.some((action) => {
        const data = actionResultData(action);
        return (
          data?.pendingApproval === true || data?.requiresConfirmation === true
        );
      });
    return any
      ? { status: "passed", detail: "pending Gmail approval observed" }
      : { status: "failed", detail: "no pending Gmail approval observed" };
  }
  if (state === "confirmed") {
    const requests = await readGmailMockRequests();
    const sendHit = requests.some((entry) =>
      gmailRequestMatches(entry, {
        method: "POST",
        path: gmailSendLedgerPaths(),
      }),
    );
    const actionHit = ctx.actionsCalled.some((action) =>
      hasConfirmedGmailSendAction(action),
    );
    return sendHit || actionHit
      ? { status: "passed", detail: "confirmed Gmail send observed" }
      : { status: "failed", detail: "no confirmed Gmail send observed" };
  }
  const canceled = ctx.actionsCalled.some((action) => {
    const data = actionResultData(action);
    return data?.noop === true && data?.cancelled === true;
  });
  return canceled
    ? { status: "passed", detail: "canceled Gmail approval observed" }
    : { status: "failed", detail: "no canceled Gmail approval observed" };
});

registerFinalCheckHandler("gmailNoRealWrite", () => {
  if (!isLoopbackUrl(process.env.ELIZA_MOCK_GOOGLE_BASE)) {
    return {
      status: "failed",
      detail:
        "ELIZA_MOCK_GOOGLE_BASE is not loopback; Gmail write proof cannot exclude real writes",
    };
  }
  if (process.env.ELIZA_ALLOW_REAL_GMAIL_WRITES === "1") {
    return {
      status: "failed",
      detail: "ELIZA_ALLOW_REAL_GMAIL_WRITES=1 disables no-real-write proof",
    };
  }
  return {
    status: "passed",
    detail: "Gmail writes are constrained to the loopback mock base",
  };
});

registerFinalCheckHandler("n8nDispatchOccurred", (check, { ctx }) => {
  const { workflowId, expected, minCount } = check as {
    workflowId?: string;
    expected?: boolean;
    minCount?: number;
  };
  const matchedActions = ctx.actionsCalled.filter((action) =>
    hasRecursiveObjectMatch(
      action.result?.data ?? action.result?.raw,
      (record) => {
        if (record.kind !== "dispatch_workflow") {
          return false;
        }
        return workflowId === undefined || record.workflowId === workflowId;
      },
    ),
  );
  const matchedWrites = (ctx.memoryWrites ?? []).filter((write) =>
    hasRecursiveObjectMatch(write.content, (record) => {
      if (record.kind !== "dispatch_workflow") {
        return false;
      }
      return workflowId === undefined || record.workflowId === workflowId;
    }),
  );
  const total = matchedActions.length + matchedWrites.length;
  const want = expected ?? true;
  if (!want) {
    return total === 0
      ? { status: "passed", detail: "no workflow dispatch observed" }
      : {
          status: "failed",
          detail: `expected no workflow dispatch, saw ${total}`,
        };
  }
  const min = typeof minCount === "number" ? minCount : 1;
  if (total < min) {
    return {
      status: "failed",
      detail: `expected ${min} workflow dispatch record(s), saw ${total}`,
    };
  }
  return {
    status: "passed",
    detail: `${total} workflow dispatch record(s) observed`,
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
      status: "failed" satisfies FinalCheckStatus,
      detail: `no handler registered for finalCheck type "${type}"`,
    };
  }
  const strictKeys = FINAL_CHECK_KEYS.get(type);
  if (strictKeys) {
    const unknownKeys = Object.keys(check as Record<string, unknown>).filter(
      (key) => !strictKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      return {
        label: name,
        type,
        status: "failed",
        detail: `unknown field(s) for finalCheck type "${type}": ${unknownKeys.join(", ")}`,
      };
    }
  }
  const outcome = await handler(check, handlerCtx);
  return {
    label: name,
    type,
    status: outcome.status,
    detail: outcome.detail,
  };
}
