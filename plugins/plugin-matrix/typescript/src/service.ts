/**
 * Matrix service implementation for elizaOS.
 *
 * This service provides Matrix messaging capabilities using matrix-js-sdk.
 */

import { Service, type IAgentRuntime, type EventPayload, logger } from "@elizaos/core";
import * as sdk from "matrix-js-sdk";
import {
  type IMatrixService,
  type MatrixMessage,
  type MatrixMessageSendOptions,
  type MatrixRoom,
  type MatrixSendResult,
  type MatrixSettings,
  type MatrixUserInfo,
  MatrixConfigurationError,
  MatrixEventTypes,
  MatrixNotConnectedError,
  MATRIX_SERVICE_NAME,
  getMatrixLocalpart,
  isValidMatrixRoomAlias,
  isValidMatrixRoomId,
} from "./types.js";

/**
 * Matrix messaging service for elizaOS agents.
 */
export class MatrixService extends Service implements IMatrixService {
  static serviceType: string = MATRIX_SERVICE_NAME;

  capabilityDescription = "Matrix messaging service for chat communication";

  declare protected runtime: IAgentRuntime;
  private settings!: MatrixSettings;
  private client!: sdk.MatrixClient;
  private connected: boolean = false;
  private syncing: boolean = false;

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

  /**
   * Initialize the Matrix service.
   */
  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Load configuration
    this.settings = this.loadSettings();

    // Validate configuration
    this.validateSettings();

