import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addLogListener,
  createLogger,
  type LogEntry,
  recentLogs,
  removeLogListener,
} from "./logger";

describe("logger", () => {
  const bufferLogger = () => createLogger({ level: "info" });

  afterEach(() => {
    bufferLogger().clear();
    vi.restoreAllMocks();
  });

  it("captures recent logs with formatted context", () => {
    const logger = bufferLogger();

    logger.info({ src: "logger-test", requestId: "abc" }, "hello");

    expect(recentLogs()).toContain("info [LOGGER-TEST] hello (requestId=abc)");
  });

  it("removes log listeners through the unsubscribe function", () => {
    const logger = bufferLogger();
    const listener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribe = addLogListener(listener);

    logger.info("first");
    const deliveredBeforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    logger.info("second");

    expect(deliveredBeforeUnsubscribe).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(deliveredBeforeUnsubscribe);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ msg: "first" });
  });

  it("removes log listeners through removeLogListener", () => {
    const logger = bufferLogger();
    const listener = vi.fn<(entry: LogEntry) => void>();

    addLogListener(listener);
    removeLogListener(listener);
    logger.info("not delivered");

    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves forced browser mode for child loggers", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({
      level: "info",
      namespace: "parent",
      __forceType: "browser",
    });

    logger
      .child({ namespace: "child" })
      .info({ src: "browser-test" }, "child message");

    expect(consoleInfo).toHaveBeenCalledWith("[BROWSER-TEST] child message");
  });
});
