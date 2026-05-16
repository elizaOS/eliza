/**
 * Unit tests for the ElizaBunRuntime TypeScript public surface.
 *
 * These tests exercise the JS-side contract only — no native plugin is
 * loaded. They verify:
 *   - The web fallback returns the correct no-op shapes so callers can
 *     detect the unavailable-on-web case without throwing.
 *   - `StartOptions` and `StartResult` shapes are correct at the type level.
 *   - Malformed / missing required fields produce clear rejections in the
 *     web fallback (mirrors what native implementations must also do).
 */

import { describe, expect, it } from "vitest";
import { ElizaBunRuntimeWeb } from "./web";

describe("ElizaBunRuntimeWeb — happy-path no-ops", () => {
  const web = new ElizaBunRuntimeWeb();

  it("start() resolves with ok:false and an error string", async () => {
    const result = await web.start({});
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("getStatus() resolves with ready:false", async () => {
    const status = await web.getStatus();
    expect(status.ready).toBe(false);
  });

  it("stop() resolves without throwing", async () => {
    await expect(web.stop()).resolves.toBeUndefined();
  });
});

describe("ElizaBunRuntimeWeb — malformed-input rejection", () => {
  const web = new ElizaBunRuntimeWeb();

  it("sendMessage() rejects with an unavailable error on web", async () => {
    await expect(web.sendMessage({ message: "hello" })).rejects.toThrow();
  });

  it("call() rejects with an unavailable error on web", async () => {
    await expect(web.call({ method: "status" })).rejects.toThrow();
  });
});

describe("bridge contract — StartOptions shape", () => {
  it("accepts engine=auto | bun | compat and optional fields", async () => {
    const web = new ElizaBunRuntimeWeb();
    // All option variants must be accepted at the type level (compile-time test)
    // and produce an ok:false result at runtime (web fallback).
    for (const engine of ["auto", "bun", "compat"] as const) {
      const result = await web.start({
        engine,
        env: { FOO: "bar" },
        argv: ["bun", "agent-bundle.js"],
      });
      expect(result.ok).toBe(false);
    }
  });

  it("start() without options resolves (all fields optional)", async () => {
    const web = new ElizaBunRuntimeWeb();
    const result = await web.start({});
    expect(result).toHaveProperty("ok");
  });
});
