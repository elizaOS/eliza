import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { generateRequestId, logger } from "../lib/logger";

describe("logger", () => {
  let consoleLogSpy: MockInstance<typeof console.log>;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let consoleWarnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("log output format", () => {
    it("outputs valid JSON", () => {
      logger.info("test message");

      expect(consoleLogSpy).toHaveBeenCalledOnce();
      const output = consoleLogSpy.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it("includes required fields", () => {
      logger.info("test message");

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output).toHaveProperty("level", "info");
      expect(output).toHaveProperty("message", "test message");
      expect(output).toHaveProperty("timestamp");
      expect(output).toHaveProperty("service", "soulmates");
    });

    it("includes context when provided", () => {
      logger.info("test", { userId: "123", action: "login" });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.context).toEqual({ userId: "123", action: "login" });
    });

    it("includes requestId when provided", () => {
      logger.info("test", { foo: "bar" }, "req-123");

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.requestId).toBe("req-123");
    });

    it("omits requestId when not provided", () => {
      logger.info("test");

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.requestId).toBeUndefined();
    });
  });

  describe("log levels", () => {
    it("uses console.log for debug", () => {
      logger.debug("debug message");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it("uses console.log for info", () => {
      logger.info("info message");
      expect(consoleLogSpy).toHaveBeenCalledOnce();
    });

    it("uses console.warn for warn", () => {
      logger.warn("warn message");
      expect(consoleWarnSpy).toHaveBeenCalledOnce();
    });

    it("uses console.error for error", () => {
      logger.error("error message");
      expect(consoleErrorSpy).toHaveBeenCalledOnce();
    });
  });

  describe("timestamp", () => {
    it("uses ISO 8601 format", () => {
      logger.info("test");

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(output.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/,
      );
    });
  });
});

describe("generateRequestId", () => {
  it("returns 8 character string", () => {
    const id = generateRequestId();
    expect(id).toHaveLength(8);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });

  it("contains only hex characters", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });
});
