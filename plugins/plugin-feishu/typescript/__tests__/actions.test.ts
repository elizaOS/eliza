import { describe, expect, it } from "vitest";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "../src/actions";

describe("SendMessageAction", () => {
  describe("metadata", () => {
    it("should have correct action name", () => {
      expect(SEND_MESSAGE_ACTION).toBe("SEND_FEISHU_MESSAGE");
      expect(sendMessageAction.name).toBe(SEND_MESSAGE_ACTION);
    });

    it("should have similes including common variations", () => {
      expect(sendMessageAction.similes).toContain("FEISHU_SEND_MESSAGE");
      expect(sendMessageAction.similes).toContain("FEISHU_REPLY");
      expect(sendMessageAction.similes).toContain("LARK_SEND_MESSAGE");
    });

    it("should have a description", () => {
      expect(sendMessageAction.description).toBeTruthy();
      expect(sendMessageAction.description.length).toBeGreaterThan(0);
    });

    it("should have examples", () => {
      expect(sendMessageAction.examples).toBeDefined();
      expect(sendMessageAction.examples.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should return true for feishu source", async () => {
      const mockMessage = {
        content: {
          source: "feishu",
        },
      };

      const result = await sendMessageAction.validate(
        {} as never,
        mockMessage as never,
      );
      expect(result).toBe(true);
    });

    it("should return false for non-feishu source", async () => {
      const mockMessage = {
        content: {
          source: "telegram",
        },
      };

      const result = await sendMessageAction.validate(
        {} as never,
        mockMessage as never,
      );
      expect(result).toBe(false);
    });

    it("should return false for undefined source", async () => {
      const mockMessage = {
        content: {},
      };

      const result = await sendMessageAction.validate(
        {} as never,
        mockMessage as never,
      );
      expect(result).toBe(false);
    });
  });
});
