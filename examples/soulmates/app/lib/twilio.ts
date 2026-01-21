import twilio from "twilio";
import { readEnv } from "@/lib/env";

type TwilioClient = ReturnType<typeof twilio>;

let client: TwilioClient | null = null;

function getClient(): TwilioClient {
  if (client) return client;
  const sid = readEnv("TWILIO_ACCOUNT_SID");
  const token = readEnv("TWILIO_AUTH_TOKEN");
  if (!sid || !token) throw new Error("Twilio is not configured.");
  client = twilio(sid, token);
  return client;
}

function getServiceSid(): string {
  const sid = readEnv("TWILIO_VERIFY_SERVICE_SID");
  if (!sid) throw new Error("Twilio Verify service SID is missing.");
  return sid;
}

export async function startSmsVerification(phone: string): Promise<void> {
  await getClient()
    .verify.v2.services(getServiceSid())
    .verifications.create({ to: phone, channel: "sms" });
}

export async function checkSmsVerification(
  phone: string,
  code: string,
): Promise<boolean> {
  const result = await getClient()
    .verify.v2.services(getServiceSid())
    .verificationChecks.create({ to: phone, code });
  return result.status === "approved";
}
