/** Exercises the real renderer logger against a captured console sink and canonical redaction. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "./browser-logger.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("browser structured logger", () => {
  it("honors configured levels, mutable levels and child bindings", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parent = createLogger({ namespace: "chat", requestId: "request-1" });
    parent.info("hidden");
    parent.warn("visible");
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { namespace: "chat", requestId: "request-1", level: "warn" },
      "visible",
    );
    parent.level = "debug";
    const child = parent.child({ requestId: "request-2" });
    child.info({ transport: "voice" }, "ready");
    expect(info).toHaveBeenCalledWith(
      { namespace: "chat", requestId: "request-2", level: "info" },
      { transport: "voice" },
      "ready",
    );
    expect(parent.level).toBe("debug");
    child.level = "silent";
    child.fatal("hidden too");
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("redacts bindings, messages, errors, binary and trailing values without mutating inputs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const source = {
      nested: { apiKey: "private-key-value" },
      bytes: new Uint8Array([83, 69, 67, 82, 69, 84]),
      promptTokens: 23,
    };
    const instance = createLogger({
      namespace: "test",
      password: "binding-secret",
    }).child({ accessToken: "child-secret" });
    const error = new Error(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    );
    instance.info(source, "Bearer abcdefghijklmnopqrstuvwxyz123456", error, {
      secret: "trailing-secret",
    });
    const emitted = info.mock.calls[0];
    expect(emitted[3]).toBeInstanceOf(Error);
    expect((emitted[3] as Error).message).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
    const serialized = JSON.stringify(emitted);
    for (const secret of [
      "private-key-value",
      "binding-secret",
      "child-secret",
      "trailing-secret",
      "abcdefghijklmnopqrstuvwxyz123456",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain('"promptTokens":23');
    expect(serialized).not.toContain('"0":83');
    expect(source.nested.apiKey).toBe("private-key-value");
    expect(error.message).toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("fails closed on hostile context and retains a usable sink", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("do not emit this secret");
        },
      },
    );
    const instance = createLogger(hostile);
    instance.info(hostile, "diagnostic");
    expect(JSON.stringify(info.mock.calls)).toContain(
      "[REDACTED: redaction failed]",
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      "do not emit this secret",
    );
  });
});
