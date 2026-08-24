/**
 * Fire-time handler for the `meeting_join` dispatch channel.
 *
 * The auto-join tasks (see `auto-join.ts`) dispatch through the standard
 * ScheduledTask runner with `escalation.steps[0].channelKey =
 * "meeting_join"` and `output.target = "meeting_join:<calendarEventId>"`.
 * The scheduling host (`@elizaos/plugin-personal-assistant`) registers this
 * handler as a `ChannelContribution` on its channel registry; the runner's
 * production dispatcher then routes the fire here, where the current auto-join
 * policy is re-checked, the firing task's scheduled mode is confirmed to still
 * match that policy (the fire-time epoch guard that stops a superseded direct
 * `all` join from firing under a later `ask` policy without owner approval),
 * the event is re-loaded from the calendar store, its conference link
 * re-validated with `parseMeetingUrl`, and the meetings service
 * (`@elizaos/plugin-meetings`) is asked to join.
 *
 * Every failure is a typed `DispatchResult { ok: false }` so the spine's
 * dispatch policy (retry / escalate / fail-loud) applies — no silent skips,
 * no thrown errors swallowed by the dispatcher.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  type DispatchResult,
  getScheduledTaskRunner,
  type ScheduledTask,
} from "@elizaos/plugin-scheduling";
import type { MeetingJoinRequest, MeetingSession } from "@elizaos/shared";
import { parseMeetingUrl } from "@elizaos/shared";
import { CalendarRepository } from "../service/CalendarRepository.js";
import {
  type MeetingAutoJoinPolicy,
  readMeetingAutoJoinSettings,
} from "./auto-join-settings.js";

const LOG_PREFIX = "[MeetingJoinChannel]";

/** Channel key the auto-join tasks dispatch through. */
export const MEETING_JOIN_CHANNEL_KEY = "meeting_join";

/** Service name of `@elizaos/plugin-meetings` (pinned contract). */
export const MEETINGS_SERVICE_TYPE = "meetings";

/** The slice of the pinned meetings-service contract this handler uses. */
export interface MeetingsServiceLike {
  requestJoin(request: MeetingJoinRequest): Promise<MeetingSession>;
}

function getMeetingsService(
  runtime: IAgentRuntime,
): MeetingsServiceLike | null {
  const service = runtime.getService(
    MEETINGS_SERVICE_TYPE,
  ) as MeetingsServiceLike | null;
  return service && typeof service.requestJoin === "function" ? service : null;
}

/**
 * Read the firing task id from the channel dispatch payload. The PA dispatcher
 * sends `{ target, message, metadata }` where `metadata.taskId` is the task
 * that fired (see plugin-personal-assistant `runtime-wiring.ts`). Used by the
 * fire-time policy-epoch guard to resolve the task's scheduled mode.
 */
function readFiringTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const metadata = (payload as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const taskId = (metadata as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : null;
}

/**
 * Fire-time policy-epoch guard. A join task is scheduled under one auto-join
 * policy generation, recorded structurally in `metadata.autoJoinMode`. The
 * scheduling-time idempotency key and stale-dismiss pass (see `auto-join.ts`)
 * are the primary epoch enforcement, but a concurrent or stale reconcile can
 * leave a task from a superseded generation `scheduled` inside the race window
 * before the next reconcile retires it. The most dangerous case is a direct
 * `all` join that survives into an `ask` policy: it would join with no owner
 * approval. This resolves the firing task and returns its scheduled mode so the
 * handler can refuse any task whose mode no longer matches the current policy.
 * Returns `null` when the mode cannot be determined; the caller then defers to
 * the scheduling-time guarantees rather than blocking a legitimate join.
 */
async function resolveFiringTaskMode(
  runtime: IAgentRuntime,
  payload: unknown,
): Promise<MeetingAutoJoinPolicy | null> {
  const taskId = readFiringTaskId(payload);
  if (!taskId) return null;
  let task: ScheduledTask | undefined;
  try {
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const tasks = await runner.list({ source: "plugin" });
    task = tasks.find((candidate) => candidate.taskId === taskId);
  } catch (error) {
    // error-policy:J7 the epoch guard is a defense-in-depth safety check layered
    // on the authoritative scheduling-time enforcement; a runner-resolution
    // failure must be warned and must not break the dispatch boundary contract
    // (every outcome is a typed DispatchResult, never a throw).
    logger.warn(
      { src: "calendar:meeting-join-channel", taskId, error },
      `${LOG_PREFIX} Could not resolve firing task ${taskId} for policy-epoch guard; deferring to scheduling-time guarantees.`,
    );
    return null;
  }
  const mode = task?.metadata?.autoJoinMode;
  return mode === "all" || mode === "ask" ? mode : null;
}

/**
 * Extract the calendar event id from the channel dispatch payload. The PA
 * dispatcher sends `{ target, message, metadata }` where `target` is
 * `output.target` with the `meeting_join:` prefix stripped.
 */
export function readMeetingJoinTarget(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const target = (payload as Record<string, unknown>).target;
  if (typeof target !== "string" || !target.trim()) return null;
  const raw = target.trim();
  const prefix = `${MEETING_JOIN_CHANNEL_KEY}:`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/**
 * Execute one `meeting_join` dispatch. Returns a typed `DispatchResult`.
 */
export async function handleMeetingJoinDispatch(
  runtime: IAgentRuntime,
  payload: unknown,
): Promise<DispatchResult> {
  const eventId = readMeetingJoinTarget(payload);
  if (!eventId) {
    return {
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
      message: "meeting_join dispatch has no calendar event target.",
    };
  }

  const settings = await readMeetingAutoJoinSettings(runtime);
  if (settings.policy === "off") {
    // Policy flipped off after the task was scheduled (reconcile normally
    // dismisses these; this is the race window). Do not join.
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      message: "Meeting auto-join is disabled for this agent.",
    };
  }

  // Policy-epoch guard: refuse a join whose scheduled mode no longer matches
  // the current policy. This closes the reconcile race where a stale `all`
  // (direct) join lingers into an `ask` policy and would otherwise join with no
  // owner approval, or a stale `ask` (gated) join lingers into `all`. Only a
  // task from the current policy generation is allowed to fire.
  const firingMode = await resolveFiringTaskMode(runtime, payload);
  if (firingMode && firingMode !== settings.policy) {
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      message: `Meeting auto-join task belongs to a superseded "${firingMode}" policy generation; current policy is "${settings.policy}". Refusing to join.`,
    };
  }

  const repo = new CalendarRepository(runtime);
  const event = await repo.getCalendarEventById(runtime.agentId, eventId);
  if (!event) {
    return {
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
      message: `Calendar event ${eventId} no longer exists.`,
    };
  }

  const parsed = event.conferenceLink
    ? parseMeetingUrl(event.conferenceLink)
    : null;
  if (!parsed) {
    return {
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
      message: `Calendar event ${eventId} has no recognizable meeting link.`,
    };
  }

  const meetings = getMeetingsService(runtime);
  if (!meetings) {
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      message:
        "Meetings service is not available on this runtime (is @elizaos/plugin-meetings loaded?).",
    };
  }

  try {
    const session = await meetings.requestJoin({
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      calendarEventId: event.id,
    });
    logger.info(
      {
        src: "calendar:meeting-join-channel",
        agentId: runtime.agentId,
        eventId: event.id,
        sessionId: session.id,
        platform: parsed.platform,
      },
      `${LOG_PREFIX} Requested meeting join for event ${event.id} (session ${session.id}).`,
    );
    return { ok: true, messageId: `meeting:${session.id}` };
  } catch (error) {
    logger.error(
      {
        src: "calendar:meeting-join-channel",
        agentId: runtime.agentId,
        eventId: event.id,
        error,
      },
      `${LOG_PREFIX} Meeting join request failed for event ${event.id}.`,
    );
    return {
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message:
        error instanceof Error ? error.message : "Meeting join request failed.",
    };
  }
}
