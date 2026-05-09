import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ChannelType,
  ContentType,
  createMessageMemory,
  createUniqueUuid,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  type MemoryMetadata,
  type Plugin,
  type Route,
  type RouteRequest,
  type RouteResponse,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { resolveStateDir } from "@elizaos/agent";

const execFileAsync = promisify(execFile);

export const DISCORD_LOCAL_PLUGIN_NAME = "@elizaos/plugin-discord-local";
export const DISCORD_LOCAL_SERVICE_NAME = "discord-local";
const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/v10/oauth2/token";
const DISCORD_LOCAL_DEFAULT_SCOPES = [
  "rpc",
  "identify",
  "rpc.notifications.read",
] as const;

const IPC_OP_HANDSHAKE = 0;
const IPC_OP_FRAME = 1;
const IPC_OP_CLOSE = 2;
const IPC_OP_PING = 3;
const IPC_OP_PONG = 4;

type DiscordLocalConfig = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  messageChannelIds: string[];
  sendDelayMs: number;
};

type DiscordLocalSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
};

type DiscordLocalUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

type DiscordLocalChannel = {
  id: string;
  guild_id?: string | null;
  type?: number;
  name?: string | null;
  recipients?: DiscordLocalUser[];
};

type DiscordLocalGuild = {
  id: string;
  name: string;
};

interface ConnectorSetupService {
  getConfig(): Record<string, unknown>;
  updateConfig(updater: (config: Record<string, unknown>) => void): void;
  registerEscalationChannel(channelName: string): boolean;
  setOwnerContact(update: {
    source: string;
    channelId?: string;
    entityId?: string;
    roomId?: string;
  }): boolean;
}

interface ConnectorConfig {
  enabled?: boolean;
  messageChannelIds?: string[];
  [key: string]: unknown;
}

type DiscordLocalAttachment = {
  id: string;
  filename?: string;
  url?: string;
  content_type?: string;
  description?: string | null;
};

type DiscordLocalMessage = {
  id: string;
  channel_id?: string;
  guild_id?: string | null;
  content?: string;
  author?: DiscordLocalUser | null;
  attachments?: DiscordLocalAttachment[];
  timestamp?: string;
  referenced_message?: DiscordLocalMessage | null;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string | null;
  } | null;
};

type DiscordLocalNotification = {
  channel_id?: string;
  message?: DiscordLocalMessage | null;
};

type DiscordLocalRpcPayload = {
  cmd?: string;
  evt?: string;
  nonce?: string;
  data?: unknown;
};

type PendingRpcRequest = {
  resolve: (value: DiscordLocalRpcPayload) => void;
  reject: (error: Error) => void;
};

function parseListSetting(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

function getDiscordLocalConfig(
  runtime: IAgentRuntime,
): DiscordLocalConfig | null {
  const clientId = runtime.getSetting("DISCORD_LOCAL_CLIENT_ID");
  const clientSecret = runtime.getSetting("DISCORD_LOCAL_CLIENT_SECRET");
  const enabledValue = runtime.getSetting("DISCORD_LOCAL_ENABLED");

  const enabled =
    enabledValue === undefined ||
    enabledValue === null ||
    (typeof enabledValue === "string" && enabledValue.trim() !== "false");

  if (
    typeof clientId !== "string" ||
    clientId.trim().length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.trim().length === 0
  ) {
    return null;
  }

  const rawSendDelayMs = runtime.getSetting("DISCORD_LOCAL_SEND_DELAY_MS");
  const parsedSendDelayMs =
    typeof rawSendDelayMs === "string"
      ? Number.parseInt(rawSendDelayMs, 10)
      : Number.NaN;

  return {
    enabled,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    scopes: (() => {
      const parsed = parseListSetting(
        runtime.getSetting("DISCORD_LOCAL_SCOPES"),
      );
      return parsed.length > 0 ? parsed : [...DISCORD_LOCAL_DEFAULT_SCOPES];
    })(),
    messageChannelIds: parseListSetting(
      runtime.getSetting("DISCORD_LOCAL_MESSAGE_CHANNEL_IDS"),
    ),
    sendDelayMs:
      Number.isFinite(parsedSendDelayMs) && parsedSendDelayMs >= 100
        ? parsedSendDelayMs
        : 900,
  };
}

function resolveSessionPath(): string {
  const dir = path.join(resolveStateDir(), "discord-local");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "session.json");
}

