/**
 * Verifies the shared access-token expiry classifier against explicit expiry,
 * generic authorization, and absent provider details.
 */

import { describe, expect, it } from "vitest";
import { classifyAuthFailureReason, isTokenExpiryText } from "./token-expiry";

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
    "access token is expired",
    "JWT expired",
    "session expired",
  ])("recognizes explicit expiry text: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(true);
    expect(classifyAuthFailureReason(text)).toBe("token_expired");
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
  ])("requires reauthentication for non-access-token failures: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(false);
    expect(classifyAuthFailureReason(text)).toBe("needs_reauth");
  });

  it("preserves missing provider detail as an unknown reason", () => {
    expect(isTokenExpiryText(undefined)).toBe(false);
    expect(classifyAuthFailureReason(undefined)).toBe("unknown");
  });
});
