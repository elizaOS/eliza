/**
 * Shared helpers for effect-proving `custom` finalChecks (#11381, #9310
 * theme 3). `actionCalled` proves a handler ran; these helpers make it cheap
 * for a scenario to additionally read the captured action's result payload —
 * the domain artifact the action claims to have produced or read — and fail
 * with a precise diff when the effect is missing.
 */
import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isSynthesizedReply(action: CapturedAction): boolean {
  return toRecord(action.result?.data)?.source === "synthesized-reply";
}

/** Compact call summary for failure details. */
export function describeCalls(ctx: ScenarioContext): string {
  return (
    ctx.actionsCalled
      .map(
        (a) =>
          `${a.actionName}(success=${String(a.result?.success)}, data=${JSON.stringify(a.result?.data ?? null)?.slice(0, 200)})`,
      )
      .join(" | ") || "(no actions called)"
  );
}

/**
 * `result.data` of the first successful, non-synthesized call to
 * `actionName` — or null when no such call (or no object payload) exists.
 */
export function successfulActionData(
  ctx: ScenarioContext,
  actionName: string | string[],
): Record<string, unknown> | null {
  const accepted = Array.isArray(actionName) ? actionName : [actionName];
  for (const action of ctx.actionsCalled) {
    if (!accepted.includes(action.actionName)) continue;
    if (action.result?.success !== true) continue;
    if (isSynthesizedReply(action)) continue;
    const data = toRecord(action.result.data);
    if (data) return data;
  }
  return null;
}

/** All successful, non-synthesized calls to `actionName`. */
export function successfulCalls(
  ctx: ScenarioContext,
  actionName: string | string[],
): CapturedAction[] {
  const accepted = Array.isArray(actionName) ? actionName : [actionName];
  return ctx.actionsCalled.filter(
    (action) =>
      accepted.includes(action.actionName) &&
      action.result?.success === true &&
      !isSynthesizedReply(action),
  );
}
