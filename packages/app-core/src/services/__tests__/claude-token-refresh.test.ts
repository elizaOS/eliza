import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/auth/token-expiry", () => ({
  isTokenExpiryText: () => false,
  isRefreshTokenExpiryText: () => false,
  classifyAuthFailureReason: () => "unknown",
}));

import {
  DEFAULT_CLAUDE_EXPECTED_RUN_MS,
  resolveClaudeExpectedRunMs,
  shouldProactivelyRefreshClaudeToken,
} from "./claude-token-refresh.ts";

describe("resolveClaudeExpectedRunMs", () => {
  it("defaults when unset or empty", () => {
    expect(resolveClaudeExpectedRunMs(() => undefined)).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
    expect(resolveClaudeExpectedRunMs(() => "  ")).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
  });

  it("parses a valid override", () => {
    expect(resolveClaudeExpectedRunMs(() => "120000")).toBe(120_000);
  });

  it("falls back on malformed values", () => {
    expect(resolveClaudeExpectedRunMs(() => "abc")).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
    expect(resolveClaudeExpectedRunMs(() => "0")).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
    expect(resolveClaudeExpectedRunMs(() => "-5")).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
  });

  it("clamps to the sane range", () => {
    expect(resolveClaudeExpectedRunMs(() => "1000")).toBe(60_000); // 低于下限
    expect(resolveClaudeExpectedRunMs(() => "99999999999")).toBe(
      6 * 60 * 60 * 1000,
    ); // 高于上限
  });
});

describe("shouldProactivelyRefreshClaudeToken", () => {
  it("refreshes when remaining ttl is below the expected run", () => {
    const nowMs = 1_000_000;
    const expiresAtMs = nowMs + 10 * 60 * 1000; // 10 分钟剩余
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs,
        nowMs,
        expectedRunMs: 45 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("reuses a fresh token", () => {
    const nowMs = 1_000_000;
    const expiresAtMs = nowMs + 55 * 60 * 1000; // 55 分钟剩余
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs,
        nowMs,
        expectedRunMs: 45 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("refreshes when expiry is missing (fail-closed)", () => {
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: null,
        nowMs: 1_000_000,
        expectedRunMs: 45 * 60 * 1000,
      }),
    ).toBe(true);
  });
});
