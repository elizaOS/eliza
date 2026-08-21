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
  logger as sharedLogger,
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

  it("skips a later listener removed during the current delivery", () => {
    const logger = bufferLogger();
    const laterListener = vi.fn<(entry: LogEntry) => void>();
    const removingListener = vi.fn<(entry: LogEntry) => void>(() => {
      removeLogListener(laterListener);
    });
    addLogListener(removingListener);
    addLogListener(laterListener);

    try {
      logger.info("removed-before-turn");

      expect(removingListener.mock.calls.length).toBeGreaterThan(0);
      expect(laterListener).not.toHaveBeenCalled();
    } finally {
      removeLogListener(removingListener);
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

  it("dispatches singleton, factory, and child logs exactly once", () => {
    const factoryLogger = createLogger({
      level: "trace",
      namespace: "factory",
    });
    const childLogger = factoryLogger.child({ namespace: "child" });
    const listener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribe = addLogListener(listener);
    const cases = [
      {
        marker: "single-dispatch-shared-fatal",
        priority: 60,
        write: () => sharedLogger.fatal("single-dispatch-shared-fatal"),
      },
      {
        marker: "single-dispatch-factory-info",
        priority: 30,
        write: () => factoryLogger.info("single-dispatch-factory-info"),
      },
      {
        marker: "single-dispatch-child-warn",
        priority: 40,
        write: () => childLogger.warn("single-dispatch-child-warn"),
      },
    ];

    try {
      for (const { marker, priority, write } of cases) {
        const deliveriesBefore = listener.mock.calls.length;
        write();
        expect(listener.mock.calls).toHaveLength(deliveriesBefore + 1);
        expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
          level: priority,
          msg: expect.stringContaining(marker),
        });
        expect(
          recentLogs()
            .split("\n")
            .filter((line) => line.includes(marker)),
        ).toHaveLength(1);
      }
    } finally {
      unsubscribe();
    }
  });

  it("dispatches every public level once with its Pino priority", () => {
    const logger = createLogger({ level: "trace" });
    const listener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribe = addLogListener(listener);
    const levels = [
      ["trace", 10],
      ["debug", 20],
      ["success", 27],
      ["progress", 28],
      ["log", 29],
      ["info", 30],
      ["warn", 40],
      ["error", 50],
      ["fatal", 60],
    ] as const;

    try {
      for (const [method, priority] of levels) {
        const marker = `single-dispatch-level-${method}`;
        const deliveriesBefore = listener.mock.calls.length;
        logger[method](marker);
        expect(listener.mock.calls).toHaveLength(deliveriesBefore + 1);
        expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
          level: priority,
          msg: marker,
        });
        expect(
          recentLogs()
            .split("\n")
            .filter((line) => line.includes(marker)),
        ).toHaveLength(1);
      }
    } finally {
      unsubscribe();
    }
  });

  it("dispatches structured and Error overloads exactly once", () => {
    const logger = createLogger({ level: "trace", namespace: "overload" });
    const child = logger.child({ namespace: "overload-child" });
    const listener = vi.fn<(entry: LogEntry) => void>();
    const unsubscribe = addLogListener(listener);
    const cases = [
      {
        marker: "single-dispatch-structured",
        priority: 30,
        write: () =>
          logger.info(
            { src: "logger-test", requestId: "structured" },
            "single-dispatch-structured",
          ),
      },
      {
        marker: "single-dispatch-error-overload",
        priority: 50,
        write: () =>
          child.error(
            new Error("single-dispatch-error-overload"),
            "error context",
          ),
      },
    ];

    try {
      for (const { marker, priority, write } of cases) {
        const deliveriesBefore = listener.mock.calls.length;
        write();
        expect(listener.mock.calls).toHaveLength(deliveriesBefore + 1);
        expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
          level: priority,
          msg: expect.stringContaining(marker),
        });
        expect(
          recentLogs()
            .split("\n")
            .filter((line) => line.includes(marker)),
        ).toHaveLength(1);
      }
    } finally {
      unsubscribe();
    }
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

