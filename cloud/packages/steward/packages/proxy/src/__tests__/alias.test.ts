import { describe, expect, test } from "bun:test";
import { getAliasNames, isAlias, resolveTarget } from "../handlers/alias";

describe("resolveTarget", () => {
  // ─── Named aliases ──────────────────────────────────────────────────────────

  test("resolves openai alias with path", () => {
    const result = resolveTarget("/openai/v1/chat/completions");
    expect(result).toEqual({
      url: "https://api.openai.com/v1/chat/completions",
      host: "api.openai.com",
      path: "/v1/chat/completions",
    });
  });

  test("resolves anthropic alias", () => {
    const result = resolveTarget("/anthropic/v1/messages");
    expect(result).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      host: "api.anthropic.com",
      path: "/v1/messages",
    });
  });

  test("resolves birdeye alias with nested path", () => {
    const result = resolveTarget("/birdeye/defi/price");
    expect(result).toEqual({
      url: "https://public-api.birdeye.so/defi/price",
      host: "public-api.birdeye.so",
      path: "/defi/price",
    });
  });

  test("resolves alias with no trailing path", () => {
    const result = resolveTarget("/openai");
    expect(result).toEqual({
      url: "https://api.openai.com",
      host: "api.openai.com",
      path: "/",
    });
  });

  // ─── Direct proxy ──────────────────────────────────────────────────────────

  test("resolves direct proxy path", () => {
    const result = resolveTarget("/proxy/custom.api.com/v2/data");
    expect(result).toEqual({
      url: "https://custom.api.com/v2/data",
      host: "custom.api.com",
      path: "/v2/data",
    });
  });

  test("resolves direct proxy with host only", () => {
    const result = resolveTarget("/proxy/example.com");
    expect(result).toEqual({
      url: "https://example.com/",
      host: "example.com",
      path: "/",
    });
  });

  test("rejects direct proxy with invalid hostname (no dot)", () => {
    const result = resolveTarget("/proxy/localhost/path");
    expect(result).toBeNull();
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  test("returns null for empty path", () => {
    expect(resolveTarget("/")).toBeNull();
    expect(resolveTarget("")).toBeNull();
  });

  test("returns null for unknown alias", () => {
    expect(resolveTarget("/unknown/v1/endpoint")).toBeNull();
  });

  test("returns null for /proxy with no host", () => {
    expect(resolveTarget("/proxy")).toBeNull();
    expect(resolveTarget("/proxy/")).toBeNull();
  });
});

describe("getAliasNames", () => {
  test("returns all alias names", () => {
    const names = getAliasNames();
    expect(names).toContain("openai");
    expect(names).toContain("anthropic");
    expect(names).toContain("birdeye");
    expect(names).toContain("coingecko");
    expect(names).toContain("helius");
  });
});

describe("isAlias", () => {
  test("returns true for known aliases", () => {
    expect(isAlias("openai")).toBe(true);
    expect(isAlias("anthropic")).toBe(true);
  });

  test("returns false for unknown names", () => {
    expect(isAlias("unknown")).toBe(false);
    expect(isAlias("proxy")).toBe(false);
  });
});
