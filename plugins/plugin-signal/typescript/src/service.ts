import {
  ChannelType,
  type Character,
  type Content,
  type ContentType,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Media,
  type Memory,
  type Room,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

type MessageService = {
  handleMessage: (
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback,
  ) => Promise<void>;
};

const getMessageService = (runtime: IAgentRuntime): MessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: MessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

import {
  getSignalContactDisplayName,
  type ISignalService,
  MAX_SIGNAL_MESSAGE_LENGTH,
  normalizeE164,
  SIGNAL_SERVICE_NAME,
  type SignalContact,
  SignalEventTypes,
  type SignalGroup,
  type SignalMessage,
  type SignalMessageSendOptions,
  type SignalSettings,
} from "./types";

/**
 * Signal API client for HTTP API mode
 */
class SignalApiClient {
  constructor(
    private baseUrl: string,
    private accountNumber: string,
  ) {}

  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Signal API error: ${response.status} - ${errorText}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async sendMessage(
    recipient: string,
    message: string,
    options?: SignalMessageSendOptions,
  ): Promise<{ timestamp: number }> {
    const body: Record<string, unknown> = {
      message,
      number: this.accountNumber,
      recipients: [recipient],
    };

    if (options?.attachments) {
      body.base64_attachments = options.attachments;
    }

    if (options?.quote) {
      body.quote_timestamp = options.quote.timestamp;
      body.quote_author = options.quote.author;
    }

    return this.request<{ timestamp: number }>("POST", "/v2/send", body);
  }

  async sendGroupMessage(
    groupId: string,
    message: string,
    options?: SignalMessageSendOptions,
  ): Promise<{ timestamp: number }> {
    const body: Record<string, unknown> = {
      message,
      number: this.accountNumber,
      recipients: [`group.${groupId}`],
    };

    if (options?.attachments) {
      body.base64_attachments = options.attachments;
    }

    return this.request<{ timestamp: number }>("POST", "/v2/send", body);
  }

  async sendReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
    remove = false,
  ): Promise<void> {
    await this.request("POST", `/v1/reactions/${this.accountNumber}`, {
      recipient,
      reaction: emoji,
      target_author: targetAuthor,
      timestamp: targetTimestamp,
      remove,
    });
  }

  async getContacts(): Promise<SignalContact[]> {
    const result = await this.request<{ contacts: SignalContact[] }>(
      "GET",
      `/v1/contacts/${this.accountNumber}`,
    );
    return result.contacts || [];
  }

  async getGroups(): Promise<SignalGroup[]> {
    const result = await this.request<SignalGroup[]>(
      "GET",
      `/v1/groups/${this.accountNumber}`,
    );
    return result || [];
  }

  async getGroup(groupId: string): Promise<SignalGroup | null> {
    const groups = await this.getGroups();
    return groups.find((g) => g.id === groupId) || null;
  }

  async receive(): Promise<SignalMessage[]> {
    const result = await this.request<SignalMessage[]>(
      "GET",
      `/v1/receive/${this.accountNumber}`,
    );
    return result || [];
  }

  async sendTyping(recipient: string, stop = false): Promise<void> {
    await this.request("PUT", `/v1/typing-indicator/${this.accountNumber}`, {
      recipient,
      stop,
    });
  }

  async setProfile(name: string, about?: string): Promise<void> {
    await this.request("PUT", `/v1/profiles/${this.accountNumber}`, {
      name,
      about: about || "",
    });
  }

  async getIdentities(): Promise<
    Array<{ number: string; safety_number: string; trust_level: string }>
  > {
    const result = await this.request<
      Array<{ number: string; safety_number: string; trust_level: string }>
    >("GET", `/v1/identities/${this.accountNumber}`);
    return result || [];
  }

  async trustIdentity(
    number: string,
    trustLevel: "TRUSTED_VERIFIED" | "TRUSTED_UNVERIFIED" | "UNTRUSTED",
  ): Promise<void> {
    await this.request(
      "PUT",
      `/v1/identities/${this.accountNumber}/trust/${number}`,
      {
        trust_level: trustLevel,
      },
    );
  }
}

/**
 * SignalService class for interacting with Signal via HTTP API or CLI
 */
export class SignalService extends Service implements ISignalService {
  static serviceType: string = SIGNAL_SERVICE_NAME;
  capabilityDescription =
    "The agent is able to send and receive messages on Signal";

