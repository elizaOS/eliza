/**
 * Pins the fail-closed error policy of the eliza-app config: the required JWT
 * secret and enabled-but-unconfigured channels must throw, while a genuinely
 * optional, unconfigured channel stays a distinguishable designed-empty value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const TOUCHED_ENV = [
  "NODE_ENV",
  "ELIZA_APP_JWT_SECRET",
  "ELIZA_APP_TELEGRAM_ENABLED",
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_DISCORD_ENABLED",
  "ELIZA_APP_DISCORD_BOT_TOKEN",
  "ELIZA_APP_DISCORD_APPLICATION_ID",
  "ELIZA_APP_DISCORD_CLIENT_SECRET",
  "ELIZA_APP_BLOOIO_ENABLED",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_WHATSAPP_ENABLED",
  "ELIZA_APP_WHATSAPP_ACCESS_TOKEN",
  "ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID",
  "ELIZA_APP_WHATSAPP_APP_SECRET",
  "ELIZA_APP_WHATSAPP_VERIFY_TOKEN",
  "ELIZA_APP_WHATSAPP_PHONE_NUMBER",
] as const;

const WHATSAPP_REQUIRED_ENV = [
  "ELIZA_APP_WHATSAPP_ACCESS_TOKEN",
  "ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID",
  "ELIZA_APP_WHATSAPP_APP_SECRET",
  "ELIZA_APP_WHATSAPP_VERIFY_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function loadConfig() {
  return import("./config");
}

describe("eliza-app config fail-closed policy", () => {
  it("throws when the required JWT secret is missing (jwt getter fails closed)", async () => {
    const { elizaAppConfig } = await loadConfig();
    delete process.env.ELIZA_APP_JWT_SECRET;
    // The secret is required for every session flow; a missing value must
    // surface as a thrown error, never a silent empty string.
    expect(() => elizaAppConfig.jwt.secret).toThrow(/ELIZA_APP_JWT_SECRET is not set/);
  });

  it("returns the JWT secret when set (no failure on the healthy path)", async () => {
    const { elizaAppConfig } = await loadConfig();
    process.env.ELIZA_APP_JWT_SECRET = "s3cr3t-value";
    expect(elizaAppConfig.jwt.secret).toBe("s3cr3t-value");
  });

  it("validateElizaAppConfig throws when the JWT secret is missing", async () => {
    const { validateElizaAppConfig } = await loadConfig();
    delete process.env.ELIZA_APP_JWT_SECRET;
    expect(() => validateElizaAppConfig()).toThrow(/ELIZA_APP_JWT_SECRET is not set/);
  });

  it("validateElizaAppConfig throws when a channel is enabled but unconfigured", async () => {
    const { validateElizaAppConfig } = await loadConfig();
    process.env.ELIZA_APP_JWT_SECRET = "s3cr3t-value";
    // Enabled Telegram with no bot token is an internal misconfiguration that
    // must fail closed, not degrade to an empty token silently at request time.
    process.env.ELIZA_APP_TELEGRAM_ENABLED = "true";
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
    expect(() => validateElizaAppConfig()).toThrow(/Telegram is enabled/);

    // Same fail-closed contract for Discord's required trio.
    delete process.env.ELIZA_APP_TELEGRAM_ENABLED;
    process.env.ELIZA_APP_DISCORD_ENABLED = "true";
    delete process.env.ELIZA_APP_DISCORD_BOT_TOKEN;
    expect(() => validateElizaAppConfig()).toThrow(/Discord is enabled/);
  });

  it("designed-empty: an unconfigured optional channel yields empty, NOT a throw, and validation passes", async () => {
    const { elizaAppConfig, validateElizaAppConfig } = await loadConfig();
    process.env.NODE_ENV = "test";
    process.env.ELIZA_APP_JWT_SECRET = "s3cr3t-value";
    // Telegram is genuinely optional here (not enabled): reading it is a
    // distinguishable empty value, and validation does not fail closed.
    expect(elizaAppConfig.telegram.botToken).toBe("");
    expect(() => elizaAppConfig.telegram.botToken).not.toThrow();
    expect(() => validateElizaAppConfig()).not.toThrow();
  });

  it("distinguishes designed-empty (optional, empty) from fail-closed (required, throws)", async () => {
    const { elizaAppConfig } = await loadConfig();
    process.env.NODE_ENV = "test";
    delete process.env.ELIZA_APP_JWT_SECRET;
    // The two states are not conflated: optional channel -> empty string;
    // required secret -> thrown error. A caller can tell them apart.
    expect(elizaAppConfig.telegram.botToken).toBe("");
    expect(() => elizaAppConfig.jwt.secret).toThrow();
  });

  it("requires the complete WhatsApp 4-of-4 runtime contract", async () => {
    const { validateElizaAppConfig } = await loadConfig();
    process.env.ELIZA_APP_JWT_SECRET = "s3cr3t-value";

    const combinations = 1 << WHATSAPP_REQUIRED_ENV.length;
    for (let mask = 0; mask < combinations; mask += 1) {
      for (const name of WHATSAPP_REQUIRED_ENV) delete process.env[name];
      delete process.env.ELIZA_APP_WHATSAPP_ENABLED;
      for (const [index, name] of WHATSAPP_REQUIRED_ENV.entries()) {
        if ((mask & (1 << index)) !== 0) process.env[name] = "configured-contract-value";
      }

      const supplied = WHATSAPP_REQUIRED_ENV.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      ).length;
      if (supplied === 0 || supplied === WHATSAPP_REQUIRED_ENV.length) {
        expect(() => validateElizaAppConfig()).not.toThrow();
      } else {
        expect(() => validateElizaAppConfig()).toThrow(/WhatsApp is enabled/);
      }
    }

    for (const name of WHATSAPP_REQUIRED_ENV) delete process.env[name];
    process.env.ELIZA_APP_WHATSAPP_ENABLED = "true";
    expect(() => validateElizaAppConfig()).toThrow(/WhatsApp is enabled/);

    delete process.env.ELIZA_APP_WHATSAPP_ENABLED;
    process.env.ELIZA_APP_WHATSAPP_PHONE_NUMBER = "+15551234567";
    expect(() => validateElizaAppConfig()).not.toThrow();
  });
});
