import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TELEGRAM_SERVICE_NAME } from "../constants";
import { EDIT_MESSAGE_ACTION, editMessageAction } from "./editMessage";

describe("editMessageAction", () => {
  // Mock service with real method signatures
  const createMockService = (editResult: { success: boolean; error?: string }) => ({
    isInitialized: vi.fn().mockReturnValue(true),
    editMessage: vi.fn().mockResolvedValue({
      success: editResult.success,
      chatId: 123,
      messageId: 456,
      error: editResult.error,
    }),
  });

  const createMockRuntime = (service: ReturnType<typeof createMockService> | undefined) => ({
    getService: vi.fn().mockImplementation((name: string) => {
      if (name === TELEGRAM_SERVICE_NAME) return service;
      return undefined;
    }),
    composeState: vi.fn().mockResolvedValue({
      values: { recentMessages: "User: Edit message 456 to say hello" },
    }),
    useModel: vi.fn().mockResolvedValue('{"messageId": 456, "text": "hello"}'),
  });

  it("should have correct name and description", () => {
    expect(editMessageAction.name).toBe(EDIT_MESSAGE_ACTION);
    expect(editMessageAction.description).toBe("Edit an existing Telegram message");
  });

  describe("validate", () => {
    it("should return false for non-telegram source", async () => {
      const mockService = createMockService({ success: true });
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const discordMessage = {
        content: { source: "discord" },
      } as Memory;

      expect(await editMessageAction.validate(mockRuntime, discordMessage)).toBe(false);
    });

    it("should return false when service is not initialized", async () => {
      const mockService = createMockService({ success: true });
      mockService.isInitialized.mockReturnValue(false);
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram" },
      } as Memory;

      expect(await editMessageAction.validate(mockRuntime, message)).toBe(false);
    });

    it("should return true when telegram source and service initialized", async () => {
      const mockService = createMockService({ success: true });
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram" },
      } as Memory;

      expect(await editMessageAction.validate(mockRuntime, message)).toBe(true);
      expect(mockService.isInitialized).toHaveBeenCalled();
    });
  });

  describe("handler", () => {
    it("should return error when telegram service is not available", async () => {
      const mockRuntime = createMockRuntime(undefined) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram", chatId: 123 },
      } as Memory;

      const callback = vi.fn();
      const result = await editMessageAction.handler(
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
      const mockService = createMockService({ success: true });
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram" }, // No chatId
      } as Memory;

      const callback = vi.fn();
      const result = await editMessageAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(result?.success).toBe(false);
      expect(result?.error).toBe("Missing chat ID");
    });

    it("should call service.editMessage with correct params on success", async () => {
      const mockService = createMockService({ success: true });
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram", chatId: 123 },
      } as Memory;

      const callback = vi.fn();
      const result = await editMessageAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(result?.success).toBe(true);
      expect(mockService.editMessage).toHaveBeenCalledWith({
        chatId: 123,
        messageId: "456",
        text: "hello",
      });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Message edited successfully",
          action: EDIT_MESSAGE_ACTION,
        })
      );
    });

    it("should return error when service.editMessage fails", async () => {
      const mockService = createMockService({ success: false, error: "Message not found" });
      const mockRuntime = createMockRuntime(mockService) as unknown as IAgentRuntime;

      const message = {
        content: { source: "telegram", chatId: 123 },
      } as Memory;

      const callback = vi.fn();
      const result = await editMessageAction.handler(
        mockRuntime,
        message,
        undefined,
        undefined,
        callback
      );

      expect(result?.success).toBe(false);
      expect(result?.error).toBe("Message not found");
      expect(callback).toHaveBeenCalledWith({
        text: "Failed to edit message: Message not found",
      });
    });
  });

  it("should have valid examples", () => {
    expect(editMessageAction.examples).toBeDefined();
    expect(editMessageAction.examples.length).toBeGreaterThan(0);

    for (const example of editMessageAction.examples) {
      expect(Array.isArray(example)).toBe(true);
      expect(example.length).toBeGreaterThan(0);
    }
  });

  it("should have similes for alternative naming", () => {
    expect(editMessageAction.similes).toContain("TELEGRAM_EDIT");
    expect(editMessageAction.similes).toContain("UPDATE_MESSAGE");
  });
});
