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
const EXECUTE_CODE_CONTEXTS = ["code", "terminal", "automation"] as const;
const EXECUTE_CODE_KEYWORDS = [
  "execute",
  "run",
  "script",
  "code",
  "javascript",
  "tool",
  "automation",
  "terminal",
  "ejecutar",
  "código",
  "exécuter",
  "skript",
  "ausführen",
  "executar",
  "codice",
  "eseguire",
  "コード",
  "実行",
  "脚本",
  "执行",
  "代码",
  "스크립트",
  "실행",
] as const;

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

function hasSelectedContext(state: State | undefined, contexts: readonly string[]): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

function hasExecuteCodeIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
  ]
    .join("\n")
    .toLowerCase();
  return EXECUTE_CODE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export const executeCodeAction: Action = {
  name: "EXECUTE_CODE",
  contexts: [...EXECUTE_CODE_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "USER" },
  similes: ["RUN_SCRIPT", "EXECUTE_TOOL_SCRIPT"],
  description:
    "Run a short JS-style script that calls multiple agent actions through `tools.<actionName>(args)` and reads runtime context via `context`. Use when the same turn needs three or more sequential tool calls with simple control flow or data passing between them. Not for single-call work.",
  descriptionCompressed:
    "Run multi-step JS script that calls actions sequentially via tools.<name>(args).",
  parameters: [
    {
      name: "script",
      description:
        "Async function body. The script may use `await tools.<actionName>(args)` to call any registered action and `context.{agentId,roomId,entityId,getMemories,searchMemories}` to read runtime state. Return value is rendered as plain text in the action result.",
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
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const disable = runtime.getSetting?.("EXECUTECODE_DISABLE");
    if (disable === true || disable === "true" || disable === "1") {
      return false;
    }
    return hasSelectedContext(state, EXECUTE_CODE_CONTEXTS) || hasExecuteCodeIntent(message, state);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const disable = runtime.getSetting?.("EXECUTECODE_DISABLE");
    if (disable === true || disable === "true" || disable === "1") {
      const text = `${LOG_PREFIX} disabled via EXECUTECODE_DISABLE`;
      return {
        success: false,
        text,
        error: new Error("executeCode disabled"),
        data: {
          actionName: "EXECUTE_CODE",
          reason: "disabled",
        },
      };
    }

    const parsed = readParams(options);
    if ("error" in parsed) {
      return {
        success: false,
        text: parsed.error,
        error: new Error(parsed.error),
        data: {
          actionName: "EXECUTE_CODE",
          reason: "invalid_parameters",
        },
      };
    }
    const { script, allowedActions, timeoutMs } = parsed.params;

    if (!message.roomId) {
      return {
        success: false,
        text: "executeCode: message has no roomId; cannot dispatch tools",
        error: new Error("missing roomId"),
        data: {
          actionName: "EXECUTE_CODE",
          reason: "missing_room_id",
        },
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
      coreLogger.warn(`${LOG_PREFIX} script failed: ${scriptError.message}`);
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

    const summary: Record<string, unknown> = {
      actionName: "EXECUTE_CODE",
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
        // ProviderDataRecord is loosely indexable JSON.
        data: summary as ActionResult["data"],
      };
    }

    const text = formatReturnValue(scriptValue);
    if (callback) await callback({ text, source: "execute-code" });

    const successData: Record<string, unknown> = {
      ...summary,
      returnValue: jsonSafe(scriptValue),
    };
    return {
      success: true,
      text,
      data: successData as ActionResult["data"],
    };
  },
};

/** Coerce a value to cloneable plain data before rendering it as text. */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function formatReturnValue(value: unknown): string {
  if (value === undefined) return "executeCode: completed";
  if (typeof value === "string") return value;
  return renderPlainData(value);
}

function renderPlainData(value: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "items[0]:";
    }
    return [
      `items[${value.length}]:`,
      ...value.map((item) => `${prefix}- ${renderPlainData(item, indent + 1)}`),
    ].join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => {
        if (nestedValue && typeof nestedValue === "object") {
          return `${key}:\n${renderPlainData(nestedValue, indent + 1)}`;
        }
        return `${key}: ${renderPlainData(nestedValue, indent + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

export type { ToolCallResult };
