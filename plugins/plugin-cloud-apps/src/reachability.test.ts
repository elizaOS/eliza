import { describe, expect, it, vi } from "vitest";
import { healthUrl, probeReachable, respondedLive } from "./reachability";

describe("healthUrl", () => {
  it("appends /health to a base without a trailing slash", () => {
    expect(healthUrl("https://app.example.com")).toBe(
      "https://app.example.com/health",
    );
  });

  it("collapses trailing slashes", () => {
    expect(healthUrl("https://app.example.com///")).toBe(
      "https://app.example.com/health",
    );
  });

  it("keeps the leading slash when the base is exactly '/'", () => {
    expect(healthUrl("/")).toBe("/health");
  });

  it("uses a custom path", () => {
    expect(healthUrl("https://app.example.com", "/livez")).toBe(
      "https://app.example.com/livez",
    );
  });

  it("normalizes a custom path missing its leading slash", () => {
    expect(healthUrl("https://app.example.com", "livez")).toBe(
      "https://app.example.com/livez",
    );
  });
});

describe("respondedLive", () => {
  it("counts 2xx, 3xx, and auth/not-found answers as live", () => {
    for (const status of [200, 204, 301, 401, 403, 404]) {
      expect(respondedLive({ ok: false, status })).toBe(true);
    }
  });

  it("treats Caddy gateway errors 502/503/504 as not live", () => {
    for (const status of [502, 503, 504]) {
      expect(respondedLive({ ok: false, status })).toBe(false);
    }
  });

  it("treats a missing status (network error / abort) as not live", () => {
    expect(respondedLive({ ok: false, error: "aborted" })).toBe(false);
  });
});

describe("probeReachable", () => {
  it("reports ok for a 2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const result = await probeReachable("https://app.example.com/health", {
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.example.com/health",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
  });

  it("infers ok from a 2xx status when response.ok is absent", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }) as never);
    const result = await probeReachable("https://app.example.com/health", {
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("reports ok=false with the status for a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const result = await probeReachable("https://app.example.com/health", {
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, status: 503 });
  });

  it("never throws on network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await probeReachable("https://app.example.com/health", {
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("aborts the probe when the timeout elapses", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("timed out")),
          );
        }),
    );
    const started = Date.now();
    const result = await probeReachable("https://app.example.com/health", {
      fetchImpl,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timed out");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("returns no_fetch when no fetch implementation is available", async () => {
    vi.resetModules();
    const original = globalThis.fetch;
    (globalThis as { fetch?: unknown }).fetch = undefined;
    try {
      const mod = (await import(
        "./reachability"
      )) as typeof import("./reachability");
      const result = await mod.probeReachable("https://app.example.com/health");
      expect(result).toEqual({ ok: false, error: "no_fetch" });
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });
});
