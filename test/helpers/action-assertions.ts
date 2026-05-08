/**
 * E2E Action Assertion Helpers
 *
 * Utilities for verifying that the agent correctly invoked actions during
 * conversation. Works by querying persisted action_result memories from the
 * runtime's message store after a message has been processed.
 *
 * Usage:
 *   const before = Date.now();
 *   await handleMessage(runtime, message);
 *   const invocations = await getActionInvocations(runtime, roomId, before);
 *   expectActionCalled(invocations, "CALENDAR", { status: "success" });
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { expect } from "vitest";

/**
 * Normalized representation of a single action invocation extracted from
 * an action_result memory persisted by the runtime.
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

/**
 * Normalize an action name for fuzzy comparison: uppercase and strip
 * underscores so that "owner_calendar", "CALENDAR", and
 * "OwnerCalendar" all match.
 */
function normalizeActionName(name: string): string {
  return name.toUpperCase().replace(/_/g, "");
}

/**
 * Query the runtime for action_result memories created after `sinceTimestamp`
 * in the given room. Returns a normalized array of ActionInvocation objects
 * sorted by timestamp ascending (oldest first).
 *
 * The runtime persists action results as memories in the "messages" table
 * with `content.type === "action_result"`. See runtime.ts processActions()
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

/**
 * Assert that a specific action was called among the given invocations.
 *
 * Name matching is fuzzy: strips underscores and compares uppercase, so
 * "CALENDAR" matches "owner_calendar" or "OwnerCalendar".
 *
 * Optionally checks that the action's status and/or params match.
 * Throws a descriptive error listing what WAS called if the expected
 * action is not found.
 */
export function expectActionCalled(
  invocations: ActionInvocation[],
  actionName: string,
  opts?: {
    /** Expected status (e.g. "success" or "failed"). */
    status?: string;
    /** Partial param match -- every key/value in this object must appear in the invocation's params. */
    params?: Record<string, unknown>;
  },
): ActionInvocation {
  const normalized = normalizeActionName(actionName);
  const match = invocations.find(
    (inv) => normalizeActionName(inv.actionName) === normalized,
  );

  if (!match) {
    const called =
      invocations.length > 0
        ? invocations
            .map((i) => `${i.actionName} (${i.actionStatus})`)
            .join(", ")
        : "(none)";
    throw new Error(
      `Expected action "${actionName}" to be called, but it was not found.\n` +
        `Actions that WERE called: ${called}`,
    );
  }

  if (opts?.status) {
    expect(match.actionStatus).toBe(opts.status);
  }

  if (opts?.params) {
    expect(match.params).toBeDefined();
    for (const [key, value] of Object.entries(opts.params)) {
      expect(
        match.params?.[key],
        `Expected action "${actionName}" param "${key}" to be ${JSON.stringify(value)}`,
      ).toEqual(value);
    }
  }

  return match;
}

/**
 * Assert that a specific action was NOT called among the given invocations.
 *
 * Uses the same fuzzy name matching as expectActionCalled.
 */
export function expectActionNotCalled(
  invocations: ActionInvocation[],
  actionName: string,
): void {
  const normalized = normalizeActionName(actionName);
  const match = invocations.find(
    (inv) => normalizeActionName(inv.actionName) === normalized,
  );

  if (match) {
    throw new Error(
      `Expected action "${actionName}" NOT to be called, but it was ` +
        `invoked with status "${match.actionStatus}".`,
    );
  }
}

/**
 * Assert that actions were called in a specific order based on their
 * timestamps. Each name in `actionNames` must appear in order within
 * the invocations array (which is already sorted by timestamp from
 * getActionInvocations).
 *
 * Non-listed actions between the expected ones are allowed (the check
 * verifies relative ordering, not adjacency).
 */
export function expectActionOrder(
  invocations: ActionInvocation[],
  actionNames: string[],
): void {
  if (actionNames.length === 0) return;

  const normalizedExpected = actionNames.map(normalizeActionName);
  let searchFrom = 0;

  for (let i = 0; i < normalizedExpected.length; i++) {
    const expectedName = normalizedExpected[i];
    let foundIndex = -1;

    for (let j = searchFrom; j < invocations.length; j++) {
      if (normalizeActionName(invocations[j].actionName) === expectedName) {
        foundIndex = j;
        break;
      }
    }

    if (foundIndex === -1) {
      const called =
        invocations.length > 0
          ? invocations.map((inv) => inv.actionName).join(", ")
          : "(none)";
      const remaining = actionNames.slice(i).join(" -> ");
      throw new Error(
        `Expected action order violated: could not find "${actionNames[i]}" ` +
          `(at position ${i}) after index ${searchFrom}.\n` +
          `Expected remaining order: ${remaining}\n` +
          `All actions called: ${called}`,
      );
    }

    searchFrom = foundIndex + 1;
  }
}

/**
 * Assert that at least one of the given action names was called.
 *
 * Useful when multiple actions could satisfy a user request (e.g. the
 * agent might choose MESSAGE or MESSAGE for an email task).
 */
export function expectAnyActionCalled(
  invocations: ActionInvocation[],
  actionNames: string[],
): ActionInvocation {
  const normalizedCandidates = actionNames.map(normalizeActionName);

  const match = invocations.find((inv) =>
    normalizedCandidates.includes(normalizeActionName(inv.actionName)),
  );

  if (!match) {
    const called =
      invocations.length > 0
        ? invocations
            .map((i) => `${i.actionName} (${i.actionStatus})`)
            .join(", ")
        : "(none)";
    throw new Error(
      `Expected at least one of [${actionNames.join(", ")}] to be called, ` +
        `but none were found.\n` +
        `Actions that WERE called: ${called}`,
    );
  }

  return match;
}
