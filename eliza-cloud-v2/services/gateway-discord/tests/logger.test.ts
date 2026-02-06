/**
 * Logger Unit Tests
 *
 * Tests for services/gateway-discord/src/logger.ts
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// Store original env
const originalEnv = { ...process.env };

describe("logger", () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
    // Spy on console methods
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    // Clear module cache to reload with new env
    const modulePath = require.resolve("../src/logger");
    delete require.cache[modulePath];
  });

  describe("log level filtering", () => {
    test("debug level logs all messages", async () => {
      process.env.LOG_LEVEL = "debug";
      const { logger } = await import("../src/logger");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(2); // debug + info
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("info level filters debug messages", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only info
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("warn level filters debug and info messages", async () => {
      process.env.LOG_LEVEL = "warn";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("error level only logs errors", async () => {
      process.env.LOG_LEVEL = "error";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");
      logger.error("error message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(0);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(0);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    test("defaults to info level when LOG_LEVEL not set", async () => {
      delete process.env.LOG_LEVEL;
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.debug("debug message");
      logger.info("info message");

      expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only info, not debug
    });
  });

  describe("message formatting", () => {
    test("formats message as JSON with timestamp, level, and message", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.info("test message");

      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed).toHaveProperty("timestamp");
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("test message");
      // Verify timestamp is valid ISO string
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    test("includes metadata in formatted message", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.info("test message", { connectionId: "conn-123", count: 42 });

      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.connectionId).toBe("conn-123");
      expect(parsed.count).toBe(42);
    });

    test("warn logs to console.warn", async () => {
      process.env.LOG_LEVEL = "warn";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.warn("warning message", { reason: "test" });

      const call = consoleWarnSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.level).toBe("warn");
      expect(parsed.message).toBe("warning message");
      expect(parsed.reason).toBe("test");
    });

    test("error logs to console.error", async () => {
      process.env.LOG_LEVEL = "error";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.error("error message", { error: "something went wrong" });

      const call = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("error message");
      expect(parsed.error).toBe("something went wrong");
    });
  });

  describe("edge cases", () => {
    test("handles undefined metadata", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.info("message without meta");

      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.timestamp).toBeDefined();
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("message without meta");
    });

    test("handles empty metadata object", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.info("message with empty meta", {});

      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.message).toBe("message with empty meta");
    });

    test("handles complex nested metadata", async () => {
      process.env.LOG_LEVEL = "info";
      const modulePath = require.resolve("../src/logger");
      delete require.cache[modulePath];
      const { logger } = await import("../src/logger");

      logger.info("complex meta", {
        nested: { deep: { value: true } },
        array: [1, 2, 3],
      });

      const call = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(call);

      expect(parsed.nested.deep.value).toBe(true);
      expect(parsed.array).toEqual([1, 2, 3]);
    });
  });
});
