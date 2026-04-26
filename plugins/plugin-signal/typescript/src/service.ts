import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChannelType,
  type Character,
  type Content,
  type ContentType,
  createMessageMemory,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  type Media,
  type Memory,
  type Room,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { signalCheck } from "./rpc";

type MessageService = Pick<IMessageService, "handleMessage">;

const getMessageService = (runtime: IAgentRuntime): MessageService | null => {
  if ("messageService" in runtime) {
    const withMessageService = runtime as IAgentRuntime & {
      messageService?: MessageService | null;
    };
    return withMessageService.messageService ?? null;
  }
  return null;
};

import { resolveSignalCliExecutable } from "./pairing-service";
import {
  getSignalContactDisplayName,
  type ISignalService,
  isValidUuid,
  MAX_SIGNAL_MESSAGE_LENGTH,
  normalizeE164,
  SIGNAL_SERVICE_NAME,
  type SignalAttachment,
  type SignalContact,
  SignalEventTypes,
  type SignalGroup,
  type SignalMessage,
  type SignalMessageSendOptions,
  type SignalQuote,
  type SignalReactionInfo,
  type SignalRecentMessage,
  type SignalSettings,
} from "./types";

export const DEFAULT_SIGNAL_HTTP_HOST = "127.0.0.1";
export const DEFAULT_SIGNAL_HTTP_PORT = 8080;
const DEFAULT_SIGNAL_DAEMON_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SIGNAL_CLI_PATH = "signal-cli";
const BREW_OPENJDK_HOME = "/opt/homebrew/opt/openjdk";

/**
 * signal-cli uses `$HOME/.local/share/signal-cli` as its default data
 * directory on every platform (the XDG path is hardcoded in signal-cli —
 * it does not honour `Library/Application Support` on macOS). Matching
 * that default here means a locally-installed signal-cli + a user who
 * ran `signal-cli -a +1555… link` once will "just work" — no config
 * needed beyond `SIGNAL_ACCOUNT_NUMBER`.
 *
 * Override with `SIGNAL_AUTH_DIR` to point at a custom install.
 */
export function defaultSignalAuthDir(): string {
  const home = os.homedir();
  return path.join(home, ".local", "share", "signal-cli");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function buildSignalCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const javaHome =
    (fs.existsSync(BREW_OPENJDK_HOME) ? BREW_OPENJDK_HOME : null) ||
    (typeof env.JAVA_HOME === "string" && env.JAVA_HOME.trim().length > 0
      ? env.JAVA_HOME.trim()
      : null);

  if (javaHome) {
    env.JAVA_HOME = javaHome;
    const javaBin = path.join(javaHome, "bin");
    env.PATH = env.PATH ? `${javaBin}:${env.PATH}` : javaBin;
  }

  return env;
}

/**
 * Signal API client for HTTP API mode
 */
