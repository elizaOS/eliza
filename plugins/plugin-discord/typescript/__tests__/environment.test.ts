import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTestRuntime,
  createTestRuntime,
} from "../../../../packages/typescript/src/bootstrap/__tests__/test-utils";
import { validateDiscordConfig } from "../src/environment";

describe("Discord Environment Configuration", () => {
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = await createTestRuntime();
  });

  afterEach(async () => {
    await cleanupTestRuntime(runtime);
  });

  it("should validate correct configuration", async () => {
    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "DISCORD_API_TOKEN") return "mocked-discord-token";
      return null;
    });

    const config = await validateDiscordConfig(runtime);
    expect(config).toBeDefined();
    expect(config.DISCORD_API_TOKEN).toBe("mocked-discord-token");
  });

  it("should throw an error when DISCORD_API_TOKEN is missing", async () => {
    vi.spyOn(runtime, "getSetting").mockReturnValue(null);

    await expect(validateDiscordConfig(runtime)).rejects.toThrowError(
      "Discord configuration validation failed:\nDISCORD_API_TOKEN: Invalid input: expected string, received null"
    );
  });

  it("should parse CHANNEL_IDS into an array when provided", async () => {
    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "DISCORD_API_TOKEN") return "mocked-discord-token";
      if (key === "CHANNEL_IDS") return "123, 456,789";
      return null;
    });

    const config = await validateDiscordConfig(runtime);
    expect(config.CHANNEL_IDS).toEqual(["123", "456", "789"]);
  });

  it("should leave CHANNEL_IDS undefined when not provided", async () => {
    vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
      if (key === "DISCORD_API_TOKEN") return "mocked-discord-token";
      return null;
    });

    const config = await validateDiscordConfig(runtime);
    expect(config.CHANNEL_IDS).toBeUndefined();
  });
});
