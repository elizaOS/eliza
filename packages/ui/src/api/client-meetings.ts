/**
 * Meeting-bot API client methods (#11856) — request / list / get / stop over
 * `/api/meetings`. Declaration-merged onto `ElizaClient` (the side-effect
 * import in `client.ts` installs the prototype methods), matching
 * `client-transcripts.ts` and the other `client-*` domain modules.
 *
 * Also exports the runtime guards that narrow the untyped agent-WebSocket
 * envelope (`onWsEvent` hands the UI `Record<string, unknown>`) into the
 * shared `MeetingWsEvent` shapes.
 */

import type {
  MeetingJoinRequest,
  MeetingSession,
  MeetingStatusEvent,
  MeetingTranscriptEvent,
} from "@elizaos/shared";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { ElizaClient } from "./client-base";

/** Options for listing meeting sessions. */
export interface ListMeetingsOptions {
  /** When true, only sessions that are not yet ended/failed. */
  active?: boolean;
}

declare module "./client-base" {
  interface ElizaClient {
    requestMeetingBot(
      input: MeetingJoinRequest,
    ): Promise<{ session: MeetingSession }>;
    listMeetings(
      options?: ListMeetingsOptions,
    ): Promise<{ sessions: MeetingSession[] }>;
    getMeeting(id: string): Promise<{ session: MeetingSession }>;
    stopMeeting(id: string): Promise<{ ok: boolean }>;
  }
}

ElizaClient.prototype.requestMeetingBot = async function (
  this: ElizaClient,
  input: MeetingJoinRequest,
) {
  return this.fetch("/api/meetings", {
    method: "POST",
    body: JSON.stringify(input),
  });
};

ElizaClient.prototype.listMeetings = async function (
  this: ElizaClient,
  options?: ListMeetingsOptions,
) {
  const q = options?.active ? "?active=1" : "";
  return this.fetch(`/api/meetings${q}`);
};

ElizaClient.prototype.getMeeting = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(`/api/meetings/${encodeURIComponent(id)}`);
};

ElizaClient.prototype.stopMeeting = async function (
  this: ElizaClient,
  id: string,
) {
  return this.fetch(`/api/meetings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

function isSegmentArray(value: unknown): value is TranscriptSegment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { id?: unknown }).id === "string" &&
        typeof (s as { text?: unknown }).text === "string",
    )
  );
}

/** Narrow a ws envelope into a live-transcript event, or null when malformed. */
export function parseMeetingTranscriptEvent(
  data: Record<string, unknown>,
): MeetingTranscriptEvent | null {
  if (
    data.type !== "meeting-transcript" ||
    typeof data.sessionId !== "string" ||
    typeof data.transcriptId !== "string" ||
    !isSegmentArray(data.confirmed) ||
    !isSegmentArray(data.pending)
  ) {
    return null;
  }
  return {
    type: "meeting-transcript",
    sessionId: data.sessionId,
    transcriptId: data.transcriptId,
    confirmed: data.confirmed,
    pending: data.pending,
  };
}

/** Narrow a ws envelope into a session-status event, or null when malformed. */
export function parseMeetingStatusEvent(
  data: Record<string, unknown>,
): MeetingStatusEvent | null {
  if (data.type !== "meeting-status") return null;
  const session = data.session;
  if (
    typeof session !== "object" ||
    session === null ||
    typeof (session as { id?: unknown }).id === "undefined"
  ) {
    return null;
  }
  return { type: "meeting-status", session: session as MeetingSession };
}
