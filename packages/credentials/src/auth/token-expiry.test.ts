/**
 * Verifies the shared access-token expiry classifier against explicit expiry,
 * generic authorization, and absent provider details.
 */

import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  isRefreshTokenExpiryText,
  isTokenExpiryText,
} from "./token-expiry";

describe("access-token expiry classification", () => {
  it.each([
    "token expired",
    "expired token",
    "oauth token has expired",
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
    "access token expired",
    "access token is expired",
    "access_token_expired",
    "ACCESS_TOKEN_HAS_EXPIRED",
    "JWT expired",
    "jwt_expired",
    "session expired",
    "session_expired",
  ])("recognizes explicit expiry text: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(true);
    expect(isRefreshTokenExpiryText(text)).toBe(false);
    expect(classifyAuthFailureReason(text)).toBe("token_expired");
  });

  it.each([
    ["401 unauthorized", false],
    ["unauthorized", false],
    ["invalid token", false],
    ["invalid credentials", false],
    ["credentials revoked", false],
    ["token revoked", false],
    ["refresh token expired", true],
    ["refresh token has expired", true],
    ["refresh token is expired", true],
    ["Refresh Token Is Expired", true],
    ["refresh_token has expired", true],
    ["The refresh token expired", true],
    ["refresh_token_expired", true],
    ["error=refresh_token_expired", true],
    ["access_token_expired; refresh_token_expired", true],
  ])(
    "requires reauthentication for non-access-token failures: %s",
    (text, refreshExpired) => {
      expect(isTokenExpiryText(text)).toBe(false);
      expect(isRefreshTokenExpiryText(text)).toBe(refreshExpired);
      expect(classifyAuthFailureReason(text)).toBe("needs_reauth");
    },
  );

  it.each([undefined, null, "", "  ", "   "])(
    "preserves missing provider detail %p as unknown",
    (text) => {
      expect(isTokenExpiryText(text)).toBe(false);
      expect(isRefreshTokenExpiryText(text)).toBe(false);
      expect(classifyAuthFailureReason(text)).toBe("unknown");
    },
  );
});