function buildDiscordAvatarUrl(
  user: DiscordLocalUser | null | undefined,
): string | undefined {
  if (!user?.avatar || !user.id) {
    return undefined;
  }
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.png?size=128`;
}

function roomTypeForChannel(channelType: number | undefined): ChannelType {
  if (channelType === 1) {
    return ChannelType.DM;
  }
  return ChannelType.GROUP;
}

function worldIdFor(runtime: IAgentRuntime, serverKey: string): UUID {
  return stringToUuid(
    `discord-local-world:${runtime.agentId}:${serverKey}`,
  ) as UUID;
}

function roomIdFor(runtime: IAgentRuntime, channelId: string): UUID {
  return stringToUuid(
    `discord-local-room:${runtime.agentId}:${channelId}`,
  ) as UUID;
}

function entityIdFor(userId: string): UUID {
  return stringToUuid(`discord-local-user:${userId}`) as UUID;
}

function messageIdFor(
  runtime: IAgentRuntime,
  channelId: string,
  messageId: string,
): UUID {
  return stringToUuid(
    `discord-local-message:${runtime.agentId}:${channelId}:${messageId}`,
  ) as UUID;
}

function outboundMemoryIdFor(runtime: IAgentRuntime, roomId: UUID): UUID {
  return createUniqueUuid(
    runtime,
    `discord-local-outbound:${roomId}:${Date.now()}`,
  ) as UUID;
}

function getRegisteredSendHandlers(
  runtime: IAgentRuntime,
): Map<string, unknown> | null {
  const sendHandlers = (runtime as IAgentRuntime & { sendHandlers?: unknown })
    .sendHandlers;
  return sendHandlers instanceof Map ? sendHandlers : null;
}

function contentTypeForMime(
  mimeType: string | undefined,
): ContentType | undefined {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("image/")) {
    return ContentType.IMAGE;
  }
  if (normalized.startsWith("video/")) {
    return ContentType.VIDEO;
  }
  if (normalized.startsWith("audio/")) {
    return ContentType.AUDIO;
  }
  if (normalized === "text/uri-list") {
    return ContentType.LINK;
  }
  return ContentType.DOCUMENT;
}

function describeRpcError(payload: DiscordLocalRpcPayload): string {
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : null;
  const message =
    typeof data?.message === "string"
      ? data.message
      : typeof data?.error === "string"
        ? data.error
        : payload.cmd
          ? `Discord RPC command ${payload.cmd} failed`
          : "Discord RPC request failed";
  const code =
    typeof data?.code === "number" || typeof data?.code === "string"
      ? ` (${String(data.code)})`
      : "";
  return `${message}${code}`;
}

function toAppleScriptStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildDiscordSendScript(text: string, delaySeconds: number): string {
  const lines = text.split(/\r?\n/);
  const scriptLines = [
    'tell application "Discord" to activate',
    `delay ${delaySeconds.toFixed(2)}`,
    'tell application "System Events"',
  ];

  for (const [index, line] of lines.entries()) {
    if (line.length > 0) {
      scriptLines.push(`  keystroke ${toAppleScriptStringLiteral(line)}`);
    }
    if (index < lines.length - 1) {
      scriptLines.push("  key code 36 using shift down");
    }
  }

  scriptLines.push("  key code 36");
  scriptLines.push("end tell");

  return scriptLines.join("\n");
}

async function openDiscordTarget(
  channelId: string,
  guildId?: string | null,
): Promise<void> {
  const url =
    guildId && guildId.trim().length > 0
      ? `discord://-/channels/${guildId}/${channelId}`
      : `discord://-/channels/@me/${channelId}`;
  await execFileAsync("/usr/bin/open", [url]);
}

function getIpcCandidateDirs(): string[] {
  const candidates = [
    process.env.DISCORD_IPC_DIR,
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    "/tmp",
    "/private/tmp",
  ].filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );

  return Array.from(new Set(candidates.map((entry) => entry.trim())));
}

