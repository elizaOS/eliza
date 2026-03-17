import { describe, expect, it } from "vitest";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "../src/providers";

describe("ChatStateProvider", () => {
  describe("metadata", () => {
    it("should have correct provider name", () => {
      expect(CHAT_STATE_PROVIDER).toBe("FEISHU_CHAT_STATE");
      expect(chatStateProvider.name).toBe(CHAT_STATE_PROVIDER);
    });

    it("should have a description", () => {
      expect(chatStateProvider.description).toBeTruthy();
      expect(chatStateProvider.description.length).toBeGreaterThan(0);
    });
  });

  describe("get", () => {
    it("should return empty text for non-feishu source", async () => {
      const mockMessage = {
        content: {
          source: "telegram",
          chatId: "oc_test123",
        },
      };

      const result = await chatStateProvider.get(
        {} as never,
        mockMessage as never,
      );
      expect(result).toEqual({ text: "" });
    });

    it("should return empty text for missing chat ID", async () => {
      const mockMessage = {
        content: {
          source: "feishu",
        },
      };

      const result = await chatStateProvider.get(
        {} as never,
        mockMessage as never,
      );
      expect(result).toEqual({ text: "" });
    });

    it("should return state string for valid feishu message", async () => {
      const mockMessage = {
        content: {
          source: "feishu",
          chatId: "oc_test123",
          messageId: "msg_456",
        },
      };

      const result = await chatStateProvider.get(
        {} as never,
        mockMessage as never,
      );
      expect(result).not.toBeNull();
      expect(result.text).toContain("Feishu/Lark");
      expect(result.text).toContain("oc_test123");
      expect(result.text).toContain("msg_456");
    });
  });
});
