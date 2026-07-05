/**
 * Error-policy guard for the OAuth cache-version counter (#13415). The version
 * counter drives OAuth token-cache invalidation, so it is auth-domain and must
 * fail closed: an unreadable/unwritable version is an internal failure that must
 * PROPAGATE, never be silently substituted with a fabricated 0/1 that would key
 * token lookups under a reset version and resurface a revoked token. This
 * asserts the failure path stays distinguishable from the one legitimately-empty
 * result — a genuine first-use miss with a reachable backend, which returns 0.
 * The cache client is mocked so backend availability and read/write outcomes are
 * driven directly.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let getResult: number | null = null;
let getShouldThrow = false;
let available = true;
let incrResult = 5;
let incrShouldThrow = false;
const getCalls: string[] = [];
const incrCalls: string[] = [];
const expireCalls: Array<{ key: string; ttl: number }> = [];

mock.module("../../cache/client", () => ({
  cache: {
    get: async (key: string) => {
      getCalls.push(key);
      if (getShouldThrow) throw new Error("redis GET blew up");
      return getResult;
    },
    incr: async (key: string) => {
      incrCalls.push(key);
      if (incrShouldThrow) throw new Error("redis INCR blew up");
      return incrResult;
    },
    expire: async (key: string, ttl: number) => {
      expireCalls.push({ key, ttl });
    },
    isAvailable: () => available,
  },
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const PLATFORM = "google";

describe("oauth cache-version error policy (#13415)", () => {
  beforeEach(() => {
    getResult = null;
    getShouldThrow = false;
    available = true;
    incrResult = 5;
    incrShouldThrow = false;
    getCalls.length = 0;
    incrCalls.length = 0;
    expireCalls.length = 0;
  });

  afterEach(() => {
    mock.restore();
  });

  it("getOAuthVersion returns 0 for a genuine first-use miss with a reachable backend", async () => {
    const { getOAuthVersion } = await import("./cache-version");
    getResult = null;
    available = true;

    const version = await getOAuthVersion(ORG, PLATFORM);

    expect(version).toBe(0);
    expect(getCalls).toEqual([`oauth:version:${ORG}:${PLATFORM}`]);
  });

  it("getOAuthVersion returns the stored version on a hit (no substitution)", async () => {
    const { getOAuthVersion } = await import("./cache-version");
    getResult = 7;
    available = true;

    expect(await getOAuthVersion(ORG, PLATFORM)).toBe(7);
  });

  it("getOAuthVersion THROWS on an unreadable backend instead of reading failure as first-use 0", async () => {
    const { getOAuthVersion } = await import("./cache-version");
    // cache.get swallows a GET error to null; the backend is then unavailable.
    getResult = null;
    available = false;

    let caught: unknown;
    try {
      await getOAuthVersion(ORG, PLATFORM);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("[OAuthCacheVersion]");
    expect((caught as Error).message).toContain("unavailable");
  });

  it("incrementOAuthVersion returns the new version and sets a TTL when the backend is reachable", async () => {
    const { incrementOAuthVersion } = await import("./cache-version");
    available = true;
    incrResult = 6;

    const version = await incrementOAuthVersion(ORG, PLATFORM);

    expect(version).toBe(6);
    expect(incrCalls).toEqual([`oauth:version:${ORG}:${PLATFORM}`]);
    expect(expireCalls).toHaveLength(1);
  });

  it("incrementOAuthVersion THROWS on an unavailable backend instead of fabricating a version bump", async () => {
    const { incrementOAuthVersion } = await import("./cache-version");
    available = false;

    let caught: unknown;
    try {
      await incrementOAuthVersion(ORG, PLATFORM);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("[OAuthCacheVersion]");
    // Must not have written a fabricated counter to the backend.
    expect(incrCalls).toHaveLength(0);
    expect(expireCalls).toHaveLength(0);
  });
});
