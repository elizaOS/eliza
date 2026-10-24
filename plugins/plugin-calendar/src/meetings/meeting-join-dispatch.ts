/**
 * Fire-time handler for the `meeting_join` dispatch channel.
 *
 * The auto-join tasks (see `auto-join.ts`) dispatch through the standard
 * ScheduledTask runner with `escalation.steps[0].channelKey =
 * "meeting_join"` and `output.target = "meeting_join:<calendarEventId>"`.
 * The scheduling host (`@elizaos/plugin-personal-assistant`) registers this
 * handler as a `ChannelContribution` on its channel registry; the runner's
 * production dispatcher then routes the fire here, where the event is
 * re-loaded from the calendar store, its conference link re-validated with
 * `parseMeetingUrl`, and the meetings service (`@elizaos/plugin-meetings`)
 * is asked to join.
 *
 * Every failure is a typed `DispatchResult { ok: false }` so the spine's
 * dispatch policy (retry / escalate / fail-loud) applies — no silent skips,
 * no thrown errors swallowed by the dispatcher.
 */

import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import {
  type MeetingJoinRequest,
  type MeetingSession,
  parseMeetingUrl,
} from "@elizaos/core/protocol";
import type { DispatchResult } from "@elizaos/plugin-scheduling";
import { googleAccountIdFromGrantId } from "../internal/google-delegates.js";
import { microsoftAccountIdFromGrantId } from "../microsoft/accounts.js";
import { CalendarRepository } from "../service/CalendarRepository.js";
import { readMeetingAutoJoinSettings } from "./auto-join-settings.js";

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
 * Disconnecting a calendar account keeps its imported events (unless purged),
 * so a join task can still point at one. Only an event whose connector account
 * is still connected may be joined.
 */
async function eventAccountIsConnected(
  runtime: IAgentRuntime,
  event: {
    provider: string;
    connectorAccountId?: string | null;
    grantId?: string | null;
  },
): Promise<boolean> {
  // The grant id carries the account-manager id; connectorAccountId can be a
  // derived digest for rows written without one.
  const candidates = [
    event.provider === "google"
      ? googleAccountIdFromGrantId(event.grantId)
      : microsoftAccountIdFromGrantId(event.grantId),
    event.connectorAccountId,
  ].filter((id): id is string => Boolean(id));
  const manager = getConnectorAccountManager(runtime);
  for (const accountId of new Set(candidates)) {
    const account = await manager.getAccount(event.provider, accountId);
    if (account?.status === "connected") return true;
  }
  return false;
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

  if (!(await eventAccountIsConnected(runtime, event))) {
    return {
      ok: false,
      reason: "disconnected",
      userActionable: true,
      message: `The calendar account for event ${eventId} is no longer connected.`,
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
