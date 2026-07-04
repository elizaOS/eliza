/**
 * Tests for the pure reachability probe (probeReachable, respondedLive, healthUrl) with an injected fetch. Asserts the probe uses redirect:"manual" to mirror the server's live decision. No SDK or runtime.
 */
import { describe, expect, it } from "bun:test";
import {
  type FetchLike,
  healthUrl,
  probeReachable,
  respondedLive,
} from "../src/reachability.ts";

describe("healthUrl", () => {
  it("joins base + path, collapsing slashes", () => {
    expect(healthUrl("https://acme.elizacloud.ai")).toBe(
      "https://acme.elizacloud.ai/health",
    );
    expect(healthUrl("https://acme.elizacloud.ai///", "health")).toBe(
      "https://acme.elizacloud.ai/health",
    );
    expect(healthUrl("https://acme.elizacloud.ai", "/status")).toBe(
      "https://acme.elizacloud.ai/status",
    );
  });
});

describe("respondedLive", () => {
  it("counts any completed non-gateway status as live (server's isReachableStatus rule)", () => {
    for (const status of [200, 204, 301, 302, 307, 308, 401, 403, 404, 500]) {
      expect(respondedLive({ ok: status < 300, status })).toBe(true);
    }
  });

  it("counts Caddy gateway errors and no-response as NOT live", () => {
    for (const status of [502, 503, 504]) {
      expect(respondedLive({ ok: false, status })).toBe(false);
    }
    expect(respondedLive({ ok: false, error: "ECONNREFUSED" })).toBe(false);
  });
});

describe("probeReachable", () => {
  it("resolves ok:true with the status for a 2xx response", async () => {
    const result = await probeReachable("https://app.example/health", {
      fetchImpl: () => Promise.resolve({ ok: true, status: 200 }),
    });
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("REGRESSION: does NOT follow redirects — mirrors the server's probe (redirect: manual)", async () => {
    // The probe must not follow redirects: it uses redirect:"manual" and treats
    // a 3xx as "the app answered", mirroring the server's probeUrlReachable.
    // Following redirects would let a failed redirect target contradict the
    // server's READY with a false "not live".
    let seenInit: Parameters<FetchLike>[1];
    const result = await probeReachable("https://app.example/health", {
      fetchImpl: (_url, init) => {
        seenInit = init;
        return Promise.resolve({ ok: false, status: 302 });
      },
    });

    expect(seenInit?.redirect).toBe("manual");
    expect(seenInit?.method).toBe("GET");
    expect(result.status).toBe(302);
    // The gate's live rule must count the redirect as "the app answered".
    expect(respondedLive(result)).toBe(true);
  });

  it("resolves ok:false with the status (not an error) for auth gates and 404s", async () => {
    const result = await probeReachable("https://app.example/health", {
      fetchImpl: () => Promise.resolve({ ok: false, status: 401 }),
    });
    expect(result).toEqual({ ok: false, status: 401 });
    expect(respondedLive(result)).toBe(true);
  });

  it("never throws: a network error resolves to ok:false with no status", async () => {
    const result = await probeReachable("https://app.example/health", {
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toBe("ECONNREFUSED");
    expect(respondedLive(result)).toBe(false);
  });

  it("a stalled probe is aborted at timeoutMs and resolves ok:false (no hang)", async () => {
    const result = await probeReachable("https://app.example/health", {
      timeoutMs: 5,
      // Signal-honoring stalled fetch: never resolves, rejects on abort.
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(respondedLive(result)).toBe(false);
  });
});
