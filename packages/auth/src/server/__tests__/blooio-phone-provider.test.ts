/** Real PhoneAuth/stores and server composition; HTTP only is mocked. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { validatePhoneAuthProviderEnvironment } from "../api/routes/auth";
import {
  getPhoneAuth,
  releaseAuthStores,
} from "../api/services/auth-lifecycle";
import {
  BlooioSmsProvider,
  buildPhoneAuthProvidersFromEnvironment,
} from "../auth/phone-provider";
import { SmsDeliveryError, TwilioVerifyProvider } from "../auth/sms-provider";

const originalFetch = globalThis.fetch;
const keys = [
  "SMS_PROVIDER",
  "NODE_ENV",
  "BLOOIO_API_KEY",
  "BLOOIO_FROM_NUMBER",
  "STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR",
] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseAuthStores();
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
const configured = {
  SMS_PROVIDER: "blooio",
  BLOOIO_API_KEY: "synthetic-key",
  BLOOIO_FROM_NUMBER: "+15555550100",
  NODE_ENV: "test",
};
test("one server factory preserves default Verify and validates explicit Blooio at readiness", () => {
  const twilio = {
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
    TWILIO_AUTH_TOKEN: "synthetic-token",
    TWILIO_VERIFY_SERVICE_SID: `VA${"b".repeat(32)}`,
    TWILIO_VERIFY_TOKEN_TTL_SECONDS: "600",
    NODE_ENV: "production",
  };
  expect(
    buildPhoneAuthProvidersFromEnvironment(twilio).managedProvider,
  ).toBeInstanceOf(TwilioVerifyProvider);
  expect(
    buildPhoneAuthProvidersFromEnvironment({ ...twilio, ...configured })
      .provider,
  ).toBeInstanceOf(BlooioSmsProvider);
  expect(() => validatePhoneAuthProviderEnvironment(configured)).not.toThrow();
  for (const missing of [
    { ...configured, BLOOIO_API_KEY: "" },
    { ...configured, BLOOIO_FROM_NUMBER: "" },
  ])
    expect(() => validatePhoneAuthProviderEnvironment(missing)).toThrow(
      "Blooio SMS provider requires",
    );
});
test("ordinary server PhoneAuth retains six-digit purpose phone expiry and atomic one-use verification", async () => {
  Object.assign(process.env, configured, {
    STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR: "0",
  });
  releaseAuthStores();
  const bodies: string[] = [];
  const idempotency: string[] = [];
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://api.blooio.com/v4/messages");
    const body = JSON.parse(String(init?.body));
    bodies.push(body.text);
    idempotency.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    return Response.json({ id: "provider-id" });
  }) as typeof fetch;
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const phone = "+15555550101",
      auth = getPhoneAuth();
    const delivery = await auth.sendOtp(phone, "login:owned", "sms");
    const code = bodies[0]?.match(/\b\d{6}\b/u)?.[0];
    if (!code) throw new Error("Expected six-digit code");
    expect(delivery.expiresAt.getTime()).toBe(now + 300_000);
    expect(
      (await auth.verifyOtp("+15555550102", code, "login:owned")).valid,
    ).toBe(false);
    expect((await auth.verifyOtp(phone, code, "mfa:owned")).valid).toBe(false);
    const verified = await Promise.all([
      auth.verifyOtp(phone, code, "login:owned"),
      auth.verifyOtp(phone, code, "login:owned"),
    ]);
    expect(verified.filter((result) => result.valid)).toHaveLength(1);
    expect(verified.find((result) => result.valid)?.phone).toBe(phone);
    await auth.sendOtp(phone, "login:owned", "sms");
    clock.mockReturnValue(now + 300_001);
    expect(
      (
        await auth.verifyOtp(
          phone,
          bodies[1]?.match(/\b\d{6}\b/u)?.[0] ?? "",
          "login:owned",
        )
      ).valid,
    ).toBe(false);
    expect(idempotency.every((key) => /^[0-9a-f-]{36}$/u.test(key))).toBe(true);
    expect(new Set(idempotency).size).toBe(2);
  } finally {
    clock.mockRestore();
  }
});
test("provider delivery failures are fixed SmsDeliveryError and cannot echo OTP or keys", async () => {
  const provider = new BlooioSmsProvider({
    apiKey: "synthetic-secret",
    from: "+15555550100",
  });
  const http = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("synthetic-secret OTP 123456 +15555550101"),
  );
  let failure: unknown;
  try {
    await provider.send("+15555550101", "OTP 123456");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SmsDeliveryError);
  expect((failure as Error).message).toBe("SMS delivery failed");
  expect((failure as Error).cause).toBeUndefined();
  http.mockRestore();
});