// #23217: `maxMemoryLogs` on LoggerBindings must resize the shared in-memory
// ring buffer in place instead of destructively clearing it. Prior code only
// called `.clear()` (never resized), so the documented option wiped every other
// logger's recent-log history and left retention hardcoded at 100. The buffer
// is a process-wide singleton, so these assertions cover both the sizing
// contract and the no-wipe invariant.
describe("in-memory buffer retention (maxMemoryLogs)", () => {
  const lineCount = (s: string): number =>
    s === "" ? 0 : s.split("\n").length;

  afterEach(() => {
    // Restore the process-wide default cap and empty the shared singleton so
    // later suites observe the original 100-entry buffer.
    createLogger({ level: "info", maxMemoryLogs: 100 });
    createLogger({ level: "info" }).clear();
    vi.restoreAllMocks();
  });

  it("bounds retention to the requested cap and evicts oldest entries", () => {
    const logger = createLogger({ level: "info", maxMemoryLogs: 3 });
    logger.clear();
    for (let i = 0; i < 8; i++) logger.info(`entry-${i}`);
    const logs = recentLogs();
    expect(lineCount(logs)).toBeLessThanOrEqual(3);
    expect(logs).toContain("entry-7");
    expect(logs).not.toContain("entry-0");
  });

  it("does not wipe the shared buffer when a sized logger is constructed", () => {
    const base = createLogger({ level: "info", maxMemoryLogs: 100 });
    base.clear();
    base.info("prior-A");
    base.info("prior-B");
    const before = recentLogs();
    expect(before).toContain("prior-A");
    expect(before).toContain("prior-B");

    // Constructing a sized logger must preserve the earlier history.
    createLogger({ level: "info", maxMemoryLogs: 5 });
    const after = recentLogs();
    expect(after).toContain("prior-A");
    expect(after).toContain("prior-B");
  });

  it("raising the cap retains all entries up to the new size", () => {
    const logger = createLogger({ level: "info", maxMemoryLogs: 200 });
    logger.clear();
    for (let i = 0; i < 150; i++) logger.info(`n-${i}`);
    expect(lineCount(recentLogs())).toBe(150);
  });

  it("keeps the default 100 cap when maxMemoryLogs is omitted", () => {
    // Reset to the documented default, then build a logger that omits the field.
    createLogger({ level: "info", maxMemoryLogs: 100 });
    const logger = createLogger({ level: "info" });
    logger.clear();
    for (let i = 0; i < 130; i++) logger.info(`d-${i}`);
    expect(lineCount(recentLogs())).toBe(100);
  });

  it("ignores invalid caps without clearing the buffer or disabling retention", () => {
    const logger = createLogger({ level: "info", maxMemoryLogs: 4 });
    logger.clear();
    for (let i = 0; i < 4; i++) logger.info(`keep-${i}`);
    const before = recentLogs();
    expect(lineCount(before)).toBe(4);

    // Every invalid shape must be ignored so the prior cap (4) and the retained
    // history both stand. A fractional value such as 0.5 is the specific
    // fail-open guarded here: floored it would become 0 and empty the ring.
    const invalidCaps = [
      0,
      -10,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const cap of invalidCaps) {
      createLogger({ level: "info", maxMemoryLogs: cap });
      const after = recentLogs();
      expect(after).toBe(before);
      expect(lineCount(after)).toBe(4);
    }

    // The prior cap remains 4, not silenced: a fifth write still evicts the
    // oldest entry rather than growing unbounded or dropping everything.
    logger.info("keep-4");
    const grown = recentLogs();
    expect(lineCount(grown)).toBe(4);
    expect(grown).toContain("keep-4");
    expect(grown).not.toContain("keep-0");
  });

  it("an invalid cap on one logger cannot wipe another logger's shared history", () => {
    // The in-memory destination is a process-wide singleton, so a bad binding
    // on any constructed logger must not perturb an unrelated logger's view.
    const base = createLogger({ level: "info", maxMemoryLogs: 100 });
    base.clear();
    base.info("shared-A");
    base.info("shared-B");
    const before = recentLogs();

    createLogger({ level: "info", maxMemoryLogs: 0.5 });
    createLogger({ level: "info", maxMemoryLogs: Number.POSITIVE_INFINITY });

    // A second, unrelated logger reads the same untouched shared buffer.
    createLogger({ level: "info" });
    const after = recentLogs();
    expect(after).toBe(before);
    expect(after).toContain("shared-A");
    expect(after).toContain("shared-B");
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

/**
 * Secret-redaction contract (W1-018/W1-019): the deep-walk redactor must mask
 * credential-named keys at any depth, case-insensitively — including top-level
 * keys, UPPERCASE env-style names, `Authorization` headers, and properties on
 * Error wrappers — without mutating the caller's live objects. Observable
 * surface is the in-memory ring buffer (`recentLogs`), the same text the
 * `/api/logs` endpoints and WS stream serve.
 */
describe("secret redaction", () => {
  const redactLogger = () => createLogger({ level: "trace" });

  afterEach(() => {
    redactLogger().clear();
    vi.restoreAllMocks();
  });

  it("masks top-level credential keys", () => {
    const logger = redactLogger();
    logger.info({ apiKey: "sk-top-level-secret" }, "ctx");
    expect(recentLogs()).toContain("apiKey=[REDACTED]");
    expect(recentLogs()).not.toContain("sk-top-level-secret");
  });

  it("masks UPPERCASE env-style keys case-insensitively", () => {
    const logger = redactLogger();
    logger.info({ OPENAI_API_KEY: "sk-uppercase-secret" }, "ctx");
    expect(recentLogs()).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(recentLogs()).not.toContain("sk-uppercase-secret");
  });

  it("masks keys nested deeper than one level", () => {
    const logger = redactLogger();
    logger.info(
      {
        provider: { config: { credentials: { clientSecret: "deep-secret" } } },
      },
      "ctx",
    );
    expect(recentLogs()).not.toContain("deep-secret");
    expect(recentLogs()).toContain("[REDACTED]");
  });

  it("masks Authorization headers inside a headers object", () => {
    const logger = redactLogger();
    logger.info(
      { headers: { Authorization: "Bearer header-secret-token" } },
      "ctx",
    );
    expect(recentLogs()).not.toContain("header-secret-token");
  });

  it("masks the extended credential key variants", () => {
    const logger = redactLogger();
    logger.info(
      {
        clientSecret: "v-client",
        secretKey: "v-secret-key",
        signingSecret: "v-signing",
        botToken: "v-bot",
        sessionKey: "v-session",
        authToken: "v-auth",
        encryptionKey: "v-encryption",
        masterKey: "v-master",
      },
      "ctx",
    );
    const logs = recentLogs();
    for (const secret of [
      "v-client",
      "v-secret-key",
      "v-signing",
      "v-bot",
      "v-session",
      "v-auth",
      "v-encryption",
      "v-master",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("redacts credentials carried on an Error wrapper without mutating it", () => {
    const logger = redactLogger();
    const err = new Error("request failed");
    (err as unknown as Record<string, unknown>).config = {
      headers: { Authorization: "Bearer axios-style-secret" },
    };

    logger.error(err);

    expect(recentLogs()).not.toContain("axios-style-secret");
    // The caller's live error object keeps its original values (W1-019).
    const config = (err as unknown as Record<string, unknown>).config as {
      headers: { Authorization: string };
    };
    expect(config.headers.Authorization).toBe("Bearer axios-style-secret");
  });

  it("never mutates nested objects the caller keeps using", () => {
    const logger = redactLogger();
    const original = { provider: { apiKey: "live-provider-key" } };

    logger.info(original, "ctx");

    expect(original.provider.apiKey).toBe("live-provider-key");
    expect(recentLogs()).not.toContain("live-provider-key");
  });

  it("redacts objects passed as trailing args", () => {
    const logger = redactLogger();
    logger.info("plain message", { token: "trailing-arg-secret" });
    expect(recentLogs()).not.toContain("trailing-arg-secret");
  });

  it("keeps non-secret token-count and key-suffix lookalikes visible", () => {
    const logger = redactLogger();
    logger.info(
      { maxTokens: 2048, monkey: "see", turnkey: "sol", keyboard: "esc" },
      "ctx",
    );
    const logs = recentLogs();
    expect(logs).toContain("maxTokens=2048");
    expect(logs).toContain("monkey=see");
    expect(logs).toContain("turnkey=sol");
    expect(logs).toContain("keyboard=esc");
  });

  it("collapses cycles instead of recursing forever", () => {
    const logger = redactLogger();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => logger.info(cyclic, "ctx")).not.toThrow();
    expect(recentLogs()).toContain("[Circular]");
  });

  it("masks webhook, connection-string, and concatenated key shapes (W5-026)", () => {
    const logger = redactLogger();
    logger.info(
      {
        webhookUrl: "https://discord.test/api/webhooks/111/hook-token-here",
        connectionString: "Server=db;User=u;Pwd=hunter2",
        MASTERKEY: "v-master-concat",
        SIGNINGKEY: "v-signing-concat",
        SSHKEY: "v-ssh-concat",
        ENCRYPTIONKEY: "v-encryption-concat",
      },
      "ctx",
    );
    const logs = recentLogs();
    for (const secret of [
      "hook-token-here",
      "hunter2",
      "v-master-concat",
      "v-signing-concat",
      "v-ssh-concat",
      "v-encryption-concat",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("scrubs credential-shaped string values under neutral keys (W5-026)", () => {
    const logger = redactLogger();
    logger.info(
      {
        url: "postgres://user:supersecretpassword@db.internal:5432/app",
        payload: '{"apiKey":"sk-neutral-key-value-12345"}',
      },
      "ctx",
    );
    const logs = recentLogs();
    expect(logs).not.toContain("supersecretpassword");
    expect(logs).not.toContain("sk-neutral-key-value-12345");
    // The non-secret remainder of the value survives the mask.
    expect(logs).toContain("postgres://***@db.internal:5432/app");
  });

  it("scrubs the common JSON credential spellings from string values (W10)", () => {
    const logger = redactLogger();
    logger.info(
      {
        payload:
          '{"clientSecret":"client-secret-value-123","client_secret":"client-snake-secret-value-123","sessionKey":"session-secret-value-123","session_key":"session-snake-secret-value-123","authToken":"auth-secret-value-123","auth_token":"auth-snake-secret-value-123","botToken":"123456:bot-secret-value-abc","bot_token":"123456:bot-snake-secret-value-abc","connectionString":"Server=db;Pwd=hunter2w10","connection_string":"Server=db;Pwd=hunter2snake","access_token":"access-secret-value-123","refresh_token":"refresh-secret-value-123","webhookUrl":"https://discord.test/api/webhooks/9/hook-secret-a","webhook_url":"https://discord.test/api/webhooks/9/hook-secret-b"}',
      },
      "ctx",
    );
    const logs = recentLogs();
    for (const secret of [
      "client-secret-value-123",
      "client-snake-secret-value-123",
      "session-secret-value-123",
      "session-snake-secret-value-123",
      "auth-secret-value-123",
      "auth-snake-secret-value-123",
      "bot-secret-value-abc",
      "bot-snake-secret-value-abc",
      "hunter2w10",
      "hunter2snake",
      "access-secret-value-123",
      "refresh-secret-value-123",
      "hook-secret-a",
      "hook-secret-b",
    ]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("scrubs a quoted credential key the ENV-style row cannot reach", () => {
    // Mirrors core's redact.test.ts case: the ENV-style pattern requires
    // `=`/`:` immediately after the key's word boundary, which a quoted
    // key's closing quote always intervenes on. Fixture assembled at
    // runtime so no scannable secret-shaped literal sits in source.
    const logger = redactLogger();
    const value = ["sk", "_live_51H8xQ2LmNpQrStUv"].join("");
    logger.info(
      { payload: `{"api_key": "${value}"}` },
      "ctx",
    );
    expect(recentLogs()).not.toContain(value);
  });

  it("scrubs Google OAuth refresh and access tokens from string values", () => {
    const logger = redactLogger();
    const refreshToken = ["1//0", "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"].join("");
    const accessToken = ["ya29.", "AbCdEfGhIjKlMnOpQrStUvWxYz1234-5678_90"].join("");
    logger.info(
      { payload: `token endpoint returned ${refreshToken} and ${accessToken}` },
      "ctx",
    );
    const logs = recentLogs();
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain(accessToken);
  });

  it("scrubs credential patterns from the Error headline message (W5-026)", () => {
    const logger = redactLogger();
    logger.error(
      new Error(
        "request to https://x.test/?key=AIzaSyD4iE4fZa1234567890abcdef failed",
      ),
    );
    const logs = recentLogs();
    expect(logs).not.toContain("AIzaSyD4iE4fZa1234567890abcdef");
    expect(logs).toContain("request to https://x.test/");
  });

  it("leaves ordinary prose strings untouched (W5-026 false-positive guard)", () => {
    const logger = redactLogger();
    logger.info(
      { status: "connection retried twice", note: "all systems nominal" },
      "plain headline",
    );
    const logs = recentLogs();
    expect(logs).toContain("connection retried twice");
    expect(logs).toContain("all systems nominal");
    expect(logs).toContain("plain headline");
  });

  it("fails closed per key when a property getter throws (W5-028)", () => {
    const logger = redactLogger();
    const booby: Record<string, unknown> = { apiKey: "sk-booby-trap-secret" };
    Object.defineProperty(booby, "lazy", {
      enumerable: true,
      get() {
        throw new Error("lazy getter exploded");
      },
    });

    expect(() => logger.info(booby, "ctx")).not.toThrow();
    const logs = recentLogs();
    // The sibling credential is still masked, the throwing key degrades to a
    // marker, and the raw object never reaches the ring.
    expect(logs).not.toContain("sk-booby-trap-secret");
    expect(logs).toContain("[REDACTED: redaction failed]");
  });

  it("fails closed when the object cannot be walked at all (W5-028)", () => {
    const logger = redactLogger();
    const unwalkable = new Proxy(
      { apiKey: "sk-proxy-hidden-secret" },
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );

    expect(() =>
      logger.info(unwalkable as Record<string, unknown>, "ctx"),
    ).not.toThrow();
    const logs = recentLogs();
    expect(logs).not.toContain("sk-proxy-hidden-secret");
    expect(logs).toContain("[REDACTED: redaction failed]");
  });

  it("drops a bare function context without losing the message", () => {
    const logger = redactLogger();
    expect(() =>
      logger.info(
        (() => "never-invoked") as unknown as Record<string, unknown>,
        "fn-context-message-survives",
      ),
    ).not.toThrow();
    const logs = recentLogs();
    expect(logs).toContain("fn-context-message-survives");
    expect(logs).not.toContain("never-invoked");
  });

  it("scrubs credential-shaped namespace bindings", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const nsSecret = "sk-namespace-binding-secret-1234";
    createLogger({ level: "trace", namespace: nsSecret }).info(
      "namespace-scrub-entry",
    );
    const out = `${recentLogs()} ${infoSpy.mock.calls.flat().join(" ")}`;
    expect(out).not.toContain(nsSecret);
    // The scrubbed affix form, not the raw value, tags the line.
    expect(out).toContain("sk-nam…1234");
    expect(out).toContain("namespace-scrub-entry");
  });
});

/**
 * JSON-mode sink hygiene (W10 logger group): the redacted clone must carry no
 * executable serializer hooks — a hostile own-property toJSON re-runs when a
 * sink JSON-stringifies the clone and would reconstitute the very secrets the
 * walk just masked — and creation/child bindings must be redacted before they
 * become Adze meta, which Adze emits verbatim on every JSON line.
 * LOG_JSON_FORMAT is read at module load, so each case boots a fresh module
 * instance and restores the variable afterwards; observable surfaces are the
 * ring buffer and Adze's own JSON console lines.
 */
describe("JSON mode sink hygiene", () => {
  const withJsonMode = async (
    run: (fresh: typeof import("./logger")) => void,
  ): Promise<void> => {
    const previous = process.env.LOG_JSON_FORMAT;
    process.env.LOG_JSON_FORMAT = "true";
    try {
      vi.resetModules();
      run(await import("./logger"));
    } finally {
      if (previous === undefined) delete process.env.LOG_JSON_FORMAT;
      else process.env.LOG_JSON_FORMAT = previous;
      vi.resetModules();
      // Re-seat Adze's global setup in the default pretty format so the
      // JSON-mode module instance cannot contaminate later tests.
      await import("./logger");
    }
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a hostile toJSON so serialization cannot reconstitute secrets", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await withJsonMode((fresh) => {
      const secret = "sk-tojson-resurrected-secret";
      const hostile = {
        apiKey: secret,
        note: "kept",
        toJSON: () => ({ apiKey: secret, marker: "resurrected" }),
      };
      fresh.createLogger({ level: "trace" }).info(hostile, "ctx");

      const logs = fresh.recentLogs();
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain("resurrected");
      // The non-hook remainder of the payload still serializes.
      expect(logs).toContain('"note":"kept"');
      // Adze's own JSON console line is clean as well.
      const printed = infoSpy.mock.calls.flat().join(" ");
      expect(printed).not.toContain(secret);
      expect(printed).not.toContain("resurrected");
    });
  });

  it("drops serializer hooks in nested objects and array elements", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await withJsonMode((fresh) => {
      const secret = "sk-nested-hook-secret";
      const hookedFn = Object.assign(() => {}, { toJSON: () => secret });
      fresh.createLogger({ level: "trace" }).info(
        {
          nested: { hook: { toJSON: () => secret }, ok: 1 },
          list: [{ toJSON: () => secret }, hookedFn],
        },
        "ctx",
      );

      const logs = fresh.recentLogs();
      expect(logs).not.toContain(secret);
      expect(logs).toContain('"ok":1');
      // Bare function array elements collapse to null, matching JSON.stringify.
      expect(logs).toContain("null");
    });
  });

  it("detaches hostile built-ins, functions, map/set contents, and clone keys", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await withJsonMode((fresh) => {
      const secrets = {
        date: "sk-date-hook-secret",
        map: "sk-map-value-secret",
        set: "sk-set-hook-secret",
        promise: "sk-promise-hook-secret",
        fn: "sk-function-hook-secret",
        proto: "sk-proto-hook-secret",
      };
      const hostileDate = new Date("2026-01-02T03:04:05.000Z");
      hostileDate.toJSON = () => secrets.date;
      const hostileSetValue = { toJSON: () => secrets.set };
      const hostilePromise = Object.assign(Promise.resolve(), {
        toJSON: () => secrets.promise,
      });
      const hostileFunction = Object.assign(() => {}, {
        toJSON: () => secrets.fn,
      });
      const protoValue = { toJSON: () => secrets.proto };
      const payload: Record<string, unknown> = {
        when: hostileDate,
        map: new Map([["apiKey", secrets.map]]),
        set: new Set([hostileSetValue]),
        pending: hostilePromise,
      };
      Object.defineProperty(payload, "__proto__", {
        value: protoValue,
        enumerable: true,
      });

      fresh
        .createLogger({ level: "trace" })
        .info(payload, "ctx", hostileFunction);

      const outputs = `${fresh.recentLogs()} ${infoSpy.mock.calls.flat().join(" ")}`;
      for (const secret of Object.values(secrets)) {
        expect(outputs).not.toContain(secret);
      }
      expect(outputs).toContain("2026-01-02T03:04:05.000Z");
      expect(outputs).toContain("[Promise]");
      expect(outputs).toContain("[REDACTED]");
    });
  });

  it("redacts creation and child bindings before they become Adze meta", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await withJsonMode((fresh) => {
      const secret = "sk-child-binding-secret";
      const logger = fresh.createLogger({ level: "trace", token: secret });
      logger.info("parent-line");
      logger.child({ apiKey: secret, requestId: "r-1" }).info("child-line");

      const printed = infoSpy.mock.calls.flat().join(" ");
      expect(printed).not.toContain(secret);
      expect(printed).toContain("[REDACTED]");
      // Non-secret bindings survive onto the JSON lines.
      expect(printed).toContain("r-1");
    });
  });

  it("detaches hostile Date hooks in creation and child bindings", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await withJsonMode((fresh) => {
      const parentSecret = "sk-parent-date-hook-secret";
      const childSecret = "sk-child-date-hook-secret";
      const parentDate = new Date("2026-02-03T04:05:06.000Z");
      const childDate = new Date("2026-03-04T05:06:07.000Z");
      parentDate.toJSON = () => parentSecret;
      childDate.toJSON = () => childSecret;

      const logger = fresh.createLogger({ level: "trace", when: parentDate });
      logger.child({ when: childDate }).info("child-line");

      const printed = infoSpy.mock.calls.flat().join(" ");
      expect(printed).not.toContain(parentSecret);
      expect(printed).not.toContain(childSecret);
      expect(printed).toContain("2026-03-04T05:06:07.000Z");
    });
  });
});

/**
 * Binary-payload redaction contract: a Buffer/TypedArray/DataView logged under
 * a neutral key must collapse to a size-only marker in both the node and
 * browser log paths — JSON would otherwise serialize the raw bytes verbatim
 * (`{"type":"Buffer","data":[...]}`) into the ring buffer and every sink.
 */
describe("binary payload redaction", () => {
  afterEach(() => {
    createLogger({ level: "info" }).clear();
    vi.restoreAllMocks();
  });

  it("masks a Buffer under a neutral key in the node path", () => {
    const logger = createLogger({ level: "trace" });
    logger.info({ payload: Buffer.from("topsecret-bytes") }, "ctx");
    const logs = recentLogs();
    expect(logs).toContain("[BUFFER REDACTED 15 bytes]");
    expect(logs).not.toContain('"type":"Buffer"');
    expect(logs).not.toContain("116,111,112");
  });

  it("masks TypedArray, DataView, and ArrayBuffer values", () => {
    const logger = createLogger({ level: "trace" });
    logger.info(
      {
        u8: new Uint8Array([1, 2, 3]),
        view: new DataView(new ArrayBuffer(7)),
        buf: new ArrayBuffer(9),
      },
      "ctx",
    );
    const logs = recentLogs();
    expect(logs).toContain("[BUFFER REDACTED 3 bytes]");
    expect(logs).toContain("[BUFFER REDACTED 7 bytes]");
    expect(logs).toContain("[BUFFER REDACTED 9 bytes]");
  });

  it("masks a Buffer passed as a trailing arg", () => {
    const logger = createLogger({ level: "trace" });
    logger.info("plain message", { file: Buffer.from("trailing-secret") });
    const logs = recentLogs();
    expect(logs).toContain("[BUFFER REDACTED 15 bytes]");
    expect(logs).not.toContain('"type":"Buffer"');
  });

  it("masks a Buffer in the browser logger path", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({ level: "trace", __forceType: "browser" });
    logger.info({ payload: Buffer.from("browser-secret") }, "ctx");
    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toContain("[BUFFER REDACTED 14 bytes]");
    expect(out).not.toContain('"type":"Buffer"');
  });

  it("detaches hostile built-ins and functions in the browser path", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const dateSecret = "sk-browser-date-hook-secret";
    const functionSecret = "sk-browser-function-hook-secret";
    const date = new Date("2026-04-05T06:07:08.000Z");
    date.toJSON = () => dateSecret;
    const fn = Object.assign(() => {}, { toJSON: () => functionSecret });

    createLogger({ level: "trace", __forceType: "browser" }).info(
      { date, values: new Set([fn]) },
      "ctx",
      fn,
    );

    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).not.toContain(dateSecret);
    expect(out).not.toContain(functionSecret);
    expect(out).toContain("2026-04-05T06:07:08.000Z");
  });
});

/**
 * File-sink permission contract (W1-059): output.log/prompts.log/chat.log
 * must be created 0600, and files left world-readable by older builds must be
 * healed on first open. Needs a fresh module instance per case because the
 * sink opens lazily once per process; LOG_FILE is restored afterwards.
 */
describe("file sink permissions", () => {
  it.skipIf(process.platform === "win32")(
    "creates sinks 0600 and heals a legacy 0644 output.log",
    async () => {
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-log-perm-"));
      const logPath = path.join(dir, "output.log");

      // Legacy sink from an older build: world-readable.
      await fs.writeFile(logPath, "old line\n");
      await fs.chmod(logPath, 0o644);

      const previous = process.env.LOG_FILE;
      process.env.LOG_FILE = logPath;
      try {
        vi.resetModules();
        const fresh = await import("./logger");
        fresh.logger.info("perm-test-entry");
        const sinkSecret = "sk-file-date-hook-secret";
        const hostileDate = new Date("2026-05-06T07:08:09.000Z");
        hostileDate.toJSON = () => sinkSecret;
        fresh.logger.info({ when: hostileDate }, "file-redaction-entry");
        fresh.logPrompt("text", "prompt-body");
        fresh.logChatIn({
          agentName: "Eliza",
          agentId: "agent-1",
          roomId: "room-123456789",
          messageId: "message-123456789",
          text: "hi",
        });

        const modeOf = async (name: string) =>
          (await fs.stat(path.join(dir, name))).mode & 0o777;
        expect(await modeOf("output.log")).toBe(0o600);
        expect(await modeOf("prompts.log")).toBe(0o600);
        expect(await modeOf("chat.log")).toBe(0o600);
        // The legacy content survives the heal (append-only sink).
        expect(await fs.readFile(logPath, "utf8")).toContain("old line");
        expect(await fs.readFile(logPath, "utf8")).toContain("perm-test-entry");
        const fileContents = await fs.readFile(logPath, "utf8");
        expect(fileContents).not.toContain(sinkSecret);
        expect(fileContents).toContain("2026-05-06T07:08:09.000Z");
      } finally {
        if (previous === undefined) delete process.env.LOG_FILE;
        else process.env.LOG_FILE = previous;
        vi.resetModules();
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