function findDiscordIpcPath(): string | null {
  for (const dir of getIpcCandidateDirs()) {
    for (let index = 0; index < 10; index += 1) {
      const candidate = path.join(dir, `discord-ipc-${index}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const macRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "discord",
  );
  if (!fs.existsSync(macRoot)) {
    return null;
  }

  const stack = [macRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidatePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidatePath);
        continue;
      }
      if (entry.isSocket() && /^discord-ipc-\d+$/.test(entry.name)) {
        return candidatePath;
      }
    }
  }

  return null;
}

export class DiscordLocalService extends Service {
  static serviceType = DISCORD_LOCAL_SERVICE_NAME;
  capabilityDescription =
    "The agent can read Discord notifications and channel messages from the local Discord desktop app and send replies through macOS UI automation.";

  private readonly sessionPath = resolveSessionPath();
  private readonly pendingRequests = new Map<string, PendingRpcRequest>();
  private readonly channelCache = new Map<string, DiscordLocalChannel>();
  private readonly guildCache = new Map<string, DiscordLocalGuild>();
  private readonly subscribedChannelIds = new Set<string>();
  private connectorConfig: DiscordLocalConfig | null = null;
  private socket: net.Socket | null = null;
  private connectedIpcPath: string | null = null;
  private readBuffer = Buffer.alloc(0);
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private session: DiscordLocalSession | null = null;
  private currentUser: DiscordLocalUser | null = null;
  private connected = false;
  private authenticated = false;
  private lastError: string | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (!runtime) {
      return;
    }
    this.connectorConfig = getDiscordLocalConfig(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DiscordLocalService> {
    const service = new DiscordLocalService(runtime);
    await service.startService();
    return service;
  }

  static registerSendHandlers(
    runtime: IAgentRuntime,
    service: DiscordLocalService,
  ): void {
    const register = (source: string) => {
      runtime.registerSendHandler(source, async (_runtime, target, content) => {
        const text =
          typeof content.text === "string" ? content.text.trim() : "";
        if (!text) {
          return;
        }

        const room =
          target.roomId && typeof runtime.getRoom === "function"
            ? await runtime.getRoom(target.roomId)
            : null;
        const channelId = String(
          target.channelId ?? room?.channelId ?? "",
        ).trim();
        if (!channelId) {
          throw new Error("Discord local target is missing a channel ID");
        }

        const channel = await service.getChannel(channelId);
        const guildId =
          channel?.guild_id && channel.guild_id.trim().length > 0
            ? channel.guild_id
            : null;
        await service.sendUiMessage(channelId, guildId, text);

        if (!target.roomId) {
          return;
        }

        const memory = createMessageMemory({
          id: outboundMemoryIdFor(runtime, target.roomId),
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          roomId: target.roomId,
          content: {
            ...content,
            text,
            source: DISCORD_LOCAL_SERVICE_NAME,
          },
        }) as Memory;
        memory.createdAt = Date.now();
        memory.metadata = {
          ...memory.metadata,
          discordChannelId: channelId,
          ...(guildId ? { discordServerId: guildId } : {}),
        } as MemoryMetadata;

        await runtime.createMemory(memory, "messages");
      });
    };

    register(DISCORD_LOCAL_SERVICE_NAME);
    const sendHandlers = getRegisteredSendHandlers(runtime);
    if (!(sendHandlers instanceof Map) || !sendHandlers.has("discord")) {
      register("discord");
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.connectedIpcPath = null;
    this.rejectPendingRequests(new Error("Discord local service stopped"));
    this.socket?.destroy();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getStatus() {
    return {
      available: Boolean(this.connectorConfig),
      connected: this.connected,
      authenticated: this.authenticated,
      currentUser: this.currentUser,
      subscribedChannelIds: [...this.subscribedChannelIds],
      configuredChannelIds: this.connectorConfig?.messageChannelIds ?? [],
      scopes: this.session?.scopes ?? this.connectorConfig?.scopes ?? [],
      lastError: this.lastError,
      ipcPath: this.connected ? this.connectedIpcPath : findDiscordIpcPath(),
    };
  }

  async authorize(): Promise<ReturnType<DiscordLocalService["getStatus"]>> {
    const config = this.requireConfig();
    await this.ensureRpcConnection();
    const response = await this.sendRpcCommand("AUTHORIZE", {
      client_id: config.clientId,
      scopes: config.scopes,
    });

    const code =
      response.data &&
      typeof response.data === "object" &&
      typeof (response.data as Record<string, unknown>).code === "string"
        ? ((response.data as Record<string, unknown>).code as string)
        : "";
    if (!code) {
      throw new Error("Discord AUTHORIZE did not return an authorization code");
    }

    await this.exchangeAuthorizationCode(code);
    return this.getStatus();
  }

  async disconnectSession(): Promise<void> {
    this.session = null;
    this.currentUser = null;
    this.authenticated = false;
    this.subscribedChannelIds.clear();
    await fsp.rm(this.sessionPath, { force: true });
    await this.stop();
  }

  async listGuilds(): Promise<DiscordLocalGuild[]> {
    await this.ensureAuthenticated();
    const response = await this.sendRpcCommand("GET_GUILDS");
    const guilds = Array.isArray(response.data)
      ? (response.data as DiscordLocalGuild[])
      : [];
    for (const guild of guilds) {
      if (guild?.id) {
        this.guildCache.set(guild.id, guild);
      }
    }
    return guilds;
  }

  async listChannels(guildId: string): Promise<DiscordLocalChannel[]> {
    await this.ensureAuthenticated();
    const response = await this.sendRpcCommand("GET_CHANNELS", {
      guild_id: guildId,
    });
    const channels = Array.isArray(response.data)
      ? (response.data as DiscordLocalChannel[])
      : [];
    for (const channel of channels) {
      if (channel?.id) {
        this.channelCache.set(channel.id, channel);
      }
    }
    return channels;
  }

  async subscribeChannelMessages(channelIds: string[]): Promise<string[]> {
    const config = this.requireConfig();
    await this.ensureAuthenticated();
    const normalized = [
      ...new Set(channelIds.map((entry) => entry.trim()).filter(Boolean)),
    ];
    config.messageChannelIds = normalized;

    for (const channelId of Array.from(this.subscribedChannelIds)) {
      if (normalized.includes(channelId)) {
        continue;
      }
      await this.sendRpcCommand(
        "UNSUBSCRIBE",
        { channel_id: channelId },
        "MESSAGE_CREATE",
      );
      this.subscribedChannelIds.delete(channelId);
    }

    for (const channelId of normalized) {
      if (this.subscribedChannelIds.has(channelId)) {
        continue;
      }
      await this.sendRpcCommand(
        "SUBSCRIBE",
        { channel_id: channelId },
        "MESSAGE_CREATE",
      );
      this.subscribedChannelIds.add(channelId);
    }

    return [...normalized];
  }

  async getChannel(channelId: string): Promise<DiscordLocalChannel | null> {
    const cached = this.channelCache.get(channelId);
    if (cached) {
      return cached;
    }
    await this.ensureAuthenticated();
    const response = await this.sendRpcCommand("GET_CHANNEL", {
      channel_id: channelId,
    });
    const channel =
      response.data && typeof response.data === "object"
        ? (response.data as DiscordLocalChannel)
        : null;
    if (channel?.id) {
      this.channelCache.set(channel.id, channel);
    }
    return channel;
  }

  private requireConfig(): DiscordLocalConfig {
    if (!this.connectorConfig) {
      throw new Error("Discord local connector is not configured");
    }
    if (process.platform !== "darwin") {
      throw new Error("Discord local connector currently supports macOS only");
    }
    return this.connectorConfig;
  }

  private async startService(): Promise<void> {
    if (!this.connectorConfig?.enabled) {
      return;
    }

    this.session = await this.loadSession();
    if (!this.session) {
      return;
    }

    try {
      await this.ensureAuthenticated();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[discord-local] Failed to restore Discord local session: ${this.lastError}`,
      );
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    this.requireConfig();
    if (!this.session) {
      throw new Error("Discord local connector is not authorized");
    }

    await this.ensureRpcConnection();

    const expiresAt = this.session.expiresAt ?? 0;
    if (
      this.session.refreshToken &&
      expiresAt > 0 &&
      Date.now() >= expiresAt - 60_000
    ) {
      await this.refreshAccessToken();
    }

    if (this.authenticated) {
      return;
    }

    const response = await this.sendRpcCommand("AUTHENTICATE", {
      access_token: this.session.accessToken,
    });
    const rawUser =
      response.data && typeof response.data === "object"
        ? ((response.data as Record<string, unknown>).user as
            | DiscordLocalUser
            | undefined)
        : undefined;
    this.currentUser = rawUser ?? null;
    this.authenticated = true;
    await this.subscribeNotifications();
    await this.subscribeConfiguredChannels();
  }

  private async subscribeNotifications(): Promise<void> {
    if (!this.session?.scopes.includes("rpc.notifications.read")) {
      return;
    }
    await this.sendRpcCommand("SUBSCRIBE", {}, "NOTIFICATION_CREATE");
  }

  private async subscribeConfiguredChannels(): Promise<void> {
    const channelIds = this.connectorConfig?.messageChannelIds ?? [];
    for (const channelId of channelIds) {
      if (this.subscribedChannelIds.has(channelId)) {
        continue;
      }
      await this.sendRpcCommand(
        "SUBSCRIBE",
        { channel_id: channelId },
        "MESSAGE_CREATE",
      );
      this.subscribedChannelIds.add(channelId);
    }
  }

  private async exchangeAuthorizationCode(code: string): Promise<void> {
    const config = this.requireConfig();
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
    });

    const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Discord OAuth token exchange failed with ${response.status}`,
      );
    }
    const json = (await response.json()) as Record<string, unknown>;
    await this.storeTokenResponse(json);
    this.authenticated = false;
    await this.ensureAuthenticated();
  }

  private async refreshAccessToken(): Promise<void> {
    const config = this.requireConfig();
    if (!this.session?.refreshToken) {
      throw new Error("Discord local session cannot be refreshed");
    }

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.session.refreshToken,
    });

    const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Discord OAuth refresh failed with ${response.status}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    await this.storeTokenResponse(json);
    this.authenticated = false;
  }

  private async storeTokenResponse(
    json: Record<string, unknown>,
  ): Promise<void> {
    const accessToken =
      typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) {
      throw new Error("Discord OAuth token response is missing access_token");
    }

    const refreshToken =
      typeof json.refresh_token === "string" ? json.refresh_token : undefined;
    const expiresIn =
      typeof json.expires_in === "number"
        ? json.expires_in
        : typeof json.expires_in === "string"
          ? Number.parseInt(json.expires_in, 10)
          : 0;
    const scopeString =
      typeof json.scope === "string"
        ? json.scope
        : (this.connectorConfig?.scopes.join(" ") ?? "");

    this.session = {
      accessToken,
      refreshToken,
      expiresAt:
        Number.isFinite(expiresIn) && expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : undefined,
      scopes: scopeString
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
    await fsp.writeFile(
      this.sessionPath,
      JSON.stringify(this.session, null, 2),
      "utf8",
    );
  }

  private async loadSession(): Promise<DiscordLocalSession | null> {
    if (!fs.existsSync(this.sessionPath)) {
      return null;
    }
    const raw = await fsp.readFile(this.sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DiscordLocalSession>;
    if (
      typeof parsed.accessToken !== "string" ||
      parsed.accessToken.trim().length === 0
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken:
        typeof parsed.refreshToken === "string"
          ? parsed.refreshToken
          : undefined,
      expiresAt:
        typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
      scopes: Array.isArray(parsed.scopes)
        ? parsed.scopes.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [...DISCORD_LOCAL_DEFAULT_SCOPES],
    };
  }

  private async ensureRpcConnection(): Promise<void> {
    const config = this.requireConfig();
    if (this.connected && this.socket && !this.socket.destroyed) {
      return;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    const ipcPath = findDiscordIpcPath();
    if (!ipcPath) {
      throw new Error(
        "Discord IPC socket not found. Open the Discord desktop app first.",
      );
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const socket = net.createConnection(ipcPath);
    this.socket = socket;
    this.readBuffer = Buffer.alloc(0);

    socket.on("connect", () => {
      this.connectedIpcPath = ipcPath;
      this.writeFrame(IPC_OP_HANDSHAKE, {
        v: 1,
        client_id: config.clientId,
      });
    });

    socket.on("data", (chunk: Buffer) => {
      this.handleSocketData(chunk);
    });

    socket.on("close", () => {
      const error = new Error("Discord local RPC connection closed");
      this.connected = false;
      this.authenticated = false;
      this.connectedIpcPath = null;
      this.socket = null;
      this.rejectPendingRequests(error);
      this.readyReject?.(error);
      this.readyReject = null;
      this.readyResolve = null;
      this.readyPromise = null;
      if (this.session?.accessToken) {
        this.scheduleReconnect();
      }
    });

    socket.on("error", (error) => {
      this.lastError = error.message;
      this.connectedIpcPath = null;
      this.readyReject?.(error);
      this.readyReject = null;
      this.readyResolve = null;
      this.readyPromise = null;
      this.rejectPendingRequests(error);
    });

    await this.readyPromise;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureAuthenticated().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, 3_000);
  }

  private handleSocketData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    while (this.readBuffer.length >= 8) {
      const op = this.readBuffer.readInt32LE(0);
      const length = this.readBuffer.readInt32LE(4);
      if (length < 0) {
        logger.warn(
          "[discord-local] Discarding malformed IPC frame with negative payload length",
        );
        this.readBuffer = Buffer.alloc(0);
        return;
      }
      if (this.readBuffer.length < 8 + length) {
        return;
      }

      const body = this.readBuffer.subarray(8, 8 + length);
      this.readBuffer = this.readBuffer.subarray(8 + length);
      let payload: DiscordLocalRpcPayload;
      try {
        payload = JSON.parse(body.toString("utf8")) as DiscordLocalRpcPayload;
      } catch {
        logger.warn(
          "[discord-local] Discarding malformed IPC frame with invalid JSON payload",
        );
        continue;
      }
      this.handleRpcPayload(op, payload);
    }
  }

  private handleRpcPayload(op: number, payload: DiscordLocalRpcPayload): void {
    if (op === IPC_OP_PING) {
      this.writeFrame(IPC_OP_PONG, payload);
      return;
    }

    if (op === IPC_OP_CLOSE) {
      this.lastError = "Discord local RPC closed the connection";
      this.socket?.destroy();
      return;
    }

    if (payload.nonce) {
      const pending = this.pendingRequests.get(payload.nonce);
      if (pending) {
        this.pendingRequests.delete(payload.nonce);
        if (payload.evt === "ERROR") {
          pending.reject(new Error(describeRpcError(payload)));
        } else {
          pending.resolve(payload);
        }
        return;
      }
    }

    if (payload.evt === "READY") {
      this.connected = true;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      this.readyPromise = null;
      return;
    }

    if (payload.evt === "MESSAGE_CREATE") {
      const data = payload.data as Record<string, unknown> | undefined;
      const channelId =
        typeof data?.channel_id === "string" ? data.channel_id : undefined;
      const message =
        data && typeof data.message === "object"
          ? (data.message as DiscordLocalMessage)
          : (payload.data as DiscordLocalMessage | undefined);
      if (channelId && message) {
        void this.ingestMessage(channelId, message);
      }
      return;
    }

    if (payload.evt === "NOTIFICATION_CREATE") {
      const notification = payload.data as DiscordLocalNotification | undefined;
      const channelId =
        notification?.channel_id ??
        (typeof notification?.message?.channel_id === "string"
          ? notification.message.channel_id
          : undefined);
      const message = notification?.message ?? null;
      if (channelId && message) {
        void this.ingestMessage(channelId, message);
      }
    }
  }

  private writeFrame(op: number, payload: Record<string, unknown>): void {
    if (!this.socket) {
      throw new Error("Discord local RPC socket is not connected");
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  private async sendRpcCommand(
    cmd: string,
    args: Record<string, unknown> = {},
    evt?: string,
  ): Promise<DiscordLocalRpcPayload> {
    await this.ensureRpcConnection();
    const nonce = crypto.randomUUID();

    return await new Promise<DiscordLocalRpcPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingRequests.delete(nonce)) {
          return;
        }
        reject(new Error(`Discord RPC command ${cmd} timed out`));
      }, 20_000);
      this.pendingRequests.set(nonce, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.writeFrame(IPC_OP_FRAME, {
          cmd,
          args,
          ...(evt ? { evt } : {}),
          nonce,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(nonce);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private async ingestMessage(
    channelId: string,
    message: DiscordLocalMessage,
  ): Promise<void> {
    if (!message.id) {
      return;
    }
    if (message.author?.id && message.author.id === this.currentUser?.id) {
      return;
    }

    const memoryId = messageIdFor(this.runtime, channelId, message.id);
    const existing = await this.runtime.getMemoryById(memoryId);
    if (existing) {
      return;
    }

    const channel = await this.getChannel(channelId);
    const guildId = channel?.guild_id ?? message.guild_id ?? null;
    const guild = guildId ? (this.guildCache.get(guildId) ?? null) : null;
    const serverKey = guildId ?? `dm:${channelId}`;
    const worldId = worldIdFor(this.runtime, serverKey);
    const roomId = roomIdFor(this.runtime, channelId);
    const entityId = entityIdFor(message.author?.id ?? channelId);
    const roomType = roomTypeForChannel(channel?.type);
    const roomName =
      channel?.name?.trim() ||
      message.author?.global_name ||
      message.author?.username ||
      `Discord ${channelId}`;

    // `roomName` is accepted by the local `./eliza` source but not by
    // the npm beta dist-tag of `@elizaos/core`. Cast around the
    // excess-property check so the call works under both resolutions;
    // the runtime itself reads `roomName` in both versions, the type
    // just lags in the published package.
    type EnsureConnectionArg = Parameters<
      typeof this.runtime.ensureConnection
    >[0] & { roomName?: string };
    await this.runtime.ensureConnection({
      entityId,
      roomId,
      roomName,
      worldId,
      worldName: guild?.name ?? "Discord Direct Messages",
      userName: message.author?.username ?? undefined,
      userId: message.author?.id as UUID | undefined,
      name:
        message.author?.global_name ?? message.author?.username ?? undefined,
      source: DISCORD_LOCAL_SERVICE_NAME,
      type: roomType,
      channelId,
      messageServerId: stringToUuid(
        `discord-local-server:${serverKey}`,
      ) as UUID,
      metadata: {
        discordChannelId: channelId,
        ...(guildId ? { discordServerId: guildId } : {}),
      },
    } as EnsureConnectionArg);

    const attachments: Media[] = (message.attachments ?? []).flatMap(
      (attachment) => {
        const url = attachment.url?.trim();
        if (!url) {
          return [];
        }
        return [
          {
            id: attachment.id,
            url,
            title: attachment.filename,
            source: DISCORD_LOCAL_SERVICE_NAME,
            description: attachment.description ?? undefined,
            contentType: contentTypeForMime(attachment.content_type),
          },
        ];
      },
    );

    const replyReference =
      message.referenced_message?.id ??
      message.message_reference?.message_id ??
      undefined;
    const replyChannelId =
      message.referenced_message?.channel_id ??
      message.message_reference?.channel_id ??
      channelId;
    const inReplyTo =
      typeof replyReference === "string" && replyReference.length > 0
        ? messageIdFor(this.runtime, replyChannelId, replyReference)
        : undefined;

    const memory = createMessageMemory({
      id: memoryId,
      agentId: this.runtime.agentId,
      entityId,
      roomId,
      content: {
        text: message.content ?? "",
        source: DISCORD_LOCAL_SERVICE_NAME,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
      },
    }) as Memory;
    memory.createdAt = message.timestamp
      ? Date.parse(message.timestamp)
      : Date.now();
    memory.metadata = {
      ...memory.metadata,
      source: DISCORD_LOCAL_SERVICE_NAME,
      provider: "discord",
      timestamp: memory.createdAt,
      entityName:
        message.author?.global_name ?? message.author?.username ?? roomName,
      entityUserName: message.author?.username ?? undefined,
      entityAvatarUrl: buildDiscordAvatarUrl(message.author),
      fromId: message.author?.id ?? undefined,
      sourceId: entityId,
      sender: {
        id: message.author?.id ?? undefined,
        name:
          message.author?.global_name ?? message.author?.username ?? roomName,
        username: message.author?.username ?? undefined,
      },
      [DISCORD_LOCAL_SERVICE_NAME]: {
        id: message.author?.id ?? undefined,
        userId: message.author?.id ?? undefined,
        username: message.author?.username ?? undefined,
        userName: message.author?.username ?? undefined,
        name:
          message.author?.global_name ?? message.author?.username ?? roomName,
        messageId: message.id,
        channelId,
        guildId: guildId ?? undefined,
      },
      discord: {
        id: message.author?.id ?? undefined,
        userId: message.author?.id ?? undefined,
        username: message.author?.username ?? undefined,
        userName: message.author?.username ?? undefined,
        name:
          message.author?.global_name ?? message.author?.username ?? roomName,
        messageId: message.id,
        channelId,
        guildId: guildId ?? undefined,
      },
      discordChannelId: channelId,
      discordMessageId: message.id,
      ...(guildId ? { discordServerId: guildId } : {}),
    } as MemoryMetadata;

    await this.runtime.createMemory(memory, "messages");
  }

  private async sendUiMessage(
    channelId: string,
    guildId: string | null,
    text: string,
  ): Promise<void> {
    const config = this.requireConfig();
    if (process.platform !== "darwin") {
      throw new Error(
        "Discord local send automation currently supports macOS only",
      );
    }

    await openDiscordTarget(channelId, guildId);
    const script = buildDiscordSendScript(text, config.sendDelayMs / 1000);
    await execFileAsync("/usr/bin/osascript", ["-e", script]);
  }
}

function isConnectorSetupService(
  service: unknown,
): service is ConnectorSetupService {
  if (!service || typeof service !== "object") {
    return false;
  }

  const candidate = service as Record<string, unknown>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.updateConfig === "function" &&
    typeof candidate.registerEscalationChannel === "function" &&
    typeof candidate.setOwnerContact === "function"
  );
}

function getSetupService(runtime: IAgentRuntime): ConnectorSetupService | null {
  const service = runtime.getService("connector-setup");
  return isConnectorSetupService(service) ? service : null;
}

function resolveDiscordLocalService(
  runtime: IAgentRuntime,
): DiscordLocalService | null {
  const service = runtime.getService(DISCORD_LOCAL_SERVICE_NAME);
  return service instanceof DiscordLocalService ? service : null;
}

function getConnectorConfig(
  setupService: ConnectorSetupService,
): ConnectorConfig {
  const config = setupService.getConfig();
  const connectors =
    (config.connectors as Record<string, ConnectorConfig> | undefined) ??
    ((config as Record<string, unknown>).channels as
      | Record<string, ConnectorConfig>
      | undefined) ??
    {};

  const current = connectors.discordLocal;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as ConnectorConfig;
  }
  return {};
}

async function handleDiscordLocalStatus(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  res.status(200).json(
    service
      ? service.getStatus()
      : {
          available: false,
          connected: false,
          authenticated: false,
          currentUser: null,
          subscribedChannelIds: [],
          configuredChannelIds: [],
          scopes: [],
          lastError: "discord-local service not registered",
          ipcPath: null,
          reason: "discord-local service not registered",
        },
  );
}

async function handleDiscordLocalAuthorize(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  if (!service) {
    res.status(503).json({ error: "discord-local service not registered" });
    return;
  }

  try {
    res.status(200).json(await service.authorize());
  } catch (error) {
    res.status(500).json({
      error: `failed to authorize discord-local: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleDiscordLocalDisconnect(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  if (!service) {
    res.status(503).json({ error: "discord-local service not registered" });
    return;
  }

  try {
    await service.disconnectSession();
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: `failed to disconnect discord-local: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleDiscordLocalGuilds(
  _req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  if (!service) {
    res.status(503).json({ error: "discord-local service not registered" });
    return;
  }

  try {
    const guilds = await service.listGuilds();
    res.status(200).json({ guilds, count: guilds.length });
  } catch (error) {
    res.status(500).json({
      error: `failed to list discord-local guilds: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleDiscordLocalChannels(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  if (!service) {
    res.status(503).json({ error: "discord-local service not registered" });
    return;
  }

  const url = new URL(
    req.url ?? "/api/discord-local/channels",
    "http://localhost",
  );
  const guildId = url.searchParams.get("guildId")?.trim() ?? "";
  if (!guildId) {
    res.status(400).json({ error: "guildId is required" });
    return;
  }

  try {
    const channels = await service.listChannels(guildId);
    res.status(200).json({ channels, count: channels.length });
  } catch (error) {
    res.status(500).json({
      error: `failed to list discord-local channels: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleDiscordLocalSubscriptions(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): Promise<void> {
  const service = resolveDiscordLocalService(runtime);
  if (!service) {
    res.status(503).json({ error: "discord-local service not registered" });
    return;
  }

  const body = req.body;
  if (!body) {
    res.status(400).json({ error: "request body is required" });
    return;
  }

  const rawChannelIds = body.channelIds;
  const channelIds = Array.isArray(rawChannelIds)
    ? Array.from(
        new Set(
          rawChannelIds
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter((entry) => entry.length > 0),
        ),
      )
    : [];

  try {
    const subscribedChannelIds =
      await service.subscribeChannelMessages(channelIds);

    const setupService = getSetupService(runtime);
    if (setupService) {
      const connectorConfig = getConnectorConfig(setupService);
      setupService.updateConfig((config) => {
        if (!config.connectors) {
          config.connectors = {};
        }
        (config.connectors as Record<string, ConnectorConfig>).discordLocal = {
          ...connectorConfig,
          enabled: connectorConfig.enabled !== false,
          messageChannelIds: subscribedChannelIds,
        };
      });

      if (subscribedChannelIds.length > 0) {
        setupService.setOwnerContact({
          source: "discord",
          channelId: subscribedChannelIds[0],
        });
        setupService.registerEscalationChannel("discord");
      }
    }

    res.status(200).json({ subscribedChannelIds });
  } catch (error) {
    res.status(500).json({
      error: `failed to update discord-local subscriptions: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

const discordLocalSetupRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/discord-local/status",
    handler: handleDiscordLocalStatus,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/discord-local/authorize",
    handler: handleDiscordLocalAuthorize,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/discord-local/disconnect",
    handler: handleDiscordLocalDisconnect,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/discord-local/guilds",
    handler: handleDiscordLocalGuilds,
    rawPath: true,
  },
  {
    type: "GET",
    path: "/api/discord-local/channels",
    handler: handleDiscordLocalChannels,
    rawPath: true,
  },
  {
    type: "POST",
    path: "/api/discord-local/subscriptions",
    handler: handleDiscordLocalSubscriptions,
    rawPath: true,
  },
];

const discordLocalPlugin: Plugin = {
  name: DISCORD_LOCAL_PLUGIN_NAME,
  description:
    "Local Discord desktop integration for Eliza via Discord RPC and macOS UI automation",
  services: [DiscordLocalService],
  routes: discordLocalSetupRoutes,
};

export default discordLocalPlugin;
