/**
 * Coverage for failover.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock("@elizaos/core/edge", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: any) => a,
}));

import { isRetryableProviderError, withProviderFallback } from "./failover.js";

describe("failover", () => {
  it("detects retryable statuses", () => {
    expect(isRetryableProviderError({ status: 429 })).toBe(true);
    expect(isRetryableProviderError({ status: 500 })).toBe(true);
    expect(isRetryableProviderError({ status: 400 })).toBe(false);
    expect(isRetryableProviderError(null)).toBe(false);
    expect(isRetryableProviderError({})).toBe(false);
  });
  it("falls back on retryable", async () => {
    const primary = vi.fn(async () => {
      throw { status: 429 };
    });
    const fallback = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = await withProviderFallback(primary, fallback);
    expect(fallback).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
  it("throws non-retryable", async () => {
    const primary = async () => {
      throw { status: 400, error: "bad" };
    };
    await expect(withProviderFallback(primary, async () => new Response("ok"))).rejects.toEqual({
      status: 400,
      error: "bad",
    });
  });
  it("returns primary when success", async () => {
    const primary = async () => new Response("ok");
    const res = await withProviderFallback(primary, null);
    expect(res.status).toBe(200);
  });
});
