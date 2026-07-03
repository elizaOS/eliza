/**
 * `GET_MEETING_TRANSCRIPT` — return the (live or final) transcript text of a
 * meeting the bot attended. Targets the session named by URL/sessionId when
 * given, otherwise the most recent session that has a transcript.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { MEETING_PLATFORM_LABELS, type MeetingSession } from "@elizaos/shared";
import { transcriptPlainText } from "@elizaos/shared/transcripts";
import type { MeetingService } from "../service.js";
import { readTranscriptRow } from "../transcripts/meeting-transcript-writer.js";
import { messageText, optionString, resolveMeetingUrl } from "./shared.js";

/** Cap the inline reply; the full record lives in the Transcripts view. */
const MAX_REPLY_CHARS = 4_000;

function pickTarget(
  sessions: MeetingSession[],
  message: Memory,
  options: unknown,
): MeetingSession | null {
  const sessionId = optionString(options, "sessionId");
  if (sessionId) return sessions.find((s) => s.id === sessionId) ?? null;
  const parsed = resolveMeetingUrl(message, options);
  if (parsed) {
    return (
      sessions.find(
        (s) =>
          s.platform === parsed.platform &&
          s.nativeMeetingId === parsed.nativeMeetingId,
      ) ?? null
    );
  }
  return sessions[0] ?? null;
}

async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: unknown,
  options?: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const service = runtime.getService<MeetingService>("meetings");
  if (!service) {
    const out = "The meetings service isn't running.";
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  const target = pickTarget(service.listSessions(), message, options);
  if (!target?.transcriptId) {
    const out = "I haven't attended a meeting with a transcript yet.";
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  const row = await runtime.getMemoryById(target.transcriptId as UUID);
  const transcript = row ? readTranscriptRow(row) : null;
  if (!transcript) {
    const out = `The transcript record for that meeting (${target.transcriptId}) is missing.`;
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  const text = transcriptPlainText(transcript.segments);
  const label = `${MEETING_PLATFORM_LABELS[target.platform]} ${target.nativeMeetingId}`;
  if (!text) {
    const out = `No speech has been transcribed in the ${label} meeting yet (status: ${transcript.status}).`;
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  const clipped =
    text.length > MAX_REPLY_CHARS
      ? `${text.slice(0, MAX_REPLY_CHARS)}\n… (truncated — open transcript ${transcript.id} in the Transcripts view for the full record)`
      : text;
  const out = `Transcript of the ${label} meeting (${transcript.status}):\n\n${clipped}`;
  await callback?.({ text: out });
  return {
    success: true,
    text: out,
    data: { sessionId: target.id, transcriptId: transcript.id },
  };
}

export const getMeetingTranscriptAction: Action = {
  name: "GET_MEETING_TRANSCRIPT",
  similes: ["MEETING_NOTES", "SHOW_MEETING_TRANSCRIPT"],
  description:
    "Retrieve the live or final transcript of a meeting the notetaker bot attended.",
  validate: async (runtime, message) => {
    const service = runtime.getService<MeetingService>("meetings");
    if (!service || service.listSessions().length === 0) return false;
    return /\b(transcript|notes|what.*(said|discussed|talked))\b/i.test(
      messageText(message),
    );
  },
  handler,
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "What was said in the meeting? Show me the transcript",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Here's the transcript of the Google Meet meeting…",
          actions: ["GET_MEETING_TRANSCRIPT"],
        },
      },
    ],
  ],
};
