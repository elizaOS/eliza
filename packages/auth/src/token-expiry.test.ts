/**
 * Verifies the shared access-token expiry classifier against explicit expiry,
 * generic authorization, and absent provider details.
 */

import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  isRateLimitText,
  isTokenExpiryText,
} from "./token-expiry";

describe("access-token expiry classification", () => {
  it.each([
    "token expired",
    "token has expired",
    "expired_token",
    "token_expired",
    "TOKEN_EXPIRED",
    "error=token_expired",
    "error: token_expired",
    "OAuth error token_expired",
    '{"error":"token_expired"}',
    "OAuth token has expired",
    "OAuth token is expired",
    "oauth_token_expired",
    "OAUTH_TOKEN_HAS_EXPIRED",
    "access token is expired",
    "access_token_expired",
    "ACCESS_TOKEN_HAS_EXPIRED",
    "JWT expired",
    "jwt_expired",
    "session expired",
    "session_expired",
  ])("recognizes explicit expiry text: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(true);
    expect(classifyAuthFailureReason(text)).toBe("token_expired");
  });

  it.each([
    "429 Too Many Requests",
    "rate limit exceeded",
    "rate_limit_exceeded",
    "RATE_LIMITED",
    "too many requests",
    "quota exceeded",
    "resource exhausted",
    "usage limit reached",
    "credit limit exceeded",
  ])("recognizes explicit rate-limiting text: %s", (text) => {
    expect(isRateLimitText(text)).toBe(true);
    expect(classifyAuthFailureReason(text)).toBe("rate_limited");
  });

  it.each([
    "401 unauthorized",
    "invalid token",
    "credentials revoked",
    "refresh token expired",
    "refresh token has expired",
    "refresh token is expired",
    "The refresh token expired",
    "refresh_token_expired",
    "error=refresh_token_expired",
    "access_token_expired; refresh_token_expired",
  ])("requires reauthentication for non-access-token failures: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(false);
    expect(classifyAuthFailureReason(text)).toBe("needs_reauth");
  });

  it("preserves missing provider detail as an unknown reason", () => {
    expect(isTokenExpiryText(undefined)).toBe(false);
    expect(classifyAuthFailureReason(undefined)).toBe("unknown");
    expect(classifyAuthFailureReason(null)).toBe("unknown");
    expect(classifyAuthFailureReason("")).toBe("unknown");
    expect(classifyAuthFailureReason("   ")).toBe("unknown");
  });
});
