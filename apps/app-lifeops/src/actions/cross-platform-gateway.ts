import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  Role,
  State,
  UUID,
} from "@elizaos/core";
import {
  ChannelType,
  ModelType,
  Role,
  parseJSONObjectFromText,
  parseKeyValueXml,
  stringToUuid,
} from "@elizaos/core";
import { recentConversationTexts } from "./life-recent-context.js";
import { hasLifeOpsAccess, messageText } from "./lifeops-google-helpers.js";
import { broadcastIntent } from "../lifeops/intent-sync.js";

type GatewaySubaction = "create_group_chat" | "escalate_to_user";

type GatewayPlan = {
  subaction: GatewaySubaction | null;
  platform?: string;
  participants?: string[];
  title?: string;
  reason?: string;
  shouldAct?: boolean | null;
  response?: string;
};

type GatewayParams = {
  subaction?: GatewaySubaction;
  platform?: string;
  participants?: string[];
  title?: string;
  reason?: string;
};

type RuntimeLike = IAgentRuntime & {
  ensureWorldExists?: (world: {
    id: UUID;
    name: string;
    agentId: UUID;
    messageServerId: UUID;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  getWorld?: (id: UUID) => Promise<{
    id: UUID;
    name?: string;
    agentId?: UUID;
    messageServerId?: UUID;
    metadata?: Record<string, unknown>;
  } | null>;
  createWorld?: (world: {
    id: UUID;
    name: string;
    agentId: UUID;
    messageServerId: UUID;
    metadata?: Record<string, unknown>;
  }) => Promise<UUID>;
  createRoomParticipants?: (entityIds: UUID[], roomId: UUID) => Promise<UUID[]>;
  getParticipantsForRoom?: (roomId: UUID) => Promise<UUID[]>;
  getEntityById?: (entityId: UUID) => Promise<{ id: UUID } | null>;
};

function normalizeSubaction(value: unknown): GatewaySubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "create_group_chat" ||
    normalized === "group_chat" ||
    normalized === "create_handoff"
  ) {
    return "create_group_chat";
  }
  if (
    normalized === "escalate_to_user" ||
    normalized === "escalate" ||
    normalized === "handoff_to_user"
  ) {
    return "escalate_to_user";
  }
  return null;
}

function normalizePlatform(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeParticipants(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  return raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function uniqueStable(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    output.push(value.trim());
  }
  return output;
}

function prettyPlatform(value: string): string {
  if (value === "discord") return "Discord";
  if (value === "telegram") return "Telegram";
  if (value === "whatsapp") return "WhatsApp";
  if (value === "signal") return "Signal";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function participantEntityId(
  runtime: IAgentRuntime,
  platform: string,
  name: string,
): UUID {
  return stringToUuid(
    `lifeops-cross-platform-participant:${runtime.agentId}:${platform}:${name.trim().toLowerCase()}`,
  ) as UUID;
}

async function resolveGatewayPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<GatewayPlan> {
  const currentText = messageText(args.message).trim();
  const recent = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 8,
  });
  const prompt = [
    "Plan the cross-platform gateway action for this owner request.",
    "Return ONLY valid JSON with exactly these fields:",
    "  subaction: create_group_chat, escalate_to_user, or null",
    "  platform: connector name like discord, telegram, whatsapp, or signal",
    "  participants: array of human participant names (do not include the owner or the assistant unless explicitly named as participants)",
    "  title: optional short group-chat title",
    "  reason: short summary of why the user needs to be brought back in",
    "  shouldAct: boolean",
    "  response: short follow-up when shouldAct is false or details are missing",
    "",
    "Use create_group_chat when the owner wants a real shared chat or handoff thread created on a messaging platform.",
    "Use escalate_to_user when the owner is asking the assistant to do something that requires the owner's direct negotiation, signature, or personal intervention.",
    "",
    "Examples:",
    '  "Create a group chat with the agent and Alice on Discord." -> {"subaction":"create_group_chat","platform":"discord","participants":["Alice"],"title":"Discord handoff with Alice","reason":null,"shouldAct":true,"response":null}',
    '  "Negotiate my lease renewal with the landlord and sign it for me." -> {"subaction":"escalate_to_user","platform":null,"participants":[],"title":null,"reason":"Lease renewal requires the owner to negotiate and sign directly.","shouldAct":true,"response":null}',
    '  "Help with cross-platform messaging." -> {"subaction":null,"platform":null,"participants":[],"title":null,"reason":null,"shouldAct":false,"response":"Do you want me to create a shared group chat handoff, or escalate something back to you for direct action?"}',
    "",
    `Current request: ${JSON.stringify(currentText)}`,
    `Recent conversation: ${JSON.stringify(recent.join("\n"))}`,
  ].join("\n");

  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed =
      parseKeyValueXml<Record<string, unknown>>(
        typeof raw === "string" ? raw : "",
      ) ?? parseJSONObjectFromText(typeof raw === "string" ? raw : "");
    if (!parsed) {
      return { subaction: null, shouldAct: null };
    }
    return {
      subaction: normalizeSubaction(parsed.subaction),
      platform: normalizePlatform(parsed.platform),
      participants: uniqueStable(normalizeParticipants(parsed.participants)),
      title: normalizeOptionalString(parsed.title),
      reason: normalizeOptionalString(parsed.reason),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizeOptionalString(parsed.response),
    };
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:cross-platform-gateway",
        error: error instanceof Error ? error.message : String(error),
      },
      "cross-platform gateway planning failed",
    );
    return { subaction: null, shouldAct: null };
  }
}

