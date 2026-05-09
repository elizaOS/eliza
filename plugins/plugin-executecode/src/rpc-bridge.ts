/**
 * RPC bridge for the executeCode action.
 *
 * Builds the in-script `tools` Proxy and the read-only `context` object that
 * the script body sees. Tool calls dispatch directly to action handlers on
 * the runtime, mirroring the same approval/parameter-validation gates used
 * by the normal action pipeline. Each call inherits the parent trajectory
 * step ID via `runWithTrajectoryContext` so child action steps link back to
 * the parent `executeCode` step.
 */

import {
  type Action,
  type ActionParameters,
  type ActionResult,
  type Content,
  logger as coreLogger,
  getActiveRoutingContexts,
  getContextRoutingFromMessage,
  getContextRoutingFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  runWithTrajectoryContext,
  type State,
  shouldIncludeByContext,
  type UUID,
  validateActionParams,
} from "@elizaos/core";

const LOG_PREFIX = "[ExecuteCodePlugin]";

/**
 * Argument bag that the script can pass to a tool. Must be a plain JSON
 * object (or undefined) — primitives, arrays, and nested plain objects only.
 */
export type ToolArgs = Record<string, unknown> | undefined;

/**
 * Public shape of the in-script `tools` proxy. Each property is a function
 * that returns the JSON-cloneable result of the underlying action.
 *
 * Indexing is intentionally permissive — the script may use any action name
 * (or simile) registered on the runtime; resolution happens at call time.
 */
export type ToolsProxy = {
  [actionName: string]: (args?: ToolArgs) => Promise<ToolCallResult>;
};

/**
 * Outcome of a single tool call. The structure is JSON-cloneable so scripts
 * can stash, log, or destructure it without referencing host objects.
 */
export interface ToolCallResult {
  /** Action name that was actually invoked (after simile/fuzzy resolution). */
  action: string;
  /** Trajectory step ID assigned to the child action call. */
  stepId: string;
  /** True when the underlying action returned an `ActionResult` with no error. */
  success: boolean;
  /** ActionResult-style payload returned by the action, if any. */
  data?: unknown;
  /** Convenience: text from the action result if present. */
  text?: string;
  /** Callback contents emitted by the action handler, in order. */
  callbacks: Content[];
}

/** Read-only context object exposed to the script as `context`. */
export interface ScriptContext {
  agentId: UUID;
  roomId: UUID;
  entityId: UUID;
  /** Runtime room-scoped getMemories. Returns plain JSON memories. */
  getMemories: (params: {
    tableName: string;
    limit?: number;
  }) => Promise<unknown[]>;
  /** Embedding-similarity search wrapper. */
  searchMemories: (params: {
    tableName: string;
    embedding: number[];
    limit?: number;
    match_threshold?: number;
  }) => Promise<unknown[]>;
}

export interface BuildToolsProxyParams {
  runtime: IAgentRuntime;
  message: Memory;
  state?: State;
  parentStepId: string;
  parentRunId?: string;
  parentRoomId?: UUID;
  /** Optional allow-list. When provided, calls outside it are rejected. */
  allowedActions?: string[];
  /** Sink for child step IDs as the script dispatches actions. */
  recordChildStep: (stepId: string) => void;
}

/** Cheap predicate that rejects inputs which won't survive `JSON.stringify`. */
function isJsonCloneable(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return t !== "number" || Number.isFinite(value as number);
  }
  if (t === "undefined") return true; // undefined survives via JSON omission
  if (t === "function" || t === "symbol" || t === "bigint") return false;
  if (t !== "object" || value === null) return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isJsonCloneable(entry, seen)) return false;
    }
    return true;
  }
  // Reject any non-plain prototypes (Date, Map, Set, custom classes, etc.).
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!isJsonCloneable(entry, seen)) return false;
  }
  return true;
}

