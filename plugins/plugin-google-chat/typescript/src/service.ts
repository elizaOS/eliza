/**
 * Google Chat service implementation for elizaOS.
 */

import {
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import { GoogleAuth } from "google-auth-library";
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
  type IGoogleChatService,
} from "./types.js";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

export class GoogleChatService extends Service implements IGoogleChatService {
  static serviceType = GOOGLE_CHAT_SERVICE_NAME;

  capabilityDescription =
    "Google Chat service for sending and receiving messages in Google Workspace";

  private settings: GoogleChatSettings | null = null;
  private auth: GoogleAuth | null = null;
  private connected = false;
  private cachedSpaces: GoogleChatSpace[] = [];

  /**
   * Start the Google Chat service.
   */
  static async start(runtime: IAgentRuntime): Promise<GoogleChatService> {
    logger.info("Starting Google Chat service...");

    const service = new GoogleChatService(runtime);
    service.settings = service.loadSettings();
    service.validateSettings();

    // Initialize Google Auth
    await service.initializeAuth();

    // Test authentication
    await service.testConnection();

    service.connected = true;
    logger.info("Google Chat service started successfully");
    runtime.emitEvent(GoogleChatEventTypes.CONNECTION_READY, {
      runtime,
      service,
    } as EventPayload);

    return service;
  }

  /**
   * Stop the Google Chat service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping Google Chat service...");
    this.connected = false;
    this.auth = null;
    logger.info("Google Chat service stopped");
  }

  /**
   * Load settings from runtime configuration.
   */
  private loadSettings(): GoogleChatSettings {
    const runtime = this.runtime;
    if (!runtime) {
      throw new GoogleChatConfigurationError("Runtime not initialized");
    }

    const getStringSetting = (
      key: string,
      envKey: string,
      defaultValue = "",
    ): string => {
      const value = runtime.getSetting(key);
      if (typeof value === "string") return value;
      return process.env[envKey] || defaultValue;
    };

    const serviceAccount = getStringSetting(
      "GOOGLE_CHAT_SERVICE_ACCOUNT",
      "GOOGLE_CHAT_SERVICE_ACCOUNT",
    );
    const serviceAccountFile = getStringSetting(
      "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE",
      "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE",
    );
    const audienceType = getStringSetting(
      "GOOGLE_CHAT_AUDIENCE_TYPE",
      "GOOGLE_CHAT_AUDIENCE_TYPE",
      "app-url",
    );
    const audience = getStringSetting(
      "GOOGLE_CHAT_AUDIENCE",
      "GOOGLE_CHAT_AUDIENCE",
    );
    const webhookPath = getStringSetting(
      "GOOGLE_CHAT_WEBHOOK_PATH",
      "GOOGLE_CHAT_WEBHOOK_PATH",
      "/googlechat",
    );
    const spacesRaw = getStringSetting(
      "GOOGLE_CHAT_SPACES",
      "GOOGLE_CHAT_SPACES",
    );
    const requireMention = getStringSetting(
      "GOOGLE_CHAT_REQUIRE_MENTION",
      "GOOGLE_CHAT_REQUIRE_MENTION",
      "true",
    );
    const enabled = getStringSetting(
      "GOOGLE_CHAT_ENABLED",
      "GOOGLE_CHAT_ENABLED",
      "true",
    );
    const botUser =
      getStringSetting("GOOGLE_CHAT_BOT_USER", "GOOGLE_CHAT_BOT_USER") ||
      undefined;

    return {
      serviceAccount: serviceAccount || undefined,
      serviceAccountFile: serviceAccountFile || undefined,
      audienceType: audienceType as "app-url" | "project-number",
      audience,
      webhookPath: webhookPath.startsWith("/")
        ? webhookPath
        : `/${webhookPath}`,
      spaces: spacesRaw
        ? spacesRaw
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : [],
      requireMention: requireMention.toLowerCase() !== "false",
      enabled: enabled.toLowerCase() !== "false",
      botUser: botUser || undefined,
    };
  }

  /**
   * Validate the settings.
   */
  private validateSettings(): void {
    const settings = this.settings;
    if (!settings) {
      throw new GoogleChatConfigurationError("Settings not loaded");
    }

    if (!settings.serviceAccount && !settings.serviceAccountFile) {
      // Check for Application Default Credentials
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        throw new GoogleChatConfigurationError(
          "Google Chat requires service account credentials. Set GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE, or GOOGLE_APPLICATION_CREDENTIALS.",
          "GOOGLE_CHAT_SERVICE_ACCOUNT",
        );
      }
    }

    if (!settings.audience) {
      throw new GoogleChatConfigurationError(
        "GOOGLE_CHAT_AUDIENCE is required for webhook verification",
        "GOOGLE_CHAT_AUDIENCE",
      );
    }

