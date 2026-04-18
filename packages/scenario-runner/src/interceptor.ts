/**
 * Action + memory-write interceptor. Wraps registered actions' handlers to
 * capture actionName/parameters/result/error into `CapturedAction` records
 * for per-turn and per-scenario assertions. Also wraps `runtime.createMemory`
 * to populate `memoryWrites` on the scenario context.
 *
 * The wrapping is idempotent and per-runtime: re-attaching the interceptor
 * to the same runtime is a no-op.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  Task,
} from "@elizaos/core";
import type {
  CapturedAction,
  CapturedApprovalRequest,
  CapturedArtifact,
  CapturedConnectorDispatch,
  CapturedStateTransition,
  CapturedMemoryWrite,
} from "@elizaos/scenario-schema";

const INTERCEPTOR_MARKER = Symbol.for("scenario-runner.interceptor-wrapped");

interface WrappedHandler {
  (...args: unknown[]): Promise<unknown>;
  [INTERCEPTOR_MARKER]?: true;
}

export interface ActionInterceptor {
  readonly actions: CapturedAction[];
  readonly approvalRequests: CapturedApprovalRequest[];
  readonly connectorDispatches: CapturedConnectorDispatch[];
  readonly memoryWrites: CapturedMemoryWrite[];
  readonly artifacts: CapturedArtifact[];
  readonly stateTransitions: CapturedStateTransition[];
  reset(): void;
  detach(): void;
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function captureArtifact(
  artifacts: CapturedArtifact[],
  artifact: CapturedArtifact,
): void {
  artifacts.push({
    ...artifact,
    createdAt: artifact.createdAt ?? new Date().toISOString(),
  });
}

function captureArtifactsFromValue(
  artifacts: CapturedArtifact[],
  actionName: string,
  source: string,
  value: unknown,
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.screenshot === "string" && record.screenshot.length > 0) {
    captureArtifact(artifacts, {
      source,
      actionName,
      kind: "screenshot",
      detail: `screenshot:${record.screenshot.length}`,
    });
  }
  if (
    typeof record.frontendScreenshot === "string" &&
    record.frontendScreenshot.length > 0
  ) {
    captureArtifact(artifacts, {
      source,
      actionName,
      kind: "frontend_screenshot",
      detail: `frontendScreenshot:${record.frontendScreenshot.length}`,
    });
  }
  if (typeof record.path === "string" && record.path.length > 0) {
    captureArtifact(artifacts, {
      source,
      actionName,
      kind: "file_path",
      detail: record.path,
    });
  }
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const item = attachment as Record<string, unknown>;
      captureArtifact(artifacts, {
        source,
        actionName,
        kind:
          typeof item.kind === "string"
            ? item.kind
            : typeof item.type === "string"
              ? item.type
              : "attachment",
        label:
          typeof item.label === "string"
            ? item.label
            : typeof item.name === "string"
              ? item.name
              : undefined,
        detail:
          typeof item.path === "string"
            ? item.path
            : typeof item.url === "string"
              ? item.url
              : undefined,
        data: item,
      });
    }
  }
  const nestedData =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const nestedArtifacts = nestedData?.artifacts;
  if (Array.isArray(nestedArtifacts)) {
    for (const artifact of nestedArtifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const item = artifact as Record<string, unknown>;
      captureArtifact(artifacts, {
        source,
        actionName,
        kind:
          typeof item.kind === "string" ? item.kind : "artifact",
        label: typeof item.label === "string" ? item.label : undefined,
        detail: typeof item.detail === "string" ? item.detail : undefined,
        data: item,
      });
    }
  }
}

function captureStateTransitionsFromValue(
  stateTransitions: CapturedStateTransition[],
  actionName: string,
  value: unknown,
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : null;
  const browserTask =
    data?.browserTask &&
    typeof data.browserTask === "object" &&
    !Array.isArray(data.browserTask)
      ? (data.browserTask as Record<string, unknown>)
      : null;

  if (browserTask?.completed === true) {
    stateTransitions.push({
      subject: "browser-task",
      to: "completed",
      actionName,
      at: new Date().toISOString(),
    });
  }
  if (browserTask?.needsHuman === true) {
    stateTransitions.push({
      subject: "browser-task",
      to: "needs-human",
      actionName,
      at: new Date().toISOString(),
    });
    stateTransitions.push({
      subject: "intervention",
      to: "requested",
      actionName,
      at: new Date().toISOString(),
    });
  }
  if (data?.interventionRequest) {
    stateTransitions.push({
      subject: "intervention",
      to: "requested",
      actionName,
      at: new Date().toISOString(),
    });
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferApprovalRequest(
  taskId: string,
  task: Task,
): CapturedApprovalRequest | null {
  const tags = Array.isArray(task.tags)
    ? task.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const metadata = toRecord(task.metadata);
  const approvalMetadata = toRecord(metadata?.approvalRequest);
  const isApprovalTask =
    approvalMetadata !== null ||
    tags.includes("APPROVAL") ||
    tags.includes("AWAITING_CHOICE");

  if (!isApprovalTask) {
    return null;
  }

  const payload =
    metadata?.payload !== undefined ? metadata.payload : approvalMetadata;
  const channel =
    typeof metadata?.channel === "string"
      ? metadata.channel
      : typeof approvalMetadata?.channel === "string"
        ? approvalMetadata.channel
        : undefined;
  const actionName =
    typeof metadata?.actionName === "string"
      ? metadata.actionName
      : typeof metadata?.action === "string"
        ? metadata.action
        : typeof task.name === "string" && task.name.length > 0
          ? task.name
          : "APPROVAL";

  return {
    id: taskId,
    state: "pending",
    actionName,
    source:
      typeof task.name === "string" && task.name.length > 0
        ? task.name
        : undefined,
    channel,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function captureConnectorDispatchesFromAction(
  connectorDispatches: CapturedConnectorDispatch[],
  actionName: string,
  parameters: unknown,
  result: unknown,
): void {
  const paramsRecord = toRecord(parameters);
  const params = toRecord(paramsRecord?.parameters) ?? paramsRecord;
  const resultRecord = toRecord(result);
  const resultData = toRecord(resultRecord?.data);
  const delivered =
    typeof resultRecord?.success === "boolean" ? resultRecord.success : true;
  const blob = [
    JSON.stringify(params ?? {}),
    JSON.stringify(resultData ?? {}),
    typeof resultRecord?.text === "string" ? resultRecord.text : "",
    typeof resultRecord?.message === "string" ? resultRecord.message : "",
  ]
    .join(" ")
    .toLowerCase();

  const push = (channel: string, payload: unknown) => {
    connectorDispatches.push({
      channel,
      actionName,
      payload,
      delivered,
      sentAt: new Date().toISOString(),
    });
  };

  if (actionName === "CROSS_CHANNEL_SEND") {
    const channels = [
      ...toStringArray(params?.channel),
      ...toStringArray(resultData?.channel),
      ...toStringArray(resultData?.channels),
    ];
    for (const channel of new Set(channels)) {
      push(channel, params ?? resultData ?? {});
    }
    return;
  }

  if (actionName === "PUBLISH_DEVICE_INTENT" || actionName === "INTENT_SYNC") {
    const channels = [
      ...toStringArray(params?.channel),
      ...toStringArray(params?.channels),
      ...toStringArray(resultData?.channel),
      ...toStringArray(resultData?.channels),
    ];
    for (const inferred of ["desktop", "mobile", "phone_call", "sms"]) {
      if (blob.includes(inferred)) {
        channels.push(inferred);
      }
    }
    for (const channel of new Set(channels)) {
      push(channel, params ?? resultData ?? {});
    }
    return;
  }

  if (actionName === "CALL_USER" || actionName === "CALL_EXTERNAL") {
    const channel = blob.includes("sms") ? "sms" : "phone_call";
    push(channel, params ?? resultData ?? {});
  }
}

export function attachInterceptor(runtime: IAgentRuntime): ActionInterceptor {
  const actions: CapturedAction[] = [];
  const approvalRequests: CapturedApprovalRequest[] = [];
  const connectorDispatches: CapturedConnectorDispatch[] = [];
  const memoryWrites: CapturedMemoryWrite[] = [];
  const artifacts: CapturedArtifact[] = [];
  const stateTransitions: CapturedStateTransition[] = [];

  // Wrap actions registered on this runtime.
  const restoreFns: Array<() => void> = [];

  const actionList = (runtime as { actions?: Action[] }).actions ?? [];
  for (const action of actionList) {
    const original = action.handler;
    if (!isCallable(original)) continue;
    const alreadyWrapped = (original as WrappedHandler)[INTERCEPTOR_MARKER];
    if (alreadyWrapped) continue;

    const wrapped: WrappedHandler = async (
      ...args: unknown[]
    ): Promise<unknown> => {
      const [_rt, _message, _state, options, callback] = args as [
        IAgentRuntime,
        Memory,
        State | undefined,
        Record<string, unknown> | undefined,
        HandlerCallback | undefined,
      ];
      const entry: CapturedAction = {
        actionName: action.name,
        parameters: options,
      };
      const wrappedArgs = [...args];
      if (isCallable(callback)) {
        wrappedArgs[4] = (async (...callbackArgs: unknown[]) => {
          const [content] = callbackArgs;
          captureArtifactsFromValue(
            artifacts,
            action.name,
            "callback",
            content,
          );
          return (callback as (...inner: unknown[]) => unknown)(...callbackArgs);
        }) as HandlerCallback;
      }
      try {
        const result = (await (
          original as (...inner: unknown[]) => unknown
        ).apply(action, wrappedArgs)) as unknown;
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          entry.result = {
            success:
              typeof r.success === "boolean" ? r.success : undefined,
            data: r.data,
            values: r.values,
            text: typeof r.text === "string" ? r.text : undefined,
            message: typeof r.message === "string" ? r.message : undefined,
            error: typeof r.error === "string" ? r.error : undefined,
            screenshot:
              typeof r.screenshot === "string" ? r.screenshot : undefined,
            frontendScreenshot:
              typeof r.frontendScreenshot === "string"
                ? r.frontendScreenshot
                : undefined,
            path: typeof r.path === "string" ? r.path : undefined,
            exists: typeof r.exists === "boolean" ? r.exists : undefined,
            raw: r,
          };
          captureArtifactsFromValue(artifacts, action.name, "result", r);
          captureStateTransitionsFromValue(stateTransitions, action.name, r);
          captureConnectorDispatchesFromAction(
            connectorDispatches,
            action.name,
            options,
            r,
          );
        } else {
          entry.result = { success: true };
        }
        actions.push(entry);
        return result;
      } catch (err) {
        entry.error = { message: errorMessage(err) };
        entry.result = { success: false };
        actions.push(entry);
        throw err;
      }
    };
    wrapped[INTERCEPTOR_MARKER] = true;

    action.handler = wrapped as unknown as Action["handler"];
    restoreFns.push(() => {
      action.handler = original;
    });
  }

  // Wrap createMemory (adapter-backed) so memory-write assertions work.
  type CreateMemoryFn = (
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ) => Promise<unknown>;

  const rt = runtime as unknown as {
    createMemory?: CreateMemoryFn;
    [k: string]: unknown;
  };
  if (isCallable(rt.createMemory)) {
    const originalCreateMemory = rt.createMemory as CreateMemoryFn & {
      [INTERCEPTOR_MARKER]?: true;
    };
    if (!originalCreateMemory[INTERCEPTOR_MARKER]) {
      const wrappedCreate: CreateMemoryFn & {
        [INTERCEPTOR_MARKER]?: true;
      } = async (memory: Memory, tableName: string, unique?: boolean) => {
        memoryWrites.push({
          table: tableName,
          entityId:
            typeof memory.entityId === "string" ? memory.entityId : undefined,
          roomId: typeof memory.roomId === "string" ? memory.roomId : undefined,
          worldId:
            typeof memory.worldId === "string" ? memory.worldId : undefined,
          content: memory.content,
          createdAt: new Date().toISOString(),
        });
        return originalCreateMemory.call(rt, memory, tableName, unique);
      };
      wrappedCreate[INTERCEPTOR_MARKER] = true;
      rt.createMemory = wrappedCreate;
      restoreFns.push(() => {
        rt.createMemory = originalCreateMemory;
      });
    }
  }

  type CreateTaskFn = (task: Task) => Promise<unknown>;
  if (isCallable((rt as { createTask?: CreateTaskFn }).createTask)) {
    const originalCreateTask = (rt as { createTask: CreateTaskFn }).createTask as
      CreateTaskFn & {
        [INTERCEPTOR_MARKER]?: true;
      };
    if (!originalCreateTask[INTERCEPTOR_MARKER]) {
      const wrappedCreateTask: CreateTaskFn & {
        [INTERCEPTOR_MARKER]?: true;
      } = async (task: Task) => {
        const createdTaskId = await originalCreateTask.call(rt, task);
        if (typeof createdTaskId === "string") {
          const captured = inferApprovalRequest(createdTaskId, task);
          if (captured) {
            approvalRequests.push(captured);
            stateTransitions.push({
              subject: "approval-request",
              to: "pending",
              actionName: captured.actionName,
              requestId: captured.id,
              at: captured.createdAt,
            });
          }
        }
        return createdTaskId;
      };
      wrappedCreateTask[INTERCEPTOR_MARKER] = true;
      (rt as { createTask: CreateTaskFn }).createTask = wrappedCreateTask;
      restoreFns.push(() => {
        (rt as { createTask: CreateTaskFn }).createTask = originalCreateTask;
      });
    }
  }

  return {
    actions,
    approvalRequests,
    connectorDispatches,
    memoryWrites,
    artifacts,
    stateTransitions,
    reset(): void {
      actions.length = 0;
      approvalRequests.length = 0;
      connectorDispatches.length = 0;
      memoryWrites.length = 0;
      artifacts.length = 0;
      stateTransitions.length = 0;
    },
    detach(): void {
      for (const restore of restoreFns) restore();
      restoreFns.length = 0;
    },
  };
}
