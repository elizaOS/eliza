// Supports LifeOps activity and focus projections consumed by owner context.
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type ActivityForegroundApp,
  getLatestForegroundActivity,
} from "./activity-tracker-reporting.js";
import type { ProactiveAction } from "./types.js";

/**
 * Consumer of the ambient app-usage signal (issue #9970): the activity-profile
 * provider already injects "current app / today's dwell" into owner context;
 * this module makes the proactive worker *act* on that signal instead of only
 * displaying it. When the owner is heads-down in a single app, non-urgent
 * proactive nudges defer to the next tick rather than interrupting deep work.
 */

/**
 * A continuous single-app foreground dwell of at least this long is treated as
 * an active focus session. `getLatestForegroundActivity` already returns null
 * for idle / system-inactivity / deactivated states, so the only remaining
 * signal we need is sustained `activeMs`.
 */
export const FOCUS_SESSION_MIN_MS = 10 * 60_000;

/**
 * How far back we look for the latest foreground event. A focus session is
 * derived from that event's continuous active time, not the window length;
 * the window only bounds the lookup.
 */
const FOCUS_LOOKBACK_MS = 12 * 60 * 60_000;

/**
 * Proactive action kinds that defer while the owner is in a focus session.
 * These are non-urgent and retry on the next worker tick once focus ends.
 *
 * Intentionally excluded:
 * - `pre_activity_nudge` — time-critical (imminent calendar/occurrence); never suppress.
 * - `gm` / `gn` — once-a-day greetings, not interruptive churn.
 * - `social_overuse_check` — already self-gated on *detected* overuse, so a
 *   sustained dwell in a distracting app is exactly when it should fire.
 */
export const FOCUS_DEFERRABLE_KINDS: ReadonlySet<ProactiveAction["kind"]> =
  new Set<ProactiveAction["kind"]>(["goal_check_in"]);

export interface OwnerFocusSession {
  app: ActivityForegroundApp;
  focusedMs: number;
}

/** Pure: classify the latest foreground app as a sustained focus session. */
export function resolveFocusSession(
  current: ActivityForegroundApp | null,
  minMs: number = FOCUS_SESSION_MIN_MS,
): OwnerFocusSession | null {
  if (!current) return null;
  if (current.activeMs < minMs) return null;
  return { app: current, focusedMs: current.activeMs };
}

/** Pure: does this action kind defer while a focus session is active? */
export function shouldDeferDuringFocus(kind: ProactiveAction["kind"]): boolean {
  return FOCUS_DEFERRABLE_KINDS.has(kind);
}

/**
 * Pure: split actions into those to dispatch now vs defer to the next tick.
 * When no focus session is active, everything dispatches unchanged.
 */
export function partitionFocusDeferredActions(
  actions: ProactiveAction[],
  focusActive: boolean,
): { dispatch: ProactiveAction[]; deferred: ProactiveAction[] } {
  if (!focusActive) return { dispatch: actions, deferred: [] };
  const dispatch: ProactiveAction[] = [];
  const deferred: ProactiveAction[] = [];
  for (const action of actions) {
    if (shouldDeferDuringFocus(action.kind)) deferred.push(action);
    else dispatch.push(action);
  }
  return { dispatch, deferred };
}

/**
 * Read the owner's current foreground focus session from the activity spine.
 * Returns null (no suppression) when there is no sustained foreground app or
 * the read fails — proactive delivery must never be blocked by this signal.
 */
export async function readOwnerFocusSession(args: {
  runtime: IAgentRuntime;
  now: Date;
  minMs?: number;
}): Promise<OwnerFocusSession | null> {
  const { runtime, now } = args;
  try {
    const current = await getLatestForegroundActivity(
      runtime,
      String(runtime.agentId),
      { sinceMs: now.getTime() - FOCUS_LOOKBACK_MS, untilMs: now.getTime() },
    );
    return resolveFocusSession(current, args.minMs ?? FOCUS_SESSION_MIN_MS);
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "owner_focus_session_read",
        err: error instanceof Error ? error : undefined,
      },
      "[proactive] Failed to read owner focus session; proceeding without focus suppression.",
    );
    return null;
  }
}
