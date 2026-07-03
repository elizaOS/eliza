/**
 * `JOIN_MEETING` — send the notetaker bot into a Google Meet / Teams / Zoom
 * meeting from a chat message ("join this call: https://meet.google.com/…").
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import { MEETING_PLATFORM_LABELS } from "@elizaos/shared";
import { MeetingJoinError } from "../service.js";
import {
  optionString,
  reply,
  requireMeetingService,
  resolveMeetingUrl,
} from "./shared.js";

async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: unknown,
  options?: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const parsed = resolveMeetingUrl(message, options);
  if (!parsed) {
    return reply(
      callback,
      false,
      "I need a meeting link to join — paste a Google Meet, Microsoft Teams, or Zoom URL.",
    );
  }
  const svc = await requireMeetingService(
    runtime,
    callback,
    "The meetings service isn't running, so I can't join calls right now.",
  );
  if ("bail" in svc) return svc.bail;
  const service = svc.service;
  try {
    const session = await service.requestJoin({
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      botName: optionString(options, "botName") ?? undefined,
      language: optionString(options, "language") ?? undefined,
    });
    return reply(
      callback,
      true,
      `Joining the ${MEETING_PLATFORM_LABELS[session.platform]} meeting ${session.nativeMeetingId} as "${session.botName}". I'll transcribe it live — watch it land in the Transcripts view (transcript ${session.transcriptId}).`,
      { sessionId: session.id, transcriptId: session.transcriptId },
    );
  } catch (err) {
    const out =
      err instanceof MeetingJoinError
        ? `I can't join that meeting: ${err.message}`
        : `Joining the meeting failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "[MeetingService] JOIN_MEETING failed",
    );
    return reply(callback, false, out);
  }
}

export const joinMeetingAction: Action = {
  name: "JOIN_MEETING",
  similes: ["INVITE_TO_MEETING", "ATTEND_MEETING"],
  description:
    "Join a Google Meet, Microsoft Teams, or Zoom meeting as a notetaker bot and transcribe it live into the Transcripts view. Requires a meeting URL in the message or a meetingUrl parameter.",
  validate: async (_runtime, message, _state, options) =>
    resolveMeetingUrl(message, options) !== null,
  handler,
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Can you join this call and take notes? https://meet.google.com/abc-defg-hij",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Joining the Google Meet meeting abc-defg-hij as a notetaker — the live transcript will appear in the Transcripts view.",
          actions: ["JOIN_MEETING"],
        },
      },
    ],
  ],
};