class SignalApiClient {
  constructor(
    private baseUrl: string,
    private accountNumber: string
  ) {}

  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>,
    allowEmptyResponse = false
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
    if (!text) {
      if (allowEmptyResponse) return {} as T;
      throw new Error(`Signal API returned empty response for ${method} ${endpoint}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Signal API returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  async sendMessage(
    recipient: string,
    message: string,
    options?: SignalMessageSendOptions
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
    options?: SignalMessageSendOptions
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
    remove = false
  ): Promise<void> {
    await this.request(
      "POST",
      `/v1/reactions/${this.accountNumber}`,
      {
        recipient,
        reaction: emoji,
        target_author: targetAuthor,
        timestamp: targetTimestamp,
        remove,
      },
      true
    );
  }

  async getContacts(): Promise<SignalContact[]> {
    const result = await this.request<{ contacts: SignalContact[] }>(
      "GET",
      `/v1/contacts/${this.accountNumber}`
    );
    return result.contacts || [];
  }

  async getGroups(): Promise<SignalGroup[]> {
    const result = await this.request<SignalGroup[]>("GET", `/v1/groups/${this.accountNumber}`);
    return result || [];
  }

  async getGroup(groupId: string): Promise<SignalGroup | null> {
    const groups = await this.getGroups();
    return groups.find((g) => g.id === groupId) || null;
  }

  async receive(): Promise<SignalMessage[]> {
    const result = await this.request<SignalMessage[]>("GET", `/v1/receive/${this.accountNumber}`);
    return result || [];
  }

  async sendTyping(recipient: string, stop = false): Promise<void> {
    await this.request(
      "PUT",
      `/v1/typing-indicator/${this.accountNumber}`,
      {
        recipient,
        stop,
      },
      true
    );
  }

  async setProfile(name: string, about?: string): Promise<void> {
    await this.request(
      "PUT",
      `/v1/profiles/${this.accountNumber}`,
      {
        name,
        about: about || "",
      },
      true
    );
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
    trustLevel: "TRUSTED_VERIFIED" | "TRUSTED_UNVERIFIED" | "UNTRUSTED"
  ): Promise<void> {
    await this.request(
      "PUT",
      `/v1/identities/${this.accountNumber}/trust/${number}`,
      {
        trust_level: trustLevel,
      },
      true
    );
  }
}

/**
 * SignalService class for interacting with Signal via HTTP API or CLI
 */
export class SignalService extends Service implements ISignalService {
  static serviceType: string = SIGNAL_SERVICE_NAME;
  capabilityDescription = "The agent is able to send and receive messages on Signal";

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
  private pollInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private daemonProcess: ChildProcess | null = null;

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
    const ignoreGroups = this.runtime.getSetting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES");

    return {
      shouldIgnoreGroupMessages: ignoreGroups === "true" || ignoreGroups === true,
      allowedGroups: undefined,
      blockedNumbers: undefined,
    };
  }

  static async start(runtime: IAgentRuntime): Promise<SignalService> {
    const service = new SignalService(runtime);

    const accountNumber = runtime.getSetting("SIGNAL_ACCOUNT_NUMBER") as string;
    const httpUrl = runtime.getSetting("SIGNAL_HTTP_URL") as string;
    const rawAuthDir = runtime.getSetting("SIGNAL_AUTH_DIR") as string | undefined;
    const authDir =
      typeof rawAuthDir === "string" && rawAuthDir.trim().length > 0
        ? rawAuthDir.trim()
        : defaultSignalAuthDir();
    const configuredCliPath =
      (runtime.getSetting("SIGNAL_CLI_PATH") as string | undefined) || DEFAULT_SIGNAL_CLI_PATH;
    const httpHost =
      (runtime.getSetting("SIGNAL_HTTP_HOST") as string | undefined)?.trim() ||
      DEFAULT_SIGNAL_HTTP_HOST;
    const parsedHttpPort = Number.parseInt(
      String(runtime.getSetting("SIGNAL_HTTP_PORT") ?? ""),
      10
    );
    const httpPort =
      Number.isFinite(parsedHttpPort) && parsedHttpPort > 0
        ? parsedHttpPort
        : DEFAULT_SIGNAL_HTTP_PORT;
    const parsedStartupTimeout = Number.parseInt(
      String(runtime.getSetting("SIGNAL_STARTUP_TIMEOUT_MS") ?? ""),
      10
    );
    const startupTimeoutMs =
      Number.isFinite(parsedStartupTimeout) && parsedStartupTimeout > 0
        ? Math.min(parsedStartupTimeout, 120_000)
        : DEFAULT_SIGNAL_DAEMON_STARTUP_TIMEOUT_MS;

    if (!accountNumber) {
      runtime.logger.warn(
        { src: "plugin:signal", agentId: runtime.agentId },
        "SIGNAL_ACCOUNT_NUMBER not provided, Signal service will not start"
      );
      return service;
    }

    const normalizedNumber = normalizeE164(accountNumber);
    if (!normalizedNumber) {
      runtime.logger.error(
        { src: "plugin:signal", agentId: runtime.agentId, accountNumber },
        "Invalid SIGNAL_ACCOUNT_NUMBER format"
      );
      return service;
    }

    service.accountNumber = normalizedNumber;

    const baseUrl = httpUrl?.trim() ? normalizeBaseUrl(httpUrl) : `http://${httpHost}:${httpPort}`;

    if (!httpUrl) {
      // authDir is now guaranteed non-empty (falls back to defaultSignalAuthDir()).
      // If the directory does not exist, signal-cli would fail on startup with
      // a confusing "No linked devices" error — pre-empt that with a clearer
      // warning that points at the user's next action.
      if (!fs.existsSync(authDir)) {
        runtime.logger.warn(
          {
            src: "plugin:signal",
            agentId: runtime.agentId,
            authDir,
          },
          "Signal auth directory does not exist yet — run `signal-cli -a <number> link` (or set SIGNAL_AUTH_DIR to a pre-existing install) before starting the plugin"
        );
        return service;
      }

      try {
        await service.ensureDaemonRunning(configuredCliPath, authDir, baseUrl, startupTimeoutMs);
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:signal",
            agentId: runtime.agentId,
            error: String(error),
            authDir,
            cliPath: configuredCliPath,
          },
          "Failed to start signal-cli daemon"
        );
        return service;
      }
    }

