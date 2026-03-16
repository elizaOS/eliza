import { describe, expect, it } from "vitest";
import { FeishuChatType, FeishuEventTypes } from "../src/types";

describe("FeishuTypes", () => {
  describe("FeishuEventTypes", () => {
    it("should have correct event type values", () => {
      expect(FeishuEventTypes.WORLD_JOINED).toBe("FEISHU_WORLD_JOINED");
      expect(FeishuEventTypes.WORLD_CONNECTED).toBe("FEISHU_WORLD_CONNECTED");
      expect(FeishuEventTypes.WORLD_LEFT).toBe("FEISHU_WORLD_LEFT");
      expect(FeishuEventTypes.ENTITY_JOINED).toBe("FEISHU_ENTITY_JOINED");
      expect(FeishuEventTypes.ENTITY_LEFT).toBe("FEISHU_ENTITY_LEFT");
      expect(FeishuEventTypes.MESSAGE_RECEIVED).toBe("FEISHU_MESSAGE_RECEIVED");
      expect(FeishuEventTypes.MESSAGE_SENT).toBe("FEISHU_MESSAGE_SENT");
    });
  });

  describe("FeishuChatType", () => {
    it("should have correct chat type values", () => {
      expect(FeishuChatType.P2P).toBe("p2p");
      expect(FeishuChatType.GROUP).toBe("group");
    });
  });
});
