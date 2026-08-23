import { describe, expect, it } from "vitest";
import {
  classifyAuthFailureReason,
  isRefreshTokenExpiryText,
  isTokenExpiryText,
} from "./token-expiry.ts";

describe("isRefreshTokenExpiryText", () => {
  it("detects explicit refresh-token expiry language", () => {
    expect(isRefreshTokenExpiryText("refresh token expired")).toBe(true);
    expect(isRefreshTokenExpiryText("refresh_token has expired")).toBe(true);
    expect(isRefreshTokenExpiryText("REFRESH TOKEN IS EXPIRED")).toBe(true);
  });

  it("rejects access-token expiry and junk", () => {
    expect(isRefreshTokenExpiryText("access token expired")).toBe(false);
    expect(isRefreshTokenExpiryText("token expired")).toBe(false);
    expect(isRefreshTokenExpiryText("")).toBe(false);
    expect(isRefreshTokenExpiryText(null)).toBe(false);
  });
});

describe("isTokenExpiryText", () => {
  it("detects explicit access-token expiry language", () => {
    expect(isTokenExpiryText("token expired")).toBe(true);
    expect(isTokenExpiryText("expired token")).toBe(true);
    expect(isTokenExpiryText("jwt expired")).toBe(true);
    expect(isTokenExpiryText("session expired")).toBe(true);
    expect(isTokenExpiryText("oauth token has expired")).toBe(true);
  });

  it("excludes refresh-token expiry", () => {
    expect(isTokenExpiryText("refresh token expired")).toBe(false);
  });
});

describe("classifyAuthFailureReason", () => {
  it("classifies token expiry", () => {
    expect(classifyAuthFailureReason("jwt expired")).toBe("token_expired");
  });

  it("classifies other auth failures as needs_reauth", () => {
    expect(classifyAuthFailureReason("invalid credentials")).toBe("needs_reauth");
  });

  it("returns unknown for empty input", () => {
    expect(classifyAuthFailureReason("")).toBe("unknown");
    expect(classifyAuthFailureReason(null)).toBe("unknown");
    expect(classifyAuthFailureReason(undefined)).toBe("unknown");
  });
});
