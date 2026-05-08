/**
 * Google Chat service implementation for ElizaOS.
 */

import {
  type Content,
  type EventPayload,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorChatContext,
  type MessageConnectorTarget,
  type MessageConnectorUserContext,
  Service,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { GoogleAuth } from "google-auth-library";
import {
  DEFAULT_GOOGLE_CHAT_ACCOUNT_ID,
  normalizeGoogleChatAccountId,
  readGoogleChatAccountId,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccountSettings,
} from "./accounts.js";
import {
  GOOGLE_CHAT_SERVICE_NAME,
  GoogleChatApiError,
  GoogleChatAuthenticationError,
  GoogleChatConfigurationError,
  type GoogleChatEvent,
  GoogleChatEventTypes,
  type GoogleChatMessageSendOptions,
  type GoogleChatReaction,
  type GoogleChatSendResult,
  type GoogleChatSettings,
  type GoogleChatSpace,
  getSpaceDisplayName,
  type IGoogleChatService,
  isDirectMessage,
  normalizeSpaceTarget,
  normalizeUserTarget,
} from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

function normalizeGoogleChatQuery(query: string): string {
  return query.trim().toLowerCase();
}

function scoreGoogleChatSpace(space: GoogleChatSpace, query: string): number {
  const normalized = normalizeGoogleChatQuery(query);
  if (!normalized) {
    return 0.45;
  }
  const candidates = [space.name, space.displayName, space.spaceType, space.type]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());

  if (candidates.some((candidate) => candidate === normalized)) {
    return 1;
  }
  return candidates.some((candidate) => candidate.includes(normalized)) ? 0.8 : 0;
}

