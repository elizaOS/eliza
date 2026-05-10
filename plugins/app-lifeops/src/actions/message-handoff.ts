/**
 * `MESSAGE.handoff` action — handoff verb + resume actions per
 * `GAP_ASSESSMENT.md` §3.14 (closes J13 from `JOURNEY_GAME_THROUGH.md`).
 *
 * Verbs:
 *   - `enter` — flips the current room into handoff mode. The
 *     `RoomPolicyProvider` then gates further agent contributions until
 *     the resume condition fires.
 *   - `resume` — exits handoff mode for the current room (manual /
 *     explicit_resume).
 *   - `status` — returns the current handoff state for the room.
 *
 * Resume conditions per `GAP_ASSESSMENT.md` §3.14:
 *   { kind: "mention" }
 *   { kind: "explicit_resume" }
 *   { kind: "silence_minutes"; minutes: number }
 *   { kind: "user_request_help"; userId: string }
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  createHandoffStore,
  type ResumeCondition,
} from "../lifeops/handoff/store.js";

type HandoffVerb = "enter" | "resume" | "status";

interface HandoffActionInput {
  verb?: HandoffVerb;
  subaction?: HandoffVerb;
  reason?: string;
  /** The roomId to operate on; defaults to message.roomId. */
  roomId?: string;
  resumeOn?: ResumeCondition;
  /** Convenience shortcut — `resumeKind: "mention"` shorthand. */
  resumeKind?: ResumeCondition["kind"];
  /** For `silence_minutes`. */
  silenceMinutes?: number;
  /** For `user_request_help`. */
  userId?: string;
}

function asVerb(input: Partial<HandoffActionInput>): HandoffVerb | null {
  const candidate = input.verb ?? input.subaction;
  if (candidate === "enter" || candidate === "resume" || candidate === "status") {
    return candidate;
  }
  return null;
}

function buildResumeCondition(
  input: Partial<HandoffActionInput>,
): ResumeCondition | null {
  if (input.resumeOn) {
    const r = input.resumeOn;
    if (r.kind === "mention" || r.kind === "explicit_resume") {
      return { kind: r.kind };
    }
    if (
      r.kind === "silence_minutes" &&
      typeof r.minutes === "number" &&
      Number.isFinite(r.minutes) &&
      r.minutes > 0
    ) {
      return { kind: "silence_minutes", minutes: r.minutes };
    }
    if (
      r.kind === "user_request_help" &&
      typeof r.userId === "string" &&
      r.userId.length > 0
    ) {
      return { kind: "user_request_help", userId: r.userId };
    }
  }
  if (input.resumeKind === "mention" || input.resumeKind === "explicit_resume") {
    return { kind: input.resumeKind };
  }
  if (
    input.resumeKind === "silence_minutes" &&
    typeof input.silenceMinutes === "number" &&
    Number.isFinite(input.silenceMinutes) &&
    input.silenceMinutes > 0
  ) {
    return { kind: "silence_minutes", minutes: input.silenceMinutes };
  }
  if (
    input.resumeKind === "user_request_help" &&
    typeof input.userId === "string" &&
    input.userId.length > 0
  ) {
    return { kind: "user_request_help", userId: input.userId };
  }
  return null;
}

function resolveRoomId(
  message: Memory,
  override?: string,
): string | null {
  if (typeof override === "string" && override.length > 0) return override;
  const candidate = message.roomId;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return null;
}

export const messageHandoffAction: Action = {
  name: "MESSAGE_HANDOFF",
  similes: [
    // Cached planner outputs from the previous one-release window may still
    // emit the dotted name. Keep it as a simile so they continue to route.
    "MESSAGE.handoff",
    "HANDOFF",
    "HAND_OFF",
    "STEP_BACK",
    "LET_HUMAN_TAKE_OVER",
    "AGENT_STAND_DOWN",
    "RESUME_AGENT",
    "AGENT_COME_BACK",
  ],
  description:
    "Hand off a multi-party room to the human owner. Verbs: enter (agent stops contributing until the resume condition fires), resume (agent rejoins), status (report current handoff state).",
  descriptionCompressed:
    "room handoff: enter|resume|status; gates agent per resumeOn condition",
  tags: [
    "domain:meta",
    "capability:execute",
    "capability:update",
    "capability:read",
    "surface:internal",
  ],
  contexts: ["messaging", "automation"],
  validate: async () => true,
  parameters: [
    {
      name: "verb",
      description: "enter | resume | status",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Why the agent is stepping back (logged in HandoffStore).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "resumeKind",
      description:
        "mention | explicit_resume | silence_minutes | user_request_help",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "silenceMinutes",
      description: "Required when resumeKind=silence_minutes.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "userId",
      description: "Required when resumeKind=user_request_help.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "Override the room to operate on; defaults to message.roomId.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "I'll let you take it from here." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Stepping back. I'll re-engage when you @mention me.",
          action: "MESSAGE.handoff",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "agent come back" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Resumed.",
          action: "MESSAGE.handoff",
        },
      },
    ],
  ] as ActionExample[][],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Partial<HandoffActionInput>;
    const verb = asVerb(params);
    if (!verb) {
      const text = "MESSAGE.handoff requires verb = enter | resume | status.";
      await callback?.({ text });
      return { text, success: false, data: { error: "INVALID_VERB" } };
    }

    const roomId = resolveRoomId(message, params.roomId);
    if (!roomId) {
      const text = "MESSAGE.handoff requires a roomId (none on the message).";
      await callback?.({ text });
      return { text, success: false, data: { error: "NO_ROOM_ID" } };
    }

    const store = createHandoffStore(runtime);

    if (verb === "enter") {
      const resumeOn = buildResumeCondition(params) ?? { kind: "mention" };
      const reason =
        typeof params.reason === "string" && params.reason.trim().length > 0
          ? params.reason.trim()
          : "agent stepped back";
      await store.enter(roomId, { reason, resumeOn });
      const phrase =
        resumeOn.kind === "mention"
          ? "I'll re-engage when @-mentioned."
          : resumeOn.kind === "explicit_resume"
            ? "I'll wait for you to explicitly bring me back."
            : resumeOn.kind === "silence_minutes"
              ? `I'll re-engage after ${resumeOn.minutes} minute(s) of silence.`
              : `I'll re-engage when ${resumeOn.userId} asks for help.`;
      const text = `Stepping back. ${phrase}`;
      await callback?.({ text, data: { verb, roomId, reason, resumeOn } });
      return {
        text,
        success: true,
        data: { verb, roomId, reason, resumeOn },
      };
    }

    if (verb === "resume") {
      await store.exit(roomId);
      const text = "Resumed.";
      await callback?.({ text, data: { verb, roomId } });
      return { text, success: true, data: { verb, roomId } };
    }

    // verb === "status"
    const status = await store.status(roomId);
    const text = status.active
      ? `Handoff active in this room since ${status.enteredAt} (resume on: ${status.resumeOn?.kind ?? "?"}).`
      : "No handoff active in this room.";
    const data = { verb, roomId, status } as any;
    await callback?.({ text, data });
    return { text, success: true, data };
  },
};
