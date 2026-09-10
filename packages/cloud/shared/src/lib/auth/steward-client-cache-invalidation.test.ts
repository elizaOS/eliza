/**
 * Verifies that Steward logout removes both token-derived cache projections
 * using each projection's canonical digest width with deterministic cache mocks.
 */

import { describe, expect, mock, test } from "bun:test";
import { createHash } from "crypto";

const cacheDel = mock(async (_key: string) => undefined);

mock.module("../../db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this cache-invalidation test path");
  },
}));

const cacheClientActualModule = await import("../cache/client");

mock.module("../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: async () => null,
    set: async () => undefined,
    del: cacheDel,
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));

mock.module("../cache/in-memory-lru-cache", () => ({
  InMemoryLRUCache: class {
    delete() {}
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { invalidateStewardTokenCache } = await import("./steward-client");

describe("invalidateStewardTokenCache", () => {
  test("deletes the canonical full-digest user-session projection", async () => {
    const token = "verified-session-token";
    const fullHash = createHash("sha256").update(token).digest("hex");
    const truncatedHash = fullHash.substring(0, 32);

    await invalidateStewardTokenCache(token);

    expect(cacheDel).toHaveBeenCalledWith(`session:steward:${truncatedHash}:v1`);
    expect(cacheDel).toHaveBeenCalledWith(`session:user:${fullHash}:v1`);
  });
});
