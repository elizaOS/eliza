/**
 * Fire-time handler for the `meeting_join` dispatch channel.
 *
 * The auto-join tasks (see `auto-join.ts`) dispatch through the standard
 * ScheduledTask runner with `escalation.steps[0].channelKey =
 * "meeting_join"` and `output.target = "meeting_join:<calendarEventId>"`.
 * The scheduling host (`@elizaos/plugin-personal-assistant`) registers this
 * handler as a `ChannelContribution` on its channel registry; the runner's
 * production dispatcher then routes the fire here, where the current auto-join
 * policy is re-checked and the firing task is authenticated fail-closed before
 * any join: the payload must name a task that resolves to a non-dismissed
 * calendar auto-join `join` task whose subject event matches the dispatch
 * target and whose scheduled mode still equals the current policy. This stops
 * a superseded direct `all` join from firing under a later `ask` policy
 * without owner approval, and refuses any fire whose provenance cannot be
 * positively established. Only after authentication is the event re-loaded
 * from the calendar store, its conference link re-validated with
 * `parseMeetingUrl`, and the meetings service (`@elizaos/plugin-meetings`)
 * asked to join.
 *
 * Every failure — including every task-resolution or validation failure — is a
 * typed `DispatchResult { ok: false }` so the spine's dispatch policy (retry /
 * escalate / fail-loud) applies; the handler never falls open to a join it
 * could not authenticate, and never throws.
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
import { AUTO_JOIN_METADATA_FLAG } from "./auto-join.js";
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

/** Fire-time authentication outcome for the join task named in the payload. */
type FiringTaskAuthorization =
  | { ok: true; task: ScheduledTask }
  | { ok: false; result: DispatchResult };

function denyFiring(
  reason: "disconnected" | "unknown_recipient" | "transport_error",
  userActionable: boolean,
  message: string,
): { ok: false; result: DispatchResult } {
  return {
    ok: false,
    result: { ok: false, reason, userActionable, message },
  };
}

/**
 * Fire-time authentication (fail closed). A join task is scheduled under one
 * auto-join policy generation, recorded structurally in its metadata
 * (`calendarAutoJoin` flag, `role`, `calendarEventId`, `autoJoinMode`). The
 * scheduling-time idempotency key and stale/retire dismiss passes (see
 * `auto-join.ts`) keep at most one non-dismissed join task alive per
 * `(event, mode)`, and retire a superseded generation by `dismiss`. This
 * resolves the firing task named in the payload and authorizes the join ONLY
 * when every provenance fact holds:
 *
 * - the payload carries a task id, and the runner resolves it to a real task;
 * - the task is a calendar auto-join task with `role: "join"`;
 * - the task's subject event matches this dispatch target;
 * - the task is not `dismissed` (a `dismissed` task is a retired generation —
 *   the authoritative epoch signal at fire time, since the module never keeps
 *   two non-dismissed same-mode join tasks for one event); and
 * - the task's scheduled mode still equals the current policy.
 *
 * Any resolution or validation failure returns a typed refusal — never a
 * fall-through join. This closes the approval-bypass class: a stale direct
 * `all` join under a later `ask` policy is refused on the mode check, a retired
 * generation is refused on the `dismissed` check, and an unauthenticated or
 * malformed fire is refused on provenance.
 */
async function authenticateFiringJoinTask(
  runtime: IAgentRuntime,
  payload: unknown,
  eventId: string,
  policy: MeetingAutoJoinPolicy,
): Promise<FiringTaskAuthorization> {
  const taskId = readFiringTaskId(payload);
  if (!taskId) {
    return denyFiring(
      "unknown_recipient",
      false,
      "meeting_join dispatch carried no firing task id; refusing to join without authenticated task provenance.",
    );
  }
  let tasks: ScheduledTask[];
  try {
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    tasks = await runner.list({ source: "plugin" });
  } catch (error) {
    // error-policy:J1 the dispatch boundary translates a runner-resolution
    // failure into a typed DispatchResult; the fire cannot be authenticated,
    // so fail closed rather than joining a meeting whose provenance is unknown.
    logger.warn(
      { src: "calendar:meeting-join-channel", taskId, error },
      `${LOG_PREFIX} Could not resolve firing task ${taskId} to authenticate the join; refusing to join (fail closed).`,
    );
    return denyFiring(
      "transport_error",
      false,
      `Could not resolve firing task ${taskId} to authenticate the meeting join; refusing to join.`,
    );
  }
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) {
    return denyFiring(
      "unknown_recipient",
      false,
      `Firing task ${taskId} is not a known scheduled task; refusing to join.`,
    );
  }
  if (
    task.metadata?.[AUTO_JOIN_METADATA_FLAG] !== true ||
    task.metadata?.role !== "join"
  ) {
    return denyFiring(
      "unknown_recipient",
      false,
      `Firing task ${taskId} is not a calendar auto-join "join" task; refusing to join.`,
    );
  }
  if (task.metadata?.calendarEventId !== eventId) {
    return denyFiring(
      "unknown_recipient",
      false,
      `Firing task ${taskId} targets a different calendar event than ${eventId}; refusing to join.`,
    );
  }
  if (task.state.status === "dismissed") {
    return denyFiring(
      "disconnected",
      true,
      `Firing task ${taskId} was retired (superseded policy generation); refusing to join.`,
    );
  }
  const mode = task.metadata?.autoJoinMode;
  if (mode !== "all" && mode !== "ask") {
    return denyFiring(
      "unknown_recipient",
      false,
      `Firing task ${taskId} has no recognizable auto-join mode; refusing to join.`,
    );
  }
  if (mode !== policy) {
    return denyFiring(
      "disconnected",
      true,
      `Meeting auto-join task belongs to a superseded "${mode}" policy generation; current policy is "${policy}". Refusing to join.`,
    );
  }
  return { ok: true, task };
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

  // Fire-time authentication (fail closed): only a currently-valid, non-
  // dismissed calendar auto-join `join` task from the CURRENT policy
  // generation, whose subject event matches this dispatch target, may drive a
  // join. Every resolution or validation failure returns a typed refusal so a
  // stale, retired, or unauthenticated fire can never join a meeting the owner
  // never approved.
  const authorization = await authenticateFiringJoinTask(
    runtime,
    payload,
    eventId,
    settings.policy,
  );
  if (!authorization.ok) return authorization.result;

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
