/**
 * Tests for Instagram UserState provider
 */

import { describe, expect, it } from "vitest";
import { userStateProvider } from "../user-state";

describe("userStateProvider", () => {
  describe("metadata", () => {
    it("should have correct name", () => {
      expect(userStateProvider.name).toBe("instagram_user_state");
    });

    it("should have description", () => {
      expect(userStateProvider.description).toBeTruthy();
      expect(userStateProvider.description).toContain("Instagram");
    });
  });

  describe("get", () => {
    it("should return user state for DM context", async () => {
      const mockRuntime = {};
      const mockMessage = {
        roomId: "room-uuid-123",
        content: {
          userId: 12345,
          threadId: "thread-1",
        },
      };

      // @ts-expect-error - partial mock
      const result = await userStateProvider.get(mockRuntime, mockMessage, {});

      // Result is a ProviderResult with text, values, and data
      expect(result.data).toBeDefined();
      const state = result.data as Record<string, unknown>;
      expect(state.user_id).toBe(12345);
      expect(state.thread_id).toBe("thread-1");
      expect(state.is_dm).toBe(true);
      expect(state.is_comment).toBe(false);
    });

    it("should return user state for comment context", async () => {
      const mockRuntime = {};
      const mockMessage = {
        roomId: "room-uuid-123",
        content: {
          userId: 12345,
          mediaId: 67890,
        },
      };

      // @ts-expect-error - partial mock
      const result = await userStateProvider.get(mockRuntime, mockMessage, {});

      expect(result.data).toBeDefined();
      const state = result.data as Record<string, unknown>;
      expect(state.user_id).toBe(12345);
      expect(state.media_id).toBe(67890);
      expect(state.is_dm).toBe(false);
      expect(state.is_comment).toBe(true);
    });

    it("should handle missing context", async () => {
      const mockRuntime = {};
      const mockMessage = {
        roomId: "room-uuid-123",
        content: {},
      };

      // @ts-expect-error - partial mock
      const result = await userStateProvider.get(mockRuntime, mockMessage, {});

      expect(result.data).toBeDefined();
      const state = result.data as Record<string, unknown>;
      expect(state.user_id).toBeNull();
      expect(state.thread_id).toBeNull();
      expect(state.is_dm).toBe(false);
      expect(state.is_comment).toBe(false);
    });
  });
});
