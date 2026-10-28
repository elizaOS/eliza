/**
 * Blooio's signed webhook and message API boundary for the iMessage connector.
 */

import crypto from "node:crypto";
import { z } from "zod";

export { sendBlooioMessage } from "@elizaos/host/blooio-transport";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const BLOOIO_MEDIA_DOMAINS = [
  "blooio.com",
  "backend.blooio.com",
  "api.blooio.com",
  "media.blooio.com",
];

function isAllowedBlooioMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      BLOOIO_MEDIA_DOMAINS.some(
        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
    );
  } catch {
    return false;
  }
}

const AttachmentSchema = z.union([
  z.string().url(),
  z.object({ url: z.string().url(), name: z.string().nullish() }).passthrough(),
]);

const MessageSchema = z
  .object({
    id: z.string().trim().min(1).nullish(),
    message_id: z.string().trim().min(1).nullish(),
    chat_id: z.string().trim().min(1).nullish(),
    channel_id: z.string().trim().min(1),
    channel_type: z.string().trim().min(1).nullish(),
    sender: z.string().trim().min(1),
    recipient: z.string().trim().min(1).nullish(),
    channel_address: z.string().trim().min(1).nullish(),
    text: z.string().nullish(),
    reply_to_message_id: z.string().trim().min(1).nullish(),
    attachments: z.array(AttachmentSchema).nullish(),
    protocol: z.string().nullish(),
    is_group: z.boolean().nullish(),
    group: z.unknown().nullish(),
  })
  .passthrough();

const EnvelopeSchema = z.object({
  id: z.string().trim().min(1),
  type: z.string().trim().min(1),
  created_at: z.number(),
  data: MessageSchema,
});

export interface BlooioInboundMessage {
  messageId: string;
  sender: string;
  chatId: string;
  channelId: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  replyToMessageId?: string;
  /** The allowed attachments with the file name Blooio reports, in order. */
  attachments: Array<{ url: string; name?: string }>;
}

export function verifyBlooioSignature(
  secret: string,
  signatureHeader: string | undefined,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !signatureHeader) return false;
  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signaturePart = parts.find((part) => part.startsWith("v1="));
  if (!timestampPart || !signaturePart) return false;
  const rawTimestamp = timestampPart.slice(2);
  if (!/^\d+$/.test(rawTimestamp)) return false;
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const provided = signaturePart.slice(3);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

export function parseBlooioInbound(
  rawBody: string,
  expectedChannelId: string
): BlooioInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // error-policy:J3 malformed webhook JSON is rejected at the route boundary.
    return null;
  }
  const envelope = EnvelopeSchema.safeParse(parsed);
  if (!envelope.success || envelope.data.type !== "message.received") return null;
  const message = envelope.data.data;
  if (message.channel_id !== expectedChannelId) return null;
  const messageId = message.message_id ?? message.id;
  if (!messageId) return null;
  const attachments = (message.attachments ?? [])
    .map((attachment) =>
      typeof attachment === "string"
        ? { url: attachment }
        : { url: attachment.url, ...(attachment.name ? { name: attachment.name } : {}) }
    )
    .filter((attachment) => isAllowedBlooioMediaUrl(attachment.url));
  if (!(message.text ?? "").trim() && attachments.length === 0) return null;
  const rawTimestamp = envelope.data.created_at;
  const timestamp = rawTimestamp < 100_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
  return {
    messageId,
    sender: message.sender,
    chatId: message.chat_id ?? message.sender,
    channelId: message.channel_id,
    text: message.text ?? "",
    timestamp,
    isGroup: message.is_group ?? message.group != null,
    ...(message.reply_to_message_id ? { replyToMessageId: message.reply_to_message_id } : {}),
    attachments,
  };
}