async function ensureEntity(
  runtime: RuntimeLike,
  entityId: UUID,
  name: string,
): Promise<void> {
  const existing = await runtime.getEntityById?.(entityId);
  if (existing) return;
  await runtime.createEntity({
    id: entityId,
    names: [name],
    agentId: runtime.agentId,
    metadata: {
      source: "cross_platform_gateway",
    },
  });
}

async function ensureWorld(
  runtime: RuntimeLike,
  args: {
    worldId: UUID;
    worldName: string;
    ownerId: UUID;
  },
): Promise<void> {
  const metadata = {
    ownership: { ownerId: args.ownerId },
    roles: {
      [args.ownerId]: "OWNER",
      [runtime.agentId]: "ADMIN",
    } as Record<string, Role>,
    roleSources: {
      [args.ownerId]: "owner",
      [runtime.agentId]: "agent",
    },
    type: "cross_platform_group_handoff",
  };

  if (typeof runtime.ensureWorldExists === "function") {
    await runtime.ensureWorldExists({
      id: args.worldId,
      name: args.worldName,
      agentId: runtime.agentId,
      messageServerId: args.ownerId,
      metadata,
    });
    return;
  }

  const existing = await runtime.getWorld?.(args.worldId);
  if (existing) {
    const currentMetadata =
      existing.metadata && typeof existing.metadata === "object"
        ? existing.metadata
        : {};
    await runtime.updateWorld?.({
      ...existing,
      id: args.worldId,
      name: args.worldName,
      agentId: runtime.agentId,
      messageServerId: args.ownerId,
      metadata,
    });
    return;
  }

  if (typeof runtime.createWorld === "function") {
    await runtime.createWorld({
      id: args.worldId,
      name: args.worldName,
      agentId: runtime.agentId,
      messageServerId: args.ownerId,
      metadata,
    });
  }
}

async function addMissingParticipants(
  runtime: RuntimeLike,
  roomId: UUID,
  entityIds: UUID[],
): Promise<void> {
  const existing = new Set(await runtime.getParticipantsForRoom?.(roomId));
  const missing = entityIds.filter((entityId) => !existing.has(entityId));
  if (missing.length === 0) return;
  if (typeof runtime.createRoomParticipants === "function") {
    await runtime.createRoomParticipants(missing, roomId);
    return;
  }
  for (const entityId of missing) {
    await runtime.addParticipant(entityId, roomId);
  }
}

