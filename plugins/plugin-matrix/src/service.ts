/**
 * Matrix service implementation for ElizaOS.
 *
 * This service provides Matrix messaging capabilities using matrix-js-sdk.
 */

import {
  type Content,
  type EventPayload,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorTarget,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import * as sdk from "matrix-js-sdk";
import {
  DEFAULT_MATRIX_ACCOUNT_ID,
  listMatrixAccountIds,
  normalizeMatrixAccountId,
  readMatrixAccountId,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccountSettings,
} from "./accounts.js";
import {
  getMatrixLocalpart,
  type IMatrixService,
  isValidMatrixRoomAlias,
  isValidMatrixRoomId,
  MATRIX_SERVICE_NAME,
  MatrixConfigurationError,
  MatrixEventTypes,
  type MatrixMessage,
  type MatrixMessageSendOptions,
  MatrixNotConnectedError,
  type MatrixRoom,
  type MatrixSendResult,
  type MatrixSettings,
  type MatrixUserInfo,
} from "./types.js";

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function matrixRoomSearchText(room: MatrixRoom): string {
  return [room.roomId, room.name, room.topic, room.canonicalAlias]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function scoreMatrixRoom(room: MatrixRoom, query: string): number {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) {
    return 0.4;
  }

  const candidates = [room.roomId, room.canonicalAlias, room.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (candidates.some((candidate) => candidate.toLowerCase() === normalized)) {
    return 1;
  }
  if (candidates.some((candidate) => candidate.toLowerCase().includes(normalized))) {
    return 0.85;
  }
  return matrixRoomSearchText(room).includes(normalized) ? 0.65 : 0;
}

function matrixRoomToConnectorTarget(
  room: MatrixRoom,
  score = 0.5,
  accountId = DEFAULT_MATRIX_ACCOUNT_ID
): MessageConnectorTarget {
  const label = room.name || room.canonicalAlias || room.roomId;
  return {
    target: {
      source: MATRIX_SERVICE_NAME,
      accountId,
      channelId: room.roomId,
    },
    label,
    kind: room.isDirect ? "user" : "room",
    description:
      room.topic || `${room.memberCount} Matrix member${room.memberCount === 1 ? "" : "s"}`,
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      roomId: room.roomId,
      canonicalAlias: room.canonicalAlias,
      isEncrypted: room.isEncrypted,
      isDirect: room.isDirect,
      memberCount: room.memberCount,
    },
  };
}

type ConnectorHookContext = {
  runtime: IAgentRuntime;
  roomId?: UUID;
  target?: TargetInfo;
};

type ConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

type ConnectorMutationParams = {
  target?: TargetInfo;
  messageId?: string;
  eventId?: string;
  emoji?: string;
};

type ConnectorRoomMembershipParams = {
  target?: TargetInfo;
  roomId?: string;
  roomIdOrAlias?: string;
  alias?: string;
  invite?: string;
  channelId?: string;
};

type AdditiveMessageConnectorHooks = {
  fetchMessages?: (
    context: ConnectorHookContext,
    params?: ConnectorReadParams
  ) => Promise<Memory[]>;
  searchMessages?: (
    context: ConnectorHookContext,
    params: ConnectorReadParams & { query: string }
  ) => Promise<Memory[]>;
  reactHandler?: (runtime: IAgentRuntime, params: ConnectorMutationParams) => Promise<void>;
  joinHandler?: (runtime: IAgentRuntime, params: ConnectorRoomMembershipParams) => Promise<void>;
  leaveHandler?: (runtime: IAgentRuntime, params: ConnectorRoomMembershipParams) => Promise<void>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

type MatrixAccountState = {
  accountId: string;
  settings: MatrixSettings;
  client: sdk.MatrixClient;
  connected: boolean;
  syncing: boolean;
};

function normalizeConnectorLimit(limit: number | undefined, fallback = 50): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
}

async function readStoredMessageMemories(
  runtime: IAgentRuntime,
  roomId: UUID,
  limit: number
): Promise<Memory[]> {
  return runtime.getMemories({
    tableName: "messages",
    roomId,
    limit,
    orderBy: "createdAt",
    orderDirection: "desc",
  });
}

async function readStoredMessagesForTargets(
  runtime: IAgentRuntime,
  targets: MessageConnectorTarget[],
  limit: number
): Promise<Memory[]> {
  const roomIds = Array.from(
    new Set(targets.map((target) => target.target.roomId).filter((id): id is UUID => Boolean(id)))
  );
  const chunks = await Promise.all(
    roomIds.map((roomId) => readStoredMessageMemories(runtime, roomId, limit))
  );
  return chunks
    .flat()
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, limit);
}

