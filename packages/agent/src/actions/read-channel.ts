import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Room,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { formatSpeakerLabel } from "../shared/conversation-format.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";
import { extractActionParamsViaLlm } from "./extract-params.js";

type ReadChannelParams = {
  source?: string;
  channel?: string;
  range?: "recent" | "dates";
  from?: string;
  to?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function formatMessagesWithLineNumbers(
  memories: Memory[],
  runtime: IAgentRuntime,
): string {
  const lines: string[] = [];
  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const speaker = formatSpeakerLabel(runtime, mem);
    const ts = mem.createdAt
      ? new Date(mem.createdAt).toISOString().slice(0, 19)
      : "";
    const text = (mem.content?.text ?? "").slice(0, 500);
    lines.push(`${String(i + 1).padStart(3, " ")} | ${ts} ${speaker}: ${text}`);
  }
  return lines.join("\n");
}

async function resolveChannelRoom(
  runtime: IAgentRuntime,
  source: string | undefined,
  channel: string | undefined,
): Promise<Room | null> {
  if (!channel) return null;

  // Try direct room lookup by ID
  try {
    const room = await runtime.getRoom(channel as UUID);
    if (room) return room;
  } catch {
    // Not a valid UUID, try name lookup
  }

  // Search through worlds for matching room name/source
  // We scan rooms the agent participates in
  const agentRooms = await runtime.getRoomsForParticipant(runtime.agentId);
  for (const roomId of agentRooms) {
    try {
      const room = await runtime.getRoom(roomId);
      if (!room) continue;

      const roomRecord = room as Room & { name?: string; source?: string };
      const roomName = (roomRecord.name ?? "").toLowerCase();
      const roomSource = (roomRecord.source ?? room.type ?? "").toLowerCase();
      const channelLower = channel.toLowerCase();

      // Match by name
      if (roomName === channelLower || roomName.includes(channelLower)) {
        // If source specified, also match source
        if (source && roomSource !== source.toLowerCase()) continue;
        return room;
      }
    } catch {}
  }

  return null;
}

function parseDateParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // Try as ISO date string
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  // Try as unix timestamp
  const num = Number(value);
  if (!Number.isNaN(num)) return num > 1e12 ? num : num * 1000;
  return undefined;
}

export const readChannelAction: Action = {
  name: "READ_CHANNEL",
  contexts: ["messaging", "social_posting", "connectors", "documents"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "READ_CHAT",
    "GET_CHANNEL",
    "VIEW_CHANNEL",
    "CHANNEL_HISTORY",
    "READ_ROOM",
  ],
  description:
    "Read messages from a channel on any connected platform. " +
    "Default: recent messages. Supports date ranges and message limits. " +
    "Results include line numbers for easy reference when copying to clipboard.",
  descriptionCompressed:
    "read message channel connect platform default: recent message support date range message limit result include line number easy reference copy clipboard",

  validate: async (_runtime, message, state) => {
    return hasContextSignalSyncForKey(message, state, "read_channel");
  },

  handler: async (runtime, message, state, options) => {
    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as ReadChannelParams;
    const params = (await extractActionParamsViaLlm<ReadChannelParams>({
      runtime,
      message,
      state,
      actionName: "READ_CHANNEL",
      actionDescription: readChannelAction.description ?? "",
      paramSchema: readChannelAction.parameters ?? [],
      existingParams: rawParams,
      requiredFields: ["channel"],
    })) as ReadChannelParams;
    const { source, channel, range = "recent" } = params;
    const limit = Math.min(
      Math.max(1, params.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    if (!channel) {
      return {
        text: "READ_CHANNEL requires a channel parameter (channel name, ID, or room ID).",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "READ_CHANNEL" },
      };
    }

    const room = await resolveChannelRoom(runtime, source, channel);
    if (!room) {
      return {
        text: `Could not find channel "${channel}"${source ? ` on ${source}` : ""}. Check the channel name or ID.`,
        success: false,
        values: { success: false, error: "CHANNEL_NOT_FOUND" },
        data: { actionName: "READ_CHANNEL", channel, source },
      };
    }

    try {
      const queryParams: Record<string, unknown> = {
        tableName: "messages",
        roomId: room.id,
        limit,
        orderBy: "createdAt" as const,
        orderDirection: "desc" as const,
      };

      // Apply date range filters
      if (range === "dates") {
        const fromTs = parseDateParam(params.from);
        const toTs = parseDateParam(params.to);
        if (fromTs) queryParams.start = fromTs;
        if (toTs) queryParams.end = toTs;
      }

      const rawMemories = (await runtime.getMemories(
        queryParams as Parameters<typeof runtime.getMemories>[0],
      )) as Memory[];

      // Enforce limit client-side (some adapters may not honour it)
      const memories = rawMemories.slice(0, limit);

      // Reverse to show oldest first (chronological order)
      memories.reverse();

      if (memories.length === 0) {
        return {
          text: `No messages found in channel "${channel}".`,
          success: true,
          values: { success: true, messageCount: 0 },
          data: { actionName: "READ_CHANNEL", channel, roomId: room.id },
        };
      }

      const formatted = formatMessagesWithLineNumbers(memories, runtime);
      const roomRecord = room as Room & { name?: string; source?: string };
      const header = `Channel: ${roomRecord.name ?? channel} (${roomRecord.source ?? room.type ?? "chat"}) | ${memories.length} messages`;
      const footer =
        "\nTo save relevant sections to clipboard, use CLIPBOARD_WRITE with the line range (e.g. lines 12-25).";

      return {
        text: `${header}\n${"─".repeat(60)}\n${formatted}\n${footer}`,
        success: true,
        values: {
          success: true,
          messageCount: memories.length,
          channelName: roomRecord.name ?? channel,
        },
        data: {
          actionName: "READ_CHANNEL",
          channel,
          roomId: room.id,
          messages: memories.map((m, i) => ({
            line: i + 1,
            id: m.id,
            entityId: m.entityId,
            text: m.content?.text,
            createdAt: m.createdAt,
          })),
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("[READ_CHANNEL] Error:", errMsg);
      return {
        text: `Failed to read channel: ${errMsg}`,
        success: false,
        values: { success: false, error: "READ_FAILED" },
        data: { actionName: "READ_CHANNEL", channel },
      };
    }
  },

  parameters: [
    {
      name: "source",
      description:
        'Platform source (e.g. "discord", "telegram"). Optional — omit to search all platforms.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "channel",
      description: "Channel name, channel ID, or room ID to read from.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "range",
      description:
        'How to select messages. "recent" (default) = latest messages. "dates" = by date range using from/to.',
      required: false,
      schema: {
        type: "string" as const,
        enum: ["recent", "dates"],
      },
    },
    {
      name: "from",
      description:
        "Start date/timestamp for date range queries (ISO string or unix timestamp).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "to",
      description:
        "End date/timestamp for date range queries (ISO string or unix timestamp).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description:
        "Maximum number of messages to return (default 50, max 200).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's been going on in the #dev-ops Discord channel lately?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Channel: dev-ops (discord) | 20 messages\n  1 | 2026-04-18 alice: rolling out the new deploy pipeline tomorrow",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Pull messages from the general chat between April 10 and April 15.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Channel: general (slack) | 42 messages",
        },
      },
    ],
  ] as ActionExample[][],
};
