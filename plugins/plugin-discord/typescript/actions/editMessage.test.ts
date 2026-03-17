import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import editMessage from "./editMessage";

describe("editMessage action", () => {
  it("should have correct name and description", () => {
    expect(editMessage.name).toBe("EDIT_MESSAGE");
    expect(editMessage.description).toBe("Edit an existing message in a Discord channel");
  });

  it("should validate only for discord source", async () => {
    const mockRuntime = {} as IAgentRuntime;

    const discordMessage = {
      content: { source: "discord" },
    } as Memory;

    const telegramMessage = {
      content: { source: "telegram" },
    } as Memory;

    expect(await editMessage.validate(mockRuntime, discordMessage)).toBe(true);
    expect(await editMessage.validate(mockRuntime, telegramMessage)).toBe(false);
  });

  it("should return error when discord service is not available", async () => {
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(undefined),
      composeState: vi.fn().mockResolvedValue({}),
    } as unknown as IAgentRuntime;

    const message = {
      content: { source: "discord", channelId: "123" },
    } as Memory;

    const callback = vi.fn();
    const result = await editMessage.handler(mockRuntime, message, undefined, undefined, callback);

    expect(callback).toHaveBeenCalledWith({
      text: "Discord service is not available.",
      source: "discord",
    });
  });

  it("should have valid examples", () => {
    expect(editMessage.examples).toBeDefined();
    expect(editMessage.examples.length).toBeGreaterThan(0);
  });

  it("should have similes for alternative naming", () => {
    expect(editMessage.similes).toContain("UPDATE_MESSAGE");
    expect(editMessage.similes).toContain("MODIFY_MESSAGE");
  });
});
