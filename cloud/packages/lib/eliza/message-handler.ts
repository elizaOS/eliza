/**
 * Message Handler - Processes messages through the elizaOS runtime message service.
 */

import {
  AgentRuntime,
  ChannelType,
  type Content,
  createUniqueUuid,
  DefaultMessageService,
  elizaLogger,
  type Media,
  Memory,
  MemoryType,
  type MessageProcessingOptions,
  stringToUuid,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { roomsRepository } from "@/db/repositories";
import { connectionCache } from "@/lib/cache/connection-cache";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { charactersService } from "@/lib/services/characters/characters";
import { discordService } from "@/lib/services/discord";
import { generateRoomTitle } from "@/lib/services/room-title";
import type { DialogueMetadata } from "@/lib/types/message-content";
import type { AgentModeConfig } from "./agent-mode-types";
import { DEFAULT_AGENT_MODE, isValidAgentModeConfig } from "./agent-mode-types";
import type { UserContext } from "./user-context";

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

function isUsageInfo(value: unknown): value is UsageInfo {
  if (!value || typeof value !== "object") {
    return false;
  }

  const usage = value as Partial<UsageInfo>;
  return (
    typeof usage.inputTokens === "number" &&
    typeof usage.outputTokens === "number" &&
    typeof usage.model === "string"
  );
}

export interface MessageResult {
  message: Memory;
  usage?: UsageInfo;
}

export type StreamChunkCallback = (chunk: string, messageId?: UUID) => Promise<void>;

export type ReasoningChunkCallback = (
  chunk: string,
  phase: "planning" | "actions" | "response" | "thinking",
  messageId?: UUID,
) => Promise<void>;

type RuntimeMessageOptions = MessageProcessingOptions & {
  useNativePlanner?: boolean;
  onReasoningChunk?: ReasoningChunkCallback;
};

export interface MessageOptions {
  roomId: string;
  text: string;
  attachments?: Media[];
  characterId?: string;
  model?: string;
  agentModeConfig?: AgentModeConfig;
  onStreamChunk?: StreamChunkCallback;
  onReasoningChunk?: ReasoningChunkCallback;
}

export class MessageHandler {
  constructor(
    private runtime: AgentRuntime,
    private userContext: UserContext,
  ) {}

  async process(options: MessageOptions): Promise<MessageResult> {
    const { roomId, text, attachments, agentModeConfig, onStreamChunk, onReasoningChunk } = options;
    const entityId = this.userContext.userId;
    const modeConfig = isValidAgentModeConfig(agentModeConfig)
      ? agentModeConfig
      : DEFAULT_AGENT_MODE;

    elizaLogger.info(
      `[MessageHandler] Processing via messageService: user=${this.userContext.userId}, room=${roomId}, mode=${modeConfig.mode}, streaming=${!!onStreamChunk}`,
    );

    await this.ensureConnectionForCloud(roomId, entityId);
    const userMessage = this.createMessage(roomId, entityId, {
      text,
      attachments,
    });

    let callbackContent: Content | undefined;
    let responseMemory: Memory | undefined;
    let usage: MessageResult["usage"];

    const callback = async (content: Content) => {
      if (content.text) {
        callbackContent = content;
      }

      if ("usage" in content && isUsageInfo(content.usage)) {
        usage = content.usage;
      }
      return [];
    };

    const messageOptions: RuntimeMessageOptions = {
      useNativePlanner: true,
      onStreamChunk,
      onReasoningChunk,
    };

    const messageService = this.runtime.messageService ?? new DefaultMessageService();
    if (!this.runtime.messageService) {
      elizaLogger.warn("[MessageHandler] No runtime.messageService available; using default.");
    }

    const result = await messageService.handleMessage(
      this.runtime,
      userMessage,
      callback,
      messageOptions,
    );

    if (result?.responseMessages && result.responseMessages.length > 0) {
      responseMemory = result.responseMessages[0];
      if (responseMemory?.id) {
        const existing = await this.runtime.getMemoryById(responseMemory.id);
        if (!existing) {
          await this.runtime.createMemory(responseMemory, "messages");
        }
      }
    }

    if (!responseMemory && result?.responseContent) {
      responseMemory = await this.createAgentResponseMemory(
        roomId,
        userMessage,
        result.responseContent,
        modeConfig,
      );
    }

    if (!responseMemory && callbackContent) {
      responseMemory = await this.createAgentResponseMemory(
        roomId,
        userMessage,
        callbackContent,
        modeConfig,
      );
    }

    if (!responseMemory) {
      responseMemory = {
        id: uuidv4() as UUID,
        roomId: roomId as UUID,
        entityId: this.runtime.agentId as UUID,
        agentId: this.runtime.agentId as UUID,
        createdAt: Date.now(),
        content: {
          text: "I'm sorry, I couldn't generate a response.",
          source: "agent",
          inReplyTo: userMessage.id,
        },
        metadata: {
          type: MemoryType.MESSAGE,
          role: "agent",
          dialogueType: "message",
          visibility: "visible",
          agentMode: modeConfig.mode,
        } as DialogueMetadata,
      };
      // Persist fallback response to ensure conversation history is complete
      await this.runtime.createMemory(responseMemory, "messages");
    }

    if (this.userContext.isAnonymous && this.userContext.sessionToken) {
      await this.incrementAnonymousMessageCount();
    }

    const responseText =
      typeof responseMemory.content === "string"
        ? responseMemory.content
        : responseMemory.content?.text || "";
    this.sendToDiscordThread(roomId, text, responseText, options.characterId).catch((e) => {
      elizaLogger.warn(`[MessageHandler] Discord thread sync failed for room ${roomId}: ${e}`);
    });

    // PERF: Fire-and-forget room title generation -- don't block the response.
    // Title generation makes a separate LLM call (1-3s) that the user doesn't need to wait for.
    generateRoomTitle(roomId).catch((e) => {
      elizaLogger.warn(`[MessageHandler] Room title generation failed for room ${roomId}: ${e}`);
    });

    return { message: responseMemory, usage };
  }

  private async createAgentResponseMemory(
    roomId: string,
    userMessage: Memory,
    content: Content,
    modeConfig: AgentModeConfig,
  ): Promise<Memory> {
    const responseMemory: Memory = {
      id: createUniqueUuid(this.runtime, (userMessage.id ?? uuidv4()) as UUID),
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: roomId as UUID,
      createdAt: Date.now(),
      content: {
        ...content,
        source: content.source || "agent",
        inReplyTo: userMessage.id,
      },
      metadata: {
        type: MemoryType.MESSAGE,
        role: "agent",
        dialogueType: "message",
        visibility: "visible",
        agentMode: modeConfig.mode,
      } as DialogueMetadata,
    };
    await this.runtime.createMemory(responseMemory, "messages");
    return responseMemory;
  }

  private async ensureConnectionForCloud(roomId: string, entityId: string): Promise<void> {
    if (await connectionCache.isEstablished(roomId, entityId)) return;

    const entityUuid = stringToUuid(entityId) as UUID;
    const roomUuid = roomId as UUID;
    const worldId = stringToUuid("eliza-world") as UUID;
    const serverId = stringToUuid("eliza-server") as UUID;

    const displayName =
      this.userContext.name || this.userContext.email || this.userContext.userId || "User";
    const names = [this.userContext.name, this.userContext.email, displayName].filter(
      Boolean,
    ) as string[];

    await Promise.all([
      this.ensureWorldExists(worldId, serverId),
      this.ensureAgentEntity(),
      this.ensureRoomExistsWithFields(roomUuid, worldId, serverId),
      this.ensureUserEntity(entityUuid, names, displayName),
    ]);

    await this.ensureParticipants(roomUuid, entityUuid);

    connectionCache.markEstablished(roomId, entityId).catch((e) => {
      elizaLogger.warn(
        `[MessageHandler] Connection cache update failed for room ${roomId}, entity ${entityId}: ${e}`,
      );
    });
  }

  private async ensureWorldExists(worldId: UUID, serverId: UUID): Promise<void> {
    try {
      await this.runtime.ensureWorldExists({
        id: worldId,
        name: "ElizaCloud Web",
        agentId: this.runtime.agentId,
        serverId,
      } as World);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.toLowerCase().includes("duplicate") &&
        !msg.toLowerCase().includes("unique constraint")
      )
        throw e;
    }
  }

  private async ensureRoomExistsWithFields(
    roomId: UUID,
    worldId: UUID,
    serverId: UUID,
  ): Promise<void> {
    const existingRoom = await this.runtime.getRoom(roomId);

    if (existingRoom) {
      if (!existingRoom.worldId || !existingRoom.serverId) {
        await this.runtime.updateRoom({ ...existingRoom, worldId, serverId });
      }
    } else {
      await this.runtime.ensureRoomExists({
        id: roomId,
        name: "New Chat",
        type: ChannelType.DM,
        channelId: roomId,
        worldId,
        serverId,
        agentId: this.runtime.agentId,
        source: "web",
      });
    }
  }

  private async ensureAgentEntity(): Promise<void> {
    if (await this.runtime.getEntityById(this.runtime.agentId)) return;

    try {
      await this.runtime.createEntity({
        id: this.runtime.agentId,
        agentId: this.runtime.agentId,
        names: [this.runtime.character?.name || "Agent"],
        metadata: {
          name: this.runtime.character?.name || "Agent",
          type: "agent",
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        !msg.toLowerCase().includes("duplicate") &&
        !msg.toLowerCase().includes("unique constraint")
      )
        throw e;
    }
  }

  private async ensureUserEntity(
    entityUuid: UUID,
    names: string[],
    displayName: string,
  ): Promise<void> {
    const existingEntity = await this.runtime.getEntityById(entityUuid);
    const metadata = {
      web: {
        id: this.userContext.userId,
        name: this.userContext.name,
        userName: displayName,
        email: this.userContext.email,
        organizationId: this.userContext.organizationId,
      },
    };

    if (!existingEntity) {
      try {
        await this.runtime.createEntity({
          id: entityUuid,
          agentId: this.runtime.agentId,
          names,
          metadata,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          !msg.toLowerCase().includes("duplicate") &&
          !msg.toLowerCase().includes("unique constraint")
        ) {
          throw new Error(`Failed to create user entity: ${msg}`);
        }
      }
    } else {
      const mergedNames = [...new Set([...(existingEntity.names || []), ...names])].filter(
        Boolean,
      ) as string[];
      const mergedMetadata = {
        ...existingEntity.metadata,
        web: {
          ...(existingEntity.metadata?.web as Record<string, unknown>),
          ...metadata.web,
        },
      };

      await this.runtime
        .updateEntity({
          id: entityUuid,
          agentId: this.runtime.agentId,
          names: mergedNames,
          metadata: mergedMetadata,
        })
        .catch((e) => {
          elizaLogger.warn(
            `[MessageHandler] Entity update failed for ${entityUuid} - user metadata may be stale: ${e}`,
          );
        });
    }
  }

  private async ensureParticipants(roomId: UUID, entityUuid: UUID): Promise<void> {
    await Promise.all([
      this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId).catch((e) => {
        elizaLogger.warn(
          `[MessageHandler] Agent participant setup failed for room ${roomId} - messages may not be attributed correctly: ${e}`,
        );
      }),
      this.runtime.ensureParticipantInRoom(entityUuid, roomId).catch((e) => {
        elizaLogger.warn(
          `[MessageHandler] User participant setup failed for entity ${entityUuid} in room ${roomId}: ${e}`,
        );
      }),
    ]);
  }

  private createMessage(
    roomId: string,
    entityId: string,
    content: { text?: string; attachments?: Media[] },
  ): Memory {
    const entityUuid = stringToUuid(entityId) as UUID;
    return {
      id: uuidv4() as UUID,
      roomId: roomId as UUID,
      entityId: entityUuid,
      agentId: this.runtime.agentId as UUID,
      createdAt: Date.now(),
      content: {
        text: content.text || "",
        source: "user",
        ...(content.attachments?.length
          ? {
              attachments: content.attachments.filter(
                (att): att is Media =>
                  typeof att === "object" &&
                  att !== null &&
                  ("url" in att || "mimeType" in att || "data" in att),
              ),
            }
          : {}),
      },
      metadata: {
        type: MemoryType.MESSAGE,
        role: "user",
        dialogueType: "message",
        visibility: "visible",
      } as DialogueMetadata,
    };
  }

  private async incrementAnonymousMessageCount(): Promise<void> {
    if (!this.userContext.sessionToken) return;

    const session = await anonymousSessionsService.getByToken(this.userContext.sessionToken);

    if (session) {
      await anonymousSessionsService.incrementMessageCount(session.id);
    }
  }

  private async sendToDiscordThread(
    roomId: string,
    userText: string,
    agentResponse: string,
    characterId?: string,
  ): Promise<void> {
    const room = await roomsRepository.findById(roomId);
    const roomMetadata = room?.metadata as { discordThreadId?: string } | undefined;
    const threadId = roomMetadata?.discordThreadId;
    if (!threadId) return;

    let characterName = "Agent";
    if (characterId) {
      const character = await charactersService.getById(characterId);
      characterName = character?.name || "Agent";
    }

    await discordService.sendToThread(
      threadId,
      `**${this.userContext.name || this.userContext.email || this.userContext.entityId}:** ${userText}`,
    );
    await discordService.sendToThread(threadId, `**🤖 ${characterName}:** ${agentResponse}`);
  }
}

export function createMessageHandler(
  runtime: AgentRuntime,
  userContext: UserContext,
): MessageHandler {
  return new MessageHandler(runtime, userContext);
}