  async stop(): Promise<void> {
    await this.shutdown();
  }

  character: Character;
  accountNumber: string | null = null;
  isConnected = false;

  private client: SignalApiClient | null = null;
  private settings: SignalSettings;
  private contactCache: Map<string, SignalContact> = new Map();
  private groupCache: Map<string, SignalGroup> = new Map();
  private pollTaskId: UUID | null = null;
  private isPolling = false;

  private static readonly SIGNAL_POLL_TASK = "SIGNAL_POLL";
  private static readonly SIGNAL_POLL_INTERVAL_MS = 2000;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      this.character = runtime.character;
      this.settings = this.loadSettings();
    } else {
      this.character = {} as Character;
      this.settings = {
        shouldIgnoreGroupMessages: false,
        allowedGroups: undefined,
        blockedNumbers: undefined,
      };
    }
  }

  private loadSettings(): SignalSettings {
    const ignoreGroups = this.runtime.getSetting(
      "SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES",
    );

    return {
      shouldIgnoreGroupMessages:
        ignoreGroups === "true" || ignoreGroups === true,
      allowedGroups: undefined,
      blockedNumbers: undefined,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<SignalService> {
    const service = new SignalService(runtime);

    const accountNumber = runtime.getSetting("SIGNAL_ACCOUNT_NUMBER") as string;
    const httpUrl = runtime.getSetting("SIGNAL_HTTP_URL") as string;

    if (!accountNumber) {
      runtime.logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_ACCOUNT_NUMBER not provided, Signal service will not start",
      );
      return service;
    }

    const normalizedNumber = normalizeE164(accountNumber);
    if (!normalizedNumber) {
      runtime.logger.error(
        { src: "plugin:signal", agentId: runtime.agentId, accountNumber },
        "Invalid SIGNAL_ACCOUNT_NUMBER format",
      );
      return service;
    }

    service.accountNumber = normalizedNumber;

    if (httpUrl) {
      service.client = new SignalApiClient(httpUrl, normalizedNumber);
      await service.initialize();
    } else {
      runtime.logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_HTTP_URL not provided, Signal service will not be able to communicate",
      );
    }

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(SIGNAL_SERVICE_NAME) as
      | SignalService
      | undefined;
    if (service) {
      await service.shutdown();
    }
  }

  private async initialize(): Promise<void> {
    if (!this.client) return;

    this.runtime.logger.info(
      {
        src: "plugin:signal",
        agentId: this.runtime.agentId,
        accountNumber: this.accountNumber,
      },
      "Initializing Signal service",
    );

    // Test connection by getting contacts
    const contacts = await this.client.getContacts();
    this.runtime.logger.info(
      {
        src: "plugin:signal",
        agentId: this.runtime.agentId,
        contactCount: contacts.length,
      },
      "Signal service connected",
    );

    // Cache contacts
    for (const contact of contacts) {
      this.contactCache.set(contact.number, contact);
    }

    // Cache groups
    const groups = await this.client.getGroups();
    for (const group of groups) {
      this.groupCache.set(group.id, group);
    }

    this.isConnected = true;

    this.registerPollWorker();
    await this.ensurePollTask();
  }

  private async shutdown(): Promise<void> {
    if (this.pollTaskId && typeof this.runtime.deleteTask === "function") {
      await this.runtime.deleteTask(this.pollTaskId).catch(() => {});
      this.pollTaskId = null;
    }
    this.client = null;
    this.isConnected = false;

    this.runtime.logger.info(
      { src: "plugin:signal", agentId: this.runtime.agentId },
      "Signal service stopped",
    );
  }

  private registerPollWorker(): void {
    this.runtime.registerTaskWorker({
      name: SignalService.SIGNAL_POLL_TASK,
      execute: async () => {
        await this.pollMessages();
      },
    });
  }

  private async ensurePollTask(): Promise<void> {
    const rt = this.runtime;
    if (typeof rt.getTasksByName !== "function" || typeof rt.createTask !== "function") return;
    const agentId = rt.agentId;
    const existing = await rt.getTasksByName(SignalService.SIGNAL_POLL_TASK);
    const mine = existing.find((t) => t.agentId != null && String(t.agentId) === String(agentId));
    if (mine?.id) {
      this.pollTaskId = mine.id;
      return;
    }
    this.pollTaskId = await rt.createTask({
      name: SignalService.SIGNAL_POLL_TASK,
      tags: ["queue", "repeat"],
      metadata: {
        updateInterval: SignalService.SIGNAL_POLL_INTERVAL_MS,
        baseInterval: SignalService.SIGNAL_POLL_INTERVAL_MS,
        updatedAt: Date.now(),
      },
    });
  }

  private async pollMessages(): Promise<void> {
    if (!this.client || this.isPolling) return;

    this.isPolling = true;

    const messages = await this.client.receive();

    for (const msg of messages) {
      await this.handleIncomingMessage(msg);
    }

    this.isPolling = false;
  }

  private async handleIncomingMessage(msg: SignalMessage): Promise<void> {
    // Handle reactions separately
    if (msg.reaction) {
      await this.handleReaction(msg);
      return;
    }

    // Skip if no message content
    if (!msg.message && msg.attachments.length === 0) {
      return;
    }

    const isGroupMessage = Boolean(msg.groupId);

    // Check if we should ignore group messages
    if (isGroupMessage && this.settings.shouldIgnoreGroupMessages) {
      return;
    }

    // Build memory from message
    const memory = await this.buildMemoryFromMessage(msg);
    if (!memory) return;

    // Get or create room
    const room = await this.ensureRoomExists(msg.sender, msg.groupId);

    // Store the memory
    await this.runtime.createMemory(memory, "messages");

    // Emit event
    await this.runtime.emitEvent(SignalEventTypes.MESSAGE_RECEIVED as string, {
      runtime: this.runtime,
      source: "signal",
    });

    // Process the message through the agent
    await this.processMessage(memory, room, msg.sender, msg.groupId);
  }

  private async handleReaction(msg: SignalMessage): Promise<void> {
    if (!msg.reaction) return;

    await this.runtime.emitEvent(SignalEventTypes.REACTION_RECEIVED as string, {
      runtime: this.runtime,
      source: "signal",
    });
  }

  private async processMessage(
    memory: Memory,
    room: Room,
    sender: string,
    groupId?: string,
  ): Promise<void> {
    const callback: HandlerCallback = async (
      response: Content,
    ): Promise<Memory[]> => {
      if (groupId) {
        await this.sendGroupMessage(groupId, response.text || "");
      } else {
        await this.sendMessage(sender, response.text || "");
      }

      // Create memory for the response
      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, `signal-response-${Date.now()}`),
        agentId: this.runtime.agentId,
        roomId: room.id,
        entityId: this.runtime.agentId,
        content: {
          text: response.text || "",
          source: "signal",
          inReplyTo: memory.id,
        },
        createdAt: Date.now(),
      };

      await this.runtime.createMemory(responseMemory, "messages");

      await this.runtime.emitEvent(SignalEventTypes.MESSAGE_SENT as string, {
        runtime: this.runtime,
        source: "signal",
      });

      return [responseMemory];
    };

    const messageService = getMessageService(this.runtime);
    if (messageService) {
      await messageService.handleMessage(this.runtime, memory, callback);
    }
  }

  private async buildMemoryFromMessage(
    msg: SignalMessage,
  ): Promise<Memory | null> {
    const roomId = await this.getRoomId(msg.sender, msg.groupId);
    const entityId = this.getEntityId(msg.sender);

    // Get contact info for display name
    const contact = this.contactCache.get(msg.sender);
    const displayName = contact
      ? getSignalContactDisplayName(contact)
      : msg.sender;

    // Extract media from attachments
    const media: Media[] = msg.attachments.map((att) => ({
      id: att.id,
      url: `signal://attachment/${att.id}`,
      title: att.filename || att.id,
      source: "signal",
      description: att.caption || att.filename,
      contentType: att.contentType as ContentType | undefined,
    }));

    const memory: Memory = {
      id: createUniqueUuid(this.runtime, `signal-${msg.timestamp}`),
      agentId: this.runtime.agentId,
      roomId,
      entityId,
      content: {
        text: msg.message || "",
        source: "signal",
        name: displayName,
        ...(media.length > 0 ? { attachments: media } : {}),
      },
      createdAt: msg.timestamp,
    };

    return memory;
  }

  private async getRoomId(sender: string, groupId?: string): Promise<UUID> {
    const roomKey = groupId || sender;
    return createUniqueUuid(this.runtime, `signal-room-${roomKey}`);
  }

  private getEntityId(number: string): UUID {
    return stringToUuid(`signal-user-${number}`);
  }

  private async ensureRoomExists(
    sender: string,
    groupId?: string,
  ): Promise<Room> {
    const roomId = await this.getRoomId(sender, groupId);

    const existingRoom = await this.runtime.getRoom(roomId);
    if (existingRoom) return existingRoom;

    const isGroup = Boolean(groupId);
    const group = groupId ? this.groupCache.get(groupId) : null;
    const contact = this.contactCache.get(sender);

    const room: Room = {
      id: roomId,
      name: isGroup
        ? group?.name || `Signal Group ${groupId}`
        : contact
          ? getSignalContactDisplayName(contact)
          : sender,
      agentId: this.runtime.agentId,
      source: "signal",
      type: isGroup ? ChannelType.GROUP : ChannelType.DM,
      channelId: groupId || sender,
      metadata: {
        isGroup,
        groupId,
        sender,
        groupName: group?.name,
        groupDescription: group?.description,
      },
    };

    await this.runtime.createRoom(room);

    return room;
  }

  async sendMessage(
    recipient: string,
    text: string,
    options?: SignalMessageSendOptions,
  ): Promise<{ timestamp: number }> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    // Normalize recipient number
    const normalizedRecipient = normalizeE164(recipient);
    if (!normalizedRecipient) {
      throw new Error(`Invalid recipient number: ${recipient}`);
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (const msg of messages) {
      const result = await this.client.sendMessage(
        normalizedRecipient,
        msg,
        options,
      );
      lastTimestamp = result.timestamp;
    }

    return { timestamp: lastTimestamp };
  }

  async sendGroupMessage(
    groupId: string,
    text: string,
    options?: SignalMessageSendOptions,
  ): Promise<{ timestamp: number }> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (const msg of messages) {
      const result = await this.client.sendGroupMessage(groupId, msg, options);
      lastTimestamp = result.timestamp;
    }

    return { timestamp: lastTimestamp };
  }

  async sendReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    await this.client.sendReaction(
      recipient,
      emoji,
      targetTimestamp,
      targetAuthor,
    );
  }

  async removeReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    await this.client.sendReaction(
      recipient,
      emoji,
      targetTimestamp,
      targetAuthor,
      true,
    );
  }

  async getContacts(): Promise<SignalContact[]> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    const contacts = await this.client.getContacts();

    // Update cache
    for (const contact of contacts) {
      this.contactCache.set(contact.number, contact);
    }

    return contacts;
  }

  async getGroups(): Promise<SignalGroup[]> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    const groups = await this.client.getGroups();

    // Update cache
    for (const group of groups) {
      this.groupCache.set(group.id, group);
    }

    return groups;
  }

  async getGroup(groupId: string): Promise<SignalGroup | null> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    const group = await this.client.getGroup(groupId);
    if (group) {
      this.groupCache.set(group.id, group);
    }

    return group;
  }

  async sendTypingIndicator(recipient: string): Promise<void> {
    if (!this.client) return;
    await this.client.sendTyping(recipient);
  }

  async stopTypingIndicator(recipient: string): Promise<void> {
    if (!this.client) return;
    await this.client.sendTyping(recipient, true);
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_SIGNAL_MESSAGE_LENGTH) {
      return [text];
    }

    const messages: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_SIGNAL_MESSAGE_LENGTH) {
        messages.push(remaining);
        break;
      }

      let splitIndex = MAX_SIGNAL_MESSAGE_LENGTH;

      const lastNewline = remaining.lastIndexOf(
        "\n",
        MAX_SIGNAL_MESSAGE_LENGTH,
      );
      if (lastNewline > MAX_SIGNAL_MESSAGE_LENGTH / 2) {
        splitIndex = lastNewline + 1;
      } else {
        const lastSpace = remaining.lastIndexOf(" ", MAX_SIGNAL_MESSAGE_LENGTH);
        if (lastSpace > MAX_SIGNAL_MESSAGE_LENGTH / 2) {
          splitIndex = lastSpace + 1;
        }
      }

      messages.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return messages;
  }

  getContact(number: string): SignalContact | null {
    return this.contactCache.get(number) || null;
  }

  getCachedGroup(groupId: string): SignalGroup | null {
    return this.groupCache.get(groupId) || null;
  }

  getAccountNumber(): string | null {
    return this.accountNumber;
  }

  isServiceConnected(): boolean {
    return this.isConnected;
  }
}