function generateStepId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${random}`;
}

function findActionByName(
  runtime: IAgentRuntime,
  rawName: string,
): Action | undefined {
  const target = rawName.toLowerCase().replace(/_/g, "");
  for (const action of runtime.actions) {
    if (action.name.toLowerCase().replace(/_/g, "") === target) return action;
  }
  for (const action of runtime.actions) {
    const similes = action.similes ?? [];
    for (const simile of similes) {
      if (simile.toLowerCase().replace(/_/g, "") === target) return action;
    }
  }
  return undefined;
}

interface ResolveAllowSetParams {
  runtime: IAgentRuntime;
  message: Memory;
  state?: State;
  allowedActions?: string[];
}

interface ResolvedAllowSet {
  /** Null → all actions permitted (no filter). */
  allowSet: Set<string> | null;
  /** Human-readable reason surfaced to the script on a reject. */
  rejectionReason: string;
}

/**
 * Resolve the effective allow-set for a tools proxy instance.
 *
 * Precedence:
 *   1. Explicit `allowedActions` from the script params → exact allow-list.
 *   2. Current turn's routing contexts (state + message metadata) → filter
 *      the runtime action list to those whose `contexts` intersect the
 *      active set.
 *   3. No context resolvable → null allow-set (all actions permitted); logs a
 *      debug note so the fall-through is visible.
 */
function resolveAllowSet({
  runtime,
  message,
  state,
  allowedActions,
}: ResolveAllowSetParams): ResolvedAllowSet {
  if (allowedActions) {
    return {
      allowSet: new Set(
        allowedActions.map((n) => n.toLowerCase().replace(/_/g, "")),
      ),
      rejectionReason: "action not in allowedActions",
    };
  }

  const routing = {
    ...getContextRoutingFromState(state),
    ...getContextRoutingFromMessage(message),
  };
  const activeContexts = getActiveRoutingContexts(routing);
  if (activeContexts.length === 0) {
    coreLogger.debug(
      `${LOG_PREFIX} no routing contexts resolvable for turn ${message.id ?? "<no-id>"}; tools allow-set falls through to all actions`,
    );
    return { allowSet: null, rejectionReason: "action not permitted" };
  }

  const contextualSet = new Set<string>();
  for (const action of runtime.actions) {
    if (shouldIncludeByContext(action.contexts, activeContexts)) {
      contextualSet.add(action.name.toLowerCase().replace(/_/g, ""));
      for (const simile of action.similes ?? []) {
        contextualSet.add(simile.toLowerCase().replace(/_/g, ""));
      }
    }
  }
  return {
    allowSet: contextualSet,
    rejectionReason: `action not in current routing contexts (${activeContexts.join(",")})`,
  };
}

export function buildToolsProxy({
  runtime,
  message,
  state,
  parentStepId,
  parentRunId,
  parentRoomId,
  allowedActions,
  recordChildStep,
}: BuildToolsProxyParams): ToolsProxy {
  // Resolve the effective allow-list. Explicit `allowedActions` always wins.
  // Otherwise, default to the actions whose declared `contexts` intersect the
  // current turn's routing contexts (pulled from state + message metadata).
  // When no routing context is resolvable, fall back to all registered
  // actions — matching the previous default but logging the fall-through.
  const { allowSet, rejectionReason } = resolveAllowSet({
    runtime,
    message,
    state,
    allowedActions,
  });

  const target: ToolsProxy = {};
  return new Proxy(target, {
    get(_t, prop) {
      if (typeof prop !== "string") {
        // Symbol access (e.g. inspector hooks) — return undefined.
        return undefined;
      }
      return async (args?: ToolArgs): Promise<ToolCallResult> => {
        if (args !== undefined) {
          if (
            typeof args !== "object" ||
            args === null ||
            Array.isArray(args)
          ) {
            throw new Error(
              `${LOG_PREFIX} tools.${prop}: args must be a plain object or undefined`,
            );
          }
          if (!isJsonCloneable(args)) {
            throw new Error(
              `${LOG_PREFIX} tools.${prop}: args must be JSON-cloneable (no functions, classes, Date, Map, etc.)`,
            );
          }
        }

        if (allowSet && !allowSet.has(prop.toLowerCase().replace(/_/g, ""))) {
          throw new Error(`${LOG_PREFIX} tools.${prop}: ${rejectionReason}`);
        }

        const action = findActionByName(runtime, prop);
        if (!action) {
          throw new Error(
            `${LOG_PREFIX} tools.${prop}: action not found on runtime`,
          );
        }
        if (typeof action.handler !== "function") {
          throw new Error(`${LOG_PREFIX} tools.${prop}: action has no handler`);
        }

        const childStepId = generateStepId("execcode-child");
        recordChildStep(childStepId);

        const options: HandlerOptions = {};
        if (args !== undefined) {
          // We've already verified args are JSON-cloneable above; cast to
          // ActionParameters so validateActionParams' nominal type accepts
          // the same payload.
          const argsAsParameters = args as ActionParameters;
          if (action.parameters && action.parameters.length > 0) {
            const validation = validateActionParams(action, argsAsParameters);
            if (validation.params) {
              options.parameters = validation.params;
            } else {
              // Pass through raw args as parameters even if validation surfaced
              // warnings; handlers still receive parameterErrors below.
              options.parameters = argsAsParameters;
            }
            if (!validation.valid) {
              options.parameterErrors = validation.errors;
            }
          } else {
            options.parameters = argsAsParameters;
          }
        }

        const callbacks: Content[] = [];
        const callback: HandlerCallback = async (response) => {
          callbacks.push(response);
          return [];
        };

        const childContext = {
          trajectoryStepId: childStepId,
          parentStepId,
          ...(parentRunId !== undefined ? { runId: parentRunId } : {}),
          ...(parentRoomId !== undefined ? { roomId: parentRoomId } : {}),
          ...(message.id !== undefined ? { messageId: message.id } : {}),
          purpose: "action",
        };

        coreLogger.debug(
          `${LOG_PREFIX} tools.${prop} dispatching (childStepId=${childStepId})`,
        );

        const handlerResult = await runWithTrajectoryContext(childContext, () =>
          action.handler(runtime, message, state, options, callback, undefined),
        );

        const result: ToolCallResult = {
          action: action.name,
          stepId: childStepId,
          success: false,
          callbacks,
        };

        if (handlerResult === undefined || handlerResult === null) {
          // Void-return: treat as success only if a callback was emitted.
          result.success = callbacks.length > 0;
        } else if (typeof handlerResult === "boolean") {
          result.success = handlerResult;
        } else if (typeof handlerResult === "object") {
          const ar = handlerResult as ActionResult;
          result.success = "success" in ar ? Boolean(ar.success) : true;
          if ("text" in ar && typeof ar.text === "string") {
            result.text = ar.text;
          }
          // Strip non-JSON-cloneable bits before exposing to the script.
          const sanitizedData = sanitizeForScript({
            text: ar.text,
            values: ar.values,
            data: ar.data,
            error: ar.error,
          });
          result.data = sanitizedData;
        }

        return result;
      };
    },
  });
}

/**
 * Strip values that won't survive structured cloning so the script never
 * receives host-bound proxies, functions, or class instances. Everything
 * non-cloneable becomes `undefined`.
 */
function sanitizeForScript(value: unknown): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") return Number.isFinite(value) ? value : undefined;
  if (t === "undefined") return undefined;
  if (t === "function" || t === "symbol" || t === "bigint") return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForScript(entry));
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeForScript(v);
      if (sanitized !== undefined) out[k] = sanitized;
    }
    return out;
  }
  return undefined;
}

export function buildScriptContext({
  runtime,
  roomId,
  entityId,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
  entityId: UUID;
}): ScriptContext {
  return {
    agentId: runtime.agentId,
    roomId,
    entityId,
    getMemories: async (params) => {
      const memories = await runtime.getMemories({
        tableName: params.tableName,
        roomId,
        limit: params.limit,
      });
      return sanitizeForScript(memories) as unknown[];
    },
    searchMemories: async (params) => {
      const memories = await runtime.searchMemories({
        tableName: params.tableName,
        embedding: params.embedding,
        roomId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.match_threshold !== undefined
          ? { match_threshold: params.match_threshold }
          : {}),
      });
      return sanitizeForScript(memories) as unknown[];
    },
  };
}
