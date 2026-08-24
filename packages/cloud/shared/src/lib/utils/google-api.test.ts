/**
 * Coverage for google-api pure helpers.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_GOOGLE_SCOPES,
  DEFAULT_GOOGLE_SCOPES,
  GOOGLE_SCOPES,
  generateGoogleAuthUrl,
  validateGoogleScopes,
} from "./google-api.js";

describe("google-api", () => {
  it("validates scopes", () => {
    expect(validateGoogleScopes([GOOGLE_SCOPES.GMAIL_READONLY, "https://evil.com"])).toEqual([
      GOOGLE_SCOPES.GMAIL_READONLY,
    ]);
    expect(validateGoogleScopes([])).toEqual([]);
  });
  it("generates auth url", () => {
    const url = generateGoogleAuthUrl({
      clientId: "cid",
      redirectUri: "https://app.com/cb",
      state: "s1",
    });
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=s1");
    expect(url).toContain("accounts.google.com");
  });
  it("defaults contain expected scopes", () => {
    expect(DEFAULT_GOOGLE_SCOPES).toContain(GOOGLE_SCOPES.USERINFO_EMAIL);
    expect(ALLOWED_GOOGLE_SCOPES.has(GOOGLE_SCOPES.CALENDAR)).toBe(true);
  });
});
