/**
 * iMessage service implementation for elizaOS.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { promisify } from "node:util";
import {
  type EventPayload,
  type IAgentRuntime,
  logger,
  Service,
} from "@elizaos/core";
import {
  DEFAULT_POLL_INTERVAL_MS,
  formatPhoneNumber,
  type IIMessageService,
  IMESSAGE_SERVICE_NAME,
  type IMessageChat,
  type IMessageChatType,
  IMessageCliError,
  IMessageConfigurationError,
  IMessageEventTypes,
  type IMessageMessage,
  IMessageNotSupportedError,
  type IMessageSendOptions,
  type IMessageSendResult,
  type IMessageSettings,
  isPhoneNumber,
  splitMessageForIMessage,
} from "./types.js";

const execAsync = promisify(exec);

/**
 * iMessage service for elizaOS agents.
 * Note: This only works on macOS.
 */
export class IMessageService extends Service implements IIMessageService {
  static serviceType: string = IMESSAGE_SERVICE_NAME;

  capabilityDescription =
    "iMessage service for sending and receiving messages on macOS";

  private settings: IMessageSettings | null = null;
  private connected: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastMessageId: string | null = null;

  /**
   * Start the iMessage service.
   */
  static async start(runtime: IAgentRuntime): Promise<IMessageService> {
    logger.info("Starting iMessage service...");

    const service = new IMessageService(runtime);

    // Check if running on macOS
    if (!service.isMacOS()) {
      throw new IMessageNotSupportedError();
    }

    // Load settings
    service.settings = service.loadSettings();
    await service.validateSettings();

    // Start polling for new messages
    if (service.settings.pollIntervalMs > 0) {
      service.startPolling();
    }

    service.connected = true;
    logger.info("iMessage service started");

    // Emit connection ready event
    runtime.emitEvent(IMessageEventTypes.CONNECTION_READY, {
      runtime,
      service,
    } as EventPayload);

    return service;
  }

  /**
   * Stop the iMessage service.
   */
  async stop(): Promise<void> {
    logger.info("Stopping iMessage service...");
    this.connected = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.settings = null;
    this.lastMessageId = null;
    logger.info("iMessage service stopped");
  }

  /**
   * Check if the service is connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Check if running on macOS.
   */
  isMacOS(): boolean {
    return platform() === "darwin";
  }

  /**
   * Send a message via iMessage.
   */
  async sendMessage(
    to: string,
    text: string,
    options?: IMessageSendOptions,
  ): Promise<IMessageSendResult> {
    if (!this.settings) {
      return { success: false, error: "Service not initialized" };
    }

    // Format phone number if needed
    const target = isPhoneNumber(to) ? formatPhoneNumber(to) : to;

    // Split message if too long
    const chunks = splitMessageForIMessage(text);

    for (const chunk of chunks) {
      const result = await this.sendSingleMessage(target, chunk, options);
      if (!result.success) {
        return result;
      }
    }

    // Emit sent event
    if (this.runtime) {
      this.runtime.emitEvent(IMessageEventTypes.MESSAGE_SENT, {
        runtime: this.runtime,
        to: target,
        text,
        hasMedia: Boolean(options?.mediaUrl),
      } as EventPayload);
    }

    return {
      success: true,
      messageId: Date.now().toString(),
      chatId: target,
    };
  }

  /**
   * Get recent messages.
   */
  async getRecentMessages(limit: number = 50): Promise<IMessageMessage[]> {
    if (!this.settings) {
      return [];
    }

    // Use CLI or AppleScript to get recent messages
    const script = `
      tell application "Messages"
        set recentMessages to {}
        repeat with i from 1 to ${limit}
          try
            set msg to item i of (get messages)
            set msgText to text of msg
            set msgSender to handle of sender of msg
            set msgDate to date of msg
            set end of recentMessages to {msgText, msgSender, msgDate}
          end try
        end repeat
        return recentMessages
      end tell
    `;

    try {
      const result = await this.runAppleScript(script);
      // Parse result and return messages
      return this.parseMessagesResult(result);
    } catch (error) {
      logger.warn(`Failed to get recent messages: ${error}`);
      return [];
    }
  }

  /**
   * Get chats.
   */
  async getChats(): Promise<IMessageChat[]> {
    if (!this.settings) {
      return [];
    }

    const script = `
      tell application "Messages"
        set chatList to {}
        repeat with c in chats
          set chatId to id of c
          set chatName to name of c
          set end of chatList to {chatId, chatName}
        end repeat
        return chatList
      end tell
    `;

    try {
      const result = await this.runAppleScript(script);
      return this.parseChatsResult(result);
    } catch (error) {
      logger.warn(`Failed to get chats: ${error}`);
      return [];
    }
  }

