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
} from "@elizaos/core";
import type {
  CapturedAction,
  CapturedApprovalRequest,
  CapturedArtifact,
  CapturedConnectorDispatch,
  CapturedMemoryWrite,
  CapturedStateTransition,
} from "@elizaos/scenario-schema";

const INTERCEPTOR_MARKER = Symbol.for("scenario-runner.interceptor-wrapped");
const RUNTIME_CAPTURE_HOOK = Symbol.for("scenario-runner.capture-hooks");
const APPROVAL_QUEUE_PATCH_MARKER = Symbol.for(
  "scenario-runner.approval-queue-patched",
);

interface WrappedHandler {
  (...args: unknown[]): Promise<unknown>;
  [INTERCEPTOR_MARKER]?: true;
}

type RuntimeCaptureHooks = {
  approvalRequests: CapturedApprovalRequest[];
  connectorDispatches: CapturedConnectorDispatch[];
  stateTransitions: CapturedStateTransition[];
};

export interface ActionInterceptor {
  readonly actions: CapturedAction[];
  readonly approvalRequests: CapturedApprovalRequest[];
  readonly connectorDispatches: CapturedConnectorDispatch[];
  readonly memoryWrites: CapturedMemoryWrite[];
  readonly stateTransitions: CapturedStateTransition[];
  readonly artifacts: CapturedArtifact[];
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

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getRuntimeCaptureHooks(
  runtime: IAgentRuntime,
): RuntimeCaptureHooks | null {
  const hooks = (runtime as Record<PropertyKey, unknown>)[RUNTIME_CAPTURE_HOOK];
  if (!hooks || typeof hooks !== "object") {
    return null;
  }
  const record = hooks as Partial<RuntimeCaptureHooks>;
  if (
    !Array.isArray(record.approvalRequests) ||
    !Array.isArray(record.connectorDispatches) ||
    !Array.isArray(record.stateTransitions)
  ) {
    return null;
  }
  return record as RuntimeCaptureHooks;
}

function normalizeCapturedApprovalRequest(
  value: unknown,
): CapturedApprovalRequest | null {
  const record = toRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.state !== "string") {
    return null;
  }
  const actionRaw =
    typeof record.action === "string"
      ? record.action
      : typeof record.actionName === "string"
        ? record.actionName
        : null;
  if (!actionRaw) {
    return null;
  }
  return {
    id: record.id,
    state: record.state as CapturedApprovalRequest["state"],
    actionName: actionRaw,
    source:
      typeof record.requestedBy === "string" ? record.requestedBy : undefined,
    command: typeof record.reason === "string" ? record.reason : undefined,
    channel: typeof record.channel === "string" ? record.channel : undefined,
    payload: record.payload,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : typeof record.createdAt === "string"
          ? record.createdAt
          : undefined,
    decidedAt:
      record.resolvedAt instanceof Date
        ? record.resolvedAt.toISOString()
        : typeof record.resolvedAt === "string"
          ? record.resolvedAt
          : undefined,
  };
}

function upsertApprovalRequest(
  list: CapturedApprovalRequest[],
  next: CapturedApprovalRequest,
): void {
  const index = list.findIndex((entry) => entry.id === next.id);
  if (index === -1) {
    list.push(next);
    return;
  }
  list[index] = next;
}

function recordApprovalTransition(
  hooks: RuntimeCaptureHooks,
  request: CapturedApprovalRequest,
  from: string | undefined,
): void {
  if (!from || from === request.state) {
    return;
  }
  hooks.stateTransitions.push({
    subject: "approval",
    from,
    to: request.state,
    actionName: request.actionName,
    requestId: request.id,
    at: request.decidedAt ?? new Date().toISOString(),
  });
}

let approvalQueuePatchPromise: Promise<void> | null = null;

