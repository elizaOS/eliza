/**
 * `LEAVE_MEETING` — pull the notetaker bot out of an active meeting. Targets
 * the meeting named by URL/sessionId when given, otherwise the single active
 * session; asks for disambiguation when several are active.
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
import type { MeetingService } from "../service.js";
import { messageText, optionString, resolveMeetingUrl } from "./shared.js";

function pickTarget(
  active: MeetingSession[],
  message: Memory,
  options: unknown,
): MeetingSession | "ambiguous" | null {
  const sessionId = optionString(options, "sessionId");
  if (sessionId) return active.find((s) => s.id === sessionId) ?? null;
  const parsed = resolveMeetingUrl(message, options);
  if (parsed) {
    return (
      active.find(
        (s) =>
          s.platform === parsed.platform &&
          s.nativeMeetingId === parsed.nativeMeetingId,
      ) ?? null
    );
  }
  if (active.length === 1) return active[0];
  return active.length === 0 ? null : "ambiguous";
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
  const active = service.listSessions({ active: true });
  const target = pickTarget(active, message, options);
  if (target === null) {
    const out = "I'm not in that meeting right now — nothing to leave.";
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  if (target === "ambiguous") {
    const list = active
      .map((s) => `${MEETING_PLATFORM_LABELS[s.platform]} ${s.nativeMeetingId}`)
      .join(", ");
    const out = `I'm in ${active.length} meetings (${list}) — which one should I leave?`;
    await callback?.({ text: out });
    return { success: false, text: out };
  }
  service.stopSession(target.id as UUID);
  const out = `Leaving the ${MEETING_PLATFORM_LABELS[target.platform]} meeting ${target.nativeMeetingId}. The transcript is saved in the Transcripts view.`;
  await callback?.({ text: out });
  return {
    success: true,
    text: out,
    data: { sessionId: target.id, transcriptId: target.transcriptId },
  };
}

export const leaveMeetingAction: Action = {
  name: "LEAVE_MEETING",
  similes: ["EXIT_MEETING", "STOP_MEETING_TRANSCRIPTION"],
  description:
    "Leave a meeting the notetaker bot is currently attending and finalize its transcript.",
  validate: async (runtime, message) => {
    const service = runtime.getService<MeetingService>("meetings");
    if (!service) return false;
    if (service.listSessions({ active: true }).length === 0) return false;
    return /\b(leave|exit|stop|end|drop)\b/i.test(messageText(message));
  },
  handler,
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "You can leave the meeting now, thanks" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Leaving the meeting — the transcript is saved in the Transcripts view.",
          actions: ["LEAVE_MEETING"],
        },
      },
    ],
  ],
};
