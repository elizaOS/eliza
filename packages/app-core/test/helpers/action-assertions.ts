/**
 * Assertion helpers for action invocations.
 *
 * Two flavors are supported:
 *
 * 1. **Spy-based** (preferred): pass an `ActionSpy` that has been attached to
 *    the runtime. This is faster, has no DB read latency, and surfaces both
 *    `started` and `completed` phases. Used by the live E2E suites and the
 *    benchmarks runner.
 *
 * 2. **Memory-query-based**: pass an array of `ActionInvocation` objects
 *    obtained from `getActionInvocations(runtime, roomId, since)`. This
 *    reads `action_result` memories the runtime persists in the messages
 *    table. Useful when the spy was not attached or when asserting after
 *    process boundaries.
 *
 * Each `expect*` function is overloaded to accept either input.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { expect } from "vitest";
import type { ActionSpy, ActionSpyCall } from "./action-spy.js";

/**
 * Normalized representation of a single action invocation extracted from an
 * `action_result` memory persisted by the runtime.
 */
export interface ActionInvocation {
  /** Canonical action name as recorded by the runtime (e.g. "CALENDAR"). */
  actionName: string;
  /** Whether the action succeeded or failed. */
  actionStatus: "success" | "failed" | string;
  /** Action-specific parameters, if present in the memory's content.data. */
  params?: Record<string, unknown>;
  /** The full result data payload from the action, if any. */
  result?: unknown;
  /** Run ID grouping related action invocations in a single processActions pass. */
  runId?: string;
  /** Unix timestamp (ms) when the memory was created. */
  timestamp?: number;
  /** The raw memory for advanced inspection. */
  _raw: Memory;
}

function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
}

function isSpy(arg: unknown): arg is ActionSpy {
  return (
    typeof arg === "object" &&
    arg !== null &&
    typeof (arg as ActionSpy).getCompletedCalls === "function" &&
    typeof (arg as ActionSpy).getCalls === "function"
  );
}

function formatCalls(calls: ActionSpyCall[]): string {
  if (calls.length === 0) return "(none)";
  return calls
    .map(
      (c) =>
        `${c.phase}:${c.actionName}${c.actionStatus ? `(${c.actionStatus})` : ""}`,
    )
    .join(", ");
}

