import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  isRefreshTokenExpiryText,
  isTokenExpiryText,
} from "./token-expiry.ts";

describe("isRefreshTokenExpiryText", () => {
  it("recognizes explicit refresh-token expiry language", () => {
    expect(isRefreshTokenExpiryText("refresh token expired")).toBe(true);
    expect(isRefreshTokenExpiryText("refresh_token has expired")).toBe(true);
    expect(isRefreshTokenExpiryText("Refresh Token Is Expired")).toBe(true);
  });

  it("rejects unrelated text", () => {
    expect(isRefreshTokenExpiryText("access token expired")).toBe(false);
    expect(isRefreshTokenExpiryText("")).toBe(false);
    expect(isRefreshTokenExpiryText(null)).toBe(false);
    expect(isRefreshTokenExpiryText("token revoked")).toBe(false);
  });
});

describe("isTokenExpiryText", () => {
  it("recognizes access-token expiry language", () => {
    expect(isTokenExpiryText("token expired")).toBe(true);
    expect(isTokenExpiryText("expired token")).toBe(true);
    expect(isTokenExpiryText("oauth token has expired")).toBe(true);
    expect(isTokenExpiryText("JWT expired")).toBe(true);
    expect(isTokenExpiryText("session expired")).toBe(true);
  });

  it("does not treat refresh-token expiry as benign access-token expiry", () => {
    expect(isTokenExpiryText("refresh token expired")).toBe(false);
  });

  it("rejects non-expiry auth text", () => {
    expect(isTokenExpiryText("invalid credentials")).toBe(false);
    expect(isTokenExpiryText(null)).toBe(false);
  });
});

describe("classifyAuthFailureReason", () => {
  it("classifies explicit expiry as token_expired", () => {
    expect(classifyAuthFailureReason("token expired")).toBe("token_expired");
  });

  it("classifies refresh expiry as needs_reauth (dead credential)", () => {
    expect(classifyAuthFailureReason("refresh token expired")).toBe(
      "needs_reauth",
    );
  });

  it("classifies other auth text as needs_reauth", () => {
    expect(classifyAuthFailureReason("unauthorized")).toBe("needs_reauth");
    expect(classifyAuthFailureReason("")).toBe("unknown");
    expect(classifyAuthFailureReason("  ")).toBe("unknown");
    expect(classifyAuthFailureReason(null)).toBe("unknown");
  });
});
