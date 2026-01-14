/**
 * Tests for Instagram SendDm action
 */

import { describe, expect, it } from "vitest";
import { sendDmAction } from "../send-dm";

describe("sendDmAction", () => {
  describe("metadata", () => {
    it("should have correct name", () => {
      expect(sendDmAction.name).toBe("SEND_INSTAGRAM_DM");
    });

    it("should have description", () => {
      expect(sendDmAction.description).toBeTruthy();
      expect(sendDmAction.description).toContain("Instagram");
    });

    it("should have similes", () => {
      expect(sendDmAction.similes).toBeDefined();
      expect(sendDmAction.similes?.length).toBeGreaterThan(0);
      expect(sendDmAction.similes).toContain("instagram_dm");
    });

    it("should have examples", () => {
      expect(sendDmAction.examples).toBeDefined();
      expect(sendDmAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    it("should return false for non-Instagram source", async () => {
      const mockRuntime = {
        getService: () => null,
      };

      const mockMessage = {
        content: {
          source: "telegram",
          threadId: "thread-123",
        },
      };

      // @ts-expect-error - partial mock
      const result = await sendDmAction.validate(mockRuntime, mockMessage, {});
      expect(result).toBe(false);
    });

    it("should return false without thread ID", async () => {
      const mockRuntime = {
        getService: () => ({ getIsRunning: () => true }),
      };

      const mockMessage = {
        content: {
          source: "instagram",
        },
      };

      // @ts-expect-error - partial mock
      const result = await sendDmAction.validate(mockRuntime, mockMessage, {});
      expect(result).toBe(false);
    });
  });
});
