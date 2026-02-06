import { describe, expect, it } from "vitest";
import {
  extractResourceId,
  getSpaceDisplayName,
  getUserDisplayName,
  GoogleChatApiError,
  GoogleChatAuthenticationError,
  GoogleChatConfigurationError,
  GoogleChatEventTypes,
  GoogleChatPluginError,
  type GoogleChatSpace,
  type GoogleChatUser,
  GOOGLE_CHAT_SERVICE_NAME,
  isDirectMessage,
  isValidGoogleChatSpaceName,
  isValidGoogleChatUserName,
  MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
  normalizeSpaceTarget,
  normalizeUserTarget,
  splitMessageForGoogleChat,
} from "../src/types.js";

describe("GoogleChatTypes", () => {
  describe("Constants", () => {
    it("should have correct max message length", () => {
      expect(MAX_GOOGLE_CHAT_MESSAGE_LENGTH).toBe(4000);
    });

    it("should have correct service name", () => {
      expect(GOOGLE_CHAT_SERVICE_NAME).toBe("google-chat");
    });
  });

  describe("GoogleChatEventTypes", () => {
    it("should have correct event type values", () => {
      expect(GoogleChatEventTypes.MESSAGE_RECEIVED).toBe(
        "GOOGLE_CHAT_MESSAGE_RECEIVED",
      );
      expect(GoogleChatEventTypes.MESSAGE_SENT).toBe(
        "GOOGLE_CHAT_MESSAGE_SENT",
      );
      expect(GoogleChatEventTypes.SPACE_JOINED).toBe(
        "GOOGLE_CHAT_SPACE_JOINED",
      );
      expect(GoogleChatEventTypes.SPACE_LEFT).toBe("GOOGLE_CHAT_SPACE_LEFT");
      expect(GoogleChatEventTypes.REACTION_RECEIVED).toBe(
        "GOOGLE_CHAT_REACTION_RECEIVED",
      );
      expect(GoogleChatEventTypes.REACTION_SENT).toBe(
        "GOOGLE_CHAT_REACTION_SENT",
      );
      expect(GoogleChatEventTypes.WEBHOOK_READY).toBe(
        "GOOGLE_CHAT_WEBHOOK_READY",
      );
      expect(GoogleChatEventTypes.CONNECTION_READY).toBe(
        "GOOGLE_CHAT_CONNECTION_READY",
      );
    });

    it("should have all 8 event types", () => {
      const values = Object.values(GoogleChatEventTypes);
      expect(values.length).toBe(8);
    });
  });

  describe("isValidGoogleChatSpaceName", () => {
    it("should accept valid space names", () => {
      expect(isValidGoogleChatSpaceName("spaces/ABC123")).toBe(true);
      expect(isValidGoogleChatSpaceName("spaces/abc-def")).toBe(true);
      expect(isValidGoogleChatSpaceName("spaces/test_space")).toBe(true);
      expect(isValidGoogleChatSpaceName("spaces/A")).toBe(true);
    });

    it("should reject invalid space names", () => {
      expect(isValidGoogleChatSpaceName("")).toBe(false);
      expect(isValidGoogleChatSpaceName("spaces/")).toBe(false);
      expect(isValidGoogleChatSpaceName("ABC123")).toBe(false);
      expect(isValidGoogleChatSpaceName("users/ABC123")).toBe(false);
      expect(isValidGoogleChatSpaceName("spaces/abc def")).toBe(false);
      expect(isValidGoogleChatSpaceName("spaces/abc/def")).toBe(false);
      expect(isValidGoogleChatSpaceName("spaces/abc.def")).toBe(false);
    });
  });

  describe("isValidGoogleChatUserName", () => {
    it("should accept valid user names", () => {
      expect(isValidGoogleChatUserName("users/ABC123")).toBe(true);
      expect(isValidGoogleChatUserName("users/abc-def")).toBe(true);
      expect(isValidGoogleChatUserName("users/test_user")).toBe(true);
      expect(isValidGoogleChatUserName("users/A")).toBe(true);
    });

    it("should reject invalid user names", () => {
      expect(isValidGoogleChatUserName("")).toBe(false);
      expect(isValidGoogleChatUserName("users/")).toBe(false);
      expect(isValidGoogleChatUserName("ABC123")).toBe(false);
      expect(isValidGoogleChatUserName("spaces/ABC123")).toBe(false);
      expect(isValidGoogleChatUserName("users/abc def")).toBe(false);
      expect(isValidGoogleChatUserName("users/abc/def")).toBe(false);
    });
  });

  describe("normalizeSpaceTarget", () => {
    it("should return full name when already prefixed", () => {
      expect(normalizeSpaceTarget("spaces/ABC123")).toBe("spaces/ABC123");
    });

    it("should prepend spaces/ to bare ID", () => {
      expect(normalizeSpaceTarget("ABC123")).toBe("spaces/ABC123");
      expect(normalizeSpaceTarget("my-space")).toBe("spaces/my-space");
      expect(normalizeSpaceTarget("space_name")).toBe("spaces/space_name");
    });

    it("should return null for empty string", () => {
      expect(normalizeSpaceTarget("")).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      expect(normalizeSpaceTarget("   ")).toBeNull();
    });

    it("should return null for invalid characters", () => {
      expect(normalizeSpaceTarget("abc def")).toBeNull();
      expect(normalizeSpaceTarget("abc/def")).toBeNull();
      expect(normalizeSpaceTarget("abc.def")).toBeNull();
    });

    it("should trim whitespace before processing", () => {
      expect(normalizeSpaceTarget("  spaces/ABC123  ")).toBe("spaces/ABC123");
      expect(normalizeSpaceTarget("  ABC123  ")).toBe("spaces/ABC123");
    });
  });

  describe("normalizeUserTarget", () => {
    it("should return full name when already prefixed", () => {
      expect(normalizeUserTarget("users/ABC123")).toBe("users/ABC123");
    });

    it("should prepend users/ to bare ID", () => {
      expect(normalizeUserTarget("ABC123")).toBe("users/ABC123");
      expect(normalizeUserTarget("user-name")).toBe("users/user-name");
      expect(normalizeUserTarget("user_id")).toBe("users/user_id");
    });

    it("should return null for empty string", () => {
      expect(normalizeUserTarget("")).toBeNull();
    });

    it("should return null for whitespace-only string", () => {
      expect(normalizeUserTarget("   ")).toBeNull();
    });

    it("should return null for invalid characters", () => {
      expect(normalizeUserTarget("abc def")).toBeNull();
      expect(normalizeUserTarget("abc/def")).toBeNull();
    });

    it("should trim whitespace before processing", () => {
      expect(normalizeUserTarget("  users/ABC123  ")).toBe("users/ABC123");
      expect(normalizeUserTarget("  ABC123  ")).toBe("users/ABC123");
    });
  });

  describe("extractResourceId", () => {
    it("should extract ID from space resource name", () => {
      expect(extractResourceId("spaces/ABC123")).toBe("ABC123");
    });

    it("should extract ID from user resource name", () => {
      expect(extractResourceId("users/DEF456")).toBe("DEF456");
    });

    it("should extract ID from message resource name", () => {
      expect(extractResourceId("spaces/ABC/messages/MSG123")).toBe("MSG123");
    });

    it("should extract ID from reaction resource name", () => {
      expect(
        extractResourceId("spaces/ABC/messages/MSG/reactions/RXN1"),
      ).toBe("RXN1");
    });

    it("should return the input if no slashes", () => {
      expect(extractResourceId("standalone")).toBe("standalone");
    });
  });

  describe("getUserDisplayName", () => {
    it("should return display name when set", () => {
      const user: GoogleChatUser = {
        name: "users/ABC123",
        displayName: "John Doe",
      };
      expect(getUserDisplayName(user)).toBe("John Doe");
    });

    it("should fall back to resource ID when display name is missing", () => {
      const user: GoogleChatUser = {
        name: "users/ABC123",
      };
      expect(getUserDisplayName(user)).toBe("ABC123");
    });

    it("should fall back to resource ID when display name is undefined", () => {
      const user: GoogleChatUser = {
        name: "users/XYZ789",
        displayName: undefined,
      };
      expect(getUserDisplayName(user)).toBe("XYZ789");
    });
  });

  describe("getSpaceDisplayName", () => {
    it("should return display name when set", () => {
      const space: GoogleChatSpace = {
        name: "spaces/ABC123",
        displayName: "Engineering Team",
        type: "SPACE",
      };
      expect(getSpaceDisplayName(space)).toBe("Engineering Team");
    });

    it("should fall back to resource ID when display name is missing", () => {
      const space: GoogleChatSpace = {
        name: "spaces/ABC123",
        type: "SPACE",
      };
      expect(getSpaceDisplayName(space)).toBe("ABC123");
    });

    it("should fall back to resource ID when display name is undefined", () => {
      const space: GoogleChatSpace = {
        name: "spaces/DEF456",
        displayName: undefined,
        type: "ROOM",
      };
      expect(getSpaceDisplayName(space)).toBe("DEF456");
    });
  });

  describe("isDirectMessage", () => {
    it("should return true for DM type", () => {
      const space: GoogleChatSpace = {
        name: "spaces/DM123",
        type: "DM",
      };
      expect(isDirectMessage(space)).toBe(true);
    });

    it("should return true for single user bot DM", () => {
      const space: GoogleChatSpace = {
        name: "spaces/BOT123",
        type: "SPACE",
        singleUserBotDm: true,
      };
      expect(isDirectMessage(space)).toBe(true);
    });

    it("should return false for regular space", () => {
      const space: GoogleChatSpace = {
        name: "spaces/SPACE123",
        type: "SPACE",
      };
      expect(isDirectMessage(space)).toBe(false);
    });

    it("should return false for room", () => {
      const space: GoogleChatSpace = {
        name: "spaces/ROOM123",
        type: "ROOM",
      };
      expect(isDirectMessage(space)).toBe(false);
    });

    it("should return false when singleUserBotDm is false", () => {
      const space: GoogleChatSpace = {
        name: "spaces/SPACE456",
        type: "SPACE",
        singleUserBotDm: false,
      };
      expect(isDirectMessage(space)).toBe(false);
    });
  });

  describe("splitMessageForGoogleChat", () => {
    it("should return single chunk for short text", () => {
      const result = splitMessageForGoogleChat("Hello, world!");
      expect(result).toEqual(["Hello, world!"]);
    });

    it("should return single chunk for text at max length", () => {
      const text = "a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
      const result = splitMessageForGoogleChat(text);
      expect(result).toEqual([text]);
    });

    it("should split text exceeding max length", () => {
      const text = "a".repeat(MAX_GOOGLE_CHAT_MESSAGE_LENGTH + 100);
      const result = splitMessageForGoogleChat(text);
      expect(result.length).toBeGreaterThan(1);
    });

    it("should split at newline boundaries when possible", () => {
      const part1 = "a".repeat(2500);
      const part2 = "b".repeat(2500);
      const text = `${part1}\n${part2}`;
      const result = splitMessageForGoogleChat(text, 3000);
      expect(result.length).toBe(2);
      expect(result[0]).toBe(part1);
      expect(result[1]).toBe(part2);
    });

    it("should split at space boundaries when no newline found", () => {
      const words = Array.from({ length: 200 }, () => "word").join(" ");
      const result = splitMessageForGoogleChat(words, 50);
      expect(result.length).toBeGreaterThan(1);
      for (const chunk of result) {
        expect(chunk.length).toBeLessThanOrEqual(50);
      }
    });

    it("should handle empty string", () => {
      const result = splitMessageForGoogleChat("");
      expect(result).toEqual([""]);
    });

    it("should use default max length when not specified", () => {
      const text = "a".repeat(3999);
      const result = splitMessageForGoogleChat(text);
      expect(result.length).toBe(1);
    });

    it("should use custom max length", () => {
      const text = "a".repeat(200);
      const result = splitMessageForGoogleChat(text, 100);
      expect(result.length).toBe(2);
    });

    it("should trim chunks", () => {
      const text = "a".repeat(2500) + "\n" + "b".repeat(2500);
      const result = splitMessageForGoogleChat(text, 3000);
      for (const chunk of result) {
        expect(chunk).toBe(chunk.trim());
      }
    });
  });

  describe("Error Classes", () => {
    describe("GoogleChatPluginError", () => {
      it("should store message, code, and name", () => {
        const error = new GoogleChatPluginError("test error", "TEST_CODE");
        expect(error.message).toBe("test error");
        expect(error.code).toBe("TEST_CODE");
        expect(error.name).toBe("GoogleChatPluginError");
      });

      it("should store cause when provided", () => {
        const cause = new Error("root cause");
        const error = new GoogleChatPluginError(
          "test error",
          "TEST_CODE",
          cause,
        );
        expect(error.cause).toBe(cause);
      });

      it("should be an instance of Error", () => {
        const error = new GoogleChatPluginError("test", "CODE");
        expect(error).toBeInstanceOf(Error);
      });
    });

    describe("GoogleChatConfigurationError", () => {
      it("should have CONFIGURATION_ERROR code", () => {
        const error = new GoogleChatConfigurationError("bad config");
        expect(error.code).toBe("CONFIGURATION_ERROR");
        expect(error.name).toBe("GoogleChatConfigurationError");
      });

      it("should store the setting name", () => {
        const error = new GoogleChatConfigurationError(
          "missing value",
          "GOOGLE_CHAT_AUDIENCE",
        );
        expect(error.setting).toBe("GOOGLE_CHAT_AUDIENCE");
      });

      it("should be an instance of GoogleChatPluginError", () => {
        const error = new GoogleChatConfigurationError("test");
        expect(error).toBeInstanceOf(GoogleChatPluginError);
        expect(error).toBeInstanceOf(Error);
      });

      it("should handle undefined setting name", () => {
        const error = new GoogleChatConfigurationError("test");
        expect(error.setting).toBeUndefined();
      });
    });

    describe("GoogleChatApiError", () => {
      it("should have API_ERROR code", () => {
        const error = new GoogleChatApiError("api failure");
        expect(error.code).toBe("API_ERROR");
        expect(error.name).toBe("GoogleChatApiError");
      });

      it("should store status code", () => {
        const error = new GoogleChatApiError("not found", 404);
        expect(error.statusCode).toBe(404);
      });

      it("should be an instance of GoogleChatPluginError", () => {
        const error = new GoogleChatApiError("test");
        expect(error).toBeInstanceOf(GoogleChatPluginError);
      });

      it("should handle common HTTP status codes", () => {
        const e400 = new GoogleChatApiError("bad request", 400);
        expect(e400.statusCode).toBe(400);

        const e401 = new GoogleChatApiError("unauthorized", 401);
        expect(e401.statusCode).toBe(401);

        const e403 = new GoogleChatApiError("forbidden", 403);
        expect(e403.statusCode).toBe(403);

        const e500 = new GoogleChatApiError("server error", 500);
        expect(e500.statusCode).toBe(500);
      });
    });

    describe("GoogleChatAuthenticationError", () => {
      it("should have AUTHENTICATION_ERROR code", () => {
        const error = new GoogleChatAuthenticationError("auth failed");
        expect(error.code).toBe("AUTHENTICATION_ERROR");
        expect(error.name).toBe("GoogleChatAuthenticationError");
      });

      it("should be an instance of GoogleChatPluginError", () => {
        const error = new GoogleChatAuthenticationError("test");
        expect(error).toBeInstanceOf(GoogleChatPluginError);
        expect(error).toBeInstanceOf(Error);
      });

      it("should store cause when provided", () => {
        const cause = new Error("token expired");
        const error = new GoogleChatAuthenticationError("auth failed", cause);
        expect(error.cause).toBe(cause);
      });
    });
  });
});
