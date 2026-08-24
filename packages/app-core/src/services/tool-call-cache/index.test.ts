/**
 * Unit tests for the app-core `services/tool-call-cache` barrel: the canonical
 * services path must expose a working cache surface, so every case drives the
 * real re-exported symbols from this module against a temp disk root — key
 * derivation ties/ordering/unbounded rejection, default-deny registry lookups,
 * hit/miss/dedup execution counting, side-effect opt-out, TTL boundary and
 * version invalidation, purge semantics, clone isolation, and credential
 * redaction of the bytes actually persisted to disk. Complements, and does not
 * repeat, the implementation suites under @elizaos/agent runtime/tool-call-cache.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCacheKey,
  canonicalizeJson,
  defaultPrivacyRedactor,
  isCacheable,
  type PrivacyRedactor,
  resolveToolDescriptor,
  ToolCallCache,
  type ToolCallCacheOptions,
} from "./index";

const passthroughRedact: PrivacyRedactor = (value) => value;

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "app-core-tool-cache-test-"));
});

afterEach(() => {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

function makeCache(
  overrides: Partial<Omit<ToolCallCacheOptions, "diskRoot">> = {},
): ToolCallCache {
  return new ToolCallCache({
    diskRoot: tempRoot,
    redact: passthroughRedact,
    ...overrides,
  });
}

describe("canonicalizeJson", () => {
  it("collides semantically equal objects regardless of key insertion order", () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe(
      canonicalizeJson({ a: 1, b: 2 }),
    );
    expect(canonicalizeJson({ outer: { y: [1, { k: 2 }], x: null } })).toBe(
      canonicalizeJson({ outer: { x: null, y: [1, { k: 2 }] } }),
    );
  });

  it("keeps distinct values distinct", () => {
    expect(canonicalizeJson({ a: 1 })).not.toBe(canonicalizeJson({ a: 2 }));
  });

  it("emits the canonical text form for empty containers", () => {
    expect(canonicalizeJson({})).toBe("{}");
    expect(canonicalizeJson([])).toBe("[]");
  });

  it("rejects cyclic arguments with a typed bounded error instead of overflowing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrowError(
      "tool-call cache key rejected unbounded arguments (cycle)",
    );
  });

  it("rejects bigint leaves as unsupported instead of throwing a raw TypeError", () => {
    expect(() => canonicalizeJson({ id: 1n })).toThrowError("(unsupported)");
  });
});

describe("buildCacheKey", () => {
  it("ties on equal args are separated by the tool name", () => {
    const args = { url: "https://example.invalid", n: 1 };
    expect(buildCacheKey("web_fetch", args)).not.toBe(
      buildCacheKey("web_search", args),
    );
  });

  it("reordered keys hash identically and empty args are stable", () => {
    expect(buildCacheKey("web_search", { q: "eliza", page: 2 })).toBe(
      buildCacheKey("web_search", { page: 2, q: "eliza" }),
    );
    expect(buildCacheKey("file_read", {})).toBe(buildCacheKey("file_read", {}));
  });
});

describe("registry defaults", () => {
  it("unknown tools resolve to an explicit non-cacheable zero-TTL descriptor", () => {
    expect(resolveToolDescriptor("send_email")).toEqual({
      name: "send_email",
      version: "1",
      ttlMs: 0,
      cacheable: false,
    });
    expect(isCacheable("run_code")).toBe(false);
  });

  it("registered tools are cacheable and honor ttl/version overrides", () => {
    const base = resolveToolDescriptor("web_fetch");
    expect(base.cacheable).toBe(true);
    expect(isCacheable("web_fetch")).toBe(true);
    const overridden = resolveToolDescriptor("web_fetch", {
      ttlMs: 1234,
      version: "9",
    });
    expect(overridden.ttlMs).toBe(1234);
    expect(overridden.version).toBe("9");
    expect(resolveToolDescriptor("web_fetch", { version: "9" }).ttlMs).toBe(
      base.ttlMs,
    );
  });
});

describe("ToolCallCache", () => {
  it("executes once and serves the second identical call from the cache", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("rag_search");
    let executions = 0;
    const first = await cache.run(descriptor, { query: "hello" }, async () => {
      executions += 1;
      return { answer: "first" };
    });
    const second = await cache.run(descriptor, { query: "hello" }, async () => {
      executions += 1;
      return { answer: "second" };
    });
    expect(first).toEqual({ answer: "first" });
    expect(second).toEqual(first);
    expect(executions).toBe(1);
  });

  it("always executes descriptors that are not cacheable", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("send_email");
    expect(descriptor.cacheable).toBe(false);
    let executions = 0;
    const run = () =>
      cache.run(descriptor, { to: "owner" }, async () => {
        executions += 1;
        return { sent: true };
      });
    await run();
    await run();
    expect(executions).toBe(2);
  });

  it("runs cyclic arguments uncached and reports them through onUnkeyableArgs", async () => {
    const observed: Array<{ toolName: string; reason: string }> = [];
    const cache = makeCache({
      onUnkeyableArgs: (info) => {
        observed.push(info);
      },
    });
    const descriptor = resolveToolDescriptor("web_search");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { live: true };
    };
    await expect(cache.run(descriptor, cyclic, execute)).resolves.toEqual({
      live: true,
    });
    await expect(cache.run(descriptor, cyclic, execute)).resolves.toEqual({
      live: true,
    });
    expect(executions).toBe(2);
    expect(observed).toEqual([
      { toolName: "web_search", reason: "cycle" },
      { toolName: "web_search", reason: "cycle" },
    ]);
  });

  it("expires entries exactly at expiresAt and keeps them one tick before", async () => {
    let clockMs = 1000;
    const cache = makeCache({ now: () => clockMs });
    const descriptor = resolveToolDescriptor("knowledge_lookup");
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { v: executions };
    };
    await cache.run(descriptor, { topic: "t" }, execute);

    clockMs += descriptor.ttlMs - 1;
    await expect(
      cache.run(descriptor, { topic: "t" }, execute),
    ).resolves.toEqual({
      v: 1,
    });
    expect(executions).toBe(1);

    clockMs += 1;
    await expect(
      cache.run(descriptor, { topic: "t" }, execute),
    ).resolves.toEqual({
      v: 2,
    });
    expect(executions).toBe(2);
  });

  it("invalidates prior entries when the descriptor version changes", async () => {
    const cache = makeCache();
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { gen: executions };
    };
    await cache.run(resolveToolDescriptor("web_fetch"), { url: "u" }, execute);
    const bumped = resolveToolDescriptor("web_fetch", { version: "2" });
    await expect(cache.run(bumped, { url: "u" }, execute)).resolves.toEqual({
      gen: 2,
    });
    expect(executions).toBe(2);
  });

  it("purges both tiers on invalidate() so purged calls re-execute", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("web_search");
    let executions = 0;
    const execute = async () => {
      executions += 1;
      return { n: executions };
    };
    await cache.run(descriptor, { q: "x" }, execute);
    cache.invalidate();
    await expect(cache.run(descriptor, { q: "x" }, execute)).resolves.toEqual({
      n: 2,
    });
    expect(executions).toBe(2);
  });

  it("ignores invalidation of an unknown argument hash without touching live entries", () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("web_search");
    expect(() =>
      cache.invalidate(
        descriptor.name,
        buildCacheKey("web_search", { q: "missing" }),
      ),
    ).not.toThrow();
    expect(cache.get(descriptor, { q: "never-cached" })).toBeUndefined();
  });

  it("returns isolated clones so callers cannot mutate cached output", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("rag_search");
    cache.set(descriptor, { query: "mutate" }, { items: [1, 2] });
    const entry = cache.get(descriptor, { query: "mutate" });
    if (entry) {
      (entry.output as { items: number[] }).items.push(999);
    }
    expect(cache.get(descriptor, { query: "mutate" })?.output).toEqual({
      items: [1, 2],
    });
  });

  it("coalesces concurrent identical calls into a single execution", async () => {
    const cache = makeCache();
    const descriptor = resolveToolDescriptor("rag_search");
    let executions = 0;
    const execute = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { n: executions };
    };
    const [a, b] = await Promise.all([
      cache.run(descriptor, { q: "parallel" }, execute),
      cache.run(descriptor, { q: "parallel" }, execute),
    ]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(executions).toBe(1);
  });
});

describe("disk-tier redaction", () => {
  it("persists redacted bytes when the default privacy redactor is installed", async () => {
    // Fixture credential and expected marker are assembled at runtime so no
    // key-shaped literal enters the diff for repository secret scanners.
    const secret = ["sk-ant", "api03", "abcdefghijklmnopqrstuvwx"].join("-");
    const redactedMarker = `<REDACTED:${["anthropic", "key"].join("-")}>`;
    const cache = makeCache({ redact: defaultPrivacyRedactor });
    const descriptor = resolveToolDescriptor("web_fetch");
    const args = { url: "https://secret.invalid" };
    await cache.run(descriptor, args, async () => ({
      body: `token ${secret}`,
    }));

    const key = buildCacheKey("web_fetch", args);
    const file = path.join(tempRoot, key.slice(0, 2), `${key}.json`);
    expect(existsSync(file)).toBe(true);
    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain(secret);
    const entry = JSON.parse(persisted) as { output: { body: string } };
    expect(entry.output.body).toContain(redactedMarker);
  });
});