export const crossPlatformGatewayAction: Action = {
  name: "CROSS_PLATFORM_GATEWAY",
  similes: [
    "GROUP_CHAT_HANDOFF",
    "CREATE_GROUP_CHAT",
    "ESCALATE_TO_USER",
    "CROSS_PLATFORM_HANDOFF",
  ],
  description:
    "Create a real cross-platform group handoff room or escalate a request back to the owner when direct user action is required. " +
    "Use this for requests like 'create a group chat with Alice on Discord' or for impossible delegate requests that require the owner's negotiation or signature, such as 'negotiate my lease renewal and sign it for me'. " +
    "Do not route these through OWNER_INBOX or generic reply fallbacks.",
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const runtimeLike = runtime as RuntimeLike;
    const params = ((options as { parameters?: GatewayParams } | undefined)
      ?.parameters ?? {}) as GatewayParams;
    const planned = await resolveGatewayPlan({ runtime, message, state });

    const subaction =
      normalizeSubaction(params.subaction) ?? planned.subaction;
    if (!subaction || planned.shouldAct === false) {
      return {
        success: false,
        text:
          planned.response ??
          "Do you want me to create a shared group chat handoff, or escalate this back to you for direct action?",
        data: {
          actionName: "CROSS_PLATFORM_GATEWAY",
          needsClarification: true,
        },
      };
    }

    if (subaction === "escalate_to_user") {
      const requestText = messageText(message).trim();
      const reason =
        normalizeOptionalString(params.reason) ??
        planned.reason ??
        "This requires the owner's direct action.";
      const title = normalizeOptionalString(params.title) ?? "Owner action needed";
      const intent = await broadcastIntent(runtime, {
        kind: "user_action_requested",
        target: "all",
        priority: "high",
        title,
        body: `${reason}\n\nRequest: ${requestText}`,
        metadata: {
          sourceAction: "CROSS_PLATFORM_GATEWAY",
          subaction,
          requestText,
          reason,
        },
      });
      return {
        success: true,
        text: `Escalated this back to you for direct action: ${reason}`,
        data: {
          actionName: "CROSS_PLATFORM_GATEWAY",
          subaction,
          intentId: intent.id,
          kind: intent.kind,
          title: intent.title,
          body: intent.body,
        },
      };
    }

    const platform =
      normalizePlatform(params.platform) ?? planned.platform ?? "discord";
    const participants = uniqueStable([
      ...normalizeParticipants(params.participants),
      ...(planned.participants ?? []),
    ]).filter((name) => {
      const normalized = name.trim().toLowerCase();
      return normalized !== "agent" && normalized !== "assistant";
    });

    if (participants.length === 0) {
      return {
        success: false,
        text:
          planned.response ??
          "Who should I add to the shared group chat handoff?",
        data: {
          actionName: "CROSS_PLATFORM_GATEWAY",
          subaction,
          needsClarification: true,
        },
      };
    }

    const ownerId = (message.entityId ?? runtime.agentId) as UUID;
    const participantKey = [...participants]
      .map((entry) => entry.trim().toLowerCase())
      .sort()
      .join("|");
    const worldId = stringToUuid(
      `lifeops-group-handoff-world:${runtime.agentId}:${platform}:${ownerId}:${participantKey}`,
    ) as UUID;
    const roomId = stringToUuid(
      `lifeops-group-handoff-room:${runtime.agentId}:${platform}:${ownerId}:${participantKey}`,
    ) as UUID;
    const roomName =
      normalizeOptionalString(params.title) ??
      planned.title ??
      `${prettyPlatform(platform)} handoff with ${participants.join(", ")}`;

    await ensureWorld(runtimeLike, {
      worldId,
      worldName: `${prettyPlatform(platform)} Group Handoff`,
      ownerId,
    });

    let room = await runtime.getRoom(roomId);
    if (!room) {
      await runtime.createRoom({
        id: roomId,
        name: roomName,
        source: platform,
        type: ChannelType.GROUP,
        channelId: `${platform}:handoff:${participantKey}`,
        worldId,
        messageServerId: ownerId,
      });
      room = await runtime.getRoom(roomId);
    }

    const participantEntityIds: UUID[] = [];
    for (const participant of participants) {
      const entityId = participantEntityId(runtime, platform, participant);
      await ensureEntity(runtimeLike, entityId, participant);
      participantEntityIds.push(entityId);
    }
    await addMissingParticipants(runtimeLike, roomId, [
      ownerId,
      runtime.agentId,
      ...participantEntityIds,
    ]);

    return {
      success: true,
      text: `Created a ${prettyPlatform(platform)} group handoff with ${participants.join(", ")}.`,
      data: {
        actionName: "CROSS_PLATFORM_GATEWAY",
        subaction,
        platform,
        worldId,
        roomId,
        roomName: room?.name ?? roomName,
        participants,
        participantEntityIds,
      },
    };
  },
};
