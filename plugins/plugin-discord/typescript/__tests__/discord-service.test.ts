import { describe, expect, it } from "vitest";
import {
  DISCORD_SERVICE_NAME,
  DiscordApiError,
  DiscordClientNotAvailableError,
  DiscordConfigurationError,
  DiscordEventTypes,
  DiscordPluginError,
  DiscordServiceNotInitializedError,
  type DiscordSettings,
  isValidSnowflake,
  validateSnowflake,
} from "../types";

/**
 * Tests for Discord service types and utilities.
 * These tests verify type definitions and utility functions without mocking.
 */
describe("Discord Service Types", () => {
  describe("DISCORD_SERVICE_NAME", () => {
    it("should have correct value", () => {
      expect(DISCORD_SERVICE_NAME).toBe("discord");
    });
  });

  describe("DiscordEventTypes", () => {
    it("should have MESSAGE_RECEIVED event", () => {
      expect(DiscordEventTypes.MESSAGE_RECEIVED).toBe("DISCORD_MESSAGE_RECEIVED");
    });

    it("should have MESSAGE_SENT event", () => {
      expect(DiscordEventTypes.MESSAGE_SENT).toBe("DISCORD_MESSAGE_SENT");
    });

    it("should have SLASH_COMMAND event", () => {
      expect(DiscordEventTypes.SLASH_COMMAND).toBe("DISCORD_SLASH_COMMAND");
    });

    it("should have REACTION_RECEIVED event", () => {
      expect(DiscordEventTypes.REACTION_RECEIVED).toBe("DISCORD_REACTION_RECEIVED");
    });

    it("should have WORLD_JOINED event", () => {
      expect(DiscordEventTypes.WORLD_JOINED).toBe("DISCORD_WORLD_JOINED");
    });

    it("should have ENTITY_JOINED event", () => {
      expect(DiscordEventTypes.ENTITY_JOINED).toBe("DISCORD_USER_JOINED");
    });

    it("should have VOICE_STATE_CHANGED event", () => {
      expect(DiscordEventTypes.VOICE_STATE_CHANGED).toBe("DISCORD_VOICE_STATE_CHANGED");
    });

    it("should have permission audit events", () => {
      expect(DiscordEventTypes.CHANNEL_PERMISSIONS_CHANGED).toBe(
        "DISCORD_CHANNEL_PERMISSIONS_CHANGED"
      );
      expect(DiscordEventTypes.ROLE_PERMISSIONS_CHANGED).toBe("DISCORD_ROLE_PERMISSIONS_CHANGED");
      expect(DiscordEventTypes.MEMBER_ROLES_CHANGED).toBe("DISCORD_MEMBER_ROLES_CHANGED");
      expect(DiscordEventTypes.ROLE_CREATED).toBe("DISCORD_ROLE_CREATED");
      expect(DiscordEventTypes.ROLE_DELETED).toBe("DISCORD_ROLE_DELETED");
    });
  });

  describe("validateSnowflake", () => {
    it("should validate correct 17-digit snowflake", () => {
      const snowflake = validateSnowflake("12345678901234567");
      expect(snowflake).toBe("12345678901234567");
    });

    it("should validate correct 18-digit snowflake", () => {
      const snowflake = validateSnowflake("123456789012345678");
      expect(snowflake).toBe("123456789012345678");
    });

    it("should validate correct 19-digit snowflake", () => {
      const snowflake = validateSnowflake("1234567890123456789");
      expect(snowflake).toBe("1234567890123456789");
    });

    it("should throw for too short snowflake", () => {
      expect(() => validateSnowflake("1234567890123456")).toThrow(DiscordPluginError);
    });

    it("should throw for too long snowflake", () => {
      expect(() => validateSnowflake("12345678901234567890")).toThrow(DiscordPluginError);
    });

    it("should throw for snowflake with letters", () => {
      expect(() => validateSnowflake("1234567890123456a")).toThrow(DiscordPluginError);
    });

    it("should throw for empty snowflake", () => {
      expect(() => validateSnowflake("")).toThrow(DiscordPluginError);
    });
  });

  describe("isValidSnowflake", () => {
    it("should return true for valid snowflakes", () => {
      expect(isValidSnowflake("12345678901234567")).toBe(true);
      expect(isValidSnowflake("123456789012345678")).toBe(true);
      expect(isValidSnowflake("1234567890123456789")).toBe(true);
    });

    it("should return false for invalid snowflakes", () => {
      expect(isValidSnowflake("1234567890123456")).toBe(false);
      expect(isValidSnowflake("12345678901234567890")).toBe(false);
      expect(isValidSnowflake("1234567890123456a")).toBe(false);
      expect(isValidSnowflake("")).toBe(false);
    });
  });

  describe("Error classes", () => {
    it("should create DiscordPluginError with message and code", () => {
      const error = new DiscordPluginError("Test error", "TEST_CODE");
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("DiscordPluginError");
    });

    it("should create DiscordServiceNotInitializedError", () => {
      const error = new DiscordServiceNotInitializedError();
      expect(error.message).toBe("Discord service is not initialized");
      expect(error.code).toBe("SERVICE_NOT_INITIALIZED");
      expect(error.name).toBe("DiscordServiceNotInitializedError");
    });

    it("should create DiscordClientNotAvailableError", () => {
      const error = new DiscordClientNotAvailableError();
      expect(error.message).toBe("Discord client is not available");
      expect(error.code).toBe("CLIENT_NOT_AVAILABLE");
      expect(error.name).toBe("DiscordClientNotAvailableError");
    });

    it("should create DiscordConfigurationError", () => {
      const error = new DiscordConfigurationError("DISCORD_API_TOKEN");
      expect(error.message).toBe("Missing required configuration: DISCORD_API_TOKEN");
      expect(error.code).toBe("MISSING_CONFIG");
      expect(error.name).toBe("DiscordConfigurationError");
    });

    it("should create DiscordApiError", () => {
      const error = new DiscordApiError("API call failed", 50001);
      expect(error.message).toBe("API call failed");
      expect(error.code).toBe("API_ERROR");
      expect(error.apiErrorCode).toBe(50001);
      expect(error.name).toBe("DiscordApiError");
    });

    it("errors should be instances of Error", () => {
      expect(new DiscordPluginError("test", "code")).toBeInstanceOf(Error);
      expect(new DiscordServiceNotInitializedError()).toBeInstanceOf(Error);
      expect(new DiscordClientNotAvailableError()).toBeInstanceOf(Error);
      expect(new DiscordConfigurationError("test")).toBeInstanceOf(Error);
      expect(new DiscordApiError("test")).toBeInstanceOf(Error);
    });
  });

  describe("DiscordSettings type", () => {
    it("should allow creating settings with all optional fields", () => {
      const settings: DiscordSettings = {
        allowedChannelIds: ["123456789012345678"],
        shouldIgnoreBotMessages: true,
        shouldIgnoreDirectMessages: false,
        shouldRespondOnlyToMentions: true,
      };

      expect(settings.allowedChannelIds).toEqual(["123456789012345678"]);
      expect(settings.shouldIgnoreBotMessages).toBe(true);
    });

    it("should allow creating empty settings", () => {
      const settings: DiscordSettings = {};
      expect(settings.allowedChannelIds).toBeUndefined();
      expect(settings.shouldIgnoreBotMessages).toBeUndefined();
    });
  });
});
