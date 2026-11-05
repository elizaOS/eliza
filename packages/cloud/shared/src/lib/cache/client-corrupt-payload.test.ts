/**
 * Regression tests for corrupt cache payloads read through `get` / `getWithOutcome`.
 *
 * Everything this client writes goes through `serializeCacheValue` -> `JSON.stringify`,
 * so any string under a `CacheClient` key that is NOT valid JSON was truncated or
 * clobbered by something else. Before the fix, `parseCacheValue` fell back to
 * `return value as T`, so `getWithOutcome` reported the damaged payload as
 * `{ kind: "hit" }` and every caller typed `T` received a raw string: property
 * reads returned `undefined`, truthiness checks passed, and the damage looked
 * exactly like a valid value. A corrupt payload must instead be classified as
 * `invalid` (warn + delete + cache miss), the same way the existing
 * `"[object Object]"` corruption branch is handled.
 */

import { describe, expect, test } from "bun:test";
import { CacheClient } from "./client";

interface FakeRedis {
  backend: "memory";
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

function makeClient(rawValues: Record<string, string>): {
  client: CacheClient;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(rawValues));
  const stub: FakeRedis = {
    backend: "memory",
    async get(key: string) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed++;
      }
      return removed;
    },
    async mget(...keys: string[]) {
      return keys.map((key) => (store.has(key) ? (store.get(key) as string) : null));
    },
  };

  const client = new CacheClient();
  const probe = client as unknown as {
    initialized: boolean;
    enabled: boolean;
    redis: unknown;
    pk(key: string): string;
  };
  probe.initialized = true;
  probe.enabled = true;
  probe.redis = stub;
  return { client, store };
}

// A payload cut off mid-write: valid prefix, no closing brace.
const TRUNCATED = '{"id":"user-1","role":"admin","expiresAt":1767';

describe("CacheClient read of a corrupt (non-JSON) payload", () => {
  test("getWithOutcome classifies it as invalid and deletes it instead of reporting a hit", async () => {
    const { client, store } = makeClient({});
    const prefixed = (client as unknown as { pk(key: string): string }).pk("auth:session");
    store.set(prefixed, TRUNCATED);

    const outcome = await client.getWithOutcome<{ id: string }>("auth:session");

    expect(outcome.kind).toBe("invalid");
    // The damaged entry must not survive to be served again on the next read.
    expect(store.has(prefixed)).toBe(false);
  });

  test("get returns null, not a raw string pretending to be T", async () => {
    const { client, store } = makeClient({});
    const prefixed = (client as unknown as { pk(key: string): string }).pk("auth:session");
    store.set(prefixed, TRUNCATED);

    const value = await client.get<{ id: string; role: string }>("auth:session");

    expect(value).toBeNull();
  });

  test("mget reports the corrupt slot as null and deletes only that key", async () => {
    const { client, store } = makeClient({});
    const probe = client as unknown as { pk(key: string): string };
    store.set(probe.pk("k:corrupt"), TRUNCATED);
    store.set(probe.pk("k:ok"), JSON.stringify({ id: "user-2" }));

    const values = await client.mget<{ id: string }>(["k:corrupt", "k:ok"]);

    expect(values[0]).toBeNull();
    expect(values[1]).toEqual({ id: "user-2" });
    expect(store.has(probe.pk("k:corrupt"))).toBe(false);
    expect(store.has(probe.pk("k:ok"))).toBe(true);
  });
});

describe("CacheClient read of well-formed payloads is unchanged", () => {
  test("JSON object payload is still a hit", async () => {
    const { client, store } = makeClient({});
    const prefixed = (client as unknown as { pk(key: string): string }).pk("k:object");
    store.set(prefixed, JSON.stringify({ id: "user-3" }));

    const outcome = await client.getWithOutcome<{ id: string }>("k:object");

    expect(outcome).toMatchObject({ kind: "hit", value: { id: "user-3" } });
  });

  test("JSON-encoded string payload round-trips (a raw string is only stored JSON-encoded)", async () => {
    const { client, store } = makeClient({});
    const prefixed = (client as unknown as { pk(key: string): string }).pk("k:string");
    // What serializeCacheValue produces for the string "hello".
    store.set(prefixed, JSON.stringify("hello"));

    const outcome = await client.getWithOutcome<string>("k:string");

    expect(outcome).toMatchObject({ kind: "hit", value: "hello" });
  });
});
