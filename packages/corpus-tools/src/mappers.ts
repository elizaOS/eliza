/**
 * Mock-shape adapters for validated corpus messages. These functions keep the
 * canonical schema independent from test harness internals while returning
 * byte-stable objects compatible with the existing Gmail mock and LifeOps
 * simulator fixtures.
 */
import {
  CORPUS_ANCHOR_MS,
  type CorpusMessage,
  type CorpusPlatform,
} from "./schema.ts";

export interface GmailFixtureAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  data: string;
}

export interface GmailFixtureMessage {
  id: string;
  threadId: string;
  accountId?: string;
  labelIds?: string[];
  snippet: string;
  internalDateOffsetMs: number;
  headers: Array<{ name: string; value: string }>;
  bodyText: string;
  attachments?: GmailFixtureAttachment[];
}

export interface LifeOpsSimulatorEmail {
  id: string;
  threadId: string;
  fromPersonKey: string;
  subject: string;
  snippet: string;
  bodyText: string;
  labels: string[];
  internalDateOffsetMs: number;
  accountId?: "work" | "home";
}

export type LifeOpsSimulatorChannel =
  | "discord"
  | "telegram"
  | "signal"
  | "whatsapp"
  | "imessage";

export interface LifeOpsSimulatorChannelMessage {
  id: string;
  channel: LifeOpsSimulatorChannel;
  threadId: string;
  threadName: string;
  threadType: "dm" | "group";
  fromPersonKey: string;
  text: string;
  sentAtOffsetMs: number;
  unread?: boolean;
  outgoing?: boolean;
}

export interface MapperOptions {
  anchorMs?: number;
  ownerDisplay?: string;
  ownerEmail?: string;
  personKeyForSender?: (message: CorpusMessage) => string;
  xChannelFallback?: Extract<LifeOpsSimulatorChannel, "telegram" | "discord">;
}

function requirePlatform(
  message: CorpusMessage,
  expected: CorpusPlatform,
): void {
  if (message.platform !== expected) {
    throw new Error(
      `Cannot map ${message.platform} message ${message.id} as ${expected}`,
    );
  }
}

function personKey(message: CorpusMessage, options: MapperOptions): string {
  return (
    options.personKeyForSender?.(message) ??
    message.senderId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ??
    message.senderId
  );
}

function offsetMs(message: CorpusMessage, options: MapperOptions): number {
  return message.ts - (options.anchorMs ?? CORPUS_ANCHOR_MS);
}

function snippet(message: CorpusMessage): string {
  return message.snippet ?? message.text.slice(0, 160);
}

function addressFor(recipient: { display?: string; address?: string }): string {
  if (recipient.address && recipient.display) {
    return `${recipient.display} <${recipient.address}>`;
  }
  return recipient.address ?? recipient.display ?? "unknown@example.test";
}

export function toGmailFixtureMessage(
  message: CorpusMessage,
  options: MapperOptions = {},
): GmailFixtureMessage {
  requirePlatform(message, "gmail");
  const ownerDisplay = options.ownerDisplay ?? "Owner";
  const ownerEmail = options.ownerEmail ?? "owner@example.test";
  const from =
    message.direction === "out"
      ? `${ownerDisplay} <${ownerEmail}>`
      : `${message.senderDisplay} <${message.senderId}>`;
  const to =
    message.direction === "out"
      ? message.recipients.map(addressFor).join(", ")
      : `${ownerDisplay} <${ownerEmail}>`;

  return {
    id: message.id,
    threadId: message.threadId,
    accountId: message.accountId,
    labelIds: [...message.labels],
    snippet: snippet(message),
    internalDateOffsetMs: offsetMs(message, options),
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      { name: "Subject", value: message.subject ?? "(no subject)" },
      { name: "Message-Id", value: `<${message.id}@corpus-tools.local>` },
    ],
    bodyText: message.text,
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((attachment, index) => ({
            attachmentId: `${message.id}-att-${index + 1}`,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            data: attachment.dataBase64 ?? attachment.sha256,
          })),
        }
      : {}),
  };
}

export function toLifeOpsSimulatorEmail(
  message: CorpusMessage,
  options: MapperOptions = {},
): LifeOpsSimulatorEmail {
  requirePlatform(message, "gmail");
  if (message.direction !== "in") {
    throw new Error(
      `LifeOps simulator passive email fixtures must be incoming: ${message.id}`,
    );
  }
  return {
    id: message.id,
    threadId: message.threadId,
    fromPersonKey: personKey(message, options),
    subject: message.subject ?? "(no subject)",
    snippet: snippet(message),
    bodyText: message.text,
    labels: [...message.labels],
    internalDateOffsetMs: offsetMs(message, options),
    ...(message.accountId === "work" || message.accountId === "home"
      ? { accountId: message.accountId }
      : {}),
  };
}

function channelFor(
  platform: CorpusPlatform,
  options: MapperOptions,
): LifeOpsSimulatorChannel {
  if (platform === "x") return options.xChannelFallback ?? "telegram";
  if (
    platform === "discord" ||
    platform === "telegram" ||
    platform === "signal" ||
    platform === "imessage"
  ) {
    return platform;
  }
  throw new Error(`Cannot map ${platform} to LifeOps channel message`);
}

export function toLifeOpsSimulatorChannelMessage(
  message: CorpusMessage,
  options: MapperOptions = {},
): LifeOpsSimulatorChannelMessage {
  if (message.platform === "gmail") {
    throw new Error(`Cannot map Gmail message ${message.id} as chat`);
  }
  const channel = channelFor(message.platform, options);
  const threadName =
    message.platform === "x"
      ? `X: ${message.subject ?? message.threadId}`
      : (message.subject ?? message.threadId);
  return {
    id: message.id,
    channel,
    threadId: message.threadId,
    threadName,
    threadType: message.recipients.length > 1 ? "group" : "dm",
    fromPersonKey: personKey(message, options),
    text: message.text,
    sentAtOffsetMs: offsetMs(message, options),
    unread: message.direction === "in" ? true : undefined,
    outgoing: message.direction === "out" ? true : undefined,
  };
}
