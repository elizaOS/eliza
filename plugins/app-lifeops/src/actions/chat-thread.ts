import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import {
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import { formatPromptSection } from "./lib/prompt-format.js";
import { recentConversationTexts } from "./lib/recent-context.js";
import { messageText } from "./lifeops-google-helpers.js";
import { scheduleOnceTriggerTask } from "./scheduled-trigger-task.js";

type ChatThreadOperation = "mute_chat" | "unmute_chat";

type ChatThreadParams = {
  operation?: ChatThreadOperation;
  platform?: string;
  chatName?: string;
  roomId?: string;
  durationMinutes?: number;
};

type ChatThreadPlan = {
  operation: ChatThreadOperation | null;
  platform?: string;
  chatName?: string;
  roomId?: string;
  durationMinutes?: number;
  shouldAct?: boolean | null;
  response?: string;
};

type RuntimeLike = IAgentRuntime & {
  getRoomsForParticipant?: (entityId: UUID) => Promise<UUID[]>;
};

function normalizeOperation(value: unknown): ChatThreadOperation | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "mute_chat" || normalized === "mute") return "mute_chat";
  if (
    normalized === "unmute_chat" ||
    normalized === "unmute" ||
    normalized === "restore_chat"
  ) {
    return "unmute_chat";
  }
  return null;
}

