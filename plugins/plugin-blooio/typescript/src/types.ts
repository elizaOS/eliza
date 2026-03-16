import * as z from "zod";

export type BlooioProtocol = "imessage" | "sms" | "rcs" | "non-imessage";

export type BlooioEventType =
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.failed"
  | "message.read"
  | "group.name_changed"
  | "group.icon_changed";

export interface BlooioAttachment {
  url: string;
  name?: string;
}

export interface BlooioMessage {
  messageId: string;
  chatId: string;
  sender: string;
  text?: string;
  attachments?: string[];
  direction: "inbound" | "outbound";
  status?: string;
  protocol?: BlooioProtocol;
  timestamp: number;
  internalId?: string;
}

export interface BlooioSendMessageRequest {
  text?: string | string[];
  attachments?: Array<string | BlooioAttachment>;
  metadata?: Record<string, string | number | boolean | null>;
  use_typing_indicator?: boolean;
  fromNumber?: string;
  idempotencyKey?: string;
}

export interface BlooioSendMessageResponse {
  message_id?: string;
  message_ids?: string[];
  status: string;
  group_id?: string;
  group_created?: boolean;
  participants?: string[];
}

export interface BlooioWebhookBase {
  event: BlooioEventType;
  message_id?: string;
  external_id?: string;
  protocol?: BlooioProtocol;
  timestamp: number;
  internal_id?: string;
}

export interface BlooioGroupParticipant {
  contact_id: string;
  identifier: string;
  name: string | null;
}

export interface BlooioMessageReceivedEvent extends BlooioWebhookBase {
  event: "message.received";
  text?: string;
  attachments?: Array<string | BlooioAttachment>;
  received_at: number;
  sender: string;
  is_group: boolean;
  group_id?: string | null;
  group_name?: string | null;
  participants?: BlooioGroupParticipant[] | null;
}

export interface BlooioMessageSentEvent extends BlooioWebhookBase {
  event: "message.sent";
  text?: string;
  attachments?: Array<string | BlooioAttachment>;
  sent_at: number;
}

export interface BlooioMessageDeliveredEvent extends BlooioWebhookBase {
  event: "message.delivered";
  delivered_at: number;
}

export interface BlooioMessageFailedEvent extends BlooioWebhookBase {
  event: "message.failed";
  error_code: string;
  error_message: string;
}

export interface BlooioMessageReadEvent extends BlooioWebhookBase {
  event: "message.read";
  read_at: number;
}

export interface BlooioGroupNameChangedEvent extends BlooioWebhookBase {
  event: "group.name_changed";
  group_id: string;
  name: string;
  previous_name: string | null;
}

export interface BlooioGroupIconChangedEvent extends BlooioWebhookBase {
  event: "group.icon_changed";
  group_id: string;
  icon_url: string;
  previous_icon_url: string | null;
}

export type BlooioWebhookEvent =
  | BlooioMessageReceivedEvent
  | BlooioMessageSentEvent
  | BlooioMessageDeliveredEvent
  | BlooioMessageFailedEvent
  | BlooioMessageReadEvent
  | BlooioGroupNameChangedEvent
  | BlooioGroupIconChangedEvent;

export interface BlooioConfig {
  apiKey: string;
  webhookUrl: string;
  webhookPath: string;
  webhookPort: number;
  webhookSecret?: string;
  baseUrl: string;
  fromNumber?: string;
  signatureToleranceSeconds: number;
}

export class BlooioError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public details?: string
  ) {
    super(message);
    this.name = "BlooioError";
  }
}

export interface BlooioServiceInterface {
  sendMessage(
    chatId: string,
    request: BlooioSendMessageRequest
  ): Promise<BlooioSendMessageResponse>;
}

export const SendMessageSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1).optional(),
  attachments: z.array(z.string().url()).optional(),
});

export const CACHE_KEYS = {
  CONVERSATION: (chatId: string) => `blooio:conversation:${chatId}`,
} as const;
