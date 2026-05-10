/**
 * Tool-call cache tests.
 *
 * Covers: cache hit/miss + recompute, TTL expiry, side-effect tool opt-out,
 * cross-session disk persistence, and that the privacy redactor is applied
 * to disk writes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolCallCache } from "./cache.ts";
import { buildCacheKey, canonicalizeJson } from "./key.ts";
import { defaultPrivacyRedactor } from "./redact.ts";
import {
  CACHEABLE_TOOL_REGISTRY,
  resolveToolDescriptor,
} from "./registry.ts";
import type { CacheableToolDescriptor, PrivacyRedactor } from "./types.ts";

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
          out[k] = typeof val === "string"
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
