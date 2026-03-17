import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DELETE_MESSAGE_ACTION, deleteMessageAction } from "./deleteMessage";

describe("deleteMessageAction", () => {
  it("should have correct name and description", () => {
    expect(deleteMessageAction.name).toBe(DELETE_MESSAGE_ACTION);
    expect(deleteMessageAction.description).toBe("Delete a Telegram message");
  });

  it("should validate only for telegram source with initialized service", async () => {
    const mockService = { isInitialized: vi.fn().mockReturnValue(true) };
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as unknown as IAgentRuntime;

    const telegramMessage = {
      content: { source: "telegram" },
    } as Memory;

    const discordMessage = {
      content: { source: "discord" },
    } as Memory;

    expect(await deleteMessageAction.validate(mockRuntime, telegramMessage)).toBe(true);
    expect(await deleteMessageAction.validate(mockRuntime, discordMessage)).toBe(false);
  });

  it("should return false when telegram service is not initialized", async () => {
    const mockService = { isInitialized: vi.fn().mockReturnValue(false) };
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(mockService),
    } as unknown as IAgentRuntime;

    const telegramMessage = {
      content: { source: "telegram" },
    } as Memory;

    expect(await deleteMessageAction.validate(mockRuntime, telegramMessage)).toBe(false);
  });

  it("should return error when telegram service is not available", async () => {
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(undefined),
      composeState: vi.fn().mockResolvedValue({}),
      useModel: vi.fn(),
    } as unknown as IAgentRuntime;

    const message = {
      content: { source: "telegram", chatId: 123 },
    } as Memory;

    const callback = vi.fn();
    const result = await deleteMessageAction.handler(
      mockRuntime,
      message,
      undefined,
      undefined,
      callback
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("Telegram service not initialized");
    expect(callback).toHaveBeenCalledWith({
      text: "Telegram service not available",
    });
  });

  it("should return error when chat ID is missing", async () => {
    const mockService = { bot: {} };
    const mockRuntime = {
      getService: vi.fn().mockReturnValue(mockService),
      composeState: vi.fn().mockResolvedValue({}),
    } as unknown as IAgentRuntime;

    const message = {
      content: { source: "telegram" }, // No chatId
    } as Memory;

    const callback = vi.fn();
    const result = await deleteMessageAction.handler(
      mockRuntime,
      message,
      undefined,
      undefined,
      callback
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("Missing chat ID");
  });

  it("should have valid examples", () => {
    expect(deleteMessageAction.examples).toBeDefined();
    expect(deleteMessageAction.examples.length).toBeGreaterThan(0);

    for (const example of deleteMessageAction.examples) {
      expect(Array.isArray(example)).toBe(true);
      expect(example.length).toBeGreaterThan(0);
    }
  });

  it("should have similes for alternative naming", () => {
    expect(deleteMessageAction.similes).toContain("TELEGRAM_DELETE");
    expect(deleteMessageAction.similes).toContain("REMOVE_MESSAGE");
  });
});
