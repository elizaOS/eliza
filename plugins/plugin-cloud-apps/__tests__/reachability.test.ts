/**
 * Coverage for the deploy-gate reachability probe — pure URL joining, Caddy
 * gateway status classification, and bounded fetch probing without a live container.
 */
import { describe, expect, it } from "bun:test";
import type { FetchLike } from "../src/reachability.ts";
import {
  healthUrl,
  probeReachable,
  respondedLive,
} from "../src/reachability.ts";

describe("healthUrl", () => {
  it("appends /health and collapses trailing slashes", () => {
    expect(healthUrl("https://example.com")).toBe("https://example.com/health");
    expect(healthUrl("https://example.com/")).toBe(
      "https://example.com/health",
    );
    expect(healthUrl("https://example.com///")).toBe(
      "https://example.com/health",
    );
  });

  it("respects a custom path and adds a leading slash when missing", () => {
    expect(healthUrl("https://example.com", "ready")).toBe(
      "https://example.com/ready",
    );
    expect(healthUrl("https://example.com/", "/ready")).toBe(
      "https://example.com/ready",
    );
  });

  it("preserves base path segments", () => {
    expect(healthUrl("https://example.com/app")).toBe(
      "https://example.com/app/health",
    );
    expect(healthUrl("https://example.com/app/", "/health")).toBe(
      "https://example.com/app/health",
    );
  });
});

describe("respondedLive", () => {
  it("treats gateway-down statuses as not live", () => {
    expect(respondedLive({ ok: false, status: 502 })).toBe(false);
    expect(respondedLive({ ok: false, status: 503 })).toBe(false);
    expect(respondedLive({ ok: false, status: 504 })).toBe(false);
  });

  it("treats other HTTP statuses as live (auth gates, 404, 3xx, 2xx)", () => {
    expect(respondedLive({ ok: true, status: 200 })).toBe(true);
    expect(respondedLive({ ok: false, status: 301 })).toBe(true);
    expect(respondedLive({ ok: false, status: 401 })).toBe(true);
    expect(respondedLive({ ok: false, status: 403 })).toBe(true);
    expect(respondedLive({ ok: false, status: 404 })).toBe(true);
    expect(respondedLive({ ok: false, status: 500 })).toBe(true);
  });

  it("returns false when no status is present (network error / abort)", () => {
    expect(respondedLive({ ok: false })).toBe(false);
    expect(respondedLive({ ok: false, error: "aborted" })).toBe(false);
  });
});

describe("probeReachable", () => {
  it("returns ok:true for a 2xx response", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200 });
    const result = await probeReachable("https://example.com/health", {
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("returns ok:false with status for a 404 and a 503", async () => {
    const f404: FetchLike = async () => ({ ok: false, status: 404 });
    expect(
      await probeReachable("https://example.com/health", { fetchImpl: f404 }),
    ).toEqual({
      ok: false,
      status: 404,
    });
    const f503: FetchLike = async () => ({ ok: false, status: 503 });
    expect(
      await probeReachable("https://example.com/health", { fetchImpl: f503 }),
    ).toEqual({
      ok: false,
      status: 503,
    });
  });

  it("treats 201 as ok via status range even when res.ok is false", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 201 });
    const result = await probeReachable("https://example.com/health", {
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(201);
  });

  it("falls back to global fetch when no fetchImpl is provided", async () => {
    const originalFetch = globalThis.fetch;
    const stub = async () => ({ ok: true as const, status: 200 });
    (globalThis as unknown as { fetch: unknown }).fetch = stub;
    try {
      const result = await probeReachable("https://example.com/health");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    }
  });

  it("returns ok:false with error message on network failure", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const result = await probeReachable("https://example.com/health", {
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network down");
  });

  it("passes redirect:manual and handles 3xx as not-ok but live via respondedLive", async () => {
    let capturedInit: unknown;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedInit = init;
      return { ok: false, status: 302 };
    };
    const result = await probeReachable("https://example.com/health", {
      fetchImpl,
    });
    expect((capturedInit as { redirect: string }).redirect).toBe("manual");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(302);
    expect(respondedLive(result)).toBe(true);
  });

  it("uses an AbortSignal and aborts on timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedSignal = init?.signal;
      // Never resolve - let the probe's timeout abort it, then reject on signal
      await new Promise<void>((_, reject) => {
        capturedSignal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
      return { ok: true, status: 200 };
    };
    const result = await probeReachable("https://example.com/health", {
      fetchImpl,
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
    expect(capturedSignal).toBeDefined();
  });
});
