import { describe, expect, test } from "bun:test";
import { matchHost, matchPath } from "../handlers/matching";

describe("matchHost", () => {
  test("exact match", () => {
    expect(matchHost("api.openai.com", "api.openai.com")).toBe(true);
  });

  test("no match on different host", () => {
    expect(matchHost("api.openai.com", "api.anthropic.com")).toBe(false);
  });

  test("wildcard prefix match", () => {
    expect(matchHost("*.openai.com", "api.openai.com")).toBe(true);
    expect(matchHost("*.openai.com", "staging.openai.com")).toBe(true);
  });

  test("wildcard does not match the root domain", () => {
    // *.openai.com should NOT match openai.com (needs at least one subdomain)
    expect(matchHost("*.openai.com", "openai.com")).toBe(false);
  });

  test("wildcard does not match partial subdomain", () => {
    expect(matchHost("*.com", "example.com")).toBe(true);
    expect(matchHost("*.example.com", "sub.example.com")).toBe(true);
  });
});

describe("matchPath", () => {
  test("wildcard /* matches everything", () => {
    expect(matchPath("/*", "/")).toBe(true);
    expect(matchPath("/*", "/v1/chat/completions")).toBe(true);
    expect(matchPath("/*", "/any/path/here")).toBe(true);
  });

  test("bare * matches everything", () => {
    expect(matchPath("*", "/anything")).toBe(true);
  });

  test("exact match", () => {
    expect(matchPath("/v1/chat/completions", "/v1/chat/completions")).toBe(true);
    expect(matchPath("/v1/chat/completions", "/v1/embeddings")).toBe(false);
  });

  test("prefix wildcard match", () => {
    expect(matchPath("/v1/*", "/v1/chat/completions")).toBe(true);
    expect(matchPath("/v1/*", "/v1/embeddings")).toBe(true);
    expect(matchPath("/v1/*", "/v1/")).toBe(true);
    expect(matchPath("/v1/*", "/v1")).toBe(true);
  });

  test("prefix wildcard does not match other prefixes", () => {
    expect(matchPath("/v1/*", "/v2/chat")).toBe(false);
    expect(matchPath("/api/v1/*", "/api/v2/data")).toBe(false);
  });

  test("nested prefix wildcard", () => {
    expect(matchPath("/api/defi/*", "/api/defi/price")).toBe(true);
    expect(matchPath("/api/defi/*", "/api/defi/volume/24h")).toBe(true);
    expect(matchPath("/api/defi/*", "/api/nft/price")).toBe(false);
  });
});
