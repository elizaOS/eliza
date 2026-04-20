/**
 * Assertion helpers for use with ActionSpy.
 * Each function throws a descriptive error when its expectation fails.
 */
import type { ActionSpy, ActionSpyCall } from "./action-spy.js";

function normalize(name: string): string {
  return name.trim().toUpperCase().replace(/_/g, "");
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

export interface ExpectActionCalledOptions {
  status?: "completed" | "failed";
  minTimes?: number;
}

export function expectActionCalled(
  spy: ActionSpy,
  actionName: string,
  opts?: ExpectActionCalledOptions,
): ActionSpyCall[] {
  const target = normalize(actionName);
  const completed = spy.getCompletedCalls();
  let matches = completed.filter((c) => normalize(c.actionName) === target);
  if (opts?.status) {
    matches = matches.filter((c) =>
      opts.status === "failed"
        ? c.actionStatus === "failed" ||
          (c.actionStatus ?? "").toLowerCase().includes("fail")
        : c.actionStatus !== "failed",
    );
  }
  const minTimes = opts?.minTimes ?? 1;
  if (matches.length < minTimes) {
    throw new Error(
      `expected action "${actionName}" to be completed at least ${minTimes} time(s)` +
        `${opts?.status ? ` with status=${opts.status}` : ""}, but got ${matches.length}. ` +
        `All calls: ${formatCalls(spy.getCalls())}`,
    );
  }
  return matches;
}

export function expectActionNotCalled(
  spy: ActionSpy,
  actionName: string,
): void {
  const target = normalize(actionName);
  const matches = spy
    .getCalls()
    .filter((c) => normalize(c.actionName) === target);
  if (matches.length > 0) {
    throw new Error(
      `expected action "${actionName}" NOT to be called, but got ${matches.length} invocation(s): ` +
        formatCalls(matches),
    );
  }
}

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

export function expectActionOrder(spy: ActionSpy, actionNames: string[]): void {
  const ordered = spy.getCompletedCalls();
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
}