function googleChatSpaceToConnectorTarget(
  space: GoogleChatSpace,
  score = 0.55,
  accountId = DEFAULT_GOOGLE_CHAT_ACCOUNT_ID
): MessageConnectorTarget {
  return {
    target: {
      source: GOOGLE_CHAT_SERVICE_NAME,
      accountId,
      channelId: space.name,
    },
    label: getSpaceDisplayName(space),
    kind: isDirectMessage(space) ? "user" : "room",
    description: space.threaded ? "Threaded Google Chat space" : "Google Chat space",
    score,
    contexts: ["social", "connectors"],
    metadata: {
      accountId,
      spaceType: space.type,
      singleUserBotDm: space.singleUserBotDm,
      threaded: space.threaded,
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
  messageId?: string;
  id?: string;
  emoji?: string;
  text?: string;
  content?: Content;
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
  editHandler?: (runtime: IAgentRuntime, params: ConnectorMutationParams) => Promise<void>;
  deleteHandler?: (runtime: IAgentRuntime, params: ConnectorMutationParams) => Promise<void>;
};

type ExtendedMessageConnectorRegistration = Parameters<
  IAgentRuntime["registerMessageConnector"]
>[0] &
  AdditiveMessageConnectorHooks;

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

function getMutationMessageName(params: ConnectorMutationParams): string {
  const messageName = String(params.messageId ?? params.id ?? "").trim();
  if (!messageName) {
    throw new Error("Google Chat message operation requires messageId");
  }
  return messageName;
}

function googleChatOptionsFromContent(
  space: string,
  content: Content,
  target?: TargetInfo
): GoogleChatMessageSendOptions {
  const data = content.data as Record<string, unknown> | undefined;
  const googleChatData = (
    data?.googleChat && typeof data.googleChat === "object" ? data.googleChat : data
  ) as Record<string, unknown> | undefined;

  return {
    space,
    text: typeof content.text === "string" ? content.text : undefined,
    thread:
      target?.threadId ||
      (typeof googleChatData?.thread === "string" ? googleChatData.thread : undefined),
    attachments: Array.isArray(googleChatData?.attachments)
      ? (googleChatData.attachments as GoogleChatMessageSendOptions["attachments"])
      : undefined,
  };
}

export class GoogleChatService extends Service implements IGoogleChatService {
  static serviceType = GOOGLE_CHAT_SERVICE_NAME;

  capabilityDescription =
    "Google Chat service for sending and receiving messages in Google Workspace";

  private settings: GoogleChatSettings | null = null;
  private auth: GoogleAuth | null = null;
  private connected = false;
  private cachedSpaces: GoogleChatSpace[] = [];

  static async start(runtime: IAgentRuntime): Promise<GoogleChatService> {
    logger.info("Starting Google Chat service...");

    const service = new GoogleChatService(runtime);
    service.settings = service.loadSettings();
    service.validateSettings();

    await service.initializeAuth();
    await service.testConnection();

    service.connected = true;
    logger.info("Google Chat service started successfully");
    runtime.emitEvent(GoogleChatEventTypes.CONNECTION_READY, {
      runtime,
      service,
      accountId: service.getAccountId(),
    } as EventPayload);

    return service;
  }

  static registerSendHandlers(runtime: IAgentRuntime, service: GoogleChatService): void {
    const accountId = service.getAccountId(runtime);
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
        source: GOOGLE_CHAT_SERVICE_NAME,
        accountId,
        label: "Google Chat",
        capabilities: [
          "send_message",
          "send_thread_reply",
          "send_attachment",
          "send_reaction",
          "list_spaces",
          "direct_message",
        ],
        supportedTargetKinds: ["room", "channel", "thread", "user"],
        contexts: ["social", "connectors"],
        description:
          "Send Google Chat messages to spaces, threaded conversations, and direct-message spaces.",
        metadata: {
          accountId,
          service: GOOGLE_CHAT_SERVICE_NAME,
        },
        sendHandler,
        resolveTargets: async (query) => {
          const directUser = normalizeUserTarget(query);
          const directTarget = directUser
            ? [
                {
                  target: {
                    source: GOOGLE_CHAT_SERVICE_NAME,
                    accountId,
                    channelId: directUser,
                  },
                  label: directUser,
                  kind: "user",
                  score: 0.95,
                  contexts: ["social", "connectors"],
                  metadata: { accountId },
                } satisfies MessageConnectorTarget,
              ]
            : [];

          const spaces = await service.listConnectorSpaces();
          const spaceTargets = spaces
            .map((space) => ({ space, score: scoreGoogleChatSpace(space, query) }))
            .filter(({ score }) => score > 0)
            .map(({ space, score }) => googleChatSpaceToConnectorTarget(space, score, accountId));

          return [...directTarget, ...spaceTargets]
            .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
            .slice(0, 10);
        },
        listRecentTargets: async () =>
          (await service.listConnectorSpaces())
            .slice(0, 10)
            .map((space) => googleChatSpaceToConnectorTarget(space, 0.55, accountId)),
        listRooms: async () =>
          (await service.listConnectorSpaces()).map((space) =>
            googleChatSpaceToConnectorTarget(space, 0.55, accountId)
          ),
        fetchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          if (target?.roomId) {
            return readStoredMessageMemories(context.runtime, target.roomId, limit);
          }
          const targets = (await service.listConnectorSpaces())
            .slice(0, 10)
            .map((space) => googleChatSpaceToConnectorTarget(space, 0.55, accountId));
          return readStoredMessagesForTargets(context.runtime, targets, limit);
        },
        searchMessages: async (context, params) => {
          const limit = normalizeConnectorLimit(params?.limit);
          const target = params?.target ?? context.target;
          const messages = target?.roomId
            ? await readStoredMessageMemories(context.runtime, target.roomId, Math.max(limit, 100))
            : await readStoredMessagesForTargets(
                context.runtime,
                (await service.listConnectorSpaces())
                  .slice(0, 10)
                  .map((space) => googleChatSpaceToConnectorTarget(space, 0.55, accountId)),
                Math.max(limit, 100)
              );
          return filterMemoriesByQuery(messages, params.query, limit);
        },
        reactHandler: async (_handlerRuntime, params) => {
          const messageName = getMutationMessageName(params);
          const emoji = String(params.emoji ?? "").trim();
          if (!emoji) {
            throw new Error("Google Chat reactHandler requires emoji");
          }
          const result = await service.sendReaction(messageName, emoji);
          if (!result.success) {
            throw new Error(result.error || "Google Chat reaction failed");
          }
        },
        editHandler: async (_handlerRuntime, params) => {
          const messageName = getMutationMessageName(params);
          const mutationParams = params as ConnectorMutationParams;
          const text = String(mutationParams.text ?? params.content?.text ?? "").trim();
          if (!text) {
            throw new Error("Google Chat editHandler requires text content");
          }
          const result = await service.updateMessage(messageName, text);
          if (!result.success) {
            throw new Error(result.error || "Google Chat message edit failed");
          }
        },
        deleteHandler: async (_handlerRuntime, params) => {
          const messageName = getMutationMessageName(params);
          const result = await service.deleteMessage(messageName);
          if (!result.success) {
            throw new Error(result.error || "Google Chat message delete failed");
          }
        },
        getChatContext: async (target, context) => {
          const room = target.roomId ? await context.runtime.getRoom(target.roomId) : null;
          const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
          const spaceName = normalizeSpaceTarget(channelId);
          if (!spaceName) {
            return null;
          }
          const space = (await service.listConnectorSpaces()).find(
            (candidate) => candidate.name === spaceName
          );
          if (!space) {
            return null;
          }
          return {
            target: {
              source: GOOGLE_CHAT_SERVICE_NAME,
              accountId,
              roomId: target.roomId,
              channelId: space.name,
              threadId: target.threadId,
            },
            label: getSpaceDisplayName(space),
            summary: isDirectMessage(space) ? "Google Chat direct message" : "Google Chat space",
            metadata: {
              accountId,
              spaceType: space.type,
              threaded: space.threaded,
              singleUserBotDm: space.singleUserBotDm,
            },
          } satisfies MessageConnectorChatContext;
        },
        getUserContext: async (entityId, context) => {
          const entity =
            typeof context.runtime.getEntityById === "function"
              ? await context.runtime.getEntityById(String(entityId) as UUID)
              : null;
          if (!entity) {
            return null;
          }
          return {
            entityId,
            label: entity.names?.[0],
            aliases: entity.names,
            handles: {},
            metadata: entity.metadata,
          } satisfies MessageConnectorUserContext;
        },
      } as ExtendedMessageConnectorRegistration;
      runtime.registerMessageConnector(registration);
      return;
    }

    runtime.registerSendHandler(GOOGLE_CHAT_SERVICE_NAME, sendHandler);
  }

  async stop(): Promise<void> {
    logger.info("Stopping Google Chat service...");
    this.connected = false;
    this.auth = null;
    logger.info("Google Chat service stopped");
  }

  private loadSettings(): GoogleChatSettings {
    const runtime = this.runtime;
    if (!runtime) {
      throw new GoogleChatConfigurationError("Runtime not initialized");
    }

    return resolveGoogleChatAccountSettings(runtime);
  }

  private validateSettings(): void {
    const settings = this.settings;
    if (!settings) {
      throw new GoogleChatConfigurationError("Settings not loaded");
    }

    if (!settings.serviceAccount && !settings.serviceAccountFile) {
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new GoogleChatConfigurationError(
          "Google Chat requires service account credentials. Set GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE, or GOOGLE_APPLICATION_CREDENTIALS.",
          "GOOGLE_CHAT_SERVICE_ACCOUNT"
        );
      }
    }

    if (!settings.audience) {
      throw new GoogleChatConfigurationError(
        "GOOGLE_CHAT_AUDIENCE is required for webhook verification",
        "GOOGLE_CHAT_AUDIENCE"
      );
    }

    if (!["app-url", "project-number"].includes(settings.audienceType)) {
      throw new GoogleChatConfigurationError(
        "GOOGLE_CHAT_AUDIENCE_TYPE must be 'app-url' or 'project-number'",
        "GOOGLE_CHAT_AUDIENCE_TYPE"
      );
    }
  }

  private async initializeAuth(): Promise<void> {
    const settings = this.settings;
    if (!settings) {
      throw new GoogleChatConfigurationError("Settings not loaded");
    }

    if (settings.serviceAccountFile) {
      this.auth = new GoogleAuth({
        keyFile: settings.serviceAccountFile,
        scopes: [CHAT_SCOPE],
      });
    } else if (settings.serviceAccount) {
      const credentials = JSON.parse(settings.serviceAccount) as Record<string, unknown>;
      this.auth = new GoogleAuth({
        credentials,
        scopes: [CHAT_SCOPE],
      });
    } else {
      this.auth = new GoogleAuth({
        scopes: [CHAT_SCOPE],
      });
    }

    logger.info("Google Auth initialized");
  }

  private async testConnection(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new GoogleChatAuthenticationError("Failed to obtain access token");
    }

    const url = `${CHAT_API_BASE}/spaces?pageSize=1`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GoogleChatApiError(
        `Failed to connect to Google Chat API: ${text || response.statusText}`,
        response.status
      );
    }

    logger.info("Google Chat API connection verified");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAccountId(runtime?: IAgentRuntime): string {
    return normalizeGoogleChatAccountId(
      this.settings?.accountId ?? (runtime ? resolveDefaultGoogleChatAccountId(runtime) : undefined)
    );
  }

  getBotUser(): string | undefined {
    return this.settings?.botUser;
  }

  async getAccessToken(): Promise<string> {
    if (!this.auth) {
      throw new GoogleChatAuthenticationError("Auth not initialized");
    }

    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;

    if (!token) {
      throw new GoogleChatAuthenticationError("Failed to obtain access token");
    }

    return token;
  }

  private async fetchApi<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GoogleChatApiError(
        `Google Chat API error: ${text || response.statusText}`,
        response.status
      );
    }

    return (await response.json()) as T;
  }

  async getSpaces(): Promise<GoogleChatSpace[]> {
    const url = `${CHAT_API_BASE}/spaces`;
    const response = await this.fetchApi<{ spaces?: GoogleChatSpace[] }>(url);
    this.cachedSpaces = response.spaces || [];
    return this.cachedSpaces;
  }

  async sendMessage(options: GoogleChatMessageSendOptions): Promise<GoogleChatSendResult> {
    if (!options.space) {
      return {
        success: false,
        error: "Space is required",
      };
    }

    const body: Record<string, unknown> = {};

    if (options.text) {
      body.text = options.text;
    }

    if (options.thread) {
      body.thread = { name: options.thread };
    }

    if (options.attachments && options.attachments.length > 0) {
      body.attachment = options.attachments.map((att) => ({
        attachmentDataRef: { attachmentUploadToken: att.attachmentUploadToken },
        ...(att.contentName ? { contentName: att.contentName } : {}),
      }));
    }

    const url = `${CHAT_API_BASE}/${options.space}/messages`;

    const result = await this.fetchApi<{ name?: string }>(url, {
      method: "POST",
      body: JSON.stringify(body),
    });

    logger.debug(`Message sent to ${options.space}: ${result.name}`);

    if (this.runtime) {
      this.runtime.emitEvent(GoogleChatEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        messageName: result.name,
        space: options.space,
      } as EventPayload);
    }

    return {
      success: true,
      messageName: result.name,
      space: options.space,
    };
  }

  async updateMessage(
    messageName: string,
    text: string
  ): Promise<{ success: boolean; messageName?: string; error?: string }> {
    const url = `${CHAT_API_BASE}/${messageName}?updateMask=text`;

    const result = await this.fetchApi<{ name?: string }>(url, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    });

    return {
      success: true,
      messageName: result.name,
    };
  }

  async deleteMessage(messageName: string): Promise<{ success: boolean; error?: string }> {
    const url = `${CHAT_API_BASE}/${messageName}`;
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: `Failed to delete message: ${text || response.statusText}`,
      };
    }

    return { success: true };
  }

  async sendReaction(
    messageName: string,
    emoji: string
  ): Promise<{ success: boolean; name?: string; error?: string }> {
    const url = `${CHAT_API_BASE}/${messageName}/reactions`;

    const result = await this.fetchApi<GoogleChatReaction>(url, {
      method: "POST",
      body: JSON.stringify({ emoji: { unicode: emoji } }),
    });

    if (this.runtime) {
      this.runtime.emitEvent(GoogleChatEventTypes.REACTION_SENT, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        messageName,
        emoji,
        reactionName: result.name,
      } as EventPayload);
    }

    return {
      success: true,
      name: result.name,
    };
  }

  async deleteReaction(reactionName: string): Promise<{ success: boolean; error?: string }> {
    const url = `${CHAT_API_BASE}/${reactionName}`;
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        success: false,
        error: `Failed to delete reaction: ${text || response.statusText}`,
      };
    }

    return { success: true };
  }

  async listReactions(messageName: string, limit?: number): Promise<GoogleChatReaction[]> {
    const url = new URL(`${CHAT_API_BASE}/${messageName}/reactions`);
    if (limit && limit > 0) {
      url.searchParams.set("pageSize", String(limit));
    }

    const result = await this.fetchApi<{ reactions?: GoogleChatReaction[] }>(url.toString());

    return result.reactions || [];
  }

  async findDirectMessage(userName: string): Promise<GoogleChatSpace | null> {
    const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
    url.searchParams.set("name", userName);

    const result = await this.fetchApi<GoogleChatSpace | null>(url.toString());
    return result;
  }

  async uploadAttachment(
    space: string,
    filename: string,
    buffer: Buffer,
    contentType?: string
  ): Promise<{ attachmentUploadToken?: string }> {
    const boundary = `elizaos-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ filename });
    const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
    const mediaHeader = `--${boundary}\r\nContent-Type: ${contentType || "application/octet-stream"}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(header, "utf8"),
      Buffer.from(mediaHeader, "utf8"),
      buffer,
      Buffer.from(footer, "utf8"),
    ]);

    const token = await this.getAccessToken();
    const url = `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GoogleChatApiError(
        `Failed to upload attachment: ${text || response.statusText}`,
        response.status
      );
    }

    const payload = (await response.json()) as {
      attachmentDataRef?: { attachmentUploadToken?: string };
    };

    return {
      attachmentUploadToken: payload.attachmentDataRef?.attachmentUploadToken,
    };
  }

  async downloadMedia(
    resourceName: string,
    maxBytes?: number
  ): Promise<{ buffer: Buffer; contentType?: string }> {
    const url = `${CHAT_API_BASE}/media/${resourceName}?alt=media`;
    const token = await this.getAccessToken();

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new GoogleChatApiError(
        `Failed to download media: ${text || response.statusText}`,
        response.status
      );
    }

    const contentLength = response.headers.get("content-length");
    if (maxBytes && contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new GoogleChatApiError(`Media exceeds max bytes (${maxBytes})`, 413);
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || undefined;

    return { buffer, contentType };
  }

  getSettings(): GoogleChatSettings | null {
    return this.settings;
  }

  async sendDirectMessage(target: string, content: Content): Promise<void> {
    const userName = normalizeUserTarget(target);
    if (!userName) {
      throw new Error(`Invalid Google Chat user target: ${target}`);
    }
    const space = await this.findDirectMessage(userName);
    if (!space?.name) {
      throw new Error(`Could not resolve Google Chat direct message for ${target}`);
    }
    await this.sendConnectorContent(space.name, content);
  }

  async sendRoomMessage(target: string, content: Content): Promise<void> {
    const spaceName = normalizeSpaceTarget(target);
    if (!spaceName) {
      throw new Error(`Invalid Google Chat space target: ${target}`);
    }
    await this.sendConnectorContent(spaceName, content);
  }

  private async handleSendMessage(
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content
  ): Promise<void> {
    const requestedAccountId = normalizeGoogleChatAccountId(
      target.accountId ?? readGoogleChatAccountId(content, target) ?? this.getAccountId()
    );
    if (requestedAccountId !== this.getAccountId()) {
      throw new Error(
        `Google Chat account '${requestedAccountId}' is not available in this service instance`
      );
    }

    const room = target.roomId ? await runtime.getRoom(target.roomId) : null;
    const channelId = String(target.channelId ?? room?.channelId ?? "").trim();
    if (!channelId) {
      throw new Error("Google Chat target is missing a space or user resource name");
    }

    const userName = normalizeUserTarget(channelId);
    if (userName && !channelId.startsWith("spaces/")) {
      await this.sendDirectMessage(userName, content);
      return;
    }

    const spaceName = normalizeSpaceTarget(channelId);
    if (!spaceName) {
      throw new Error(`Invalid Google Chat target: ${channelId}`);
    }
    await this.sendConnectorContent(spaceName, content, target);
  }

  private async sendConnectorContent(
    space: string,
    content: Content,
    target?: TargetInfo
  ): Promise<void> {
    const text = typeof content.text === "string" ? content.text.trim() : "";
    const options = googleChatOptionsFromContent(space, { ...content, text }, target);
    if (!options.text && (!options.attachments || options.attachments.length === 0)) {
      return;
    }
    const result = await this.sendMessage(options);
    if (!result.success) {
      throw new Error(result.error || "Google Chat message send failed");
    }
  }

  private async listConnectorSpaces(): Promise<GoogleChatSpace[]> {
    try {
      return await this.getSpaces();
    } catch {
      return [...this.cachedSpaces];
    }
  }

  async processWebhookEvent(event: GoogleChatEvent): Promise<void> {
    const eventType = event.type;

    if (!this.runtime) return;

    if (eventType === "MESSAGE") {
      this.runtime.emitEvent(GoogleChatEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        event,
        message: event.message,
        space: event.space,
        user: event.user,
      } as EventPayload);
    } else if (eventType === "ADDED_TO_SPACE") {
      this.runtime.emitEvent(GoogleChatEventTypes.SPACE_JOINED, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        space: event.space,
        user: event.user,
      } as EventPayload);
    } else if (eventType === "REMOVED_FROM_SPACE") {
      this.runtime.emitEvent(GoogleChatEventTypes.SPACE_LEFT, {
        runtime: this.runtime,
        accountId: this.getAccountId(),
        space: event.space,
        user: event.user,
      } as EventPayload);
    }
  }
}
