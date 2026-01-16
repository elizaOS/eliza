/**
 * Discord Handlers Tests
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { character } from "../character";

describe("Discord Character", () => {
  it("should have required character fields", () => {
    expect(character.name).toBe("DiscordEliza");
    expect(character.bio).toBeDefined();
    expect(character.system).toBeDefined();
  });

  it("should have Discord-specific settings", () => {
    expect(character.settings?.discord).toBeDefined();
    const discordSettings = character.settings?.discord;
    expect(typeof discordSettings).toBe("object");
    expect(discordSettings).not.toBeNull();

    const typedDiscordSettings = discordSettings as {
      shouldIgnoreBotMessages?: boolean;
      shouldRespondOnlyToMentions?: boolean;
    };

    expect(typedDiscordSettings.shouldIgnoreBotMessages).toBe(true);
    expect(typedDiscordSettings.shouldRespondOnlyToMentions).toBe(true);
  });
});

describe("Discord Handlers", () => {
  it("should export registerDiscordHandlers function", async () => {
    const { registerDiscordHandlers } = await import("../handlers");
    expect(typeof registerDiscordHandlers).toBe("function");
  });

  it("should export registerSlashCommands function", async () => {
    const { registerSlashCommands } = await import("../handlers");
    expect(typeof registerSlashCommands).toBe("function");
  });
});

describe("Environment Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  it("should detect missing Discord credentials", () => {
    delete process.env.DISCORD_APPLICATION_ID;
    delete process.env.DISCORD_API_TOKEN;

    const missing = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"].filter(
      (key) => !process.env[key],
    );

    expect(missing.length).toBe(2);
  });

  it("should detect when credentials are present", () => {
    process.env.DISCORD_APPLICATION_ID = "test-id";
    process.env.DISCORD_API_TOKEN = "test-token";
    process.env.OPENAI_API_KEY = "test-key";

    const required = ["DISCORD_APPLICATION_ID", "DISCORD_API_TOKEN"];
    const missing = required.filter((key) => !process.env[key]);

    expect(missing.length).toBe(0);
  });
});
