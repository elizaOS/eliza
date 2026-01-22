import { z } from "zod";

// Twilio message types
export interface TwilioMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  media?: TwilioMedia[];
  direction: "inbound" | "outbound";
  status: string;
  dateCreated: Date;
  dateSent?: Date;
}

export interface TwilioMedia {
  contentType: string;
  url: string;
  sid: string;
}

// Voice call types
export interface TwilioCall {
  sid: string;
  from: string;
  to: string;
  status: string;
  direction: "inbound" | "outbound";
  duration?: number;
  dateCreated: Date;
  dateEnded?: Date;
}

// WebSocket connection for voice streaming
export interface TwilioVoiceStream {
  streamSid: string;
  callSid: string;
  from: string;
  to: string;
  socket: any; // WebSocket instance
}

// Webhook request types
export interface TwilioSmsWebhook {
  MessageSid: string;
  From: string;
  To: string;
  Body: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
}

export interface TwilioVoiceWebhook {
  CallSid: string;
  From: string;
  To: string;
  CallStatus: string;
  Direction: string;
}

export interface TwilioStatusWebhook {
  MessageSid?: string;
  MessageStatus?: string;
  SmsStatus?: string;
  CallSid?: string;
  CallStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
  To?: string;
  From?: string;
  MessagingServiceSid?: string;
  AccountSid?: string;
  ApiVersion?: string;
}

// Configuration
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookUrl: string;
  webhookPort?: number;
}

const E164_REGEX = /^\+\d{1,15}$/;
const MESSAGING_REGEX = /^(whatsapp:)?\+\d{1,15}$/;

// Zod schemas for validation
export const TwilioMessageSchema = z.object({
  to: z.string().regex(MESSAGING_REGEX),
  body: z.string().min(1).max(1600),
  mediaUrl: z.array(z.string().url()).optional(),
});

export const TwilioCallSchema = z.object({
  to: z.string().regex(E164_REGEX),
  twiml: z.string().optional(),
  url: z.string().url().optional(),
});

// Action parameters
export const SendSmsSchema = z.object({
  to: z.string().regex(MESSAGING_REGEX),
  message: z.string().min(1).max(1600),
  mediaUrl: z.array(z.string().url()).optional(),
});

export const MakeCallSchema = z.object({
  to: z.string().regex(E164_REGEX),
  message: z.string().optional(),
  url: z.string().url().optional(),
});

export const SendMmsSchema = z.object({
  to: z.string().regex(MESSAGING_REGEX),
  message: z.string().min(1).max(1600),
  mediaUrl: z.array(z.string().url()).min(1),
});

// Cache keys
export const CACHE_KEYS = {
  CONVERSATION: (phoneNumber: string) => `twilio:conversation:${phoneNumber}`,
  CALL_STATE: (callSid: string) => `twilio:call:${callSid}`,
  MEDIA: (mediaSid: string) => `twilio:media:${mediaSid}`,
} as const;

// Event types
export enum TwilioEventType {
  SMS_RECEIVED = "sms:received",
  SMS_SENT = "sms:sent",
  CALL_RECEIVED = "call:received",
  CALL_ENDED = "call:ended",
  VOICE_STREAM_STARTED = "voice:stream:started",
  VOICE_STREAM_ENDED = "voice:stream:ended",
}

// Error types
export class TwilioError extends Error {
  constructor(
    message: string,
    public code?: number,
    public twilioCode?: string
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

export interface TwilioServiceInterface {
  sendSms(to: string, body: string, mediaUrl?: string[], from?: string): Promise<TwilioMessage>;
  makeCall(to: string, twiml?: string, url?: string): Promise<TwilioCall>;
  handleIncomingSms(webhook: TwilioSmsWebhook): Promise<void>;
  handleIncomingCall(webhook: TwilioVoiceWebhook): Promise<string>; // Returns TwiML
  startVoiceStream(callSid: string): Promise<void>;
  endVoiceStream(callSid: string): Promise<void>;
}
