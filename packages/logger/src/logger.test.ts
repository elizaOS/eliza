/**
 * Tests for the structured logger: the in-memory ring buffer (`recentLogs`),
 * the chat/prompt/response tap helpers, and add/remove listener fan-out.
 * Pure unit test — `createLogger` writes to an in-memory buffer, no I/O.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("strips an OSC sequence terminated by ST", () => {
    expect(stripAnsi("\x1b]0;window title\x1b\\rest")).toBe("rest");
  });

  it("strips a standalone charset reset", () => {
    expect(stripAnsi("\x1b(Bhello")).toBe("hello");
  });

  it("does not treat a charset reset inside OSC payload as its terminator", () => {
    expect(stripAnsi("\x1b]0;foo(Bbar\x07rest")).toBe("rest");
  });

  it("leaves text with no escape sequences unchanged", () => {
    expect(stripAnsi("no ansi here")).toBe("no ansi here");
  });

  it("writes ANSI-free messages to the configured log file", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-logger-"));
    const logPath = join(directory, "output.log");
    const previousLogFile = process.env.LOG_FILE;

    try {
      process.env.LOG_FILE = logPath;
      __loggerTestHooks.resetFileLogForTests();

      createLogger({ level: "info" }).info(
        { src: "file-test" },
        "\x1b[36mwritten\x1b[39m once",
      );

      const contents = readFileSync(logPath, "utf8");
      expect(contents).toContain("[INFO    ] [FILE-TEST] written once");
      expect(contents).not.toContain("\x1b");
    } finally {
      __loggerTestHooks.resetFileLogForTests();
      if (previousLogFile === undefined) delete process.env.LOG_FILE;
      else process.env.LOG_FILE = previousLogFile;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
