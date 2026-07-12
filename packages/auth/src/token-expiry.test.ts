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
  ])("does not infer expiry from a generic authorization failure: %s", (text) => {
    expect(isTokenExpiryText(text)).toBe(false);
    expect(classifyAuthFailureReason(text)).toBe("needs_reauth");
  });

  it("preserves missing provider detail as an unknown reason", () => {
    expect(isTokenExpiryText(undefined)).toBe(false);
    expect(classifyAuthFailureReason(undefined)).toBe("unknown");
  });
});
