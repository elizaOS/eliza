/**
 * Covers the process-scoped config override layer merged over `ElizaConfig` at
 * read time. The contract that matters to callers is that overrides adjust
 * config **without mutating the persisted file** — so `applyConfigOverrides`
 * must deep-merge onto a fresh tree and leave the input config untouched, and
 * `setConfigOverride` must refuse a path that could reach `Object.prototype`.
 *
 * Pure module state; each test resets it first. No filesystem, no runtime.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import type { ElizaConfig } from "./types.eliza.js";

const cfg = (value: unknown): ElizaConfig => value as ElizaConfig;

beforeEach(() => {
  resetConfigOverrides();
});

describe("setConfigOverride / unsetConfigOverride", () => {
  it("stores a value at a dotted path", () => {
    expect(setConfigOverride("a.b.c", 1)).toEqual({ ok: true });
    expect(getConfigOverrides()).toMatchObject({ a: { b: { c: 1 } } });
  });

  it("rejects an empty or malformed path without mutating state", () => {
    const result = setConfigOverride("   ", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(Object.keys(getConfigOverrides())).toHaveLength(0);
  });

  it("rejects a path segment that could reach Object.prototype", () => {
    const result = setConfigOverride("__proto__.polluted", true);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(getConfigOverrides())).toHaveLength(0);
  });

  it("reports whether an unset actually removed something", () => {
    setConfigOverride("a.b", 1);
    expect(unsetConfigOverride("a.b")).toEqual({ ok: true, removed: true });
    expect(unsetConfigOverride("a.b")).toEqual({ ok: true, removed: false });
  });

  it("rejects an unset on a malformed path", () => {
    const result = unsetConfigOverride("");
    expect(result.ok).toBe(false);
    expect(result.removed).toBe(false);
  });

  it("resetConfigOverrides clears every stored override", () => {
    setConfigOverride("a.b", 1);
    resetConfigOverrides();
    expect(Object.keys(getConfigOverrides())).toHaveLength(0);
  });
});

describe("applyConfigOverrides", () => {
  it("returns the config unchanged when no overrides are set", () => {
    const base = cfg({ a: 1 });
    expect(applyConfigOverrides(base)).toBe(base);
  });

  it("merges nested overrides without dropping sibling keys", () => {
    setConfigOverride("server.port", 9999);
    const merged = applyConfigOverrides(
      cfg({ server: { port: 3000, host: "localhost" }, other: true }),
    ) as unknown as Record<string, Record<string, unknown>>;
    expect(merged.server).toEqual({ port: 9999, host: "localhost" });
    expect(merged.other).toBe(true);
  });

  it("does not mutate the input config", () => {
    setConfigOverride("server.port", 9999);
    const base = cfg({ server: { port: 3000 } });
    applyConfigOverrides(base);
    expect((base as unknown as { server: { port: number } }).server.port).toBe(
      3000,
    );
  });

  it("adds a key the base config does not have", () => {
    setConfigOverride("added.deep", "x");
    const merged = applyConfigOverrides(
      cfg({ existing: 1 }),
    ) as unknown as Record<string, unknown>;
    expect(merged).toMatchObject({ existing: 1, added: { deep: "x" } });
  });

  it("replaces rather than merges when the base value is not a plain object", () => {
    setConfigOverride("list.0", "b");
    const merged = applyConfigOverrides(
      cfg({ list: ["a", "z"] }),
    ) as unknown as Record<string, unknown>;
    // An array base is not a plain object, so the override subtree replaces it.
    expect(Array.isArray(merged.list)).toBe(false);
    expect(merged.list).toMatchObject({ 0: "b" });
  });

  it("replaces a scalar base with a scalar override", () => {
    setConfigOverride("flag", false);
    const merged = applyConfigOverrides(
      cfg({ flag: true }),
    ) as unknown as Record<string, unknown>;
    expect(merged.flag).toBe(false);
  });

  it("keeps a null override as an explicit null rather than dropping it", () => {
    setConfigOverride("maybe", null);
    const merged = applyConfigOverrides(
      cfg({ maybe: { nested: 1 } }),
    ) as unknown as Record<string, unknown>;
    expect(merged.maybe).toBeNull();
  });
});
