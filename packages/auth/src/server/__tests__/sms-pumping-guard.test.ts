import { afterAll, beforeEach, expect, test } from "bun:test";

// The real getPhoneAuth() path with the mock SMS provider: no network, no Redis.
process.env.SMS_PROVIDER = "mock";
process.env.NODE_ENV = "test";
delete process.env.STEWARD_SMS_ALLOWED_COUNTRY_CODES;
process.env.STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR = "3";

const {
  isSmsDestinationAllowed,
  MockSmsInbox,
  SmsDestinationNotAllowedError,
  SmsSendBudgetExceededError,
  smsSendGlobalMaxPerHour,
} = await import("../auth/index");
const { getPhoneAuth } = await import("../api/services/auth-lifecycle");
const { setDatabaseAuthRateLimiter } = await import(
  "../api/services/auth-rate-limit"
);

const counters = new Map<string, number>();
setDatabaseAuthRateLimiter(async (key, _windowMs, maximum) => {
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return { allowed: next <= maximum, retryAfterSecs: 60 };
});

beforeEach(() => {
  counters.clear();
  MockSmsInbox.clear();
});

afterAll(() => setDatabaseAuthRateLimiter(undefined));

test("default policy: US and Canada only, NANP Caribbean and toll-free refused", () => {
  // Destinations seen in the 2026-10 pumping incident.
  for (const phone of [
    "+998995073528", // Uzbekistan
    "+94785196335", // Sri Lanka
    "+9779747694922", // Nepal
    "+21629473789", // Tunisia
    "+25765517171", // Burundi
    "+18765550123", // Jamaica (+1 876)
    "+12425550123", // Bahamas (+1 242)
    "+18005550123", // toll-free
    "+19005550123", // premium
  ]) {
    expect(isSmsDestinationAllowed(phone, {})).toBe(false);
  }
  for (const phone of ["+14155550123", "+16475550123", "+17875550123"]) {
    expect(isSmsDestinationAllowed(phone, {})).toBe(true);
  }
});

test("allowlist is configurable and never fails open on a malformed value", () => {
  for (const raw of ["0invalid", "0.5", "Infinity", "9007199254740992"]) {
    expect(
      smsSendGlobalMaxPerHour({ STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR: raw }),
    ).toBe(300);
  }
  expect(
    smsSendGlobalMaxPerHour({ STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR: "0" }),
  ).toBe(0);
  expect(
    smsSendGlobalMaxPerHour({ STEWARD_SMS_SEND_GLOBAL_MAX_PER_HOUR: "1e3" }),
  ).toBe(1000);
  expect(
    isSmsDestinationAllowed("+447700900123", {
      STEWARD_SMS_ALLOWED_COUNTRY_CODES: "1,44",
    }),
  ).toBe(true);
  expect(
    isSmsDestinationAllowed("+18765550123", {
      STEWARD_SMS_ALLOWED_COUNTRY_CODES: "1,1876",
    }),
  ).toBe(true);
  expect(
    isSmsDestinationAllowed("+998995073528", {
      STEWARD_SMS_ALLOWED_COUNTRY_CODES: "garbage",
    }),
  ).toBe(false);
  expect(
    isSmsDestinationAllowed("+998995073528", {
      STEWARD_SMS_ALLOWED_COUNTRY_CODES: "*",
    }),
  ).toBe(true);
});

test("a refused destination never reaches the provider", async () => {
  const phone = "+998995073528";
  await expect(
    getPhoneAuth().sendOtp(phone, "login:test", "sms"),
  ).rejects.toBeInstanceOf(SmsDestinationNotAllowedError);
  expect(MockSmsInbox.all(phone)).toHaveLength(0);
});

test("deployment-wide hourly budget stops rotating destinations", async () => {
  const sent: string[] = [];
  for (let i = 0; i < 3; i++) {
    const phone = `+1415555010${i}`;
    await getPhoneAuth().sendOtp(phone, "login:test", "sms");
    sent.push(phone);
  }
  for (const phone of sent) expect(MockSmsInbox.all(phone)).toHaveLength(1);

  const fourth = "+14155550109";
  await expect(
    getPhoneAuth().sendOtp(fourth, "login:test", "sms"),
  ).rejects.toBeInstanceOf(SmsSendBudgetExceededError);
  expect(MockSmsInbox.all(fourth)).toHaveLength(0);
});
