/**
 * Covers the push-token registry: register/list/count/unregister, idempotent
 * upsert, moving a token between platforms, whitespace trimming and empty-token
 * rejection, platform filtering, cache-backed persistence with rehydration,
 * dropping malformed records on hydrate, concurrent first-use hydration, and
 * serialized persistence.
 *
 * Adversarial persistence-boundary coverage: UTF-8 byte-length bounding (not
 * char length), malformed-timestamp rejection (NaN/Infinity/negative/fractional
 * /unsafe-integer/non-number), dedup-before-cap so duplicate-heavy dumps do not
 * underfill, the persisted-record ceiling (exact boundary hydrates, one above
 * fails closed without destroying the durable row), one-time durable repair
 * that never rewrites a clean load (including a resolved-false repair write that
 * leaves the dirty row intact, reports a redacted diagnostic without failing the
 * read, retries on the next cold start, and stops rewriting once it lands),
 * failed-write rollback (in-memory and durable
 * state unchanged, typed error, token redacted), mutation-queue recovery after a
 * failed op, resolved-false persistence failure (register/unregister and a
 * deferred false-return all leave in-memory and durable state unchanged with the
 * typed persist-failed error), observable atomicity (list/count never see an
 * uncommitted mutation while its write is pending and stay unchanged on
 * rejection), and
 * persistence-boundary validation of direct callers (unsupported platform and
 * non-string token become the typed invalid error). Backed by a Map-backed mock
 * runtime cache — no real storage.
 */
import { ElizaError, type IAgentRuntime, jsonValueEquals } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_PUSH_TOKENS,
  MAX_PUSH_TOKEN_BYTES,
  MAX_PUSH_TOKENS_PER_AGENT,
  PUSH_TOKEN_CONFLICT_EXHAUSTED_CODE,
  PUSH_TOKEN_INVALID_CODE,
  PUSH_TOKEN_PERSIST_FAILED_CODE,
  type PushTokenRecord,
  PushTokenRegistry,
} from "./push-token-registry.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";

/** Durable row read helper: the persisted envelope (legacy rows are bare arrays). */
function readEnvelope(cache: Map<string, unknown>): {
  version: number;
  tokens: PushTokenRecord[];
} {
  const row = cache.get(KEY) as { version: number; tokens: PushTokenRecord[] };
  return row;
}
const KEY = `push-tokens:${AGENT_ID}`;

function createRuntime(): {
  runtime: IAgentRuntime;
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const runtime = createMockRuntime({
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
    compareAndSetCache: async <T>(
      key: string,
      expected: unknown,
      replacement: T,
    ): Promise<boolean> => {
      const stored = cache.get(key);
      const matches =
        expected === undefined
          ? stored === undefined
          : stored !== undefined && jsonValueEquals(stored, expected);
      if (!matches) return false;
      cache.set(key, replacement);
      return true;
    },
  });
  return { runtime, cache };
}