function normalizePlatform(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDurationMinutes(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

async function resolveChatThreadPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<ChatThreadPlan> {
  const currentText = messageText(args.message).trim();
  const recent = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 8,
  });
  const prompt = [
    "Plan a targeted local chat-thread control action.",
    "Return JSON only as a single object with exactly these fields:",
    "  operation: mute_chat, unmute_chat, or null",
    "  platform: connector name like telegram or discord",
    "  chatName: exact chat/channel title when present",
    "  roomId: explicit room id when the request already supplies one, otherwise null",
    "  durationMinutes: integer number of minutes when the user asks for a temporary mute, otherwise null",
    "  shouldAct: boolean",
    "  response: short follow-up if shouldAct is false or details are missing",
    "",
    "Use this action for targeted connector chat mute/unmute, especially when the user names a Telegram or Discord room that is not the current chat.",
    'Example: {"operation":"mute_chat","platform":"telegram","chatName":"crypto signals","roomId":null,"durationMinutes":1440,"shouldAct":true,"response":null}',
    "",
    formatPromptSection("Current request", currentText),
    formatPromptSection("Recent conversation", recent.join("\n")),
  ].join("\n");

  try {
    const raw = await runWithTrajectoryContext(
      { purpose: "lifeops-chat-thread" },
      () => args.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    const parsed = parseJsonModelRecord<Record<string, unknown>>(
      typeof raw === "string" ? raw : "",
    );
    if (!parsed) {
      return { operation: null, shouldAct: null };
    }
    return {
      operation: normalizeOperation(parsed.operation),
      platform: normalizePlatform(parsed.platform),
      chatName: normalizeString(parsed.chatName),
      roomId: normalizeString(parsed.roomId),
      durationMinutes: normalizeDurationMinutes(parsed.durationMinutes),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizeString(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:chat-thread",
        error: error instanceof Error ? error.message : String(error),
      },
      "chat thread control planning failed",
    );
    return { operation: null, shouldAct: null };
  }
}

function roomMatchesTarget(args: {
  room: Awaited<ReturnType<IAgentRuntime["getRoom"]>>;
  platform: string;
  roomId?: string;
  chatName?: string;
}): boolean {
  const room = args.room;
  if (!room) return false;
  if (
    normalizePlatform((room as { source?: unknown }).source) !== args.platform
  ) {
    return false;
  }
  if (args.roomId && room.id === args.roomId) {
    return true;
  }
  if (!args.chatName) {
    return false;
  }
  const lookup = args.chatName.trim().toLowerCase();
  const candidates = [
    typeof room.name === "string" ? room.name : "",
    typeof room.channelId === "string" ? room.channelId : "",
    typeof room.id === "string" ? room.id : "",
  ]
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return candidates.some(
    (candidate) => candidate === lookup || candidate.includes(lookup),
  );
}

async function resolveTargetRoom(args: {
  runtime: RuntimeLike;
  platform: string;
  roomId?: string;
  chatName?: string;
}): Promise<Awaited<ReturnType<IAgentRuntime["getRoom"]>> | null> {
  if (args.roomId) {
    return await args.runtime.getRoom(args.roomId as UUID);
  }
  const roomIds =
    (await args.runtime.getRoomsForParticipant?.(args.runtime.agentId)) ?? [];
  for (const roomId of roomIds) {
    const room = await args.runtime.getRoom(roomId);
    if (
      roomMatchesTarget({
        room,
        platform: args.platform,
        chatName: args.chatName,
      })
    ) {
      return room;
    }
  }
  return null;
}

export const chatThreadAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "CHAT_THREAD",
  similes: [
    "MUTE_CHAT",
    "UNMUTE_CHAT",
    "MUTE_TELEGRAM",
    "MUTE_DISCORD",
    "SILENCE_GROUP_CHAT",
  ],
  description:
    "Mute or unmute a specific connector chat that is not necessarily the current room, and optionally schedule an automatic unmute.",
  descriptionCompressed:
    "mute|unmute named connector chat (telegram|discord|...) not-current-room: mute_chat(target,duration?) unmute_chat(target) auto-unmute-schedule",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const runtimeLike = runtime as RuntimeLike;
    const params = ((options as { parameters?: ChatThreadParams } | undefined)
      ?.parameters ?? {}) as ChatThreadParams;
    const planned = await resolveChatThreadPlan({ runtime, message, state });
    const operation = normalizeOperation(params.operation) ?? planned.operation;
    const platform = normalizePlatform(params.platform) ?? planned.platform;
    const roomId = normalizeString(params.roomId) ?? planned.roomId;
    const chatName = normalizeString(params.chatName) ?? planned.chatName;
    const durationMinutes =
      normalizeDurationMinutes(params.durationMinutes) ??
      planned.durationMinutes;

    if (!operation || !platform || planned.shouldAct === false) {
      return {
        success: false,
        text:
          planned.response ??
          "Which chat should I control, and on which platform?",
        data: {
          actionName: "CHAT_THREAD",
          needsClarification: true,
        },
      };
    }

    const room = await resolveTargetRoom({
      runtime: runtimeLike,
      platform,
      roomId,
      chatName,
    });
    if (!room) {
      return {
        success: false,
        text: `I couldn't find that ${platform} chat yet.`,
        data: {
          actionName: "CHAT_THREAD",
          operation,
          platform,
          roomId: roomId ?? null,
          chatName: chatName ?? null,
          error: "ROOM_NOT_FOUND",
        },
      };
    }

    if (operation === "unmute_chat") {
      await runtime.updateParticipantUserState(room.id, runtime.agentId, null);
      return {
        success: true,
        text: `Unmuted ${room.name ?? chatName ?? "that chat"} on ${platform}.`,
        data: {
          actionName: "CHAT_THREAD",
          operation,
          platform,
          roomId: room.id,
          roomName: room.name ?? null,
          muted: false,
        },
      };
    }

    await runtime.updateParticipantUserState(room.id, runtime.agentId, "MUTED");

    let scheduledTaskId: UUID | undefined;
    let triggerId: UUID | undefined;
    let scheduledAtIso: string | undefined;
    let duplicateTaskId: UUID | undefined;
    if (durationMinutes && durationMinutes > 0) {
      scheduledAtIso = new Date(
        Date.now() + durationMinutes * 60_000,
      ).toISOString();
      const schedule = await scheduleOnceTriggerTask({
        runtime,
        message,
        displayName: `Unmute ${platform} chat: ${room.name ?? chatName ?? room.id}`,
        instructions: [
          "Run the queued connector chat unmute.",
          `Use CHAT_THREAD to unmute the ${platform} chat.`,
          `operation: unmute_chat`,
          `platform: ${platform}`,
          `roomId: ${room.id}`,
          `chatName: ${room.name ?? chatName ?? room.id}`,
        ].join("\n"),
        scheduledAtIso,
        dedupeKey: `chat-thread-control:${platform}:unmute:${room.id}:${scheduledAtIso}`,
      });
      scheduledTaskId = schedule.taskId;
      triggerId = schedule.triggerId;
      duplicateTaskId = schedule.duplicateTaskId;
    }

    return {
      success: true,
      text:
        durationMinutes && scheduledAtIso
          ? `Muted ${room.name ?? chatName ?? "that chat"} on ${platform} for ${durationMinutes} minutes.`
          : `Muted ${room.name ?? chatName ?? "that chat"} on ${platform}.`,
      data: {
        actionName: "CHAT_THREAD",
        operation,
        platform,
        roomId: room.id,
        roomName: room.name ?? null,
        muted: true,
        durationMinutes: durationMinutes ?? null,
        scheduledAtIso: scheduledAtIso ?? null,
        scheduledTaskId: scheduledTaskId ?? duplicateTaskId ?? null,
        triggerId: triggerId ?? null,
      },
    };
  },

  parameters: [
    {
      name: "operation",
      description: "mute_chat or unmute_chat when already known.",
      required: false,
      schema: { type: "string" as const, enum: ["mute_chat", "unmute_chat"] },
    },
    {
      name: "platform",
      description: "Connector id (telegram, discord, ...).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "chatName",
      description:
        "Channel or group title to match against joined rooms when roomId omitted.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "Exact room UUID when caller already knows it.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "durationMinutes",
      description:
        "Temporary mute window; schedules automatic unmute when set.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Mute the crypto signals Telegram channel for six hours.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Muted crypto signals on Telegram for 360 minutes.",
          action: "CHAT_THREAD",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Unmute #general on Discord now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Unmuted #general on Discord.",
          action: "CHAT_THREAD",
        },
      },
    ],
  ] as ActionExample[][],
};
