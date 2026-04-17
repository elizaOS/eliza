/**
 * `EXECUTE_CODE` action.
 *
 * Lets the planner write a small JS-style script that calls multiple actions
 * sequentially through an injected `tools` Proxy, with a read-only `context`
 * object exposing room-scoped runtime data. Trajectory linkage:
 *   - On entry, we open a parent step with `kind: "executeCode"` and persist
 *     the script source (capped to TRAJECTORY_STEP_SCRIPT_MAX_CHARS).
 *   - Every dispatched tool call is run inside `runWithTrajectoryContext`
 *     with `parentStepId` set so the child action's trajectory step links
 *     back to the parent.
 *   - On exit, we close the parent step and write the collected child
 *     step IDs onto its `childSteps`.
 *
 * Execution model: in-process `AsyncFunction`. No sandbox. The script runs
 * with the same privileges as the rest of the agent — gating happens at the
 * tool/action layer, not here.
 */

import {
  type Action,
  type ActionResult,
  annotateActiveTrajectoryStep,
  type HandlerCallback,
  type IAgentRuntime,
  logger as coreLogger,
  type Memory,
  resolveTrajectoryLogger,
  type State,
  type UUID,
} from "@elizaos/core";

import {
  buildScriptContext,
  buildToolsProxy,
  type ToolCallResult,
  type ToolsProxy,
} from "./rpc-bridge.js";

const LOG_PREFIX = "[ExecuteCodePlugin]";

const DEFAULT_TIMEOUT_MS = 30_000;

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

interface ExecuteCodeParams {
  script: string;
  allowedActions?: string[];
  timeoutMs?: number;
}

function readParams(
  options: unknown,
): { params: ExecuteCodeParams } | { error: string } {
  if (!options || typeof options !== "object") {
    return { error: "executeCode: missing options bag" };
  }
  const opts = options as Record<string, unknown>;
  const raw =
    (opts.parameters as Record<string, unknown> | undefined) ??
    (opts as Record<string, unknown>);

  const script = raw.script;
  if (typeof script !== "string" || script.trim().length === 0) {
    return { error: "executeCode: 'script' parameter is required" };
  }

  const result: ExecuteCodeParams = { script };

  if (raw.allowedActions !== undefined) {
    if (
      !Array.isArray(raw.allowedActions) ||
      !raw.allowedActions.every((entry) => typeof entry === "string")
    ) {
      return {
        error: "executeCode: 'allowedActions' must be a string[] when provided",
      };
    }
    result.allowedActions = raw.allowedActions;
  }

  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs)) {
      return { error: "executeCode: 'timeoutMs' must be a finite number" };
    }
    if (raw.timeoutMs <= 0) {
      return { error: "executeCode: 'timeoutMs' must be > 0" };
    }
    result.timeoutMs = raw.timeoutMs;
  }

  return { params: result };
}

