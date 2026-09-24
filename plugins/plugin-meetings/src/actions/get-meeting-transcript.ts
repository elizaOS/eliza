/**
 * `GET_MEETING_TRANSCRIPT` — return the (live or final) transcript text of a
 * meeting the bot attended. Targets the session named by URL/sessionId when
 * given, otherwise the most recent session that has a transcript.
 */
import { MEETING_PLATFORM_LABELS } from "@elizaos/core/meetings";
import { messageText } from "./shared.js";
import { readTranscriptRow } from "../transcripts/meeting-transcript-writer.js";
import { reply } from "./shared.js";
import { requireMeetingService } from "./shared.js";
import { resolveTargetSession } from "./shared.js";
import { transcriptPlainText } from "@elizaos/core/transcripts";
import { type Action } from "@elizaos/core";
import { type ActionResult } from "@elizaos/core";
import { type HandlerCallback } from "@elizaos/core";
import { type IAgentRuntime } from "@elizaos/core";
import { type MeetingService } from "../service.js";
import { type Memory } from "@elizaos/core";
import { type UUID } from "@elizaos/core";
async function handler(runtime: IAgentRuntime, message: Memory, _state?: unknown, options?: unknown, callback?: HandlerCallback): Promise<ActionResult> {
    const svc = await requireMeetingService(runtime, callback, "The meetings service isn't running.");
    if ("bail" in svc)
        return svc.bail;
    const target = resolveTargetSession(svc.service.listSessions(), message, options, "most-recent");
    if (!target || target === "ambiguous" || !target.transcriptId) {
        return reply(callback, false, "I haven't attended a meeting with a transcript yet.");
    }
    const row = await runtime.getMemoryById(target.transcriptId as UUID);
    const transcript = row ? readTranscriptRow(row) : null;
    if (!transcript) {
        return reply(callback, false, `The transcript record for that meeting (${target.transcriptId}) is missing.`);
    }
    const text = transcriptPlainText(transcript.segments);
    const label = `${MEETING_PLATFORM_LABELS[target.platform]} ${target.nativeMeetingId}`;
    if (!text) {
        return reply(callback, false, `No speech has been transcribed in the ${label} meeting yet (status: ${transcript.status}).`);
    }
    return reply(callback, true, `Transcript of the ${label} meeting (${transcript.status}):\n\n${text}`, { sessionId: target.id, transcriptId: transcript.id });
}
export const getMeetingTranscriptAction: Action = {
    name: "GET_MEETING_TRANSCRIPT",
    similes: ["MEETING_NOTES", "SHOW_MEETING_TRANSCRIPT"],
    description: "Retrieve the live or final transcript of a meeting the notetaker bot attended.",
    validate: async (runtime, message) => {
        const service = runtime.getService<MeetingService>("meetings");
        if (!service || service.listSessions().length === 0)
            return false;
        return /\b(transcript|notes|what.*(said|discussed|talked))\b/i.test(messageText(message));
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
