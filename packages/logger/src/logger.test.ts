/**
 * Tests for the structured logger: the in-memory ring buffer (`recentLogs`),
 * the chat/prompt/response tap helpers, and add/remove listener fan-out.
 * Pure unit test — `createLogger` writes to an in-memory buffer, no I/O.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __loggerTestHooks,
  addLogListener,
  createLogger,
  type LogEntry,
  logChatIn,
  logChatOut,
  logPrompt,
  logResponse,
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

  it("isolates listener failures and continues fan-out", () => {
    const logger = bufferLogger();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const throwingListener = vi.fn<(entry: LogEntry) => void>(() => {
      throw new Error("listener-failed");
    });
    const laterListener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribeThrowing = addLogListener(throwingListener);
    const unsubscribeLater = addLogListener(laterListener);

    try {
      expect(() => {
        logger.info("isolated-entry");
        logger.warn("second-isolated-entry");
      }).not.toThrow();

      expect(throwingListener.mock.calls.length).toBeGreaterThan(0);
      expect(laterListener).toHaveBeenCalledTimes(
        throwingListener.mock.calls.length,
      );
      expect(laterListener.mock.calls).toContainEqual([
        expect.objectContaining({ msg: "isolated-entry" }),
      ]);
      expect(laterListener.mock.calls).toContainEqual([
        expect.objectContaining({ msg: "second-isolated-entry" }),
      ]);
      expect(recentLogs()).toContain("isolated-entry");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[logger] log listener failed; continuing fan-out and suppressing further errors from this listener",
      );
    } finally {
      unsubscribeThrowing();
      unsubscribeLater();
    }
  });

  it("does not rethrow when the fallback warning sink fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("console-failed");
    });
    const unsubscribeThrowing = addLogListener(() => {
      throw new Error("listener-failed");
    });
    const laterListener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribeLater = addLogListener(laterListener);

    try {
      expect(() => bufferLogger().info("sink-failure-entry")).not.toThrow();
      expect(laterListener.mock.calls.length).toBeGreaterThan(0);
    } finally {
      unsubscribeThrowing();
      unsubscribeLater();
    }
  });

  it("invokes a listener at most once per entry when it re-registers itself", () => {
    const logger = bufferLogger();
    const mutatingListener = vi.fn<(entry: LogEntry) => void>(() => {
      removeLogListener(mutatingListener);
      addLogListener(mutatingListener);
    });
    const laterListener = vi.fn<(entry: LogEntry) => void>();
    addLogListener(mutatingListener);
    addLogListener(laterListener);

    try {
      expect(() => logger.info("mutating-listener-entry")).not.toThrow();
      const deliveredEntries = mutatingListener.mock.calls.map(
        ([entry]) => entry,
      );
      expect(new Set(deliveredEntries).size).toBe(deliveredEntries.length);
      expect(laterListener).toHaveBeenCalledTimes(deliveredEntries.length);
    } finally {
      removeLogListener(mutatingListener);
      removeLogListener(laterListener);
    }
  });

  it("does not reset warning suppression for a duplicate active listener", () => {
    const logger = bufferLogger();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const throwingListener = () => {
      throw new Error("listener-failed");
    };
    const unsubscribe = addLogListener(throwingListener);

    try {
      logger.info("first-failure");
      addLogListener(throwingListener);
      logger.info("second-failure");
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("resets warning suppression after unsubscribe and re-register", () => {
    const logger = bufferLogger();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const throwingListener = () => {
      throw new Error("listener-failed");
    };
    const unsubscribeFirst = addLogListener(throwingListener);

    try {
      logger.info("first-registration-failure");
      unsubscribeFirst();
      addLogListener(throwingListener);
      logger.info("second-registration-failure");
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      removeLogListener(throwingListener);
    }
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

  it("keeps the public prompt/chat instrumentation helpers available", () => {
    expect(logPrompt("text", "hello")).toBe("");
    expect(logResponse("text", "world")).toBe("");
    expect(
      logChatIn({
        agentName: "Eliza",
        agentId: "agent-1",
        roomId: "room-123456789",
        messageId: "message-123456789",
        text: 'hello "there"',
        source: "test",
      }),
    ).toContain(
      '[CHAT:IN]  #agent:Eliza room=room-123 msg=message- source=test "hello \\"there\\""',
    );
    expect(
      logChatOut({
        agentName: "Eliza",
        agentId: "agent-1",
        roomId: "room-123456789",
        action: "reply",
        text: "done",
        providers: ["test-provider"],
      }),
    ).toContain(
      '[CHAT:OUT] #agent:Eliza room=room-123 action=reply len=4 "done" providers=test-provider',
    );
  });
});

// #16356: the file-log path's stripAnsi built an invalid regex (an extra escape
// level made `\\(B` an unterminated group), so `new RegExp` threw on every call
// and output.log silently stayed empty. Guard the regex compiles and strips.
describe("stripAnsi", () => {
  const { stripAnsi } = __loggerTestHooks;

  it("compiles a valid regex and never throws", () => {
    expect(() => stripAnsi("plain text")).not.toThrow();
  });

  it("strips SGR color sequences", () => {
    expect(stripAnsi("\x1b[36mInfo\x1b[39m hi")).toBe("Info hi");
  });

  it("strips an OSC sequence terminated by BEL", () => {
    expect(stripAnsi("\x1b]0;window title\x07rest")).toBe("rest");
  });

  it("leaves text with no escape sequences unchanged", () => {
    expect(stripAnsi("no ansi here")).toBe("no ansi here");
  });
});