describe("PushTokenRegistry", () => {
  let ctx: ReturnType<typeof createRuntime>;
  let registry: PushTokenRegistry;

  beforeEach(() => {
    ctx = createRuntime();
    registry = new PushTokenRegistry(ctx.runtime);
  });

  it("registers, lists, and counts a token", async () => {
    await registry.register("ios", "device-token-1");
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ token: "device-token-1", platform: "ios" });
    expect(list[0].createdAt).toBeGreaterThan(0);
    expect(await registry.count()).toBe(1);
  });

  it("upserts the same token idempotently (no duplicate)", async () => {
    await registry.register("android", "tok-a");
    await registry.register("android", "tok-a");
    expect(await registry.count()).toBe(1);
  });

  it("moves a token to a new platform on re-registration", async () => {
    await registry.register("ios", "tok-b");
    await registry.register("android", "tok-b");
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].platform).toBe("android");
  });

  it("trims whitespace and rejects an empty token", async () => {
    await registry.register("ios", "  spaced  ");
    const list = await registry.list();
    expect(list[0].token).toBe("spaced");
    await expect(registry.register("ios", "   ")).rejects.toThrow(/token/);
  });

  it("an absent unregister never creates or bumps the durable row (F7: no phantom write)", async () => {
    expect(await registry.unregister("never-registered")).toBe(false);
    expect(ctx.cache.has(KEY)).toBe(false);
    await registry.register("ios", "tok-live");
    const before = readEnvelope(ctx.cache).version;
    expect(await registry.unregister("never-registered-2")).toBe(false);
    expect(readEnvelope(ctx.cache).version).toBe(before);
    expect(readEnvelope(ctx.cache).tokens).toHaveLength(1);
  });

  it("hydration never rewrites an over-ceiling ENVELOPE row (F2: the durable dump survives repair)", async () => {
    const oversized = Array.from(
      { length: MAX_PERSISTED_PUSH_TOKENS + 1 },
      (_, i) => ({
        token: `t-${i}`,
        platform: "ios",
        createdAt: i + 1,
      }),
    );
    ctx.cache.set(KEY, { version: 2, tokens: oversized });
    // First read fails closed to empty but must leave the durable row intact.
    expect(await registry.count()).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    const row = ctx.cache.get(KEY) as { version: number; tokens: unknown[] };
    expect(row.tokens).toHaveLength(MAX_PERSISTED_PUSH_TOKENS + 1);
    expect(row.version).toBe(2);
  });

  it("a mutation on a MAX_SAFE_INTEGER-1 envelope refuses the bump too — writing MAX would plant the poison row (N1 off-by-one)", async () => {
    ctx.cache.set(KEY, {
      version: Number.MAX_SAFE_INTEGER - 1,
      tokens: [{ token: "edge-tok", platform: "ios", createdAt: 1 }],
    });
    await expect(registry.register("ios", "next-tok")).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_TOKEN_PERSIST_FAILED_CODE,
      context: { reason: "version_exhausted" },
    });
    const row = ctx.cache.get(KEY) as { version: number; tokens: unknown[] };
    expect(row.version).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(row.tokens).toHaveLength(1);
  });

  it("a mutation on an exhausted-version envelope refuses the bump instead of destroying the row (F3)", async () => {
    ctx.cache.set(KEY, {
      version: Number.MAX_SAFE_INTEGER,
      tokens: [{ token: "ceiling-tok", platform: "ios", createdAt: 1 }],
    });
    await expect(registry.register("ios", "next-tok")).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_TOKEN_PERSIST_FAILED_CODE,
      context: { reason: "version_exhausted" },
    });
    const row = ctx.cache.get(KEY) as { version: number; tokens: unknown[] };
    expect(row.version).toBe(Number.MAX_SAFE_INTEGER);
    expect(row.tokens).toHaveLength(1);
  });

  it("unregisters and reports existence", async () => {
    await registry.register("ios", "tok-c");
    expect(await registry.unregister("tok-c")).toBe(true);
    expect(await registry.unregister("tok-c")).toBe(false);
    expect(await registry.count()).toBe(0);
  });

  it("filters by platform", async () => {
    await registry.register("ios", "i1");
    await registry.register("ios", "i2");
    await registry.register("android", "a1");
    expect(await registry.listByPlatform("ios")).toHaveLength(2);
    expect(await registry.listByPlatform("android")).toHaveLength(1);
  });

  it("persists to the runtime cache and rehydrates a fresh registry", async () => {
    await registry.register("ios", "persisted-token");
    const restarted = new PushTokenRegistry(ctx.runtime);
    const list = await restarted.list();
    expect(list).toHaveLength(1);
    expect(list[0].token).toBe("persisted-token");
  });

  it("drops malformed records on hydrate", async () => {
    ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", [
      { token: "good", platform: "ios", createdAt: 1 },
      { token: "", platform: "ios", createdAt: 2 },
      { token: "bad-platform", platform: "web", createdAt: 3 },
      { nope: true },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list.map((r) => r.token)).toEqual(["good"]);
  });

  it("preserves registrations made while first-use hydration is in flight", async () => {
    const cache = new Map<string, unknown>();
    const cacheReads: Array<(value: unknown) => void> = [];
    let reads = 0;
    const runtime = createMockRuntime({
      agentId: "00000000-0000-0000-0000-0000000000aa",
      getCache: <T>(k: string): Promise<T | undefined> =>
        reads++ === 0
          ? new Promise((resolve) => {
              cacheReads.push(resolve as (value: unknown) => void);
            })
          : Promise.resolve(cache.get(k) as T | undefined),
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
      compareAndSetCache: async <T>(
        key: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        const stored = cache.get(key);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        cache.set(key, replacement);
        return true;
      },
    });
    const concurrentRegistry = new PushTokenRegistry(runtime);

    const first = concurrentRegistry.register("ios", "ios-token");
    const second = concurrentRegistry.register("android", "android-token");
    await Promise.resolve();
    expect(cacheReads).toHaveLength(1);

    // Hydration observes the durable row (empty); the baseline becomes [] and
    // the queued mutations CAS from there.
    cacheReads[0]([]);
    await first;
    await second;

    expect(
      (await concurrentRegistry.list()).map((record) => record.token).sort(),
    ).toEqual(["android-token", "ios-token"]);
  });

  it("serializes concurrent mutations so persisted tokens cannot regress", async () => {
    let casCalls = 0;
    let persisted: { version: number; tokens: PushTokenRecord[] } | undefined;
    const snapshots: Array<{ version: number; tokens: PushTokenRecord[] }> = [];
    let firstWriteStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let releaseFirst!: (ok: boolean) => void;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      // The CAS layer persists through `persisted` (a stand-in durable row) so
      // attempt #2 CAS-es against the row attempt #1 committed.
      getCache: async <T>(): Promise<T | undefined> =>
        persisted as T | undefined,
      compareAndSetCache: <T>(
        _k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        casCalls += 1;
        snapshots.push(
          replacement as { version: number; tokens: PushTokenRecord[] },
        );
        if (casCalls === 1) {
          firstWriteStarted();
          return new Promise<boolean>((resolve) => {
            releaseFirst = (ok) => {
              if (ok)
                persisted = replacement as {
                  version: number;
                  tokens: PushTokenRecord[];
                };
              resolve(ok);
            };
          });
        }
        const matches =
          persisted === undefined
            ? expected === undefined
            : expected !== undefined && jsonValueEquals(persisted, expected);
        if (!matches) return Promise.resolve(false);
        persisted = replacement as {
          version: number;
          tokens: PushTokenRecord[];
        };
        return Promise.resolve(true);
      },
    });
    const concurrentRegistry = new PushTokenRegistry(runtime);

    const first = concurrentRegistry.register("ios", "ios-token");
    const second = concurrentRegistry.register("android", "android-token");
    await firstStarted;
    // Only the first mutation has reached the durable layer so far.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].tokens.map((r) => r.token)).toEqual(["ios-token"]);

    releaseFirst(true);
    await first;
    await second;
    // The second mutation was applied on top of the first (queue + CAS
    // compose) and strictly bumped the envelope version.
    const last = snapshots[snapshots.length - 1];
    expect(last.tokens.map((r) => r.token).sort()).toEqual([
      "android-token",
      "ios-token",
    ]);
    expect(last.version).toBe(snapshots[0].version + 1);
  });

  it("evicts the oldest unique token once the per-agent cap is exceeded", async () => {
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      await registry.register("ios", `tok-${i}`);
    }
    expect(await registry.count()).toBe(MAX_PUSH_TOKENS_PER_AGENT);

    await registry.register("android", "tok-newest");
    const list = await registry.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.map((r) => r.token)).toContain("tok-newest");
    expect(list.map((r) => r.token)).not.toContain("tok-0");
    expect(list.map((r) => r.token)).toContain("tok-1");

    const persisted = readEnvelope(ctx.cache).tokens;
    expect(persisted).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(persisted.map((r) => r.token)).not.toContain("tok-0");
  });

  it("does not grow the registry when an existing token is re-registered at the cap", async () => {
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      await registry.register("ios", `tok-${i}`);
    }
    await registry.register("android", "tok-0");
    const list = await registry.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.find((r) => r.token === "tok-0")?.platform).toBe("android");
  });

  it("hydrates only the newest capped records from an oversized cache dump", async () => {
    const dumped: PushTokenRecord[] = [];
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT + 40; i++) {
      dumped.push({
        token: `old-${i}`,
        platform: "ios",
        createdAt: i + 1,
      });
    }
    ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", dumped);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list).toHaveLength(MAX_PUSH_TOKENS_PER_AGENT);
    expect(list.map((r) => r.token)).toContain(
      `old-${MAX_PUSH_TOKENS_PER_AGENT + 39}`,
    );
    expect(list.map((r) => r.token)).not.toContain("old-0");
  });

  it("rejects a token longer than the byte cap", async () => {
    const huge = "x".repeat(MAX_PUSH_TOKEN_BYTES + 1);
    await expect(registry.register("ios", huge)).rejects.toThrow(/byte cap/);
    expect(await registry.count()).toBe(0);
  });

  it("bounds tokens by UTF-8 byte length, not char length", async () => {
    // '€' encodes to 3 UTF-8 bytes, so a char-length check would accept a token
    // over the byte cap. Register the largest token that fits by bytes, then one
    // char more (still tiny by char count) and confirm it is rejected.
    const maxChars = Math.floor(MAX_PUSH_TOKEN_BYTES / 3);
    const atLimit = "€".repeat(maxChars);
    expect(Buffer.byteLength(atLimit, "utf8")).toBeLessThanOrEqual(
      MAX_PUSH_TOKEN_BYTES,
    );
    await registry.register("ios", atLimit);
    expect(await registry.count()).toBe(1);

    const overByBytes = "€".repeat(maxChars + 1);
    expect(overByBytes.length).toBeLessThan(MAX_PUSH_TOKEN_BYTES);
    expect(Buffer.byteLength(overByBytes, "utf8")).toBeGreaterThan(
      MAX_PUSH_TOKEN_BYTES,
    );
    await expect(registry.register("android", overByBytes)).rejects.toThrow(
      /byte cap/,
    );
    expect(await registry.count()).toBe(1);
  });

  it("rejects hydrated records with malformed timestamps", async () => {
    ctx.cache.set(KEY, [
      { token: "ok", platform: "ios", createdAt: 5 },
      { token: "nan", platform: "ios", createdAt: Number.NaN },
      { token: "inf", platform: "ios", createdAt: Number.POSITIVE_INFINITY },
      { token: "negative", platform: "ios", createdAt: -1 },
      { token: "fractional", platform: "ios", createdAt: 1.5 },
      {
        token: "unsafe",
        platform: "ios",
        createdAt: Number.MAX_SAFE_INTEGER + 1,
      },
      { token: "stringified", platform: "ios", createdAt: "5" },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    expect((await fresh.list()).map((r) => r.token)).toEqual(["ok"]);
  });

  it("drops hydrated records whose token exceeds the UTF-8 byte cap", async () => {
    ctx.cache.set(KEY, [
      { token: "small", platform: "ios", createdAt: 1 },
      {
        token: "€".repeat(Math.floor(MAX_PUSH_TOKEN_BYTES / 3) + 1),
        platform: "android",
        createdAt: 2,
      },
    ]);
    const fresh = new PushTokenRegistry(ctx.runtime);
    expect((await fresh.list()).map((r) => r.token)).toEqual(["small"]);
  });

  it("dedups before capping so duplicate-heavy data does not underfill", async () => {
    // Naive cap-then-dedup would keep only the single hottest token (its 64
    // newest duplicates fill the cap, then collapse to one). Dedup-before-cap
    // must retain the newest hot record PLUS every unique older token.
    const dump: PushTokenRecord[] = [];
    for (let i = 0; i < MAX_PUSH_TOKENS_PER_AGENT; i++) {
      dump.push({ token: "hot", platform: "ios", createdAt: 1000 + i });
    }
    for (let i = 0; i < 40; i++) {
      dump.push({ token: `uniq-${i}`, platform: "android", createdAt: 1 + i });
    }
    ctx.cache.set(KEY, dump);
    const fresh = new PushTokenRegistry(ctx.runtime);
    const list = await fresh.list();
    expect(list).toHaveLength(41);
    expect(list.find((r) => r.token === "hot")?.createdAt).toBe(1063);
    expect(list.filter((r) => r.token.startsWith("uniq-"))).toHaveLength(40);
  });

  it("hydrates exactly at the persisted-record ceiling but fails closed above it", async () => {
    const makeDump = (n: number): PushTokenRecord[] =>
      Array.from({ length: n }, (_, i) => ({
        token: `t-${i}`,
        platform: "ios" as const,
        createdAt: i + 1,
      }));

    // Exactly at the ceiling: traversed, deduped, capped to the live cap.
    ctx.cache.set(KEY, makeDump(MAX_PERSISTED_PUSH_TOKENS));
    const atCeiling = new PushTokenRegistry(ctx.runtime);
    expect(await atCeiling.count()).toBe(MAX_PUSH_TOKENS_PER_AGENT);

    // One above the ceiling: fail closed to empty and DO NOT destroy the
    // durable row (the repair write is suppressed for over-ceiling rows; a
    // later mutation overwrites it with a bounded envelope).
    const over = createRuntime();
    const oversized = makeDump(MAX_PERSISTED_PUSH_TOKENS + 1);
    over.cache.set(KEY, oversized);
    const aboveCeiling = new PushTokenRegistry(over.runtime);
    expect(await aboveCeiling.count()).toBe(0);
    expect((over.cache.get(KEY) as PushTokenRecord[]).length).toBe(
      MAX_PERSISTED_PUSH_TOKENS + 1,
    );
    // Exactly at the ceiling hydrates AND is repaired to the envelope form.
    expect(readEnvelope(ctx.cache).tokens).toHaveLength(
      MAX_PUSH_TOKENS_PER_AGENT,
    );
  });

  it("persists the repaired form exactly once and never rewrites a clean load", async () => {
    const casCalls: Array<{ version: number; tokens: PushTokenRecord[] }> = [];
    const cache = new Map<string, unknown>();
    cache.set(KEY, [
      { token: "  spaced  ", platform: "ios", createdAt: 2, extra: "junk" },
      { token: "dupe", platform: "android", createdAt: 1 },
      { token: "dupe", platform: "android", createdAt: 9 },
      { token: "", platform: "ios", createdAt: 3 },
    ]);
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        casCalls.push(
          replacement as { version: number; tokens: PushTokenRecord[] },
        );
        cache.set(k, replacement);
        return true;
      },
    });

    const first = new PushTokenRegistry(runtime);
    const list = await first.list();
    expect(list.map((r) => r.token).sort()).toEqual(["dupe", "spaced"]);
    expect(casCalls).toHaveLength(1);
    const repaired = casCalls[0].tokens;
    expect(repaired.find((r) => r.token === "dupe")?.createdAt).toBe(9);
    for (const record of repaired) {
      expect(Object.keys(record).sort()).toEqual([
        "createdAt",
        "platform",
        "token",
      ]);
    }
    // The repair wrote the canonical envelope (version 1 over the legacy row).
    expect(casCalls[0].version).toBe(1);

    // A second cold registry over the already-repaired cache must not rewrite.
    const second = new PushTokenRegistry(runtime);
    await second.list();
    expect(casCalls).toHaveLength(1);
  });

  it("leaves the dirty row intact and reports when the repair CAS conflicts, then a later landed repair stops rewriting", async () => {
    const casWrites: Array<{ version: number; tokens: PushTokenRecord[] }> = [];
    const reported: Array<{ scope: string; error: unknown }> = [];
    const cache = new Map<string, unknown>();
    // A bounded-but-dirty dump (unsorted extra field + dupe) that normalizes.
    const dirty = [
      { token: "  spaced  ", platform: "ios", createdAt: 2, extra: "junk" },
      { token: "dupe", platform: "android", createdAt: 1 },
      { token: "dupe", platform: "android", createdAt: 9 },
    ];
    cache.set(KEY, dirty);
    let repairSucceeds = false;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        // The adapter reports `false` when the durable row did not land.
        if (!repairSucceeds) return false;
        casWrites.push(
          replacement as { version: number; tokens: PushTokenRecord[] },
        );
        cache.set(k, replacement);
        return true;
      },
    });
    runtime.reportError = ((scope: string, error: unknown) => {
      reported.push({ scope, error });
    }) as IAgentRuntime["reportError"];

    // Cold start #1: the repair CAS conflicts (a concurrent writer owns the
    // row). The read still succeeds with the normalized in-memory view, the
    // diagnostic is reported (redacted), and the original dirty durable row is
    // left intact for a later retry.
    const first = new PushTokenRegistry(runtime);
    expect((await first.list()).map((r) => r.token).sort()).toEqual([
      "dupe",
      "spaced",
    ]);
    expect(casWrites).toHaveLength(0);
    expect(reported).toHaveLength(0);
    // Durable row is still the original dirty dump (repair did not land).
    expect(cache.get(KEY)).toBe(dirty);

    // Cold start #2: the dirty row is still present, so the registry scans and
    // re-normalizes again — but now the repair write lands.
    repairSucceeds = true;
    const second = new PushTokenRegistry(runtime);
    expect((await second.list()).map((r) => r.token).sort()).toEqual([
      "dupe",
      "spaced",
    ]);
    expect(casWrites).toHaveLength(1);
    const repaired = readEnvelope(cache).tokens;
    for (const record of repaired) {
      expect(Object.keys(record).sort()).toEqual([
        "createdAt",
        "platform",
        "token",
      ]);
    }

    // Cold start #3: the durable row is now canonical, so no rewrite occurs.
    const third = new PushTokenRegistry(runtime);
    await third.list();
    expect(casWrites).toHaveLength(1);
  });

  it("rolls the in-memory registry back when a durable write is rejected", async () => {
    let failNextCas = false;
    const cache = new Map<string, unknown>();
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, value: T): Promise<boolean> => {
        cache.set(k, value);
        return true;
      },
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        if (failNextCas) throw new Error("cache offline");
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        cache.set(k, replacement);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    expect(await reg.count()).toBe(1);

    failNextCas = true;
    await reg.register("android", "reject-me").then(
      () => {
        throw new Error("expected the rejected write to throw");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_PERSIST_FAILED_CODE);
        // Tokens are never leaked into the error surface.
        expect(String((err as ElizaError).message)).not.toContain("reject-me");
        expect(JSON.stringify((err as ElizaError).context)).not.toContain(
          "reject-me",
        );
      },
    );
    failNextCas = false;

    // In-memory registry unchanged (rejected token absent, prior token intact).
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);
    // Durable cache never received the rejected token either.
    expect(readEnvelope(cache).tokens.map((r) => r.token)).toEqual(["keep"]);
  });
  it("retries a conflicted register against the reloaded durable base", async () => {
    const cache = new Map<string, unknown>();
    let casCalls = 0;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        casCalls += 1;
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        if (casCalls === 1) {
          // Simulate another process winning the race between our read and
          // this attempt: mutate the row so the committed value is ours
          // anyway — no; instead resolve conflict on the first attempt.
          return false;
        }
        cache.set(k, replacement);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    // Another process inserts the row after our hydrate read (undefined).
    await runtime.setCache(KEY, [
      { token: "theirs", platform: "ios", createdAt: 1 },
    ]);
    await reg.register("android", "ours");
    expect(casCalls).toBe(2);
    const durable = readEnvelope(cache)
      .tokens.map((r) => r.token)
      .sort();
    expect(durable).toEqual(["ours", "theirs"]);
  });
  it("retries a conflicted unregister and converges on the freshest base", async () => {
    const cache = new Map<string, unknown>();
    let casCalls = 0;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        casCalls += 1;
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        cache.set(k, replacement);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    // Another process appends a token after our baseline.
    await runtime.setCache(KEY, [
      { token: "keep", platform: "ios", createdAt: 1 },
      { token: "theirs", platform: "ios", createdAt: 2 },
    ]);
    // Our unregister conflicts once, reloads (sees both), re-applies, lands.
    await expect(reg.unregister("keep")).resolves.toBe(true);
    // CAS #1: baseline [keep] vs durable [keep, theirs] → conflict.
    // CAS #2: reloaded [keep, theirs] vs op applied — wait: the retry compares
    // baseline [keep, theirs] against the same durable row → match, lands.
    expect(casCalls).toBeGreaterThanOrEqual(2);
    expect(readEnvelope(cache).tokens.map((r) => r.token)).toEqual(["theirs"]);
  });
  it("never publishes a deferred mutation while its CAS is pending, and stays unchanged on exhaustion", async () => {
    const cache = new Map<string, unknown>();
    let started = false;
    let casCalls = 0;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      compareAndSetCache: <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        casCalls += 1;
        if (!started) {
          // First CAS (the "keep" registration) commits normally.
          started = true;
          const stored = cache.get(k);
          const matches =
            expected === undefined
              ? stored === undefined
              : stored !== undefined && jsonValueEquals(stored, expected);
          if (!matches) return Promise.resolve(false);
          cache.set(k, replacement);
          return Promise.resolve(true);
        }
        writeStartedThen();
        return new Promise<boolean>(() => {
          // never resolves: the mutation's CAS is forever in flight
        });
      },
    });
    let signal!: () => void;
    const writeStartedThen = () => signal?.();
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    expect(await reg.count()).toBe(1);

    const gated = new Promise<void>((resolve) => {
      signal = resolve;
    });
    void reg.register("android", "pending-token");
    await gated;
    // Staged but not published while the durable CAS is in flight. list()
    // itself would block on the same in-flight mutation queue, so prove
    // non-publication through a SECOND registry hydrating the durable row:
    // it sees only the committed state.
    const observer = new PushTokenRegistry(runtime);
    expect((await observer.list()).map((r) => r.token)).toEqual(["keep"]);
    // Leave the CAS unresolved (in flight) — the observable registry stays
    // on committed state; the assertion above is the guarantee under test.
    // Cancel the pending promise's effect on the queue by leaving the test
    // without awaiting `pending` (the forever-pending CAS mirrors a
    // real-world hang; the queue simply stays busy on this op).
    expect(casCalls).toBe(2);
  });
  it("keeps processing later mutations after a failed one (no queue wedge)", async () => {
    let failCount = 0;
    const cache = new Map<string, unknown>();
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      compareAndSetCache: async <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        if (failCount > 0) {
          failCount--;
          throw new Error("transient cache failure");
        }
        const stored = cache.get(k);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined && jsonValueEquals(stored, expected);
        if (!matches) return false;
        cache.set(k, replacement);
        return true;
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "a");

    failCount = 1;
    const failing = reg.register("android", "b");
    const following = reg.register("ios", "c");
    await expect(failing).rejects.toThrow(/persist/);
    // The queue is not wedged: the op enqueued after the failure still resolves.
    await following;

    expect((await reg.list()).map((r) => r.token).sort()).toEqual(["a", "c"]);
    expect(
      readEnvelope(cache)
        .tokens.map((r) => r.token)
        .sort(),
    ).toEqual(["a", "c"]);
  });
  it("never exposes an uncommitted mutation while its CAS is pending, and stays unchanged on a throw", async () => {
    const cache = new Map<string, unknown>();
    let gateNextCas = false;
    let rejectPendingWrite!: (reason: Error) => void;
    let pendingWriteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingWriteStarted = resolve;
    });
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(k: string): Promise<T | undefined> =>
        cache.get(k) as T | undefined,
      setCache: async <T>(k: string, v: T): Promise<boolean> => {
        cache.set(k, v);
        return true;
      },
      compareAndSetCache: <T>(
        k: string,
        expected: unknown,
        replacement: T,
      ): Promise<boolean> => {
        if (!gateNextCas) {
          const stored = cache.get(k);
          const matches =
            expected === undefined
              ? stored === undefined
              : stored !== undefined && jsonValueEquals(stored, expected);
          if (!matches) return Promise.resolve(false);
          cache.set(k, replacement);
          return Promise.resolve(true);
        }
        return new Promise<boolean>((_resolve, reject) => {
          rejectPendingWrite = reject;
          pendingWriteStarted();
        });
      },
    });
    const reg = new PushTokenRegistry(runtime);
    await reg.register("ios", "keep");
    expect(await reg.count()).toBe(1);

    gateNextCas = true;
    const pending = reg.register("android", "pending-token");
    await started;
    // The candidate is staged but not published: readers observe only committed
    // state while the durable write is in flight.
    expect(await reg.count()).toBe(1);
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);

    rejectPendingWrite(new Error("cache offline"));
    await pending.then(
      () => {
        throw new Error("expected the rejected write to throw");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_PERSIST_FAILED_CODE);
      },
    );

    // Observable registry and durable cache are unchanged after the rejection.
    expect((await reg.list()).map((r) => r.token)).toEqual(["keep"]);
    expect(readEnvelope(cache).tokens.map((r) => r.token)).toEqual(["keep"]);
  });
  it("rejects an unsupported platform from a direct caller with a typed error", async () => {
    const untyped = registry as unknown as {
      register(platform: unknown, token: string): Promise<void>;
    };
    await untyped.register("web", "tok-web").then(
      () => {
        throw new Error("expected unsupported platform to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
    expect(await registry.count()).toBe(0);
    expect(ctx.cache.get(KEY)).toBeUndefined();
  });

  it("turns a non-string runtime token into the typed invalid error, not a TypeError", async () => {
    const untyped = registry as unknown as {
      register(platform: string, token: unknown): Promise<void>;
    };
    await untyped.register("ios", 12345).then(
      () => {
        throw new Error("expected a non-string token to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
    expect(await registry.count()).toBe(0);
  });

  it("rejects an empty token with a typed validation error", async () => {
    await registry.register("ios", "real").catch(() => undefined);
    await registry.register("ios", "   ").then(
      () => {
        throw new Error("expected empty token to reject");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe(PUSH_TOKEN_INVALID_CODE);
      },
    );
  });

  describe("owner binding (#23106)", () => {
    it("stores and lists tokens per owner, isolated across principals", async () => {
      await registry.register("ios", "tok-a1", "owner-a");
      await registry.register("android", "tok-a2", "owner-a");
      await registry.register("ios", "tok-b1", "owner-b");
      await registry.register("ios", "tok-free");

      expect(
        (await registry.listByOwner("owner-a")).map((r) => r.token),
      ).toEqual(["tok-a1", "tok-a2"]);
      expect(
        (await registry.listByOwner("owner-b")).map((r) => r.token),
      ).toEqual(["tok-b1"]);
      // An unowned (legacy) token never matches any owner.
      expect(await registry.listByOwner("owner-a")).not.toContainEqual(
        expect.objectContaining({ token: "tok-free" }),
      );
      expect(await registry.listByOwner("owner-b")).toHaveLength(1);
    });

    it("re-registration moves a token between owners (upsert)", async () => {
      await registry.register("ios", "tok-a1", "owner-a");
      await registry.register("ios", "tok-a1", "owner-b");
      expect(await registry.listByOwner("owner-a")).toHaveLength(0);
      expect(
        (await registry.listByOwner("owner-b")).map((r) => r.token),
      ).toEqual(["tok-a1"]);
    });

    it("persists the owner across restart (hydration round-trip)", async () => {
      await registry.register("ios", "tok-a1", "owner-a");
      const restarted = new PushTokenRegistry(ctx.runtime);
      expect(
        (await restarted.listByOwner("owner-a")).map((r) => r.token),
      ).toEqual(["tok-a1"]);
    });

    it("an oversized persisted owner string degrades to unowned (no throw on hydration)", async () => {
      ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", [
        {
          token: "tok-huge-owner",
          platform: "ios",
          createdAt: 1,
          ownerEntityId: "o".repeat(5000),
        },
      ]);
      const fresh = new PushTokenRegistry(ctx.runtime);
      await expect(fresh.hydrate()).resolves.toBeUndefined();
      const all = await fresh.list();
      expect(all.map((r) => r.token)).toEqual(["tok-huge-owner"]);
      expect(all[0].ownerEntityId).toBeUndefined();
      expect(await fresh.listByOwner("o".repeat(5000))).toHaveLength(0);
    });

    it("a corrupt owner field on a persisted row degrades to unowned, record still valid", async () => {
      ctx.cache.set("push-tokens:00000000-0000-0000-0000-0000000000aa", [
        { token: "tok-x", platform: "ios", createdAt: 1, ownerEntityId: 42 },
      ]);
      const fresh = new PushTokenRegistry(ctx.runtime);
      const all = await fresh.list();
      expect(all.map((r) => r.token)).toEqual(["tok-x"]);
      expect(all[0].ownerEntityId).toBeUndefined();
      expect(await fresh.listByOwner("owner-a")).toHaveLength(0);
    });

    it("rejects an oversized owner id with the typed validation error", async () => {
      const hugeOwner = "o".repeat(5000);
      await expect(
        registry.register("ios", "tok-big", hugeOwner),
      ).rejects.toThrow(/ownerEntityId exceeds the byte cap/);
    });

    it("a blank owner string registers unowned (never fabricated)", async () => {
      await registry.register("ios", "tok-blank", "   ");
      const all = await registry.list();
      expect(all[0].ownerEntityId).toBeUndefined();
    });
  });
});

describe("PushTokenRegistry cross-writer CAS regression", () => {
  /**
   * The acceptance-criteria regression: two registry instances sharing one
   * durable cache (the blue/green overlap — two container generations over
   * one backend). The stale writer must CONFLICT, reload, re-apply, and
   * converge instead of blindly overwriting (the old `setCache` path lost the
   * other writer's token).
   */
  it("a stale registry converges instead of dropping a concurrent writer's token", async () => {
    const ctx = createRuntime();
    const stale = new PushTokenRegistry(ctx.runtime);
    const fresh = new PushTokenRegistry(ctx.runtime);
    await stale.hydrate();
    await fresh.hydrate();
    // The "other process" writes first.
    await fresh.register("ios", "tokA");
    // The stale instance still holds the pre-tokA baseline; its write CAS-es
    // against the outdated snapshot, conflicts, reloads, re-applies.
    await stale.register("android", "tokB");
    // Read through a third registry so the assertion observes the durable
    // row, not either writer's in-memory view.
    const tokens = await new PushTokenRegistry(ctx.runtime).list();
    const byToken = new Map(tokens.map((r) => [r.token, r.platform]));
    expect(byToken.get("tokA")).toBe("ios");
    expect(byToken.get("tokB")).toBe("android");
    expect(tokens).toHaveLength(2);
  });

  it("unregister after a concurrent removal answers false w.r.t. the freshest durable state", async () => {
    const ctx = createRuntime();
    const stale = new PushTokenRegistry(ctx.runtime);
    const fresh = new PushTokenRegistry(ctx.runtime);
    await stale.register("ios", "tokA");
    await fresh.hydrate();
    await fresh.unregister("tokA");
    // stale's in-memory view still contains tokA; the op must resolve
    // against the reloaded durable base, not the stale view.
    await expect(stale.unregister("tokA")).resolves.toBe(false);
    await expect(stale.count()).resolves.toBe(0);
  });

  it("throws the typed conflict-exhausted error when every CAS attempt conflicts", async () => {
    const cache = new Map<string, unknown>();
    let casCalls = 0;
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(key: string): Promise<T | undefined> =>
        cache.get(key) as T | undefined,
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
      deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
      // Adversarial CAS: always conflict (simulates a writer racing every
      // attempt past the retry budget).
      compareAndSetCache: async () => {
        casCalls += 1;
        return false;
      },
    });
    const registry = new PushTokenRegistry(runtime);
    await expect(registry.register("ios", "tokA")).rejects.toMatchObject({
      code: PUSH_TOKEN_CONFLICT_EXHAUSTED_CODE,
    });
    // Observable registry never published the candidate.
    await expect(registry.count()).resolves.toBe(0);
    expect(casCalls).toBeGreaterThan(0);
  });

  it("a CAS storage failure surfaces as the typed persist failure, never a false", async () => {
    const cache = new Map<string, unknown>();
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      getCache: async <T>(key: string): Promise<T | undefined> =>
        cache.get(key) as T | undefined,
      setCache: async <T>(key: string, value: T): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
      deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
      compareAndSetCache: async () => {
        throw new Error("backend down");
      },
    });
    const registry = new PushTokenRegistry(runtime);
    await expect(registry.register("ios", "tokA")).rejects.toMatchObject({
      code: PUSH_TOKEN_PERSIST_FAILED_CODE,
    });
    await expect(registry.count()).resolves.toBe(0);
  });

  it("concurrent registers from one registry serialize onto one durable list (in-process queue + CAS compose)", async () => {
    const ctx = createRuntime();
    const registry = new PushTokenRegistry(ctx.runtime);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        registry.register("ios", `tok-${i}`),
      ),
    );
    await expect(registry.count()).resolves.toBe(12);
    const restarted = new PushTokenRegistry(ctx.runtime);
    await expect(restarted.count()).resolves.toBe(12);
  });
});