function filterMemoriesByQuery(memories: Memory[], query: string, limit: number): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return memories.slice(0, limit);
  }
  return memories
    .filter((memory) => {
      const text = typeof memory.content?.text === "string" ? memory.content.text : "";
      return text.toLowerCase().includes(normalized);
    })
    .slice(0, limit);
}

function extractMatrixSendOptions(content: Content, target: TargetInfo): MatrixMessageSendOptions {
  const data = content.data as Record<string, unknown> | undefined;
  const matrixData = (data?.matrix && typeof data.matrix === "object" ? data.matrix : data) as
    | Record<string, unknown>
    | undefined;

  return {
    threadId:
      target.threadId ||
      (typeof matrixData?.threadId === "string" ? matrixData.threadId : undefined),
    replyTo: typeof matrixData?.replyTo === "string" ? matrixData.replyTo : undefined,
    formatted: matrixData?.formatted === true,
  };
}

/**
 * Matrix messaging service for ElizaOS agents.
 */
export class MatrixService extends Service implements IMatrixService {
  static serviceType: string = MATRIX_SERVICE_NAME;

  capabilityDescription = "Matrix messaging service for chat communication";

  protected declare runtime: IAgentRuntime;
  private states = new Map<string, MatrixAccountState>();
  private defaultAccountId = DEFAULT_MATRIX_ACCOUNT_ID;

  /**
   * Start the Matrix service.
   */
  static async start(runtime: IAgentRuntime): Promise<MatrixService> {
    const service = new MatrixService();
    await service.initialize(runtime);
    return service;
  }

