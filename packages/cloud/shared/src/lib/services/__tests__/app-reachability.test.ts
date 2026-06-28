/**
 * App public-URL reachability probe (#9853) — a deploy must not report success
 * without a URL that actually answers. These tests pin the status classifier
 * (auth gates count, gateway errors don't) and the bounded-retry poll (recovers
 * once the URL starts answering; gives up after the window).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isReachableStatus, probeUrlReachable, waitForUrlReachable } from "../app-reachability";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isReachableStatus", () => {
  test("2xx/3xx and auth gates (401/403) are reachable", () => {
    for (const status of [200, 204, 301, 302, 401, 403, 404, 500]) {
      expect(isReachableStatus(status)).toBe(true);
    }
  });

  test("bad-gateway family (502/503/504) is NOT reachable", () => {
    for (const status of [502, 503, 504]) {
      expect(isReachableStatus(status)).toBe(false);
    }
  });
});

describe("probeUrlReachable", () => {
  test("a completed 401 counts as reachable", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    expect(await probeUrlReachable("https://x.apps.test", 1000)).toBe(true);
  });

  test("a 502 gateway error is NOT reachable", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 502 })) as typeof fetch;
    expect(await probeUrlReachable("https://x.apps.test", 1000)).toBe(false);
  });

  test("a thrown request (connection refused / timeout) is NOT reachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await probeUrlReachable("https://x.apps.test", 1000)).toBe(false);
  });
});

describe("waitForUrlReachable", () => {
  test("returns true as soon as the URL answers", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(
      await waitForUrlReachable("https://x.apps.test", { maxAttempts: 5, retryDelayMs: 0 }),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  test("recovers once the upstream starts answering after a few 502s", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: calls < 3 ? 502 : 200 });
    }) as typeof fetch;
    expect(
      await waitForUrlReachable("https://x.apps.test", { maxAttempts: 5, retryDelayMs: 0 }),
    ).toBe(true);
    expect(calls).toBe(3);
  });

  test("gives up after the bounded window when never reachable", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 504 });
    }) as typeof fetch;
    expect(
      await waitForUrlReachable("https://x.apps.test", { maxAttempts: 4, retryDelayMs: 0 }),
    ).toBe(false);
    expect(calls).toBe(4);
  });
});
