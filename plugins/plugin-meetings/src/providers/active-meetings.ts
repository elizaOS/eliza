/**
 * `ACTIVE_MEETINGS` provider — injects the meetings the notetaker bot is
 * currently attending (platform, URL, elapsed time, speakers heard) into the
 * prompt, so the agent can answer "are you in the call?" and route
 * LEAVE_MEETING / GET_MEETING_TRANSCRIPT correctly. Contributes nothing when
 * no meeting is active.
 */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { MEETING_PLATFORM_LABELS, type MeetingSession } from "@elizaos/shared";
import type { MeetingService } from "../service.js";

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function describe(session: MeetingSession, now: number): string {
  const label = MEETING_PLATFORM_LABELS[session.platform];
  const since = session.activeAt ?? session.requestedAt;
  const present = session.participants.filter(
    (p) => p.leftAtMs === undefined,
  ).length;
  return `- ${label} ${session.nativeMeetingId} (${session.meetingUrl}) — status ${session.status}, ${formatDuration(now - since)} elapsed, ${present} participant(s) present, transcript ${session.transcriptId ?? "pending"}`;
}

export const activeMeetingsProvider: Provider = {
  name: "ACTIVE_MEETINGS",
  description:
    "Meetings the notetaker bot is currently attending and transcribing",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const service = runtime.getService<MeetingService>("meetings");
    const active = service?.listSessions({ active: true }) ?? [];
    if (active.length === 0) {
      return { text: "", values: {}, data: { activeMeetings: [] } };
    }
    const now = Date.now();
    const text = [
      `The agent is currently attending ${active.length} meeting(s) as a notetaker bot:`,
      ...active.map((s) => describe(s, now)),
    ].join("\n");
    return {
      text,
      values: { activeMeetingCount: active.length },
      data: { activeMeetings: active },
    };
  },
};
