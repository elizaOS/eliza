import { createHmac } from "node:crypto";
import { WhatsAppClient } from "./client";
import { MessageHandler, WebhookHandler } from "./handlers";
import type {
  CloudAPIConfig,
  SendReactionParams,
  SendReactionResult,
  WhatsAppEventType,
  WhatsAppMessage,
  WhatsAppMessageResponse,
  WhatsAppWebhookEvent,
} from "./types";

type EventHandler = (payload: unknown) => void | Promise<void>;

/**
 * WhatsApp service for ElizaOS.
 * Provides comprehensive WhatsApp Cloud API integration.
 */
export class WhatsAppService {
  static readonly serviceType = "whatsapp";

  private config: CloudAPIConfig;
  private client: WhatsAppClient;
  private messageHandler: MessageHandler;
  private webhookHandler: WebhookHandler;
  private running = false;
  private eventHandlers: Map<WhatsAppEventType, EventHandler[]> = new Map();

  constructor(config: CloudAPIConfig) {
    this.config = config;
    this.client = new WhatsAppClient(config);
    this.messageHandler = new MessageHandler(this.client);
    this.webhookHandler = new WebhookHandler();
  }

  /**
   * Create service from environment variables.
   */
  static fromEnv(): WhatsAppService {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!accessToken) {
      throw new Error("WHATSAPP_ACCESS_TOKEN environment variable is required");
    }
    if (!phoneNumberId) {
      throw new Error("WHATSAPP_PHONE_NUMBER_ID environment variable is required");
    }

    return new WhatsAppService({
      accessToken,
      phoneNumberId,
      webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
      apiVersion: process.env.WHATSAPP_API_VERSION || "v24.0",
    });
  }

  /**
   * Get the underlying client.
   */
  getClient(): WhatsAppClient {
    return this.client;
  }

  /**
   * Start the WhatsApp service.
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn("WhatsApp service is already running");
      return;
    }

    this.running = true;
    console.log(`WhatsApp service started for phone number ID: ${this.config.phoneNumberId}`);
  }

  /**
   * Stop the WhatsApp service.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    console.log("WhatsApp service stopped");
  }

  /**
   * Check if the service is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register an event handler.
   */
  onEvent(eventType: WhatsAppEventType, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.push(handler);
    this.eventHandlers.set(eventType, handlers);
  }

  /**
   * Handle a webhook event.
   */
  async handleWebhook(event: WhatsAppWebhookEvent): Promise<void> {
    await this.webhookHandler.handle(event);
  }

  /**
   * Verify a webhook subscription request.
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === "subscribe" && token === this.config.webhookVerifyToken) {
      console.log("Webhook verified successfully");
      return challenge;
    }
    console.warn("Webhook verification failed");
    return null;
  }

  /**
   * Verify webhook payload signature.
   */
  verifyWebhookSignature(payload: Buffer | string, signature: string): boolean {
    if (!this.config.webhookVerifyToken) {
      return true; // No verification configured
    }

    if (!signature.startsWith("sha256=")) {
      return false;
    }

    const expectedSignature = signature.slice(7);
    const computed = createHmac("sha256", this.config.webhookVerifyToken)
      .update(payload)
      .digest("hex");

    return computed === expectedSignature;
  }

  // Message sending methods

  /**
   * Send a message of any type.
   */
  async sendMessage(message: WhatsAppMessage): Promise<WhatsAppMessageResponse> {
    return this.messageHandler.send(message);
  }

  /**
   * Send a text message.
   */
  async sendText(to: string, text: string): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendTextMessage(to, text);
    return response.data;
  }

  /**
   * Send a reaction to a message.
   */
  async sendReaction(params: SendReactionParams): Promise<SendReactionResult> {
    return this.client.sendReaction(params);
  }

  /**
   * Remove a reaction from a message.
   */
  async removeReaction(to: string, messageId: string): Promise<SendReactionResult> {
    return this.client.removeReaction(to, messageId);
  }

  /**
   * Send an image message.
   */
  async sendImage(
    to: string,
    imageUrl: string,
    caption?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendImage(to, imageUrl, caption);
    return response.data;
  }

  /**
   * Send a video message.
   */
  async sendVideo(
    to: string,
    videoUrl: string,
    caption?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendVideo(to, videoUrl, caption);
    return response.data;
  }

  /**
   * Send an audio message.
   */
  async sendAudio(to: string, audioUrl: string): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendAudio(to, audioUrl);
    return response.data;
  }

  /**
   * Send a document message.
   */
  async sendDocument(
    to: string,
    documentUrl: string,
    filename?: string,
    caption?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendDocument(to, documentUrl, filename, caption);
    return response.data;
  }

  /**
   * Send a location message.
   */
  async sendLocation(
    to: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendLocation(to, latitude, longitude, name, address);
    return response.data;
  }

  /**
   * Send an interactive button message.
   */
  async sendButtonMessage(
    to: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    headerText?: string,
    footerText?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendButtonMessage(
      to,
      bodyText,
      buttons,
      headerText,
      footerText
    );
    return response.data;
  }

  /**
   * Send an interactive list message.
   */
  async sendListMessage(
    to: string,
    bodyText: string,
    buttonText: string,
    sections: Array<{
      title?: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>,
    headerText?: string,
    footerText?: string
  ): Promise<WhatsAppMessageResponse> {
    const response = await this.client.sendListMessage(
      to,
      bodyText,
      buttonText,
      sections,
      headerText,
      footerText
    );
    return response.data;
  }

  /**
   * Mark a message as read.
   */
  async markAsRead(messageId: string): Promise<boolean> {
    return this.client.markMessageAsRead(messageId);
  }

  /**
   * Get the download URL for a media file.
   */
  async getMediaUrl(mediaId: string): Promise<string | null> {
    return this.client.getMediaUrl(mediaId);
  }
}