  /**
   * Stop the Matrix service.
   */
  static override async stopRuntime(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(MATRIX_SERVICE_NAME) as MatrixService | undefined;
    if (service) {
      await service.stop();
    }
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    service: MatrixService,
    accountId = service.getAccountId(runtime)
  ): void {
    accountId = normalizeMatrixAccountId(accountId);
    const sendHandler = async (
      handlerRuntime: IAgentRuntime,
      target: TargetInfo,
      content: Content
    ): Promise<Memory | undefined> => {
      await service.handleSendMessage(handlerRuntime, target, content);
      return undefined;
    };

    if (typeof runtime.registerMessageConnector === "function") {
      const registration = {
        source: MATRIX_SERVICE_NAME,
        accountId,
        label: "Matrix",
        capabilities: [
          "send_message",
          "send_thread_reply",
          "send_formatted_message",
          "react_to_message",
          "list_rooms",
          "join_room",
        ],
        supportedTargetKinds: ["room", "channel", "thread", "user"],
        contexts: ["social", "connectors"],
        description:
          "Send messages to joined Matrix rooms, aliases, encrypted rooms, and known direct-message rooms.",
        metadata: {
          accountId,
          service: MATRIX_SERVICE_NAME,
        },
        sendHandler,
        resolveTargets: async (query) => {
          const rooms = await service.getJoinedRooms(accountId);
          return rooms
            .map((room) => ({ room, score: scoreMatrixRoom(room, query) }))
            .filter(({ score }) => score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, 10)
            .map(({ room, score }) => matrixRoomToConnectorTarget(room, score, accountId));
        },
        listRecentTargets: async () =>
          (await service.getJoinedRooms(accountId))
            .slice(0, 10)
            .map((room) => matrixRoomToConnectorTarget(room, 0.5, accountId)),
        listRooms: async () =>
          (await service.getJoinedRooms(accountId)).map((room) =>
            matrixRoomToConnectorTarget(room, 0.5, accountId)
          ),
        fetchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          if (target?.roomId) {
            return readStoredMessageMemories(context.runtime, target.roomId, limit);
          }
          const targets = (await service.getJoinedRooms(accountId))
            .slice(0, 10)
            .map((room) => matrixRoomToConnectorTarget(room, 0.5, accountId));
          return readStoredMessagesForTargets(context.runtime, targets, limit);
        },
        searchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          const messages = target?.roomId
            ? await readStoredMessageMemories(context.runtime, target.roomId, Math.max(limit, 100))
            : await readStoredMessagesForTargets(
                context.runtime,
                (await service.getJoinedRooms(accountId))
                  .slice(0, 10)
                  .map((room) => matrixRoomToConnectorTarget(room, 0.5, accountId)),
                Math.max(limit, 100)
              );
          return filterMemoriesByQuery(messages, params.query, limit);
        },
        reactHandler: async (handlerRuntime, params) => {
          const target = params.target ?? ({ source: MATRIX_SERVICE_NAME } as TargetInfo);
          const room = target.roomId ? await handlerRuntime.getRoom(target.roomId) : null;
          const roomId = String(target.channelId ?? room?.channelId ?? "").trim();
          const mutationParams = params as ConnectorMutationParams;
          const eventId = String(mutationParams.eventId ?? params.messageId ?? "").trim();
          const emoji = String(params.emoji ?? "").trim();
          if (!roomId || !eventId || !emoji) {
            throw new Error("Matrix reactHandler requires room, event id, and emoji");
          }
          const result = await service.sendReaction(roomId, eventId, emoji, accountId);
          if (!result.success) {
            throw new Error(result.error || "Matrix reaction failed");
          }
        },
        joinHandler: async (_handlerRuntime, params) => {
          const membershipParams = params as ConnectorRoomMembershipParams;
          const roomIdOrAlias = String(
            membershipParams.roomIdOrAlias ??
              params.alias ??
              params.invite ??
              params.channelId ??
              params.roomId ??
              ""
          ).trim();
          if (!roomIdOrAlias) {
            throw new Error("Matrix joinHandler requires a room ID or alias");
          }
          await service.joinRoom(roomIdOrAlias, accountId);
        },
        leaveHandler: async (handlerRuntime, params) => {
          const target = params.target ?? ({ source: MATRIX_SERVICE_NAME } as TargetInfo);
          const room = target.roomId ? await handlerRuntime.getRoom(target.roomId) : null;
          const roomId = String(
            params?.roomId ?? params?.channelId ?? target.channelId ?? room?.channelId ?? ""
          );
          if (!roomId) {
            throw new Error("Matrix leaveHandler requires a room ID");
          }
          await service.leaveRoom(roomId, accountId);
        },
        getChatContext: async (target, context) => {
          const room = target.roomId ? await context.runtime.getRoom(target.roomId) : null;
          const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
          const joinedRoom = (await service.getJoinedRooms(accountId)).find(
            (candidate) => candidate.roomId === channelId || candidate.canonicalAlias === channelId
          );
          if (!joinedRoom) {
            return null;
          }

          return {
            target: {
              source: MATRIX_SERVICE_NAME,
              accountId,
              channelId: joinedRoom.roomId,
              roomId: target.roomId,
            },
            label: joinedRoom.name || joinedRoom.canonicalAlias || joinedRoom.roomId,
            summary: joinedRoom.topic,
            metadata: {
              accountId,
              roomId: joinedRoom.roomId,
              canonicalAlias: joinedRoom.canonicalAlias,
              isEncrypted: joinedRoom.isEncrypted,
              isDirect: joinedRoom.isDirect,
              memberCount: joinedRoom.memberCount,
            },
          } satisfies MessageConnectorChatContext;
        },
        getUserContext: async (entityId, context) => {
          if (typeof context.runtime.getEntityById !== "function") {
            return null;
          }
          const entity = await context.runtime.getEntityById(String(entityId) as UUID);
          if (!entity) {
            return null;
          }
          return {
            entityId,
            label: entity.names?.[0],
            aliases: entity.names,
            handles: {},
            metadata: entity.metadata,
          };
        },
      } as ExtendedMessageConnectorRegistration;
      runtime.registerMessageConnector(registration);
      return;
    }

    runtime.registerSendHandler(MATRIX_SERVICE_NAME, sendHandler);
  }

  /**
   * Initialize the Matrix service.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.defaultAccountId = normalizeMatrixAccountId(resolveDefaultMatrixAccountId(runtime));

    const accountIds = listMatrixAccountIds(runtime);
    for (const accountId of accountIds) {
      const settings = this.loadSettings(accountId);
      if (settings.enabled === false) {
        continue;
      }

      this.validateSettings(settings);

      const state: MatrixAccountState = {
        accountId: normalizeMatrixAccountId(settings.accountId),
        settings,
        client: sdk.createClient({
          baseUrl: settings.homeserver,
          userId: settings.userId,
          accessToken: settings.accessToken,
          deviceId: settings.deviceId,
        }),
        connected: false,
        syncing: false,
      };

      this.states.set(state.accountId, state);
      this.setupEventHandlers(state);
      await this.connect(state);
      MatrixService.registerSendHandlers(runtime, this, state.accountId);

      logger.info(`Matrix service initialized for ${settings.userId} on ${settings.homeserver}`);
    }

    if (this.states.size === 0) {
      const settings = this.loadSettings(this.defaultAccountId);
      this.validateSettings(settings);
    }
  }

  /**
   * Load settings from runtime.
   */
  private loadSettings(accountId?: string): MatrixSettings {
    return resolveMatrixAccountSettings(this.runtime, accountId);
  }

  /**
   * Validate the settings.
   */
  private validateSettings(settings: MatrixSettings): void {
    if (!settings.homeserver) {
      throw new MatrixConfigurationError("MATRIX_HOMESERVER is required", "MATRIX_HOMESERVER");
    }

    if (!settings.userId) {
      throw new MatrixConfigurationError("MATRIX_USER_ID is required", "MATRIX_USER_ID");
    }

    if (!settings.accessToken) {
      throw new MatrixConfigurationError("MATRIX_ACCESS_TOKEN is required", "MATRIX_ACCESS_TOKEN");
    }
  }

  /**
   * Set up event handlers for the Matrix client.
   */
  private setupEventHandlers(state: MatrixAccountState): void {
    // Sync events
    state.client.on(sdk.ClientEvent.Sync, (syncState) => {
      if (syncState === "PREPARED") {
        state.syncing = true;
        logger.info("Matrix sync complete");
        this.runtime.emitEvent(MatrixEventTypes.SYNC_COMPLETE, {
          runtime: this.runtime,
          accountId: state.accountId,
        } as EventPayload);
      }
    });

    // Room timeline events (messages)
    state.client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return;
      if (event.getType() !== "m.room.message") return;
      if (event.getSender() === state.settings.userId) return;

      this.handleRoomMessage(state, event, room);
    });

    // Room membership events
    state.client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
      if (member.userId !== state.settings.userId) return;

      if (member.membership === "invite" && state.settings.autoJoin) {
        const roomId = event.getRoomId();
        if (roomId) {
          logger.info(`Auto-joining room ${roomId}`);
          state.client.joinRoom(roomId).catch((err) => {
            logger.error(`Failed to auto-join room: ${err.message}`);
          });
        }
      }
    });
  }

  /**
   * Handle an incoming room message.
   */
  private handleRoomMessage(
    state: MatrixAccountState,
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined
  ): void {
    const content = event.getContent();
    const msgType = content.msgtype;

    // Only handle text messages for now
    if (msgType !== "m.text") return;

    const roomId = event.getRoomId();
    if (!roomId || !room) return;

    // Check mention requirement
    if (state.settings.requireMention) {
      const body = content.body || "";
      const localpart = getMatrixLocalpart(state.settings.userId);
      const mentionPattern = new RegExp(`@?${localpart}`, "i");
      if (!mentionPattern.test(body)) {
        return;
      }
    }

    const sender = event.getSender();
    const senderMember = room.getMember(sender || "");

    const senderInfo: MatrixUserInfo = {
      userId: sender || "",
      displayName: senderMember?.name,
      avatarUrl: senderMember?.getMxcAvatarUrl() || undefined,
    };

    // Check for reply/thread
    const relatesTo = content["m.relates_to"];
    const isEdit = relatesTo?.rel_type === "m.replace";
    const threadId = relatesTo?.rel_type === "m.thread" ? relatesTo.event_id : undefined;
    const replyTo = relatesTo?.["m.in_reply_to"]?.event_id;

    const message: MatrixMessage = {
      eventId: event.getId() || "",
      roomId,
      sender: sender || "",
      senderInfo,
      content: content.body || "",
      msgType,
      formattedBody: content.formatted_body,
      timestamp: event.getTs(),
      threadId,
      replyTo,
      isEdit,
      replacesEventId: isEdit ? relatesTo?.event_id : undefined,
    };

    const matrixRoom: MatrixRoom = {
      roomId,
      name: room.name,
      topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic,
      canonicalAlias: room.getCanonicalAlias() || undefined,
      isEncrypted: room.hasEncryptionStateEvent(),
      isDirect:
        state.client
          .getAccountData(sdk.EventType.Direct)
          ?.getContent()
          ?.[sender || ""]?.includes(roomId) || false,
      memberCount: room.getJoinedMemberCount(),
    };

    logger.debug(
      `Matrix message from ${senderInfo.displayName || sender} in ${room.name || roomId}: ${message.content.slice(0, 50)}...`
    );

    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_RECEIVED, {
      message,
      room: matrixRoom,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);
  }

  /**
   * Connect to Matrix.
   */
  private async connect(state: MatrixAccountState): Promise<void> {
    await state.client.startClient({ initialSyncLimit: 10 });
    state.connected = true;

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      const listener = (syncState: string) => {
        if (syncState === "PREPARED") {
          state.client.removeListener(sdk.ClientEvent.Sync, listener);
          resolve();
        }
      };
      state.client.on(sdk.ClientEvent.Sync, listener);
    });

    // Join configured rooms
    for (const room of state.settings.rooms) {
      try {
        await this.joinRoom(room, state.accountId);
      } catch (err) {
        logger.warn(`Failed to join room ${room}: ${err}`);
      }
    }
  }

  /**
   * Shutdown the service.
   */
  async stop(): Promise<void> {
    for (const state of this.states.values()) {
      state.client.stopClient();
      state.connected = false;
      state.syncing = false;
    }
    logger.info("Matrix service stopped");
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  isConnected(): boolean {
    const legacy = this as unknown as { connected?: boolean; syncing?: boolean };
    const states = this.states ?? new Map<string, MatrixAccountState>();
    if (states.size === 0 && typeof legacy.connected === "boolean") {
      return legacy.connected && (legacy.syncing ?? true);
    }
    return Array.from(states.values()).some((state) => state.connected && state.syncing);
  }

  getAccountId(runtime?: IAgentRuntime): string {
    const legacy = this as unknown as { settings?: MatrixSettings };
    const states = this.states ?? new Map<string, MatrixAccountState>();
    if (states.size === 0 && legacy.settings?.accountId) {
      return normalizeMatrixAccountId(legacy.settings.accountId);
    }
    return normalizeMatrixAccountId(
      this.defaultAccountId !== DEFAULT_MATRIX_ACCOUNT_ID
        ? this.defaultAccountId
        : runtime
          ? resolveDefaultMatrixAccountId(runtime)
          : this.defaultAccountId
    );
  }

  getUserId(): string {
    return this.getState().settings.userId;
  }

  getHomeserver(): string {
    return this.getState().settings.homeserver;
  }

  async getJoinedRooms(accountId?: string): Promise<MatrixRoom[]> {
    const state = this.getState(accountId);
    const rooms = state.client.getRooms();
    return rooms
      .filter((room) => room.getMyMembership() === "join")
      .map((room) => ({
        roomId: room.roomId,
        name: room.name,
        topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic,
        canonicalAlias: room.getCanonicalAlias() || undefined,
        isEncrypted: room.hasEncryptionStateEvent(),
        isDirect: false,
        memberCount: room.getJoinedMemberCount(),
      }));
  }

  async sendMessage(text: string, options?: MatrixMessageSendOptions): Promise<MatrixSendResult> {
    const state = this.getState(options?.accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }

    const roomId = options?.roomId;
    if (!roomId) {
      return { success: false, error: "Room ID is required" };
    }

    // Resolve room ID from alias if needed
    let resolvedRoomId = roomId;
    if (isValidMatrixRoomAlias(roomId)) {
      const resolved = await state.client.getRoomIdForAlias(roomId);
      resolvedRoomId = resolved.room_id;
    }

    // Build content
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body: text,
    };

    if (options?.formatted) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = text;
    }

    // Handle reply/thread
    if (options?.threadId || options?.replyTo) {
      content["m.relates_to"] = {};

      if (options.threadId) {
        (content["m.relates_to"] as Record<string, unknown>).rel_type = "m.thread";
        (content["m.relates_to"] as Record<string, unknown>).event_id = options.threadId;
      }

      if (options.replyTo) {
        (content["m.relates_to"] as Record<string, unknown>)["m.in_reply_to"] = {
          event_id: options.replyTo,
        };
      }
    }

    // sendMessage's content parameter is typed RoomMessageEventContent, which is
    // not re-exported from matrix-js-sdk's main barrel. The runtime check is the
    // structural shape of `content` (msgtype + body); skip the unreachable type.
    const response = await state.client.sendMessage(
      resolvedRoomId,
      // biome-ignore lint/suspicious/noExplicitAny: type not exported from main entry
      content as any
    );
    const eventId = response.event_id;

    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_SENT, {
      roomId: resolvedRoomId,
      eventId,
      content: text,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    return {
      success: true,
      eventId,
      roomId: resolvedRoomId,
    };
  }

  async sendReaction(
    roomId: string,
    eventId: string,
    emoji: string,
    accountId?: string
  ): Promise<MatrixSendResult> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }

    const content = {
      "m.relates_to": {
        rel_type: sdk.RelationType.Annotation as const,
        event_id: eventId,
        key: emoji,
      },
    };

    const response = await state.client.sendEvent(roomId, sdk.EventType.Reaction, content);

    return {
      success: true,
      eventId: response.event_id,
      roomId,
    };
  }

  async joinRoom(roomIdOrAlias: string, accountId?: string): Promise<string> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }

    const response = await state.client.joinRoom(roomIdOrAlias);
    const roomId = response.roomId;

    logger.info(`Joined room ${roomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_JOINED, {
      room: { roomId },
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);

    return roomId;
  }

  async leaveRoom(roomId: string, accountId?: string): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      throw new MatrixNotConnectedError();
    }

    await state.client.leave(roomId);
    logger.info(`Left room ${roomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_LEFT, {
      roomId,
      runtime: this.runtime,
      accountId: state.accountId,
    } as EventPayload);
  }

  async sendTyping(
    roomId: string,
    typing: boolean,
    timeout: number = 30000,
    accountId?: string
  ): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      return;
    }

    await state.client.sendTyping(roomId, typing, timeout);
  }

  async sendReadReceipt(roomId: string, eventId: string, accountId?: string): Promise<void> {
    const state = this.getState(accountId);
    if (!state.connected || !state.syncing) {
      return;
    }

    await state.client.sendReadReceipt(new sdk.MatrixEvent({ event_id: eventId, room_id: roomId }));
  }

  async sendRoomMessage(roomIdOrAlias: string, content: Content): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    await this.sendMessage(text, {
      accountId: readMatrixAccountId(content) ?? this.getAccountId(),
      roomId: roomIdOrAlias,
    });
  }

  async sendDirectMessage(roomIdOrAlias: string, content: Content): Promise<void> {
    await this.sendRoomMessage(roomIdOrAlias, content);
  }

  private async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const requestedAccountId = normalizeMatrixAccountId(
      target.accountId ?? readMatrixAccountId(content, target) ?? this.getAccountId()
    );
    this.getState(requestedAccountId);

    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }

    const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
    const roomIdOrAlias = String(
      target.channelId ||
        room?.channelId ||
        (typeof target.roomId === "string" &&
        (isValidMatrixRoomId(target.roomId) || isValidMatrixRoomAlias(target.roomId))
          ? target.roomId
          : "")
    ).trim();

    if (!roomIdOrAlias) {
      throw new Error("Matrix target is missing a room ID or alias");
    }

    await this.sendMessage(text, {
      accountId: requestedAccountId,
      roomId: roomIdOrAlias,
      ...extractMatrixSendOptions(content, target),
    });
  }

  private getState(accountId = this.defaultAccountId): MatrixAccountState {
    const normalized = normalizeMatrixAccountId(accountId);
    const states = this.states ?? new Map<string, MatrixAccountState>();
    const state = states.get(normalized);
    if (state) {
      return state;
    }

    const legacy = this as unknown as {
      settings?: MatrixSettings;
      client?: sdk.MatrixClient;
      connected?: boolean;
      syncing?: boolean;
    };
    if (legacy.settings) {
      return {
        accountId: normalizeMatrixAccountId(legacy.settings.accountId ?? normalized),
        settings: legacy.settings,
        client: legacy.client ?? ({} as sdk.MatrixClient),
        connected: legacy.connected ?? true,
        syncing: legacy.syncing ?? true,
      };
    }

    throw new Error(`Matrix account '${normalized}' is not available in this service instance`);
  }
}
