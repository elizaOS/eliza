/**
 * Translates between Baileys protobuf messages and the plugin's transport types.
 * `toNormalized` maps an inbound proto.IWebMessageInfo into a NormalizedMessage
 * (chat id, type, content, reply target); `toBaileys` builds the outbound
 * Baileys payload from a WhatsAppMessage, validating media links before send.
 */
import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import { extractMessageContent, type proto } from "@whiskeysockets/baileys";
import type {
  NormalizedMessage,
  WhatsAppMediaMessage,
  WhatsAppMessage,
  WhatsAppTemplate,
} from "../types";
import { extractPersonalMediaMetadata } from "./media";

export class MessageAdapter {
  toNormalized(msg: proto.IWebMessageInfo): NormalizedMessage {
    const chatId = msg.key?.remoteJid ?? "";
    const senderId = msg.key?.participant ?? chatId;
    const content = extractMessageContent(msg.message);

    const personalMedia = content ? extractPersonalMediaMetadata(content) : undefined;
    return {
      id: msg.key?.id ?? "",
      from: chatId,
      timestamp: Number(msg.messageTimestamp ?? 0),
      type: this.detectType(content),
      content: this.extractContent(content),
      chatId,
      senderId,
      replyToId: this.extractReplyToId(content),
      ...(personalMedia ? { personalMedia } : {}),
    };
  }

  toBaileys(msg: WhatsAppMessage): Record<string, unknown> {
    switch (msg.type) {
      case "text":
        return { text: msg.content as string };
      case "image":
        return this.mediaWithCaption("image", msg.content as WhatsAppMediaMessage);
      case "video":
        return this.mediaWithCaption("video", msg.content as WhatsAppMediaMessage);
      case "audio":
        return this.mediaNoCaption("audio", msg.content as WhatsAppMediaMessage);
      case "document":
        return this.mediaWithFilename(msg.content as WhatsAppMediaMessage);
      case "template":
        return { text: this.renderTemplate(msg.content as WhatsAppTemplate) };
      default:
        throw new Error(`Message type ${msg.type} is outside the Baileys adapter contract`);
    }
  }

  private mediaWithCaption(
    key: "image" | "video",
    media: WhatsAppMediaMessage
  ): Record<string, unknown> {
    return {
      [key]: this.requiredCanonicalBytes(media, key),
      ...(media.caption ? { caption: media.caption } : {}),
    };
  }

  private mediaNoCaption(key: "audio", media: WhatsAppMediaMessage): Record<string, unknown> {
    return { [key]: this.requiredCanonicalBytes(media, key) };
  }

  private mediaWithFilename(media: WhatsAppMediaMessage): Record<string, unknown> {
    return {
      document: this.requiredCanonicalBytes(media, "document"),
      ...(media.filename ? { fileName: media.filename } : {}),
      ...(media.caption ? { caption: media.caption } : {}),
    };
  }

  private requiredCanonicalBytes(media: WhatsAppMediaMessage, kind: string): Buffer {
    if (!media.bytes || media.bytes.byteLength === 0) {
      throw new ElizaError("Personal WhatsApp media requires canonical local bytes", {
        code: "WHATSAPP_PERSONAL_MEDIA_BYTES_REQUIRED",
        context: { messageType: kind },
      });
    }
    return Buffer.from(media.bytes);
  }

  private detectType(
    content: proto.IMessage | undefined
  ): "text" | "image" | "audio" | "video" | "document" {
    if (content?.conversation || content?.extendedTextMessage) {
      return "text";
    }
    if (content?.imageMessage) {
      return "image";
    }
    if (content?.audioMessage) {
      return "audio";
    }
    if (content?.videoMessage) {
      return "video";
    }
    if (content?.documentMessage) {
      return "document";
    }
    return "text";
  }

  private extractContent(content: proto.IMessage | undefined): string {
    return (
      content?.conversation ??
      content?.extendedTextMessage?.text ??
      content?.imageMessage?.caption ??
      content?.videoMessage?.caption ??
      content?.documentMessage?.caption ??
      ""
    );
  }

  private extractReplyToId(content: proto.IMessage | undefined): string | undefined {
    const contextInfo =
      content?.extendedTextMessage?.contextInfo ??
      content?.imageMessage?.contextInfo ??
      content?.videoMessage?.contextInfo ??
      content?.documentMessage?.contextInfo;

    return typeof contextInfo?.stanzaId === "string" ? contextInfo.stanzaId : undefined;
  }

  private renderTemplate(template: WhatsAppTemplate): string {
    const params = template.components?.flatMap((component) =>
      component.parameters.map((parameter) => parameter.text).filter(Boolean)
    );
    return params && params.length > 0 ? `${template.name}: ${params.join(", ")}` : template.name;
  }
}