export async function ensureInterceptorRuntimeHooks(): Promise<void> {
  if (approvalQueuePatchPromise) {
    return approvalQueuePatchPromise;
  }
  approvalQueuePatchPromise = (async () => {
    try {
      const approvalQueueUrl = new URL(
        "../../../apps/app-lifeops/src/lifeops/approval-queue.ts",
        import.meta.url,
      );
      const moduleRecord = (await import(
        approvalQueueUrl.href
      )) as Record<string, unknown>;
      const PgApprovalQueue = moduleRecord.PgApprovalQueue as
        | { prototype?: Record<string, unknown> }
        | undefined;
      const prototype = PgApprovalQueue?.prototype;
      if (!prototype || prototype[APPROVAL_QUEUE_PATCH_MARKER]) {
        return;
      }

      const wrapMethod = (name: string) => {
        const original = prototype[name];
        if (typeof original !== "function") {
          return;
        }
        prototype[name] = async function (
          this: { runtime?: IAgentRuntime },
          ...args: unknown[]
        ): Promise<unknown> {
          const runtime = this.runtime;
          const hooks =
            runtime && typeof runtime === "object"
              ? getRuntimeCaptureHooks(runtime)
              : null;
          const previousState =
            hooks && typeof args[0] === "string"
              ? hooks.approvalRequests.find((entry) => entry.id === args[0])
                  ?.state
              : undefined;
          const result = await original.apply(this, args);
          if (!hooks) {
            return result;
          }
          const normalized = normalizeCapturedApprovalRequest(result);
          if (!normalized) {
            return result;
          }
          upsertApprovalRequest(hooks.approvalRequests, normalized);
          recordApprovalTransition(hooks, normalized, previousState);
          return result;
        };
      };

      for (const methodName of [
        "enqueue",
        "approve",
        "reject",
        "markExecuting",
        "markDone",
        "markExpired",
      ]) {
        wrapMethod(methodName);
      }

      prototype[APPROVAL_QUEUE_PATCH_MARKER] = true;
    } catch {
      // Scenario runner also lives outside the app-lifeops repo surface.
      // Absence of the optional app module should not break generic usage.
    }
  })();
  return approvalQueuePatchPromise;
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

export function attachInterceptor(runtime: IAgentRuntime): ActionInterceptor {
  const actions: CapturedAction[] = [];
  const approvalRequests: CapturedApprovalRequest[] = [];
  const connectorDispatches: CapturedConnectorDispatch[] = [];
  const memoryWrites: CapturedMemoryWrite[] = [];
  const stateTransitions: CapturedStateTransition[] = [];
  const artifacts: CapturedArtifact[] = [];

  // Wrap actions registered on this runtime.
  const restoreFns: Array<() => void> = [];

  (runtime as Record<PropertyKey, unknown>)[RUNTIME_CAPTURE_HOOK] = {
    approvalRequests,
    connectorDispatches,
    stateTransitions,
  } satisfies RuntimeCaptureHooks;

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

  type SendMessageToTargetFn = (
    target: Record<string, unknown>,
    content: Record<string, unknown>,
  ) => Promise<unknown>;

  if (isCallable((runtime as { sendMessageToTarget?: unknown }).sendMessageToTarget)) {
    const originalSend = (
      runtime as unknown as {
        sendMessageToTarget?: SendMessageToTargetFn & {
          [INTERCEPTOR_MARKER]?: true;
        };
      }
    ).sendMessageToTarget;
    if (originalSend && !originalSend[INTERCEPTOR_MARKER]) {
      const wrappedSend: SendMessageToTargetFn & {
        [INTERCEPTOR_MARKER]?: true;
      } = async (target, content) => {
        const channel =
          (typeof target?.source === "string" ? target.source : null) ??
          (typeof content?.source === "string" ? content.source : null) ??
          "unknown";
        const actionName =
          typeof content?.actionName === "string" ? content.actionName : undefined;
        const dispatch: CapturedConnectorDispatch = {
          channel,
          actionName,
          payload: { target, content },
          sentAt: new Date().toISOString(),
          delivered: false,
        };
        try {
          const result = await originalSend.call(runtime, target, content);
          dispatch.delivered = true;
          connectorDispatches.push(dispatch);
          return result;
        } catch (error) {
          dispatch.payload = {
            target,
            content,
            error: errorMessage(error),
          };
          connectorDispatches.push(dispatch);
          throw error;
        }
      };
      wrappedSend[INTERCEPTOR_MARKER] = true;
      (
        runtime as unknown as {
          sendMessageToTarget?: SendMessageToTargetFn;
        }
      ).sendMessageToTarget = wrappedSend;
      restoreFns.push(() => {
        (
          runtime as unknown as {
            sendMessageToTarget?: SendMessageToTargetFn;
          }
        ).sendMessageToTarget = originalSend;
      });
    }
  }

  return {
    actions,
    approvalRequests,
    connectorDispatches,
    memoryWrites,
    stateTransitions,
    artifacts,
    reset(): void {
      actions.length = 0;
      approvalRequests.length = 0;
      connectorDispatches.length = 0;
      memoryWrites.length = 0;
      stateTransitions.length = 0;
      artifacts.length = 0;
    },
    detach(): void {
      delete (runtime as Record<PropertyKey, unknown>)[RUNTIME_CAPTURE_HOOK];
      for (const restore of restoreFns) restore();
      restoreFns.length = 0;
    },
  };
}
