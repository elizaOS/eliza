/**
 * Fail-closed contract tests for the browser fallback of the native secure
 * store.
 *
 * Materiality: this module is the security boundary for secrets on web
 * surfaces. The documented contract is that the web fallback NEVER degrades
 * to localStorage/IndexedDB ("stored in the clear") — every operation reports
 * `unavailable`. These tests pin that contract so a future "helpful" fallback
 * that starts persisting via web storage fails CI instead of silently
 * weakening the secrets guarantee.
 */
import { describe, expect, it } from "vitest";
import { ElizaSecureStoreWeb } from "./web";

describe("ElizaSecureStoreWeb (fail-closed fallback)", () => {
  it("get() never reads from web storage — reports unavailable", async () => {
    const result = await new ElizaSecureStoreWeb().get();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unavailable");
  });

  it("set() never writes to web storage — reports unavailable", async () => {
    const result = await new ElizaSecureStoreWeb().set();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unavailable");
  });

  it("remove() reports unavailable", async () => {
    const result = await new ElizaSecureStoreWeb().remove();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unavailable");
  });

  it("status() reports the backend as unavailable", async () => {
    const status = await new ElizaSecureStoreWeb().status();
    expect(status.ok).toBe(false);
    expect(status.available).toBe(false);
    expect(status.backend).toBe("unavailable");
    expect(status.accessibility).toBe("unavailable");
    expect(status.synchronized).toBe(false);
  });

  it("explains the absence of secure storage in the message", async () => {
    const result = await new ElizaSecureStoreWeb().get();
    expect(result.message).toMatch(/native Eliza app/);
    const status = await new ElizaSecureStoreWeb().status();
    expect(status.message).toMatch(/native Eliza app/);
  });
});
