import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import type {
  SendReactionParams,
  SendReactionResult,
  WhatsAppConfig,
  WhatsAppInteractiveMessage,
  WhatsAppLocationMessage,
  WhatsAppMediaMessage,
  WhatsAppMessage,
  WhatsAppMessageResponse,
  WhatsAppReactionMessage,
} from "./types";

const DEFAULT_API_VERSION = "v18.0";

export class WhatsAppClient {
  private client: AxiosInstance;
  private config: WhatsAppConfig;

  constructor(config: WhatsAppConfig) {
    this.config = config;
    const apiVersion = config.apiVersion || DEFAULT_API_VERSION;

    this.client = axios.create({
      baseURL: `https://graph.facebook.com/${apiVersion}`,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Get the configured phone number ID.
   */
  getPhoneNumberId(): string {
    return this.config.phoneNumberId;
  }

  /**
   * Send a message of any supported type.
   */
  async sendMessage(message: WhatsAppMessage): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    const endpoint = `/${this.config.phoneNumberId}/messages`;
    const payload = this.buildMessagePayload(message);
    return this.client.post(endpoint, payload);
  }

  /**
   * Send a text message.
   */
  async sendTextMessage(
    to: string,
    text: string,
    _previewUrl = false
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "text",
      to,
      content: text,
    });
  }

  /**
   * Send a reaction to a message.
   */
  async sendReaction(params: SendReactionParams): Promise<SendReactionResult> {
    const endpoint = `/${this.config.phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "reaction",
      reaction: {
        message_id: params.messageId,
        emoji: params.emoji,
      },
    };

    try {
      const response = await this.client.post<WhatsAppMessageResponse>(endpoint, payload);
      return {
        success: true,
        messageId: response.data.messages?.[0]?.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Remove a reaction from a message (send empty emoji).
   */
  async removeReaction(to: string, messageId: string): Promise<SendReactionResult> {
    return this.sendReaction({
      to,
      messageId,
      emoji: "",
    });
  }

  /**
   * Send an image message.
   */
  async sendImage(
    to: string,
    imageUrl: string,
    caption?: string
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "image",
      to,
      content: {
        link: imageUrl,
        caption,
      } as WhatsAppMediaMessage,
    });
  }

  /**
   * Send a video message.
   */
  async sendVideo(
    to: string,
    videoUrl: string,
    caption?: string
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "video",
      to,
      content: {
        link: videoUrl,
        caption,
      } as WhatsAppMediaMessage,
    });
  }

  /**
   * Send an audio message.
   */
  async sendAudio(to: string, audioUrl: string): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "audio",
      to,
      content: {
        link: audioUrl,
      } as WhatsAppMediaMessage,
    });
  }

  /**
   * Send a document message.
   */
  async sendDocument(
    to: string,
    documentUrl: string,
    filename?: string,
    caption?: string
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "document",
      to,
      content: {
        link: documentUrl,
        filename,
        caption,
      } as WhatsAppMediaMessage,
    });
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
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    return this.sendMessage({
      type: "location",
      to,
      content: {
        latitude,
        longitude,
        name,
        address,
      } as WhatsAppLocationMessage,
    });
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
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    const interactive: WhatsAppInteractiveMessage = {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((btn) => ({
          type: "reply" as const,
          reply: { id: btn.id, title: btn.title },
        })),
      },
    };

    if (headerText) {
      interactive.header = { type: "text", text: headerText };
    }
    if (footerText) {
      interactive.footer = { text: footerText };
    }

    return this.sendMessage({
      type: "interactive",
      to,
      content: interactive,
    });
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
  ): Promise<AxiosResponse<WhatsAppMessageResponse>> {
    const interactive: WhatsAppInteractiveMessage = {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections,
      },
    };

    if (headerText) {
      interactive.header = { type: "text", text: headerText };
    }
    if (footerText) {
      interactive.footer = { text: footerText };
    }

    return this.sendMessage({
      type: "interactive",
      to,
      content: interactive,
    });
  }

  /**
   * Mark a message as read.
   */
  async markMessageAsRead(messageId: string): Promise<boolean> {
    const endpoint = `/${this.config.phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };

    try {
      await this.client.post(endpoint, payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Download media by ID.
   */
  async getMediaUrl(mediaId: string): Promise<string | null> {
    try {
      const response = await this.client.get(`/${mediaId}`);
      return response.data.url || null;
    } catch {
      return null;
    }
  }

  /**
   * Verify webhook token.
   */
  async verifyWebhook(token: string): Promise<boolean> {
    return token === this.config.webhookVerifyToken;
  }

  /**
   * Build the message payload based on message type.
   */
  private buildMessagePayload(message: WhatsAppMessage): Record<string, unknown> {
    const basePayload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.to,
      type: message.type,
    };

    // Add context for replies
    const contextPayload = message.replyToMessageId
      ? { context: { message_id: message.replyToMessageId } }
      : {};

    switch (message.type) {
      case "text":
        return {
          ...basePayload,
          ...contextPayload,
          text: {
            body: message.content as string,
          },
        };

      case "template":
        return {
          ...basePayload,
          ...contextPayload,
          template: message.content,
        };

      case "image": {
        const imageContent = message.content as WhatsAppMediaMessage;
        return {
          ...basePayload,
          ...contextPayload,
          image: {
            link: imageContent.link,
            caption: imageContent.caption,
          },
        };
      }

      case "video": {
        const videoContent = message.content as WhatsAppMediaMessage;
        return {
          ...basePayload,
          ...contextPayload,
          video: {
            link: videoContent.link,
            caption: videoContent.caption,
          },
        };
      }

      case "audio": {
        const audioContent = message.content as WhatsAppMediaMessage;
        return {
          ...basePayload,
          ...contextPayload,
          audio: {
            link: audioContent.link,
          },
        };
      }

      case "document": {
        const docContent = message.content as WhatsAppMediaMessage;
        return {
          ...basePayload,
          ...contextPayload,
          document: {
            link: docContent.link,
            filename: docContent.filename,
            caption: docContent.caption,
          },
        };
      }

      case "location": {
        const locContent = message.content as WhatsAppLocationMessage;
        return {
          ...basePayload,
          ...contextPayload,
          location: {
            latitude: locContent.latitude,
            longitude: locContent.longitude,
            name: locContent.name,
            address: locContent.address,
          },
        };
      }

      case "reaction": {
        const reactionContent = message.content as WhatsAppReactionMessage;
        return {
          ...basePayload,
          reaction: {
            message_id: reactionContent.messageId,
            emoji: reactionContent.emoji,
          },
        };
      }

      case "interactive": {
        const interactiveContent = message.content as WhatsAppInteractiveMessage;
        return {
          ...basePayload,
          ...contextPayload,
          interactive: interactiveContent,
        };
      }

      default:
        return basePayload;
    }
  }
}
