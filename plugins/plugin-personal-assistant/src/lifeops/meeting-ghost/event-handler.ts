/**
 * Runtime event bridge from finalized meeting transcripts into LifeOps
 * post-meeting ownership.
 *
 * The meetings plugin owns capture and transcript persistence; this bridge owns
 * interpreting an owner-skipped meeting into approvals and ledger rows when the
 * join request supplied ghost-attendance context.
 */
import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import type {
  MeetingGhostAttendanceContext,
  MeetingTranscriptFinalizedPayload,
} from "@elizaos/shared";
import {
  type RunMeetingGhostInput,
  runMeetingGhostForTranscript,
} from "./consumer.js";
import type { MeetingGhostAttendee } from "./index.js";

const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FinalizedMeetingEvent = EventPayload & MeetingTranscriptFinalizedPayload;

function attendeeList(
  ghostAttendance: MeetingGhostAttendanceContext,
  payload: MeetingTranscriptFinalizedPayload,
): MeetingGhostAttendee[] {
  if (ghostAttendance.attendees && ghostAttendance.attendees.length > 0) {
    return ghostAttendance.attendees.map((attendee) => ({
      name: attendee.name,
      ...(attendee.email ? { email: attendee.email } : {}),
    }));
  }
  return payload.session.participants.map((participant) => ({
    name: participant.displayName,
  }));
}

export function meetingGhostInputFromFinalizedPayload(
  runtime: IAgentRuntime,
  payload: MeetingTranscriptFinalizedPayload,
): RunMeetingGhostInput | null {
  const ghostAttendance = payload.ghostAttendance;
  if (!ghostAttendance) return null;

  const approvalTtlMs =
    ghostAttendance.approvalTtlMs && ghostAttendance.approvalTtlMs > 0
      ? ghostAttendance.approvalTtlMs
      : DEFAULT_APPROVAL_TTL_MS;

  return {
    agentId: runtime.agentId,
    owner: {
      ownerUserId: ghostAttendance.ownerUserId,
      ownerDisplayName: ghostAttendance.ownerDisplayName,
      requestedBy: ghostAttendance.requestedBy ?? ghostAttendance.ownerUserId,
      careAbouts: ghostAttendance.careAbouts,
      ...(ghostAttendance.calendarId
        ? { calendarId: ghostAttendance.calendarId }
        : {}),
      approvalExpiresAt: new Date(Date.now() + approvalTtlMs),
    },
    transcript: {
      meetingId: payload.session.id,
      title: payload.transcript.title,
      startedAt: new Date(payload.transcript.createdAt).toISOString(),
      attendees: attendeeList(ghostAttendance, payload),
      segments: payload.transcript.segments,
    },
  };
}

export async function handleMeetingTranscriptFinalized(
  payload: FinalizedMeetingEvent,
): Promise<void> {
  const input = meetingGhostInputFromFinalizedPayload(payload.runtime, payload);
  if (!input) return;
  await runMeetingGhostForTranscript(payload.runtime, input);
}
