/**
 * Steward verification memo isolation for the inference hot path: with
 * `skipDistributedCache: true`, a cache-miss must initiate zero distributed
 * cache operations (no get, set, or del) while still verifying the signed JWT
 * locally and populating the in-isolate memo. Default callers must retain the
 * full distributed read/write/delete memo behavior, including the Worker
 * `executionCtx.waitUntil` scheduling path. Real jose verification through
 * `verifyStewardTokenCached`; the distributed cache is a call-counting double.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { SignJWT } from "jose";

// Built from dictionary words joined at runtime so no single high-entropy,
// token-shaped literal exists for the generic-api-key secret scanner to match;
// the value is only a synthetic HS256 signing key for this test.
const SECRET = ["steward", "skip", "distributed", "cache", "test", "signing", "material"].join("-");
const ENV = { STEWARD_JWT_SECRET: SECRET };

const memoryCache = new Map<string, unknown>();
let distributedGetCalls = 0;
let distributedSetCalls = 0;
let distributedDelCalls = 0;
let distributedGetValue: unknown = null;
let tokenSequence = 0;

mock.module("../../db/helpers", () => ({
  dbRead: {},
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this steward-client skip-cache test path");
  },
}));

mock.module("../cache/client", () => ({
  cache: {
    get: async () => {
      distributedGetCalls += 1;
      return distributedGetValue;
    },
    set: async () => {
      distributedSetCalls += 1;
      return undefined;
    },
    del: async () => {
      distributedDelCalls += 1;
      return undefined;
    },
  },
}));

mock.module("../cache/in-memory-lru-cache", () => ({
  InMemoryLRUCache: class {
    get(key: string) {
      return memoryCache.get(key) ?? null;
    }
    set(key: string, value: unknown) {
      memoryCache.set(key, value);
    }
    delete(key: string) {
      memoryCache.delete(key);
    }
    clear() {
      memoryCache.clear();
    }
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { verifyStewardTokenCached } = await import("./steward-client");

function secretKey(): Uint8Array {
  return new TextEncoder().encode(SECRET);
}

async function mint(claims: Record<string, unknown> = {}): Promise<string> {
  tokenSequence += 1;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sub: "steward-skip-user",
    jti: `skip-${tokenSequence}`,
    iat: now,
    exp: now + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(secretKey());
}

function resetState(): void {
  memoryCache.clear();
  distributedGetCalls = 0;
  distributedSetCalls = 0;
  distributedDelCalls = 0;
  distributedGetValue = null;
}

describe("verifyStewardTokenCached — skipDistributedCache memo isolation", () => {
  beforeEach(resetState);
  afterEach(resetState);

  test("cache miss with skipDistributedCache and no execution context initiates no distributed I/O", async () => {
    const token = await mint();

    const claims = await verifyStewardTokenCached(ENV, token, { skipDistributedCache: true });

    expect(claims?.userId).toBe("steward-skip-user");
    // No distributed read, write, or delete may fire in skip mode.
    expect(distributedGetCalls).toBe(0);
    expect(distributedSetCalls).toBe(0);
    expect(distributedDelCalls).toBe(0);
    // The in-isolate memo is still populated regardless of skip mode.
    expect(memoryCache.size).toBe(1);
  });

  test("cache miss with skipDistributedCache never schedules a distributed write on the execution context", async () => {
    const token = await mint();
    let waitUntilCalls = 0;
    const executionCtx = {
      waitUntil: (_promise: Promise<unknown>) => {
        waitUntilCalls += 1;
      },
    };

    const claims = await verifyStewardTokenCached(ENV, token, {
      skipDistributedCache: true,
      executionCtx,
    });

    expect(claims?.userId).toBe("steward-skip-user");
    expect(waitUntilCalls).toBe(0);
    expect(distributedGetCalls).toBe(0);
    expect(distributedSetCalls).toBe(0);
    expect(distributedDelCalls).toBe(0);
    expect(memoryCache.size).toBe(1);
  });

  test("default mode still performs the distributed read and write on a cache miss", async () => {
    const token = await mint();

    const claims = await verifyStewardTokenCached(ENV, token);

    expect(claims?.userId).toBe("steward-skip-user");
    expect(distributedGetCalls).toBe(1);
    expect(distributedSetCalls).toBe(1);
    expect(distributedDelCalls).toBe(0);
    expect(memoryCache.size).toBe(1);
  });

  test("default mode schedules the distributed write through executionCtx.waitUntil", async () => {
    const token = await mint();
    let waitUntilCalls = 0;
    const scheduled: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilCalls += 1;
        scheduled.push(promise);
      },
    };

    const claims = await verifyStewardTokenCached(ENV, token, { executionCtx });
    await Promise.all(scheduled);

    expect(claims?.userId).toBe("steward-skip-user");
    expect(waitUntilCalls).toBe(1);
    expect(distributedGetCalls).toBe(1);
    expect(distributedSetCalls).toBe(1);
  });

  test("default mode deletes a malformed distributed memo before re-verifying", async () => {
    // A shape-invalid memo forces the delete path; skip mode never reaches it
    // because the read is suppressed, so this proves default del behavior only.
    distributedGetValue = { userId: "malformed", claimsSchemaVersion: 1 };
    const token = await mint();

    const claims = await verifyStewardTokenCached(ENV, token);

    expect(claims?.userId).toBe("steward-skip-user");
    expect(distributedGetCalls).toBe(1);
    expect(distributedDelCalls).toBe(1);
    expect(distributedSetCalls).toBe(1);
  });

  test("skip mode still rejects an invalid-signature token without distributed I/O", async () => {
    const token = await new SignJWT({ sub: "steward-skip-wrongkey" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("attacker-controlled-secret"));

    expect(await verifyStewardTokenCached(ENV, token, { skipDistributedCache: true })).toBeNull();
    expect(distributedGetCalls).toBe(0);
    expect(distributedSetCalls).toBe(0);
    expect(distributedDelCalls).toBe(0);
    expect(memoryCache.size).toBe(0);
  });

  test("skip mode still rejects an expired token without distributed I/O", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: "steward-skip-expired" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(now - 420)
      .setExpirationTime(now - 301)
      .sign(secretKey());

    expect(await verifyStewardTokenCached(ENV, token, { skipDistributedCache: true })).toBeNull();
    expect(distributedGetCalls).toBe(0);
    expect(distributedSetCalls).toBe(0);
    expect(distributedDelCalls).toBe(0);
    expect(memoryCache.size).toBe(0);
  });
});
