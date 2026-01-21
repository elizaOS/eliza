import twilio from "twilio";
import { readEnv } from "@/lib/env";

type TwilioClient = ReturnType<typeof twilio>;

export type OutboundChannel = "sms" | "whatsapp";

export type OutboundMessage = {
  to: string;
  body: string;
  channel: OutboundChannel;
};

let client: TwilioClient | null = null;

const getClient = (): TwilioClient => {
  if (client) return client;
  const sid = readEnv("TWILIO_ACCOUNT_SID");
  const token = readEnv("TWILIO_AUTH_TOKEN");
  if (!sid || !token) {
    throw new Error("Twilio messaging is not configured.");
  }
  client = twilio(sid, token);
  return client;
};

const ensureWhatsApp = (value: string): string =>
  value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;

const resolveFromNumber = (channel: OutboundChannel): string | null => {
  const from =
    readEnv("TWILIO_PHONE_NUMBER") ?? readEnv("NEXT_PUBLIC_ORI_PHONE_NUMBER");
  if (!from) return null;
  return channel === "whatsapp" ? ensureWhatsApp(from) : from;
};

export async function sendOutboundMessage(
  message: OutboundMessage,
): Promise<string> {
  const messagingServiceSid = readEnv("TWILIO_MESSAGING_SERVICE_SID");
  const to =
    message.channel === "whatsapp" ? ensureWhatsApp(message.to) : message.to;
  if (messagingServiceSid) {
    const payload = { to, body: message.body, messagingServiceSid };
    const result = await getClient().messages.create(payload);
    return result.sid;
  }

  const from = resolveFromNumber(message.channel);
  if (!from) {
    throw new Error("Twilio from number is missing for outbound messages.");
  }

  const payload = { to, body: message.body, from };

  const result = await getClient().messages.create(payload);
  return result.sid;
}