  /**
   * Get current settings.
   */
  getSettings(): IMessageSettings | null {
    return this.settings;
  }

  // Private methods

  private loadSettings(): IMessageSettings {
    if (!this.runtime) {
      throw new IMessageConfigurationError("Runtime not initialized");
    }

    const getStringSetting = (
      key: string,
      envKey: string,
      defaultValue = "",
    ): string => {
      const value = this.runtime?.getSetting(key);
      if (typeof value === "string") return value;
      return process.env[envKey] || defaultValue;
    };

    const cliPath = getStringSetting(
      "IMESSAGE_CLI_PATH",
      "IMESSAGE_CLI_PATH",
      "imsg",
    );
    const dbPath =
      getStringSetting("IMESSAGE_DB_PATH", "IMESSAGE_DB_PATH") || undefined;

    const pollIntervalMs =
      Number(
        getStringSetting(
          "IMESSAGE_POLL_INTERVAL_MS",
          "IMESSAGE_POLL_INTERVAL_MS",
        ),
      ) || DEFAULT_POLL_INTERVAL_MS;

    const dmPolicy = getStringSetting(
      "IMESSAGE_DM_POLICY",
      "IMESSAGE_DM_POLICY",
      "pairing",
    ) as IMessageSettings["dmPolicy"];

    const groupPolicy = getStringSetting(
      "IMESSAGE_GROUP_POLICY",
      "IMESSAGE_GROUP_POLICY",
      "allowlist",
    ) as IMessageSettings["groupPolicy"];

    const allowFromRaw = getStringSetting(
      "IMESSAGE_ALLOW_FROM",
      "IMESSAGE_ALLOW_FROM",
    );
    const allowFrom = allowFromRaw
      ? allowFromRaw
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : [];

    const enabledRaw = getStringSetting(
      "IMESSAGE_ENABLED",
      "IMESSAGE_ENABLED",
      "true",
    );
    const enabled = enabledRaw !== "false";

    return {
      cliPath,
      dbPath,
      pollIntervalMs,
      dmPolicy,
      groupPolicy,
      allowFrom,
      enabled,
    };
  }

  private async validateSettings(): Promise<void> {
    if (!this.settings) {
      throw new IMessageConfigurationError("Settings not loaded");
    }

    // Check if CLI tool exists (if specified and not default)
    if (this.settings.cliPath !== "imsg") {
      if (!existsSync(this.settings.cliPath)) {
        logger.warn(
          `iMessage CLI not found at ${this.settings.cliPath}, will use AppleScript`,
        );
      }
    }

    // Check if Messages app is accessible
    try {
      await this.runAppleScript('tell application "Messages" to return 1');
    } catch (_error) {
      throw new IMessageConfigurationError(
        "Cannot access Messages app. Ensure Full Disk Access is granted.",
      );
    }
  }

  private async sendSingleMessage(
    to: string,
    text: string,
    options?: IMessageSendOptions,
  ): Promise<IMessageSendResult> {
    // Try CLI first if available
    if (this.settings?.cliPath && this.settings.cliPath !== "imsg") {
      try {
        return await this.sendViaCli(to, text, options);
      } catch (error) {
        logger.debug(`CLI send failed, falling back to AppleScript: ${error}`);
      }
    }

    // Fall back to AppleScript
    return await this.sendViaAppleScript(to, text, options);
  }

  private async sendViaCli(
    to: string,
    text: string,
    options?: IMessageSendOptions,
  ): Promise<IMessageSendResult> {
    if (!this.settings) {
      return { success: false, error: "Service not initialized" };
    }

    const args = [to, text];
    if (options?.mediaUrl) {
      args.push("--attachment", options.mediaUrl);
    }

    try {
      await execAsync(
        `"${this.settings.cliPath}" ${args.map((a) => `"${a}"`).join(" ")}`,
      );
      return { success: true, messageId: Date.now().toString(), chatId: to };
    } catch (error) {
      const err = error as { code?: number; message?: string };
      throw new IMessageCliError(err.message || "CLI command failed", err.code);
    }
  }

