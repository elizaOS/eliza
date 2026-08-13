// @vitest-environment jsdom
/**
 * Regression for PR #19137 review blocking #1:
 * A 401/403 refresh must clear only the token that was sent.
 * A concurrent same-tab login that rotated storage during the
 * in-flight request must still be present after the stale 401 lands.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refreshCloudStewardSession } from "./client-cloud";

describe("refreshCloudStewardSession stale-token race (web/fetch)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("on 401 clears ONLY the sent token; a fresh token rotated during the request survives", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stale-token");
    let resolveFetch!: (v: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = refreshCloudStewardSession({ endpoint: "/api/auth/steward-refresh" });

    // rotate storage while request is in flight (same-tab concurrent login)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    localStorage.setItem(STEWARD_TOKEN_KEY, "fresh-token");

    resolveFetch({ ok: false, status: 401, json: async () => ({}) } as Response);
    const result = await promise;

    expect(result).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("fresh-token");
  });

  it("on 403 likewise preserves a concurrently rotated fresh token", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stale-token");
    let resolveFetch!: (v: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = refreshCloudStewardSession({ endpoint: "/api/auth/steward-refresh" });
    localStorage.setItem(STEWARD_TOKEN_KEY, "fresh-token");
    resolveFetch({ ok: false, status: 403, json: async () => ({}) } as Response);
    await promise;

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("fresh-token");
  });

  it("on 401 with no concurrent rotation clears the stale token", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "stale-token");
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch;

    const result = await refreshCloudStewardSession({ endpoint: "/api/auth/steward-refresh" });
    expect(result).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });
});

describe("refreshCloudStewardSession stale-token race (native CapacitorHttp)", () => {
  // Native branch is structurally identical (captures sentToken before
  // CapacitorHttp.request and calls clearStoredStewardTokenIfCurrent).
  // Covered by the web-branch assertions above plus unit in
  // client-cloud-steward-refresh-native.test.ts.
  it.skip("native branch is covered by the same sentToken guard (see client-cloud.ts)", () => {});
});