    service.client = new SignalApiClient(baseUrl, normalizedNumber);
    try {
      await service.initialize();
    } catch (error) {
      runtime.logger.warn(
        {
          src: "plugin:signal",
          agentId: runtime.agentId,
          error: String(error),
          baseUrl,
        },
        "Signal service failed to initialize"
      );
    }

    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: SignalService): void {
    runtime.registerSendHandler("signal", async (_runtime, target, content) => {
      const text = typeof content.text === "string" ? content.text.trim() : "";
      if (!text) {
        return;
      }

      const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
      const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
      if (!channelId) {
        throw new Error("Signal target is missing a channel identifier");
      }

      const isGroup = room?.type === ChannelType.GROUP;
      const result = isGroup
        ? await service.sendGroupMessage(channelId, text)
        : await service.sendMessage(channelId, text);

      if (!target.roomId) {
        return;
      }

      await runtime.createMemory(
        createMessageMemory({
          id: createUniqueUuid(runtime, `signal:${result.timestamp}`),
          entityId: runtime.agentId,
          roomId: target.roomId,
          content: {
            ...content,
            text,
            source: "signal",
          },
        }),
        "messages"
      );
    });
  }

  private async initialize(): Promise<void> {
    if (!this.client) return;

    this.runtime.logger.info(
      {
        src: "plugin:signal",
        agentId: this.runtime.agentId,
        accountNumber: this.accountNumber,
      },
      "Initializing Signal service"
    );

    // Test connection by getting contacts
    const contacts = await this.client.getContacts();
    this.runtime.logger.info(
      {
        src: "plugin:signal",
        agentId: this.runtime.agentId,
        contactCount: contacts.length,
      },
      "Signal service connected"
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

    // Start polling for messages
    this.startPolling();
  }

  private async shutdown(): Promise<void> {
    this.stopPolling();
    this.client = null;
    this.isConnected = false;
    if (this.daemonProcess) {
      this.daemonProcess.kill("SIGTERM");
      this.daemonProcess = null;
    }

    this.runtime.logger.info(
      { src: "plugin:signal", agentId: this.runtime.agentId },
      "Signal service stopped"
    );
  }

  private async ensureDaemonRunning(
    cliPath: string,
    authDir: string,
    baseUrl: string,
    startupTimeoutMs: number
  ): Promise<void> {
    const current = await signalCheck(baseUrl, 1_500);
    if (current.ok) {
      return;
    }

    const resolvedCliPath = await resolveSignalCliExecutable({
      cliPath,
      env: process.env,
    });
    if (!resolvedCliPath) {
      throw new Error(`signal-cli executable not found for ${cliPath}`);
    }

    fs.mkdirSync(authDir, { recursive: true });
    const httpTarget = new URL(baseUrl).host;
    const daemonArgs = [
      "--config",
      authDir,
      "daemon",
      "--http",
      httpTarget,
      "--receive-mode",
      "on-start",
      "--no-receive-stdout",
    ];
    const child = spawn(resolvedCliPath, daemonArgs, {
      env: buildSignalCliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.daemonProcess = child;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text.length > 0) {
        this.runtime.logger.debug(
          { src: "plugin:signal", agentId: this.runtime.agentId, output: text },
          "signal-cli daemon stdout"
        );
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text.length > 0) {
        this.runtime.logger.info(
          { src: "plugin:signal", agentId: this.runtime.agentId, output: text },
          "signal-cli daemon stderr"
        );
      }
    });

    child.once("exit", (code, signal) => {
      if (this.daemonProcess === child) {
        this.daemonProcess = null;
      }
      this.runtime.logger.warn(
        {
          src: "plugin:signal",
          agentId: this.runtime.agentId,
          code,
          signal,
        },
        "signal-cli daemon exited"
      );
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < startupTimeoutMs) {
      if (child.exitCode !== null) {
        throw new Error(`signal-cli daemon exited before becoming ready (code ${child.exitCode})`);
      }

      const ready = await signalCheck(baseUrl, 1_500);
      if (ready.ok) {
        return;
      }

      await sleep(500);
    }

    throw new Error(
      `signal-cli daemon did not become ready at ${baseUrl} within ${startupTimeoutMs}ms`
    );
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      await this.pollMessages();
    }, 2000); // Poll every 2 seconds
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Unwraps signal-cli REST API envelope format into a flat SignalMessage.
   *
   * signal-cli returns `{envelope:{source, sourceNumber, sourceName, dataMessage:{message,...}}}`
   * but the plugin expects flat `{sender, message, timestamp, ...}` objects.
   */
  static unwrapEnvelope(raw: Record<string, unknown>): SignalMessage | null {
    if (!raw || !("envelope" in raw)) return raw as unknown as SignalMessage;

    const env = raw.envelope as Record<string, unknown>;
    const dm = (env.dataMessage || {}) as Record<string, unknown>;
    const groupInfo = dm.groupInfo as Record<string, unknown> | undefined;

    const sender = (env.sourceNumber as string) || (env.source as string);
    const timestamp = (dm.timestamp as number) || (env.timestamp as number);

    // Both sender and timestamp are required to produce a usable message.
    if (!sender || !timestamp) return null;

    return {
      sender,
      senderUuid: env.source as string | undefined,
      message: dm.message as string | undefined,
      timestamp,
      groupId: groupInfo?.groupId as string | undefined,
      attachments: (dm.attachments as SignalAttachment[]) || [],
      reaction: dm.reaction as SignalReactionInfo | undefined,
      expiresInSeconds: (dm.expiresInSeconds as number) || 0,
      viewOnce: (dm.viewOnce as boolean) || false,
      quote: dm.quote as SignalQuote | undefined,
    };
  }

  private async pollMessages(): Promise<void> {
    if (!this.client || this.isPolling) return;

    this.isPolling = true;

    try {
      const rawMessages = (await this.client.receive()) || [];

      for (const raw of rawMessages) {
        try {
          const msg = SignalService.unwrapEnvelope(raw as unknown as Record<string, unknown>);
          if (!msg) {
            this.runtime.logger.warn(
              { src: "plugin:signal" },
              "Skipping malformed envelope (missing sender or timestamp)"
            );
            continue;
          }
          await this.handleIncomingMessage(msg);
        } catch (msgErr) {
          this.runtime.logger.error(
            { src: "plugin:signal", error: String(msgErr) },
            "Error handling incoming message"
          );
        }
      }
    } catch (err) {
      this.runtime.logger.error(
        { src: "plugin:signal", error: String(err) },
        "Error polling messages"
      );
    } finally {
      this.isPolling = false;
    }
  }

  private async handleIncomingMessage(msg: SignalMessage): Promise<void> {
    // Handle reactions separately
    if (msg.reaction) {
      await this.handleReaction(msg);
      return;
    }

    // Skip if no message content
    if (!msg.message && (!msg.attachments || msg.attachments.length === 0)) {
      return;
    }

    const isGroupMessage = Boolean(msg.groupId);

    // Check if we should ignore group messages
    if (isGroupMessage && this.settings.shouldIgnoreGroupMessages) {
      return;
    }

    // Ensure entity, room, and world exist before creating memories.
    // Without this, the DB insert fails because the foreign keys don't exist.
    const entityId = this.getEntityId(msg.sender);
    const roomId = await this.getRoomId(msg.sender, msg.groupId);
    const worldId = createUniqueUuid(this.runtime, "signal-world");
    const contact = this.contactCache.get(msg.sender);
    const displayName = contact ? getSignalContactDisplayName(contact) : msg.sender;

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: "Signal",
      userName: displayName,
      name: displayName,
      source: "signal",
      type: isGroupMessage ? ChannelType.GROUP : ChannelType.DM,
      channelId: msg.groupId || msg.sender,
    });

    // Build memory from message
    const memory = await this.buildMemoryFromMessage(msg);
    if (!memory) return;

    // Store the memory
    await this.runtime.createMemory(memory, "messages");

    // Emit event
    await this.runtime.emitEvent(SignalEventTypes.MESSAGE_RECEIVED as string, {
      runtime: this.runtime,
      source: "signal",
    });

    // Get the room for processMessage; fall back to ensureRoomExists if
    // getRoom returns null (e.g. race condition after ensureConnection).
    let room = await this.runtime.getRoom(roomId);
    if (!room) {
      this.runtime.logger.warn(
        { src: "plugin:signal", roomId, sender: msg.sender },
        "Room not found after ensureConnection, creating via ensureRoomExists"
      );
      room = await this.ensureRoomExists(msg.sender, msg.groupId);
    }

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
    groupId?: string
  ): Promise<void> {
    const callback: HandlerCallback = async (response: Content): Promise<Memory[]> => {
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
      await messageService.handleMessage(this.runtime, memory, callback, {
        onBeforeActionExecution: async () => {
          await this.sendTypingBeforeActions(sender, groupId);
        },
      });
    }
  }

  private async buildMemoryFromMessage(msg: SignalMessage): Promise<Memory | null> {
    const roomId = await this.getRoomId(msg.sender, msg.groupId);
    const entityId = this.getEntityId(msg.sender);

    // Get contact info for display name
    const contact = this.contactCache.get(msg.sender);
    const displayName = contact ? getSignalContactDisplayName(contact) : msg.sender;

    // Extract media from attachments
    const media: Media[] = (msg.attachments || []).map((att) => ({
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

  private async ensureRoomExists(sender: string, groupId?: string): Promise<Room> {
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
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    // signal-cli may identify senders by UUID instead of phone number.
    // Accept both UUID and E.164 formats.
    const normalizedRecipient = isValidUuid(recipient) ? recipient : normalizeE164(recipient);
    if (!normalizedRecipient) {
      throw new Error(`Invalid recipient number: ${recipient}`);
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (let i = 0; i < messages.length; i++) {
      // Only send attachments/quote with the first chunk
      const chunkOptions = i === 0 ? options : undefined;
      const result = await this.client.sendMessage(normalizedRecipient, messages[i], chunkOptions);
      lastTimestamp = result.timestamp;
    }

    return { timestamp: lastTimestamp };
  }

  async sendGroupMessage(
    groupId: string,
    text: string,
    options?: SignalMessageSendOptions
  ): Promise<{ timestamp: number }> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    // Split message if too long
    const messages = this.splitMessage(text);
    let lastTimestamp = 0;

    for (let i = 0; i < messages.length; i++) {
      // Only send attachments with the first chunk
      const chunkOptions = i === 0 ? options : undefined;
      const result = await this.client.sendGroupMessage(groupId, messages[i], chunkOptions);
      lastTimestamp = result.timestamp;
    }

    return { timestamp: lastTimestamp };
  }

  async sendReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    await this.client.sendReaction(recipient, emoji, targetTimestamp, targetAuthor);
  }

  async removeReaction(
    recipient: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Signal client not initialized");
    }

    await this.client.sendReaction(recipient, emoji, targetTimestamp, targetAuthor, true);
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

  async getRecentMessages(limit: number = 20): Promise<SignalRecentMessage[]> {
    if (
      typeof this.runtime.getRoomsForParticipant !== "function" ||
      typeof this.runtime.getMemoriesByRoomIds !== "function"
    ) {
      return [];
    }

    const requestedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    const participantRoomIds = await this.runtime.getRoomsForParticipant(this.runtime.agentId);

    const signalRooms: Room[] = [];
    for (const roomId of participantRoomIds) {
      const room = await this.runtime.getRoom(roomId);
      if (room?.source === "signal") {
        signalRooms.push(room);
      }
    }

    if (signalRooms.length === 0) {
      return [];
    }

    const roomIds = signalRooms.map((room) => room.id);
    const roomsById = new Map(signalRooms.map((room) => [room.id, room]));
    const memories = await this.runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: requestedLimit * 4,
    });

    return memories
      .filter((memory) => memory.content?.source === "signal")
      .filter(
        (memory) =>
          typeof memory.content?.text === "string" && memory.content.text.trim().length > 0
      )
      .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))
      .slice(0, requestedLimit)
      .map((memory) => {
        const room = roomsById.get(memory.roomId);
        const isGroup =
          room?.type === ChannelType.GROUP ||
          Boolean((room?.metadata as Record<string, unknown> | undefined)?.isGroup);
        const text = String(memory.content.text ?? "").trim();
        const speakerName =
          memory.entityId === this.runtime.agentId
            ? this.character?.name || "Agent"
            : typeof memory.content.name === "string" && memory.content.name.trim().length > 0
              ? memory.content.name.trim()
              : room?.name || room?.channelId || "Unknown";

        return {
          id: String(memory.id),
          roomId: String(memory.roomId),
          channelId: String(room?.channelId ?? ""),
          roomName: room?.name || room?.channelId || "Signal",
          speakerName,
          text,
          createdAt: Number(memory.createdAt ?? Date.now()),
          isFromAgent: memory.entityId === this.runtime.agentId,
          isGroup,
        } satisfies SignalRecentMessage;
      });
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

  /**
   * Typing after planning when the pipeline will run actions (not a simple reply).
   * Uses the same addressing scheme as send (E.164 / UUID for DM, `group.{id}` for groups).
   */
  async sendTypingBeforeActions(sender: string, groupId?: string): Promise<void> {
    if (!this.client) return;
    const target = groupId ? `group.${groupId}` : sender;
    await this.client.sendTyping(target);
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

      const lastNewline = remaining.lastIndexOf("\n", MAX_SIGNAL_MESSAGE_LENGTH);
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
