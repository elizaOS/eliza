/**
 * Tests for the app-authorize hand-off scheme gate
 * (`isSafeAppAuthorizeRedirectUri`): the fail-closed check every authorize
 * navigation target must pass. Pure function, deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { isSafeAppAuthorizeRedirectUri } from "./authorize-return";

describe("isSafeAppAuthorizeRedirectUri", () => {
  it.each([
    "https://app.example/callback",
    "http://localhost:2138/callback",
    "myapp://oauth/callback",
    "myapp:/oauth/callback",
    "eliza-app://auth?next=%2Fhome",
  ])("allows %s", (value) => {
    expect(isSafeAppAuthorizeRedirectUri(value)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "javascript:/alert(1)",
    "javascript://alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "about:blank",
    "blob:https://app.example/1234",
    "mailto:user@example.com",
    "not a url",
    "",
    "//example.com/protocol-relative",
  ])("rejects %s", (value) => {
    expect(isSafeAppAuthorizeRedirectUri(value)).toBe(false);
  });
});
