import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parentPort: { postMessage: vi.fn() } as {
    postMessage: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("node:worker_threads", () => ({ parentPort: mocks.parentPort }));

import { logger } from "./worker-logger";

beforeEach(() => {
  mocks.parentPort.postMessage.mockClear();
});

describe("worker-logger with parentPort", () => {
  it("posts a structured log message with level/message/args/timestamp", () => {
    logger.info("hello", 42, { key: "value" });
    expect(mocks.parentPort.postMessage).toHaveBeenCalledTimes(1);
    const [payload] = mocks.parentPort.postMessage.mock.calls[0];
    expect(payload.type).toBe("log");
    expect(payload.level).toBe("info");
    expect(payload.message).toBe("hello");
    expect(payload.args).toEqual([42, { key: "value" }]);
    // timestamp must be a valid ISO-8601 instant
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
  });

  it("does not fall back to the console when parentPort exists", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello", 42);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("uses the correct level for warn/error/debug", () => {
    logger.warn("w1", 1);
    logger.error("e1", 2);
    logger.debug("d1", 3);
    const calls = mocks.parentPort.postMessage.mock.calls.map(
      ([payload]) => payload.level,
    );
    expect(calls).toEqual(["warn", "error", "debug"]);
  });
});

describe("worker-logger without parentPort", () => {
  it("falls back to console.log with [INFO] prefix and args", async () => {
    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ parentPort: null }));
    const mod = await import("./worker-logger");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    mod.logger.info("hello", 42);
    expect(spy).toHaveBeenCalledWith("[INFO] hello", 42);
    spy.mockRestore();
  });

  it("falls back to console.warn/error/debug with level prefixes", async () => {
    vi.resetModules();
    vi.doMock("node:worker_threads", () => ({ parentPort: null }));
    const mod = await import("./worker-logger");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    mod.logger.warn("w1");
    mod.logger.error("e1");
    mod.logger.debug("d1");
    expect(warn).toHaveBeenCalledWith("[WARN] w1");
    expect(error).toHaveBeenCalledWith("[ERROR] e1");
    expect(debug).toHaveBeenCalledWith("[DEBUG] d1");
    warn.mockRestore();
    error.mockRestore();
    debug.mockRestore();
  });
});