function generateParentStepId(): string {
  return `execcode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveTimeoutMs(
  runtime: IAgentRuntime,
  override: number | undefined,
): number {
  if (override !== undefined) return override;
  const setting = runtime.getSetting?.("EXECUTECODE_TIMEOUT_MS");
  if (typeof setting === "number" && Number.isFinite(setting) && setting > 0) {
    return setting;
  }
  if (typeof setting === "string") {
    const parsed = Number(setting);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`executeCode: script timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export const executeCodeAction: Action = {
  name: "EXECUTE_CODE",
  similes: ["RUN_SCRIPT", "EXECUTE_TOOL_SCRIPT"],
  description:
    "Run a short JS-style script that calls multiple agent actions through `tools.<actionName>(args)` and reads runtime context via `context`. Use when the same turn needs three or more sequential tool calls with simple control flow or data passing between them. Not for single-call work.",
  parameters: [
    {
      name: "script",
      description:
        "Async function body. The script may use `await tools.<actionName>(args)` to call any registered action and `context.{agentId,roomId,entityId,getMemories,searchMemories}` to read runtime state. Return value is JSON-serialized into the action result.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "allowedActions",
      description:
        "Optional allow-list of action names the script may call. When omitted, all registered actions are callable.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "timeoutMs",
      description:
        "Override the default 30s timeout. Hard ceiling enforced via Promise.race.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const disable = runtime.getSetting?.("EXECUTECODE_DISABLE");
    if (disable === true || disable === "true" || disable === "1") {
      return {
        success: false,
        text: `${LOG_PREFIX} disabled via EXECUTECODE_DISABLE`,
        error: new Error("executeCode disabled"),
      };
    }

    const parsed = readParams(options);
    if ("error" in parsed) {
      return {
        success: false,
        text: parsed.error,
        error: new Error(parsed.error),
      };
    }
    const { script, allowedActions, timeoutMs } = parsed.params;

    if (!message.roomId) {
      return {
        success: false,
        text: "executeCode: message has no roomId; cannot dispatch tools",
        error: new Error("missing roomId"),
      };
    }
    const roomId = message.roomId as UUID;
    const entityId = (message.entityId ?? runtime.agentId) as UUID;

    const parentStepId = generateParentStepId();
    coreLogger.debug(
      `${LOG_PREFIX} starting parent step ${parentStepId} (script length=${script.length})`,
    );

    const trajectoryLogger = resolveTrajectoryLogger(runtime);

    if (
      trajectoryLogger &&
      typeof trajectoryLogger.startTrajectory === "function"
    ) {
      // Legacy signature: (stepId, { agentId, source, metadata }) returns stepId.
      await trajectoryLogger.startTrajectory(parentStepId, {
        agentId: runtime.agentId,
        source: "execute-code",
        metadata: {
          scriptLength: script.length,
          ...(allowedActions !== undefined ? { allowedActions } : {}),
        },
      } as Parameters<NonNullable<typeof trajectoryLogger.startTrajectory>>[1]);
    }

    await annotateActiveTrajectoryStep(runtime, {
      stepId: parentStepId,
      kind: "executeCode",
      script,
      childSteps: [],
    });

    const childSteps: string[] = [];
    const tools: ToolsProxy = buildToolsProxy({
      runtime,
      message,
      state,
      parentStepId,
      parentRoomId: roomId,
      ...(allowedActions !== undefined ? { allowedActions } : {}),
      recordChildStep: (id) => {
        childSteps.push(id);
      },
    });
    const context = buildScriptContext({ runtime, roomId, entityId });

    const effectiveTimeoutMs = resolveTimeoutMs(runtime, timeoutMs);

    let scriptValue: unknown;
    let scriptError: Error | undefined;
    try {
      const fn = new AsyncFunction("tools", "context", script);
      scriptValue = await withTimeout(
        Promise.resolve(fn(tools, context)),
        effectiveTimeoutMs,
      );
    } catch (err) {
      scriptError = err instanceof Error ? err : new Error(String(err));
      coreLogger.warn(
        `${LOG_PREFIX} script failed: ${scriptError.message}`,
      );
    }

    await annotateActiveTrajectoryStep(runtime, {
      stepId: parentStepId,
      childSteps,
    });

    if (
      trajectoryLogger &&
      typeof trajectoryLogger.endTrajectory === "function"
    ) {
      await trajectoryLogger.endTrajectory(
        parentStepId,
        scriptError ? "error" : "completed",
      );
    }

    const summary: ToolCallResultsSummary = {
      parentStepId,
      childSteps,
      childCount: childSteps.length,
    };

    if (scriptError) {
      const text = `${LOG_PREFIX} ${scriptError.message}`;
      if (callback) await callback({ text, source: "execute-code" });
      return {
        success: false,
        text,
        error: scriptError,
        data: summary,
      };
    }

    const text = formatReturnValue(scriptValue);
    if (callback) await callback({ text, source: "execute-code" });

    return {
      success: true,
      text,
      data: { ...summary, returnValue: scriptValue },
    };
  },
};

interface ToolCallResultsSummary {
  parentStepId: string;
  childSteps: string[];
  childCount: number;
}

function formatReturnValue(value: unknown): string {
  if (value === undefined) return "executeCode: completed";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type { ToolCallResult };