function formatInvocations(invocations: ActionInvocation[]): string {
  if (invocations.length === 0) return "(none)";
  return invocations
    .map((i) => `${i.actionName} (${i.actionStatus})`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// getActionInvocations
// ---------------------------------------------------------------------------

/**
 * Query the runtime for `action_result` memories created after
 * `sinceTimestamp` in the given room. Returns a normalized array of
 * `ActionInvocation` objects sorted by timestamp ascending (oldest first).
 *
 * The runtime persists action results as memories in the "messages" table
 * with `content.type === "action_result"`. See `runtime.ts processActions()`
 * for the persistence logic.
 */
export async function getActionInvocations(
  runtime: AgentRuntime,
  roomId: UUID,
  sinceTimestamp: number,
): Promise<ActionInvocation[]> {
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    start: sinceTimestamp,
    count: 200,
  });

  const actionMemories = memories.filter(
    (m) => m.content?.type === "action_result",
  );

  return actionMemories
    .map(
      (m): ActionInvocation => ({
        actionName: String(m.content.actionName ?? "UNKNOWN"),
        actionStatus: String(m.content.actionStatus ?? "unknown"),
        params:
          m.content.data && typeof m.content.data === "object"
            ? (m.content.data as Record<string, unknown>)
            : undefined,
        result: m.content.data,
        runId:
          typeof m.content.runId === "string" ? m.content.runId : undefined,
        timestamp: m.createdAt,
        _raw: m,
      }),
    )
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

// ---------------------------------------------------------------------------
// expectActionCalled
// ---------------------------------------------------------------------------

export interface ExpectActionCalledSpyOptions {
  /** Match only completed calls with `actionStatus === "failed"` (or any non-failed). */
  status?: "completed" | "failed";
  /** Minimum number of matching completed calls required. Defaults to 1. */
  minTimes?: number;
}

export interface ExpectActionCalledInvocationOptions {
  /** Expected memory `actionStatus` (e.g. "success" or "failed"). */
  status?: string;
  /** Partial param match — every key/value must appear in the invocation's params. */
  params?: Record<string, unknown>;
}

export function expectActionCalled(
  spy: ActionSpy,
  actionName: string,
  opts?: ExpectActionCalledSpyOptions,
): ActionSpyCall[];
export function expectActionCalled(
  invocations: ActionInvocation[],
  actionName: string,
  opts?: ExpectActionCalledInvocationOptions,
): ActionInvocation;
export function expectActionCalled(
  source: ActionSpy | ActionInvocation[],
  actionName: string,
  opts?: ExpectActionCalledSpyOptions | ExpectActionCalledInvocationOptions,
): ActionSpyCall[] | ActionInvocation {
  const target = normalize(actionName);

  if (isSpy(source)) {
    const spyOpts = opts as ExpectActionCalledSpyOptions | undefined;
    let matches = source
      .getCompletedCalls()
      .filter((c) => normalize(c.actionName) === target);
    if (spyOpts?.status) {
      matches = matches.filter((c) =>
        spyOpts.status === "failed"
          ? c.actionStatus === "failed" ||
            (c.actionStatus ?? "").toLowerCase().includes("fail")
          : c.actionStatus !== "failed",
      );
    }
    const minTimes = spyOpts?.minTimes ?? 1;
    if (matches.length < minTimes) {
      throw new Error(
        `expected action "${actionName}" to be completed at least ${minTimes} time(s)` +
          `${spyOpts?.status ? ` with status=${spyOpts.status}` : ""}, but got ${matches.length}. ` +
          `All calls: ${formatCalls(source.getCalls())}`,
      );
    }
    return matches;
  }

  const invOpts = opts as ExpectActionCalledInvocationOptions | undefined;
  const match = source.find((inv) => normalize(inv.actionName) === target);
  if (!match) {
    throw new Error(
      `Expected action "${actionName}" to be called, but it was not found.\n` +
        `Actions that WERE called: ${formatInvocations(source)}`,
    );
  }
  if (invOpts?.status) {
    expect(match.actionStatus).toBe(invOpts.status);
  }
  if (invOpts?.params) {
    expect(match.params).toBeDefined();
    for (const [key, value] of Object.entries(invOpts.params)) {
      expect(
        match.params?.[key],
        `Expected action "${actionName}" param "${key}" to be ${JSON.stringify(value)}`,
      ).toEqual(value);
    }
  }
  return match;
}

// ---------------------------------------------------------------------------
// expectActionNotCalled
// ---------------------------------------------------------------------------

export function expectActionNotCalled(spy: ActionSpy, actionName: string): void;
export function expectActionNotCalled(
  invocations: ActionInvocation[],
  actionName: string,
): void;
export function expectActionNotCalled(
  source: ActionSpy | ActionInvocation[],
  actionName: string,
): void {
  const target = normalize(actionName);
  if (isSpy(source)) {
    const matches = source
      .getCalls()
      .filter((c) => normalize(c.actionName) === target);
    if (matches.length > 0) {
      throw new Error(
        `expected action "${actionName}" NOT to be called, but got ${matches.length} invocation(s): ` +
          formatCalls(matches),
      );
    }
    return;
  }
  const match = source.find((inv) => normalize(inv.actionName) === target);
  if (match) {
    throw new Error(
      `Expected action "${actionName}" NOT to be called, but it was ` +
        `invoked with status "${match.actionStatus}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// expectActionCalledTimes (spy only)
// ---------------------------------------------------------------------------

export function expectActionCalledTimes(
  spy: ActionSpy,
  actionName: string,
  times: number,
): void {
  const target = normalize(actionName);
  const matches = spy
    .getCompletedCalls()
    .filter((c) => normalize(c.actionName) === target);
  if (matches.length !== times) {
    throw new Error(
      `expected action "${actionName}" to be completed exactly ${times} time(s), but got ${matches.length}. ` +
        `All calls: ${formatCalls(spy.getCalls())}`,
    );
  }
}

// ---------------------------------------------------------------------------
// expectActionOrder
// ---------------------------------------------------------------------------

export function expectActionOrder(spy: ActionSpy, actionNames: string[]): void;
export function expectActionOrder(
  invocations: ActionInvocation[],
  actionNames: string[],
): void;
export function expectActionOrder(
  source: ActionSpy | ActionInvocation[],
  actionNames: string[],
): void {
  if (actionNames.length === 0) return;

  if (isSpy(source)) {
    const ordered = source.getCompletedCalls();
    let cursor = 0;
    for (const wanted of actionNames) {
      const target = normalize(wanted);
      let found = -1;
      for (let i = cursor; i < ordered.length; i += 1) {
        if (normalize(ordered[i].actionName) === target) {
          found = i;
          break;
        }
      }
      if (found === -1) {
        throw new Error(
          `expected action order ${actionNames.join(" -> ")} but could not find "${wanted}" after position ${cursor}. ` +
            `Completed calls: ${formatCalls(ordered)}`,
        );
      }
      cursor = found + 1;
    }
    return;
  }

  let searchFrom = 0;
  for (let i = 0; i < actionNames.length; i++) {
    const expectedName = normalize(actionNames[i]);
    let foundIndex = -1;
    for (let j = searchFrom; j < source.length; j++) {
      if (normalize(source[j].actionName) === expectedName) {
        foundIndex = j;
        break;
      }
    }
    if (foundIndex === -1) {
      const remaining = actionNames.slice(i).join(" -> ");
      throw new Error(
        `Expected action order violated: could not find "${actionNames[i]}" ` +
          `(at position ${i}) after index ${searchFrom}.\n` +
          `Expected remaining order: ${remaining}\n` +
          `All actions called: ${formatInvocations(source)}`,
      );
    }
    searchFrom = foundIndex + 1;
  }
}

// ---------------------------------------------------------------------------
// expectAnyActionCalled
// ---------------------------------------------------------------------------

/**
 * Assert that at least one of the given action names was called. Useful when
 * multiple actions could satisfy a user request (e.g. the agent might choose
 * MESSAGE or MESSAGE for an email task).
 */
export function expectAnyActionCalled(
  spy: ActionSpy,
  actionNames: string[],
): ActionSpyCall;
export function expectAnyActionCalled(
  invocations: ActionInvocation[],
  actionNames: string[],
): ActionInvocation;
export function expectAnyActionCalled(
  source: ActionSpy | ActionInvocation[],
  actionNames: string[],
): ActionSpyCall | ActionInvocation {
  const targets = new Set(actionNames.map(normalize));

  if (isSpy(source)) {
    const completed = source.getCompletedCalls();
    const match = completed.find((c) => targets.has(normalize(c.actionName)));
    if (!match) {
      throw new Error(
        `Expected at least one of [${actionNames.join(", ")}] to complete, ` +
          `but none were found. All calls: ${formatCalls(source.getCalls())}`,
      );
    }
    return match;
  }

  const match = source.find((inv) => targets.has(normalize(inv.actionName)));
  if (!match) {
    throw new Error(
      `Expected at least one of [${actionNames.join(", ")}] to be called, ` +
        `but none were found.\n` +
        `Actions that WERE called: ${formatInvocations(source)}`,
    );
  }
  return match;
}
