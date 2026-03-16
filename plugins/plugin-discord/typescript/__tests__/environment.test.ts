import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { validateDiscordConfig } from "../environment";

/**
 * Tests for Discord environment configuration validation.
 * These tests verify the validation logic without mocking - they use real runtime behavior.
 */
describe("Discord Environment Configuration", () => {
  // Create a minimal runtime that returns settings from a map
  function createRuntimeWithSettings(settings: Record<string, string | null>): IAgentRuntime {
    // Create a partial runtime mock that satisfies the IAgentRuntime interface
    const partialRuntime: Partial<IAgentRuntime> = {
      getSetting: (key: string) => settings[key] ?? null,
      character: { name: "Test Agent" },
      logger: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error,
      },
    };
    // Type assertion is safe here because we're only using the required properties
    return partialRuntime as IAgentRuntime;
  }

  it("should validate correct configuration", async () => {
    const runtime = createRuntimeWithSettings({
      DISCORD_API_TOKEN: "test-discord-token-12345",
    });

    const config = await validateDiscordConfig(runtime);
    expect(config).toBeDefined();
    expect(config.DISCORD_API_TOKEN).toBe("test-discord-token-12345");
  });

  it("should throw an error when DISCORD_API_TOKEN is missing", async () => {
    const runtime = createRuntimeWithSettings({});

    await expect(validateDiscordConfig(runtime)).rejects.toThrowError(
      /Discord configuration validation failed/
    );
  });

  it("should parse CHANNEL_IDS into an array when provided", async () => {
    const runtime = createRuntimeWithSettings({
      DISCORD_API_TOKEN: "test-discord-token-12345",
      CHANNEL_IDS: "123, 456,789",
    });

    const config = await validateDiscordConfig(runtime);
    expect(config.CHANNEL_IDS).toEqual(["123", "456", "789"]);
  });

  it("should leave CHANNEL_IDS undefined when not provided", async () => {
    const runtime = createRuntimeWithSettings({
      DISCORD_API_TOKEN: "test-discord-token-12345",
    });

    const config = await validateDiscordConfig(runtime);
    expect(config.CHANNEL_IDS).toBeUndefined();
  });
});
