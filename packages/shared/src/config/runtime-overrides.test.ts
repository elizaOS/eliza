/**
 * Covers the process-scoped config override layer merged over `ElizaConfig` at
 * read time. The contract that matters to callers is that overrides adjust
 * config **without mutating the persisted file** — so `applyConfigOverrides`
 * must deep-merge onto a fresh tree and leave the input config untouched, and
 * `setConfigOverride` must refuse a path that could reach `Object.prototype`.
 *
 * Pure module state; each test resets it before and after use. No filesystem, no runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigOverrides,
  getConfigOverrides,
  resetConfigOverrides,
  setConfigOverride,
  unsetConfigOverride,
} from "./runtime-overrides.js";
import type { ElizaConfig } from "./types.eliza.js";

const cfg = (value: unknown): ElizaConfig => value as ElizaConfig;

beforeEach(resetConfigOverrides);
afterEach(resetConfigOverrides);

describe("setConfigOverride / unsetConfigOverride", () => {
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
    expect(setConfigOverride("a.b", 1)).toEqual({ ok: true });
    expect(getConfigOverrides()).toEqual({ a: { b: 1 } });
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

  it("merges nested overrides, preserves siblings and leaves the input untouched", () => {
    const base = cfg({
      server: { port: 3000, host: "localhost" },
      other: true,
    });
    setConfigOverride("server.port", 9999);
    expect(applyConfigOverrides(base)).toEqual({
      server: { port: 9999, host: "localhost" },
      other: true,
    });
    expect(base).toEqual({
      server: { port: 3000, host: "localhost" },
      other: true,
    });
  });

  it("adds a key the base config does not have", () => {
    setConfigOverride("added.deep", "x");
    const merged = applyConfigOverrides(cfg({ existing: 1 }));
    expect(merged).toEqual({ existing: 1, added: { deep: "x" } });
  });

  it("replaces rather than merges when the base value is not a plain object", () => {
    setConfigOverride("list.0", "b");
    const merged = applyConfigOverrides(cfg({ list: ["a", "z"] }));
    expect(merged).toEqual({ list: { 0: "b" } });
  });

  it("replaces a scalar base with a scalar override", () => {
    setConfigOverride("flag", false);
    const merged = applyConfigOverrides(cfg({ flag: true }));
    expect(merged).toEqual({ flag: false });
  });

  it("keeps a null override as an explicit null rather than dropping it", () => {
    setConfigOverride("maybe", null);
    const merged = applyConfigOverrides(cfg({ maybe: { nested: 1 } }));
    expect(merged).toEqual({ maybe: null });
  });
});
