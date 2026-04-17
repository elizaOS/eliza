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
  CapturedMemoryWrite,
} from "@elizaos/scenario-schema";

const INTERCEPTOR_MARKER = Symbol.for("scenario-runner.interceptor-wrapped");

interface WrappedHandler {
  (...args: unknown[]): Promise<unknown>;
  [INTERCEPTOR_MARKER]?: true;
}

export interface ActionInterceptor {
  readonly actions: CapturedAction[];
  readonly memoryWrites: CapturedMemoryWrite[];
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

export function attachInterceptor(runtime: IAgentRuntime): ActionInterceptor {
  const actions: CapturedAction[] = [];
  const memoryWrites: CapturedMemoryWrite[] = [];

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
      const [_rt, _message, _state, options, _callback] = args as [
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
      try {
        const result = (await (
          original as (...inner: unknown[]) => unknown
        ).apply(action, args)) as unknown;
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          entry.result = {
            success:
              typeof r.success === "boolean" ? r.success : undefined,
            data: r.data,
            values: r.values,
            text: typeof r.text === "string" ? r.text : undefined,
          };
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

  return {
    actions,
    memoryWrites,
    reset(): void {
      actions.length = 0;
      memoryWrites.length = 0;
    },
    detach(): void {
      for (const restore of restoreFns) restore();
      restoreFns.length = 0;
    },
  };
}