    if (!["app-url", "project-number"].includes(settings.audienceType)) {
      throw new GoogleChatConfigurationError(
        "GOOGLE_CHAT_AUDIENCE_TYPE must be 'app-url' or 'project-number'",
        "GOOGLE_CHAT_AUDIENCE_TYPE",
      );
    }
  }

  /**
   * Initialize Google Auth client.
   */
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
      const credentials = JSON.parse(settings.serviceAccount) as Record<
        string,
        unknown
      >;
      this.auth = new GoogleAuth({
        credentials,
        scopes: [CHAT_SCOPE],
      });
    } else {
      // Use Application Default Credentials
      this.auth = new GoogleAuth({
        scopes: [CHAT_SCOPE],
      });
    }

    logger.info("Google Auth initialized");
  }

  /**
   * Test the connection to Google Chat API.
   */
  private async testConnection(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new GoogleChatAuthenticationError("Failed to obtain access token");
    }

    // Test by listing spaces (limit 1)
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
        response.status,
      );
    }

    logger.info("Google Chat API connection verified");
  }

  /**
   * Check if the service is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the bot user name.
   */
  getBotUser(): string | undefined {
    return this.settings?.botUser;
  }

  /**
   * Get an access token for API calls.
   */
  async getAccessToken(): Promise<string> {
    if (!this.auth) {
      throw new GoogleChatAuthenticationError("Auth not initialized");
    }

    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token =
      typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;

    if (!token) {
      throw new GoogleChatAuthenticationError("Failed to obtain access token");
    }

    return token;
  }

  /**
   * Make an authenticated API request.
   */
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
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Get spaces the bot is in.
   */
  async getSpaces(): Promise<GoogleChatSpace[]> {
    const url = `${CHAT_API_BASE}/spaces`;
    const response = await this.fetchApi<{ spaces?: GoogleChatSpace[] }>(url);
    this.cachedSpaces = response.spaces || [];
    return this.cachedSpaces;
  }

  /**
   * Send a message to a space.
   */
  async sendMessage(
    options: GoogleChatMessageSendOptions,
  ): Promise<GoogleChatSendResult> {
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

  /**
   * Update a message.
   */
  async updateMessage(
    messageName: string,
    text: string,
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

  /**
   * Delete a message.
   */
  async deleteMessage(
    messageName: string,
  ): Promise<{ success: boolean; error?: string }> {
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

  /**
   * Send a reaction to a message.
   */
  async sendReaction(
    messageName: string,
    emoji: string,
  ): Promise<{ success: boolean; name?: string; error?: string }> {
    const url = `${CHAT_API_BASE}/${messageName}/reactions`;

    const result = await this.fetchApi<GoogleChatReaction>(url, {
      method: "POST",
      body: JSON.stringify({ emoji: { unicode: emoji } }),
    });

    if (this.runtime) {
      this.runtime.emitEvent(GoogleChatEventTypes.REACTION_SENT, {
        runtime: this.runtime,
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

  /**
   * Delete a reaction.
   */
  async deleteReaction(
    reactionName: string,
  ): Promise<{ success: boolean; error?: string }> {
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

  /**
   * List reactions on a message.
   */
  async listReactions(
    messageName: string,
    limit?: number,
  ): Promise<GoogleChatReaction[]> {
    const url = new URL(`${CHAT_API_BASE}/${messageName}/reactions`);
    if (limit && limit > 0) {
      url.searchParams.set("pageSize", String(limit));
    }

    const result = await this.fetchApi<{ reactions?: GoogleChatReaction[] }>(
      url.toString(),
    );

    return result.reactions || [];
  }

  /**
   * Find or create a DM space with a user.
   */
  async findDirectMessage(userName: string): Promise<GoogleChatSpace | null> {
    const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
    url.searchParams.set("name", userName);

    const result = await this.fetchApi<GoogleChatSpace | null>(url.toString());
    return result;
  }

  /**
   * Upload an attachment to a space.
   */
  async uploadAttachment(
    space: string,
    filename: string,
    buffer: Buffer,
    contentType?: string,
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
        response.status,
      );
    }

    const payload = (await response.json()) as {
      attachmentDataRef?: { attachmentUploadToken?: string };
    };

    return {
      attachmentUploadToken: payload.attachmentDataRef?.attachmentUploadToken,
    };
  }

  /**
   * Download media from a resource name.
   */
  async downloadMedia(
    resourceName: string,
    maxBytes?: number,
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
        response.status,
      );
    }

    const contentLength = response.headers.get("content-length");
    if (maxBytes && contentLength) {
      const length = Number(contentLength);
      if (Number.isFinite(length) && length > maxBytes) {
        throw new GoogleChatApiError(
          `Media exceeds max bytes (${maxBytes})`,
          413,
        );
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get("content-type") || undefined;

    return { buffer, contentType };
  }

  /**
   * Get the settings.
   */
  getSettings(): GoogleChatSettings | null {
    return this.settings;
  }

  /**
   * Process a webhook event.
   */
  async processWebhookEvent(event: GoogleChatEvent): Promise<void> {
    const eventType = event.type;

    if (!this.runtime) return;

    if (eventType === "MESSAGE") {
      this.runtime.emitEvent(GoogleChatEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        event,
        message: event.message,
        space: event.space,
        user: event.user,
      } as EventPayload);
    } else if (eventType === "ADDED_TO_SPACE") {
      this.runtime.emitEvent(GoogleChatEventTypes.SPACE_JOINED, {
        runtime: this.runtime,
        space: event.space,
        user: event.user,
      } as EventPayload);
    } else if (eventType === "REMOVED_FROM_SPACE") {
      this.runtime.emitEvent(GoogleChatEventTypes.SPACE_LEFT, {
        runtime: this.runtime,
        space: event.space,
        user: event.user,
      } as EventPayload);
    }
  }
}
