import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  claudeMinRemainingMs,
  DEFAULT_CLAUDE_EXPECTED_RUN_MS,
  isTokenExpiryText,
  resolveClaudeExpectedRunMs,
  shouldProactivelyRefreshClaudeToken,
} from "./claude-token-refresh.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("resolveClaudeExpectedRunMs", () => {
  it("returns the default when unset/blank", () => {
    expect(resolveClaudeExpectedRunMs(() => undefined)).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
    expect(resolveClaudeExpectedRunMs(() => "   ")).toBe(
      DEFAULT_CLAUDE_EXPECTED_RUN_MS,
    );
  });

  it("honors a valid positive override", () => {
    expect(
      resolveClaudeExpectedRunMs((k) =>
        k === "ELIZA_CLAUDE_EXPECTED_RUN_MS" ? String(30 * MIN) : undefined,
      ),
    ).toBe(30 * MIN);
  });

  it("falls back to the default on non-numeric / non-positive input", () => {
    for (const bad of ["abc", "0", "-5", "NaN", "1e999abc"]) {
      expect(resolveClaudeExpectedRunMs(() => bad)).toBe(
        DEFAULT_CLAUDE_EXPECTED_RUN_MS,
      );
    }
  });

  it("clamps an absurdly small override up to the 1-minute floor", () => {
    expect(resolveClaudeExpectedRunMs(() => "500")).toBe(MIN);
  });

  it("clamps an absurdly large override down to the 6-hour ceiling", () => {
    expect(resolveClaudeExpectedRunMs(() => String(999 * HOUR))).toBe(6 * HOUR);
  });

  it("floors a fractional override", () => {
    expect(resolveClaudeExpectedRunMs(() => "90000.9")).toBe(90000);
  });
});

describe("claudeMinRemainingMs", () => {
  it("is exactly the expected run duration", () => {
    expect(claudeMinRemainingMs(42)).toBe(42);
  });
});

describe("shouldProactivelyRefreshClaudeToken", () => {
  const nowMs = 1_000_000;
  const expectedRunMs = 55 * MIN;

  it("refreshes when remaining TTL is below the expected run", () => {
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs + 10 * MIN,
        nowMs,
        expectedRunMs,
      }),
    ).toBe(true);
  });

  it("does NOT refresh when remaining TTL exceeds the expected run", () => {
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs + 90 * MIN,
        nowMs,
        expectedRunMs,
      }),
    ).toBe(false);
  });

  it("refreshes an already-expired token", () => {
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs - 1,
        nowMs,
        expectedRunMs,
      }),
    ).toBe(true);
  });

  it("refreshes (fail-safe) when expiry is unknown", () => {
    for (const unknown of [null, undefined, Number.NaN, Infinity]) {
      expect(
        shouldProactivelyRefreshClaudeToken({
          expiresAtMs: unknown as number | null | undefined,
          nowMs,
          expectedRunMs,
        }),
      ).toBe(true);
    }
  });

  it("boundary: TTL exactly equal to expected run is NOT below it (no refresh)", () => {
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs + expectedRunMs,
        nowMs,
        expectedRunMs,
      }),
    ).toBe(false);
  });

  it("a FRESH Anthropic token (~55min) is NOT refreshed under the default threshold (anti-thrash)", () => {
    // Regression for the every-spawn-refresh trap: Anthropic stores
    // expires = now + expires_in - 5min, so a just-refreshed ~1h token sits at
    // ~55min remaining. The 45-min default must leave it alone, otherwise every
    // Claude spawn would re-refresh a perfectly fresh token.
    const freshTtl = 55 * MIN;
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs + freshTtl,
        nowMs,
        expectedRunMs: DEFAULT_CLAUDE_EXPECTED_RUN_MS,
      }),
    ).toBe(false);
    // But a token already well into its life (30min left) IS refreshed.
    expect(
      shouldProactivelyRefreshClaudeToken({
        expiresAtMs: nowMs + 30 * MIN,
        nowMs,
        expectedRunMs: DEFAULT_CLAUDE_EXPECTED_RUN_MS,
      }),
    ).toBe(true);
  });
});

describe("isTokenExpiryText / classifyAuthFailureReason", () => {
  const expiryPhrases = [
    "OAuth token has expired",
    "access token expired",
    "the token is expired, please refresh",
    "Error: token expired",
    "jwt expired",
    "session expired",
    "expired_token returned by provider",
  ];

  for (const phrase of expiryPhrases) {
    it(`detects expiry phrase: ${JSON.stringify(phrase)}`, () => {
      expect(isTokenExpiryText(phrase)).toBe(true);
      expect(classifyAuthFailureReason(phrase)).toBe("token_expired");
    });
  }

  it("does NOT treat a bare 401 / unauthorized as expiry (routes to needs_reauth)", () => {
    for (const auth of [
      "401 Unauthorized",
      "invalid_grant",
      "revoked credential",
      "please re-authenticate",
    ]) {
      expect(isTokenExpiryText(auth)).toBe(false);
      expect(classifyAuthFailureReason(auth)).toBe("needs_reauth");
    }
  });

  it("returns unknown / false on empty input", () => {
    expect(isTokenExpiryText("")).toBe(false);
    expect(isTokenExpiryText(null)).toBe(false);
    expect(isTokenExpiryText(undefined)).toBe(false);
    expect(classifyAuthFailureReason("")).toBe("unknown");
    expect(classifyAuthFailureReason(null)).toBe("unknown");
  });

  it("returns only enum values, never any substring of the (token-bearing) input", () => {
    // A message that embeds a token-like string but no expiry phrase must NOT
    // be classified as expiry, and the classifier's return value is always one
    // of the four fixed enum strings — never a slice of the input (so token
    // material can never leak through the classifier's output).
    const withTokenlike =
      "auth failed for sk-ant-oat01-REDACTEDSECRETVALUE unauthorized";
    expect(isTokenExpiryText(withTokenlike)).toBe(false);
    const reason = classifyAuthFailureReason(withTokenlike);
    expect([
      "token_expired",
      "needs_reauth",
      "rate_limited",
      "unknown",
    ]).toContain(reason);
    // The returned enum value is not a substring of the sensitive input.
    expect(withTokenlike.includes(reason)).toBe(false);
  });
});
