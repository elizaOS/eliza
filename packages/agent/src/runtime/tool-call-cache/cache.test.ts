/**
 * Tool-call cache tests.
 *
 * Covers cache hit/miss behavior, TTL and version invalidation, side-effect
 * opt-out, mutation isolation at memory and disk boundaries, persistence,
 * and privacy redaction.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isCacheableToolOutput, ToolCallCache } from "./cache.ts";
import { buildCacheKey, canonicalizeJson } from "./key.ts";
import {
  defaultPrivacyRedactor,
  REDACT_BOUNDED_SENTINEL,
  REDACT_CYCLE_SENTINEL,
  REDACT_DEPTH_SENTINEL,
} from "./redact.ts";
import { CACHEABLE_TOOL_REGISTRY, resolveToolDescriptor } from "./registry.ts";
import type {
  CacheableToolDescriptor,
  PrivacyRedactor,
  ToolOutput,
} from "./types.ts";

const passthroughRedact: PrivacyRedactor = (v) => v;

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "tool-cache-test-"));
});

afterEach(() => {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function makeCache(now: () => number = Date.now): ToolCallCache {
  return new ToolCallCache({
    diskRoot: tempRoot,
    redact: passthroughRedact,
    now,
  });
}

describe("canonicalizeJson", () => {
  it("produces the same output for identical objects with reordered keys", () => {
    const a = canonicalizeJson({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalizeJson({ a: 1, c: { x: 1, y: 2 }, b: 2 });
    expect(a).toBe(b);
  });
});

describe("buildCacheKey", () => {
  it("collides on semantically equal arg shapes", () => {
    const k1 = buildCacheKey("web_fetch", { url: "https://x", n: 1 });
    const k2 = buildCacheKey("web_fetch", { n: 1, url: "https://x" });
    expect(k1).toBe(k2);
  });

  it("differs across tools", () => {
    const k1 = buildCacheKey("web_fetch", { url: "https://x" });
    const k2 = buildCacheKey("web_search", { url: "https://x" });
    expect(k1).not.toBe(k2);
  });
});

describe("ToolCallCache", () => {
  it("miss → run → populated → hit returns cached value without re-running", async () => {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    let calls = 0;
    const args = { q: "foo" };

    const out1 = await cache.run(desc, args, async () => {
      calls += 1;
      return { result: "first" };
    });
    expect(out1).toEqual({ result: "first" });
    expect(calls).toBe(1);

    const out2 = await cache.run(desc, args, async () => {
      calls += 1;
      return { result: "second" };
    });
    expect(out2).toEqual({ result: "first" });
    expect(calls).toBe(1);
  });

  it("deduplicates concurrent misses for the same key", async () => {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const execute = async () => {
      calls += 1;
      await gate;
      return { result: "shared" };
    };
    const first = cache.run(desc, { q: "same" }, execute);
    const second = cache.run(desc, { q: "same" }, execute);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { result: "shared" },
      { result: "shared" },
    ]);
    expect(calls).toBe(1);
  });

  it("does not share in-flight results across tool versions", async () => {
    const cache = makeCache();
    const args = { q: "same" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;

    const first = cache.run(
      { name: "web_search", version: "1", ttlMs: 1_000, cacheable: true },
      args,
      async () => {
        calls += 1;
        await gate;
        return "v1";
      },
    );
    const second = cache.run(
      { name: "web_search", version: "2", ttlMs: 1_000, cacheable: true },
      args,
      async () => {
        calls += 1;
        return "v2";
      },
    );
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["v1", "v2"]);
    expect(calls).toBe(2);
  });

  it("allows a retry after an in-flight execution rejects", async () => {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    const args = { q: "retry" };

    await expect(
      cache.run(desc, args, async () => {
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");
    await expect(cache.run(desc, args, async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("expires entries after TTL", async () => {
    let now = 1_000;
    const cache = makeCache(() => now);
    const desc: CacheableToolDescriptor = {
      name: "web_search",
      version: "1",
      ttlMs: 100,
      cacheable: true,
    };
    let calls = 0;

    await cache.run(desc, { q: "a" }, async () => {
      calls += 1;
      return "v1";
    });
    expect(calls).toBe(1);

    now = 1_050;
    await cache.run(desc, { q: "a" }, async () => {
      calls += 1;
      return "v2";
    });
    expect(calls).toBe(1);

    now = 2_000;
    const out = await cache.run(desc, { q: "a" }, async () => {
      calls += 1;
      return "v3";
    });
    expect(out).toBe("v3");
    expect(calls).toBe(2);
  });

  it("invalidates on tool-version bump", async () => {
    const cache = makeCache();
    let calls = 0;
    const args = { q: "x" };

    await cache.run(
      { name: "web_search", version: "1", ttlMs: 1_000_000, cacheable: true },
      args,
      async () => {
        calls += 1;
        return "old";
      },
    );
    const out = await cache.run(
      { name: "web_search", version: "2", ttlMs: 1_000_000, cacheable: true },
      args,
      async () => {
        calls += 1;
        return "new";
      },
    );
    expect(out).toBe("new");
    expect(calls).toBe(2);
  });

  it("never caches side-effect tools", async () => {
    const cache = makeCache();
    const desc: CacheableToolDescriptor = {
      name: "send_email",
      version: "1",
      ttlMs: 1_000_000,
      cacheable: false,
    };
    let calls = 0;

    const out1 = await cache.run(desc, { to: "x" }, async () => {
      calls += 1;
      return "sent-1";
    });
    const out2 = await cache.run(desc, { to: "x" }, async () => {
      calls += 1;
      return "sent-2";
    });
    expect(out1).toBe("sent-1");
    expect(out2).toBe("sent-2");
    expect(calls).toBe(2);
    expect(cache.get(desc, { to: "x" })).toBeUndefined();
  });

  it("persists across processes via the disk tier", async () => {
    const desc = resolveToolDescriptor("web_fetch");
    const cacheA = makeCache();
    let callsA = 0;
    await cacheA.run(desc, { url: "https://x" }, async () => {
      callsA += 1;
      return { html: "<h1>hi</h1>" };
    });
    expect(callsA).toBe(1);

    const cacheB = new ToolCallCache({
      diskRoot: tempRoot,
      redact: passthroughRedact,
    });
    let callsB = 0;
    const out = await cacheB.run(desc, { url: "https://x" }, async () => {
      callsB += 1;
      return { html: "stale" };
    });
    expect(callsB).toBe(0);
    expect(out).toEqual({ html: "<h1>hi</h1>" });
  });

  it("isolates cached output from mutations after set and get", () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("web_search");
    const output = { result: { title: "original" } };

    cache.set(descriptor, { q: "mutation" }, output);
    output.result.title = "changed after set";

    const first = cache.get(descriptor, { q: "mutation" });
    expect(first?.output).toEqual({ result: { title: "original" } });

    const returned = first?.output as { result: { title: string } };
    returned.result.title = "changed after get";

    expect(cache.get(descriptor, { q: "mutation" })?.output).toEqual({
      result: { title: "original" },
    });
  });

  it("does not replay a mutated result returned by run", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("web_search");
    let calls = 0;

    const first = (await cache.run(descriptor, { q: "replay" }, async () => {
      calls += 1;
      return { result: { title: "original" } };
    })) as { result: { title: string } };
    first.result.title = "poisoned";

    const replay = await cache.run(descriptor, { q: "replay" }, async () => {
      calls += 1;
      return { result: { title: "unexpected recompute" } };
    });

    expect(calls).toBe(1);
    expect(replay).toEqual({ result: { title: "original" } });
  });

  it("isolates entries promoted from disk into memory", async () => {
    const descriptor = resolveToolDescriptor("web_fetch");
    const writer = makeCache();
    await writer.run(descriptor, { url: "https://x" }, async () => ({
      response: { body: "original" },
    }));

    const reader = makeCache();
    const promoted = reader.get(descriptor, { url: "https://x" });
    const returned = promoted?.output as { response: { body: string } };
    returned.response.body = "poisoned";

    expect(reader.get(descriptor, { url: "https://x" })?.output).toEqual({
      response: { body: "original" },
    });
  });

  it("rejects non-cloneable outputs before populating either tier", () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("web_search");
    const args = { q: "invalid output" };
    const invalidOutput = {
      callback: () => "not serializable",
    } as unknown as ToolOutput;

    expect(() => cache.set(descriptor, args, invalidOutput)).not.toThrow();
    expect(cache.get(descriptor, args)).toBeUndefined();
  });

  it("invalidate(toolName) drops in-memory entries for that tool", async () => {
    const cache = makeCache();
    const search = resolveToolDescriptor("web_search");
    const fetchD = resolveToolDescriptor("web_fetch");
    let searchCalls = 0;
    let fetchCalls = 0;

    await cache.run(search, { q: "a" }, async () => {
      searchCalls += 1;
      return "s1";
    });
    await cache.run(fetchD, { url: "https://x" }, async () => {
      fetchCalls += 1;
      return "f1";
    });

    cache.invalidate("web_search");

    await cache.run(search, { q: "a" }, async () => {
      searchCalls += 1;
      return "s2";
    });
    const out = await cache.run(fetchD, { url: "https://x" }, async () => {
      fetchCalls += 1;
      return "f2";
    });

    expect(searchCalls).toBe(2);
    expect(fetchCalls).toBe(1);
    expect(out).toBe("f1");
  });

  it("runs the privacy redactor on disk writes", async () => {
    const redact: PrivacyRedactor = (v) => {
      if (typeof v === "string") return v.replace(/SECRET/g, "<REDACTED>");
      if (Array.isArray(v)) return v;
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>)) {
          const val = (v as Record<string, unknown>)[k];
          out[k] =
            typeof val === "string"
              ? val.replace(/SECRET/g, "<REDACTED>")
              : val;
        }
        return out;
      }
      return v;
    };
    const cache = new ToolCallCache({ diskRoot: tempRoot, redact });
    const desc = resolveToolDescriptor("web_fetch");

    await cache.run(desc, { url: "https://x" }, async () => ({
      body: "this contains SECRET data",
    }));

    const key = buildCacheKey(desc.name, { url: "https://x" });
    const file = path.join(tempRoot, key.slice(0, 2), `${key}.json`);
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.output.body).toContain("<REDACTED>");
    expect(onDisk.output.body).not.toContain("SECRET");
  });

  it("default privacy redactor strips API key shapes", () => {
    const redacted = defaultPrivacyRedactor({
      blob: "auth Bearer abcdefghijklmnopqr1234 trailing",
      key: "sk-AAAAAAAAAAAAAAAAAA",
    }) as Record<string, string>;
    expect(redacted.blob).toContain("<REDACTED:bearer>");
    expect(redacted.key).toContain("<REDACTED:openai-key>");
  });

  it("fail-closes on cyclic tool output instead of stack-overflowing the disk write", () => {
    const cyclic: Record<string, unknown> = { blob: "sk-AAAAAAAAAAAAAAAAAA" };
    cyclic.self = cyclic;
    let redacted: Record<string, unknown> = {};
    expect(() => {
      redacted = defaultPrivacyRedactor(cyclic) as Record<string, unknown>;
    }).not.toThrow();
    expect(redacted.blob).toContain("<REDACTED:openai-key>");
    expect(redacted.self).toBe(REDACT_CYCLE_SENTINEL);
  });

  it("fail-closes on a deep nest instead of overflowing", () => {
    let deep: unknown = { blob: "Bearer abcdefghijklmnopqr1234" };
    for (let i = 0; i < 24; i++) deep = { child: deep };
    let redacted: unknown;
    expect(() => {
      redacted = defaultPrivacyRedactor(deep);
    }).not.toThrow();
    expect(() => JSON.stringify(redacted)).not.toThrow();
    expect(JSON.stringify(redacted)).toContain(REDACT_DEPTH_SENTINEL);
  });

  it("preserves a shared acyclic subtree instead of destroying the DAG", () => {
    const shared = { leaf: 1, key: "sk-AAAAAAAAAAAAAAAAAA" };
    const redacted = defaultPrivacyRedactor({ x: shared, y: shared }) as {
      x: { leaf: number; key: string };
      y: { leaf: number; key: string };
    };
    expect(redacted.x.leaf).toBe(1);
    expect(redacted.y.leaf).toBe(1);
    expect(redacted.x.key).toContain("<REDACTED:openai-key>");
    expect(redacted.y.key).toContain("<REDACTED:openai-key>");
    expect(redacted.y).not.toBe(REDACT_CYCLE_SENTINEL);
  });

  it("does not persist or serve a depth-truncated disk hit", async () => {
    const cache = new ToolCallCache({
      diskRoot: tempRoot,
      redact: defaultPrivacyRedactor,
    });
    const desc = resolveToolDescriptor("web_search");
    let deep: ToolOutput = { bottom: "bottom-value" };
    for (let i = 0; i < 12; i++) deep = { child: deep };

    const out = await cache.run(desc, { q: "deep" }, async () => deep);
    expect(out).toEqual(deep);

    const key = buildCacheKey(desc.name, { q: "deep" });
    const file = path.join(tempRoot, key.slice(0, 2), `${key}.json`);
    expect(existsSync(file)).toBe(false);

    const fresh = new ToolCallCache({
      diskRoot: tempRoot,
      redact: defaultPrivacyRedactor,
    });
    expect(fresh.get(desc, { q: "deep" })).toBeUndefined();
  });

  it("does not serve a prior-head truncated disk row as a successful hit", () => {
    const cache = new ToolCallCache({
      diskRoot: tempRoot,
      redact: defaultPrivacyRedactor,
    });
    const desc = resolveToolDescriptor("web_search");
    const key = buildCacheKey(desc.name, { q: "old" });
    const dir = path.join(tempRoot, key.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        key,
        toolName: desc.name,
        toolVersion: desc.version,
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        output: { child: { child: REDACT_BOUNDED_SENTINEL } },
      }),
      "utf8",
    );
    expect(cache.get(desc, { q: "old" })).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("returns deep-but-legal output through run without rejecting", async () => {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    let deep: ToolOutput = { v: 1 };
    for (let i = 0; i < 64; i++) deep = { child: deep };
    await expect(
      cache.run(desc, { q: "legal-deep" }, async () => deep),
    ).resolves.toEqual(deep);
  });

  it("never stores cyclic output as a memory-tier hit via run or set", async () => {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    const cyclic = { v: 1 } as ToolOutput & { self?: unknown };
    cyclic.self = cyclic;

    const defaultOut = await cache.run(
      desc,
      { q: "cycle-default" },
      async () => cyclic,
    );
    expect(defaultOut).toBe(cyclic);
    expect(cache.get(desc, { q: "cycle-default" })).toBeUndefined();

    const lenient = (_output: unknown): _output is typeof cyclic => true;
    let calls = 0;
    const lenientOut = await cache.run(
      desc,
      { q: "cycle-lenient" },
      async () => {
        calls += 1;
        return cyclic;
      },
      lenient,
    );
    expect(lenientOut).toBe(cyclic);
    expect(cache.get(desc, { q: "cycle-lenient" })).toBeUndefined();
    await cache.run(
      desc,
      { q: "cycle-lenient" },
      async () => {
        calls += 1;
        return cyclic;
      },
      lenient,
    );
    expect(calls).toBe(2);

    cache.set(desc, { q: "cycle-set" }, cyclic);
    expect(cache.get(desc, { q: "cycle-set" })).toBeUndefined();
  });

  it("evicts a prior successful disk row when a later write is degraded", () => {
    const cache = new ToolCallCache({
      diskRoot: tempRoot,
      redact: defaultPrivacyRedactor,
    });
    const desc = resolveToolDescriptor("web_search");
    const args = { q: "flip" };

    cache.set(desc, args, { ok: "t1" });
    const key = buildCacheKey(desc.name, args);
    const file = path.join(tempRoot, key.slice(0, 2), `${key}.json`);
    expect(existsSync(file)).toBe(true);

    let deep: ToolOutput = { bottom: "t2" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    cache.set(desc, args, deep);
    expect(existsSync(file)).toBe(false);

    const fresh = new ToolCallCache({
      diskRoot: tempRoot,
      redact: defaultPrivacyRedactor,
    });
    expect(fresh.get(desc, args)).toBeUndefined();
  });

  /**
   * Hostile-input regressions. Each fixture must be returned to the caller
   * untouched and must never enter either tier, on all three write routes:
   * direct `set()`, the default `run()` predicate, and a lenient custom
   * `run()` predicate that says "cache everything".
   */
  async function expectUncacheableOnEveryRoute(
    label: string,
    make: () => unknown,
  ): Promise<void> {
    const cache = makeCache();
    const desc = resolveToolDescriptor("web_search");
    const lenient = (_output: unknown): _output is ToolOutput => true;

    const viaDefault = make();
    await expect(
      cache.run(
        desc,
        { q: `${label}-default` },
        async () => viaDefault as ToolOutput,
      ),
    ).resolves.toBe(viaDefault);
    expect(cache.get(desc, { q: `${label}-default` })).toBeUndefined();

    const viaLenient = make();
    await expect(
      cache.run(
        desc,
        { q: `${label}-lenient` },
        async () => viaLenient,
        lenient,
      ),
    ).resolves.toBe(viaLenient);
    expect(cache.get(desc, { q: `${label}-lenient` })).toBeUndefined();

    const viaSet = make();
    expect(() =>
      cache.set(desc, { q: `${label}-set` }, viaSet as ToolOutput),
    ).not.toThrow();
    expect(cache.get(desc, { q: `${label}-set` })).toBeUndefined();
  }

  it("returns a flat-wide result uncached on set, default run and lenient run", async () => {
    const makeWide = (): Record<string, number> => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 150_000; i += 1) wide[`k${i}`] = i;
      return wide;
    };
    // Width is reserved before any per-entry work, so the verdict is stable.
    expect(isCacheableToolOutput(makeWide())).toBe(false);
    expect(isCacheableToolOutput(makeWide())).toBe(false);
    await expectUncacheableOnEveryRoute("wide", makeWide);
  });

  it("returns an accessor-bearing result uncached without invoking the getter", async () => {
    let getterCalls = 0;
    const makeAccessor = (): Record<string, unknown> => {
      const value: Record<string, unknown> = { ok: "plain" };
      Object.defineProperty(value, "leak", {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          return "secret";
        },
      });
      return value;
    };
    expect(isCacheableToolOutput(makeAccessor())).toBe(false);
    await expectUncacheableOnEveryRoute("accessor", makeAccessor);
    expect(getterCalls).toBe(0);
  });

  it("returns a proxy uncached without running any reflection trap", async () => {
    const trapCalls = {
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    };
    // Wrapped in a plain object: a bare proxy as a resolved promise value
    // would trip the runtime's own `then` lookup before the cache sees it.
    const makeHostile = (): unknown => ({
      ok: "plain",
      nested: new Proxy(
        { payload: "value" },
        {
          get() {
            trapCalls.get += 1;
            throw new TypeError("hostile get trap");
          },
          getOwnPropertyDescriptor() {
            trapCalls.getOwnPropertyDescriptor += 1;
            throw new TypeError("hostile descriptor trap");
          },
          getPrototypeOf() {
            trapCalls.getPrototypeOf += 1;
            throw new TypeError("hostile prototype trap");
          },
          ownKeys() {
            trapCalls.ownKeys += 1;
            throw new TypeError("hostile ownKeys trap");
          },
        },
      ),
    });
    expect(isCacheableToolOutput(makeHostile())).toBe(false);
    await expectUncacheableOnEveryRoute("hostile-proxy", makeHostile);
    expect(trapCalls).toEqual({
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
    });
  });

  it("returns a revoked proxy uncached instead of leaking a raw TypeError", async () => {
    const makeRevoked = (): unknown => {
      const revocable = Proxy.revocable({ payload: "value" }, {});
      revocable.revoke();
      return { ok: "plain", nested: revocable.proxy };
    };
    expect(isCacheableToolOutput(makeRevoked())).toBe(false);
    await expectUncacheableOnEveryRoute("revoked-proxy", makeRevoked);
  });

  it("registry includes web_search, web_fetch, file_read, rag_search, knowledge_lookup", () => {
    expect(CACHEABLE_TOOL_REGISTRY.web_search?.cacheable).toBe(true);
    expect(CACHEABLE_TOOL_REGISTRY.web_fetch?.cacheable).toBe(true);
    expect(CACHEABLE_TOOL_REGISTRY.file_read?.cacheable).toBe(true);
    expect(CACHEABLE_TOOL_REGISTRY.rag_search?.cacheable).toBe(true);
    expect(CACHEABLE_TOOL_REGISTRY.knowledge_lookup?.cacheable).toBe(true);
  });

  it("descriptor for unknown tool is non-cacheable", () => {
    const desc = resolveToolDescriptor("send_email");
    expect(desc.cacheable).toBe(false);
  });
});