    // Create Matrix client
    this.client = sdk.createClient({
      baseUrl: this.settings.homeserver,
      userId: this.settings.userId,
      accessToken: this.settings.accessToken,
      deviceId: this.settings.deviceId,
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Start client
    await this.connect();

    logger.info(
      `Matrix service initialized for ${this.settings.userId} on ${this.settings.homeserver}`
    );
  }

  /**
   * Load settings from runtime.
   */
  private loadSettings(): MatrixSettings {
    // Helper to safely get string settings
    const getStringSetting = (key: string): string | undefined => {
      const value = this.runtime.getSetting(key);
      return typeof value === "string" ? value : undefined;
    };

    const homeserver = getStringSetting("MATRIX_HOMESERVER");
    const userId = getStringSetting("MATRIX_USER_ID");
    const accessToken = getStringSetting("MATRIX_ACCESS_TOKEN");
    const deviceId = getStringSetting("MATRIX_DEVICE_ID");
    const roomsStr = getStringSetting("MATRIX_ROOMS");
    const autoJoinStr = getStringSetting("MATRIX_AUTO_JOIN");
    const encryptionStr = getStringSetting("MATRIX_ENCRYPTION");
    const requireMentionStr = getStringSetting("MATRIX_REQUIRE_MENTION");

    const rooms = roomsStr
      ? roomsStr.split(",").map((r: string) => r.trim()).filter(Boolean)
      : [];

    return {
      homeserver: homeserver || "",
      userId: userId || "",
      accessToken: accessToken || "",
      deviceId,
      rooms,
      autoJoin: autoJoinStr === "true",
      encryption: encryptionStr === "true",
      requireMention: requireMentionStr === "true",
      enabled: true,
    };
  }

  /**
   * Validate the settings.
   */
  private validateSettings(): void {
    if (!this.settings.homeserver) {
      throw new MatrixConfigurationError(
        "MATRIX_HOMESERVER is required",
        "MATRIX_HOMESERVER"
      );
    }

    if (!this.settings.userId) {
      throw new MatrixConfigurationError(
        "MATRIX_USER_ID is required",
        "MATRIX_USER_ID"
      );
    }

    if (!this.settings.accessToken) {
      throw new MatrixConfigurationError(
        "MATRIX_ACCESS_TOKEN is required",
        "MATRIX_ACCESS_TOKEN"
      );
    }
  }

  /**
   * Set up event handlers for the Matrix client.
   */
  private setupEventHandlers(): void {
    // Sync events
    this.client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === "PREPARED") {
        this.syncing = true;
        logger.info("Matrix sync complete");
        this.runtime.emitEvent(MatrixEventTypes.SYNC_COMPLETE, {
          runtime: this.runtime,
        } as EventPayload);
      }
    });

    // Room timeline events (messages)
    this.client.on(
      sdk.RoomEvent.Timeline,
      (event, room, toStartOfTimeline) => {
        if (toStartOfTimeline) return;
        if (event.getType() !== "m.room.message") return;
        if (event.getSender() === this.settings.userId) return;

        this.handleRoomMessage(event, room);
      }
    );

    // Room membership events
    this.client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
      if (member.userId !== this.settings.userId) return;

      if (member.membership === "invite" && this.settings.autoJoin) {
        const roomId = event.getRoomId();
        if (roomId) {
          logger.info(`Auto-joining room ${roomId}`);
          this.client.joinRoom(roomId).catch((err) => {
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
    if (this.settings.requireMention) {
      const body = content.body || "";
      const localpart = getMatrixLocalpart(this.settings.userId);
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
      isDirect: this.client.getAccountData("m.direct")?.getContent()?.[sender || ""]?.includes(roomId) || false,
      memberCount: room.getJoinedMemberCount(),
    };

    logger.debug(
      `Matrix message from ${senderInfo.displayName || sender} in ${room.name || roomId}: ${message.content.slice(0, 50)}...`
    );

    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_RECEIVED, {
      message,
      room: matrixRoom,
      runtime: this.runtime,
    } as EventPayload);
  }

  /**
   * Connect to Matrix.
   */
  private async connect(): Promise<void> {
    await this.client.startClient({ initialSyncLimit: 10 });
    this.connected = true;

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      const listener = (state: string) => {
        if (state === "PREPARED") {
          this.client.removeListener(sdk.ClientEvent.Sync, listener);
          resolve();
        }
      };
      this.client.on(sdk.ClientEvent.Sync, listener);
    });

    // Join configured rooms
    for (const room of this.settings.rooms) {
      try {
        await this.joinRoom(room);
      } catch (err) {
        logger.warn(`Failed to join room ${room}: ${err}`);
      }
    }
  }

  /**
   * Shutdown the service.
   */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
    }
    this.connected = false;
    logger.info("Matrix service stopped");
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  isConnected(): boolean {
    return this.connected && this.syncing;
  }

  getUserId(): string {
    return this.settings.userId;
  }

  getHomeserver(): string {
    return this.settings.homeserver;
  }

  async getJoinedRooms(): Promise<MatrixRoom[]> {
    const rooms = this.client.getRooms();
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

  async sendMessage(
    text: string,
    options?: MatrixMessageSendOptions
  ): Promise<MatrixSendResult> {
    if (!this.isConnected()) {
      throw new MatrixNotConnectedError();
    }

    const roomId = options?.roomId;
    if (!roomId) {
      return { success: false, error: "Room ID is required" };
    }

    // Resolve room ID from alias if needed
    let resolvedRoomId = roomId;
    if (isValidMatrixRoomAlias(roomId)) {
      const resolved = await this.client.getRoomIdForAlias(roomId);
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

    const response = await this.client.sendMessage(resolvedRoomId, content);
    const eventId = response.event_id;

    this.runtime.emitEvent(MatrixEventTypes.MESSAGE_SENT, {
      roomId: resolvedRoomId,
      eventId,
      content: text,
      runtime: this.runtime,
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
    emoji: string
  ): Promise<MatrixSendResult> {
    if (!this.isConnected()) {
      throw new MatrixNotConnectedError();
    }

    const content = {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: emoji,
      },
    };

    const response = await this.client.sendEvent(roomId, "m.reaction", content);

    return {
      success: true,
      eventId: response.event_id,
      roomId,
    };
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.isConnected()) {
      throw new MatrixNotConnectedError();
    }

    const response = await this.client.joinRoom(roomIdOrAlias);
    const roomId = response.roomId;

    logger.info(`Joined room ${roomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_JOINED, {
      room: { roomId },
      runtime: this.runtime,
    } as EventPayload);

    return roomId;
  }

  async leaveRoom(roomId: string): Promise<void> {
    if (!this.isConnected()) {
      throw new MatrixNotConnectedError();
    }

    await this.client.leave(roomId);
    logger.info(`Left room ${roomId}`);
    this.runtime.emitEvent(MatrixEventTypes.ROOM_LEFT, {
      roomId,
      runtime: this.runtime,
    } as EventPayload);
  }

  async sendTyping(
    roomId: string,
    typing: boolean,
    timeout: number = 30000
  ): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    await this.client.sendTyping(roomId, typing, timeout);
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    if (!this.isConnected()) {
      return;
    }

    await this.client.sendReadReceipt(
      new sdk.MatrixEvent({ event_id: eventId, room_id: roomId })
    );
  }
}
