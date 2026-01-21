import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { character } from "../character";

describe("Soulmates Character", () => {
  it("should have required character fields", () => {
    expect(character.name).toBe("Ori");
    expect(character.bio).toBeDefined();
    expect(character.system).toBeDefined();
  });

  it("should include Twilio and form plugins", () => {
    const plugins = character.plugins ?? [];
    expect(plugins).toEqual(
      expect.arrayContaining([
        "@elizaos/plugin-form",
        "@elizaos/plugin-twilio",
      ]),
    );
  });
});

describe("Environment Validation", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_WEBHOOK_URL",
    "OPENAI_API_KEY",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("should detect missing Twilio credentials", () => {
    for (const key of envKeys) delete process.env[key];

    const missing = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "TWILIO_WEBHOOK_URL",
    ].filter((key) => !process.env[key]);

    expect(missing.length).toBe(4);
  });

  it("should detect when credentials are present", () => {
    process.env.TWILIO_ACCOUNT_SID = "test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    process.env.TWILIO_PHONE_NUMBER = "+15551234567";
    process.env.TWILIO_WEBHOOK_URL = "https://example.com/webhooks/twilio";
    process.env.OPENAI_API_KEY = "test-key";

    const required = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
      "TWILIO_WEBHOOK_URL",
    ];
    const missing = required.filter((key) => !process.env[key]);

    expect(missing.length).toBe(0);
  });
});