  private async sendViaAppleScript(
    to: string,
    text: string,
    _options?: IMessageSendOptions,
  ): Promise<IMessageSendResult> {
    // Escape text for AppleScript
    const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    let script: string;

    if (to.startsWith("chat_id:")) {
      // Send to existing chat
      const chatId = to.slice(8);
      script = `
        tell application "Messages"
          set targetChat to chat id "${chatId}"
          send "${escapedText}" to targetChat
        end tell
      `;
    } else {
      // Send to buddy (phone/email)
      script = `
        tell application "Messages"
          set targetService to 1st account whose service type = iMessage
          set targetBuddy to participant "${to}" of targetService
          send "${escapedText}" to targetBuddy
        end tell
      `;
    }

    try {
      await this.runAppleScript(script);
      return { success: true, messageId: Date.now().toString(), chatId: to };
    } catch (error) {
      return { success: false, error: `AppleScript error: ${error}` };
    }
  }

  private async runAppleScript(script: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `osascript -e '${script.replace(/'/g, "'\"'\"'")}'`,
      );
      return stdout.trim();
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(
        err.stderr || err.message || "AppleScript execution failed",
      );
    }
  }

  private startPolling(): void {
    if (!this.settings) {
      return;
    }

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollForNewMessages();
      } catch (error) {
        logger.debug(`Polling error: ${error}`);
      }
    }, this.settings.pollIntervalMs);
  }

  private async pollForNewMessages(): Promise<void> {
    if (!this.runtime) {
      return;
    }

    const messages = await this.getRecentMessages(10);

    for (const msg of messages) {
      // Skip if we've already seen this message
      if (this.lastMessageId && msg.id <= this.lastMessageId) {
        continue;
      }

      // Skip messages from self
      if (msg.isFromMe) {
        continue;
      }

      // Check DM policy
      if (!this.isAllowed(msg.handle)) {
        continue;
      }

      // Emit message received event
      this.runtime.emitEvent(IMessageEventTypes.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: msg,
      } as EventPayload);

      this.lastMessageId = msg.id;
    }
  }

  private isAllowed(handle: string): boolean {
    if (!this.settings) {
      return false;
    }

    if (this.settings.dmPolicy === "open") {
      return true;
    }

    if (this.settings.dmPolicy === "disabled") {
      return false;
    }

    if (this.settings.dmPolicy === "allowlist") {
      return this.settings.allowFrom.some(
        (allowed) => allowed.toLowerCase() === handle.toLowerCase(),
      );
    }

    // pairing - allow and track
    return true;
  }

  private parseMessagesResult(result: string): IMessageMessage[] {
    return parseMessagesFromAppleScript(result);
  }

  private parseChatsResult(result: string): IMessageChat[] {
    return parseChatsFromAppleScript(result);
  }
}

/**
 * Parse tab-delimited AppleScript messages output.
 * Expected format per line: "id\ttext\tdate_sent\tis_from_me\tchat_identifier\tsender"
 */
export function parseMessagesFromAppleScript(
  result: string,
): IMessageMessage[] {
  const messages: IMessageMessage[] = [];
  if (!result || !result.trim()) {
    return messages;
  }

  for (const line of result.split("\n")) {
    const fields = line.trim().split("\t");
    if (fields.length < 6) {
      continue;
    }

    const [id, text, dateSent, isFromMeStr, chatIdentifier, sender] = fields;

    const isFromMe =
      isFromMeStr === "1" || isFromMeStr.toLowerCase() === "true";

    let timestamp: number;
    const parsed = Number(dateSent);
    if (!Number.isNaN(parsed) && parsed > 0) {
      timestamp = parsed;
    } else {
      const dateObj = new Date(dateSent);
      timestamp = Number.isNaN(dateObj.getTime()) ? 0 : dateObj.getTime();
    }

    messages.push({
      id: id || "",
      text: text || "",
      handle: sender || "",
      chatId: chatIdentifier || "",
      timestamp,
      isFromMe,
      hasAttachments: false,
    });
  }

  return messages;
}

/**
 * Parse tab-delimited AppleScript chats output.
 * Expected format per line: "chat_identifier\tdisplay_name\tparticipant_count\tlast_message_date"
 */
export function parseChatsFromAppleScript(result: string): IMessageChat[] {
  const chats: IMessageChat[] = [];
  if (!result || !result.trim()) {
    return chats;
  }

  for (const line of result.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const fields = trimmed.split("\t");
    if (fields.length < 4) {
      continue;
    }

    const [chatIdentifier, displayName, participantCountStr] = fields;

    const participantCount = Number(participantCountStr) || 0;
    const chatType: IMessageChatType = participantCount > 1 ? "group" : "direct";

    chats.push({
      chatId: chatIdentifier || "",
      chatType,
      displayName: displayName || undefined,
      participants: [],
    });
  }

  return chats;
}
