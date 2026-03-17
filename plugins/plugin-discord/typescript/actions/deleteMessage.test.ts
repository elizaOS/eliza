import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import deleteMessage from "./deleteMessage";

describe("deleteMessage action", () => {
  it("should have correct name and description", () => {
    expect(deleteMessage.name).toBe("DELETE_MESSAGE");
    expect(deleteMessage.description).toBe("Delete a message from a Discord channel");
  });

  it("should validate only for discord source", async () => {
    const mockRuntime = {} as IAgentRuntime;

    const discordMessage = {
      content: { source: "discord" },
    } as Memory;

    const telegramMessage = {
      content: { source: "telegram" },
    } as Memory;

    expect(await deleteMessage.validate(mockRuntime, discordMessage)).toBe(true);
    expect(await deleteMessage.validate(mockRuntime, telegramMessage)).toBe(false);
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
    const result = await deleteMessage.handler(
      mockRuntime,
      message,
      undefined,
      undefined,
      callback
    );

    expect(callback).toHaveBeenCalledWith({
      text: "Discord service is not available.",
      source: "discord",
    });
  });

  it("should have valid examples", () => {
    expect(deleteMessage.examples).toBeDefined();
    expect(deleteMessage.examples.length).toBeGreaterThan(0);
  });

  it("should have similes for alternative naming", () => {
    expect(deleteMessage.similes).toContain("REMOVE_MESSAGE");
    expect(deleteMessage.similes).toContain("UNSEND_MESSAGE");
  });
});
