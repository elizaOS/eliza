/** One server-owned provider selection for startup validation and ordinary PhoneAuth. */
import { randomUUID } from "node:crypto";
import { sendBlooioMessage } from "@elizaos/host/blooio-transport";
import {
  type ManagedSmsOtpProvider,
  MockSmsProvider,
  SmsDeliveryError,
  type SmsProvider,
  TwilioSmsProvider,
  TwilioVerifyProvider,
} from "./sms-provider";

export class BlooioSmsProvider implements SmsProvider {
  constructor(private readonly config: { apiKey: string; from: string }) {
    if (!config.apiKey.trim() || !/^\+[1-9]\d{6,14}$/u.test(config.from))
      throw new Error(
        "Blooio SMS provider requires an API key and E.164 sender",
      );
  }
  async send(to: string, body: string): Promise<void> {
    if (!/^\+[1-9]\d{6,14}$/u.test(to)) throw new SmsDeliveryError();
    try {
      const result = await sendBlooioMessage({
        ...this.config,
        to,
        text: body,
        idempotencyKey: randomUUID(),
      });
      if (!result.success) throw new SmsDeliveryError();
    } catch {
      throw new SmsDeliveryError();
    }
  }
}
export function buildTwilioVerifyProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TwilioVerifyProvider | undefined {
  const configured =
    env.TWILIO_VERIFY_SERVICE_SID !== undefined ||
    env.TWILIO_VERIFY_TOKEN_TTL_SECONDS !== undefined;
  if (!configured) return undefined;
  return new TwilioVerifyProvider({
    accountSid: env.TWILIO_ACCOUNT_SID ?? "",
    authToken: env.TWILIO_AUTH_TOKEN ?? "",
    serviceSid: env.TWILIO_VERIFY_SERVICE_SID ?? "",
    tokenTtlSeconds: Number(env.TWILIO_VERIFY_TOKEN_TTL_SECONDS),
  });
}
export function buildPhoneAuthProvidersFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { provider?: SmsProvider; managedProvider?: ManagedSmsOtpProvider } {
  if (env.SMS_PROVIDER === "mock" && env.NODE_ENV !== "production")
    return { provider: new MockSmsProvider() };
  if (env.SMS_PROVIDER === "blooio")
    return {
      provider: new BlooioSmsProvider({
        apiKey: env.BLOOIO_API_KEY ?? "",
        from: env.BLOOIO_FROM_NUMBER ?? "",
      }),
    };
  const managedProvider = buildTwilioVerifyProviderFromEnvironment(env);
  if (managedProvider) return { managedProvider };
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM)
    return {
      provider: new TwilioSmsProvider({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_FROM,
      }),
    };
  return {};
}
