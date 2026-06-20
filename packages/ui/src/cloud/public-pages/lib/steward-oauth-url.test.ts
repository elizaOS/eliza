/**
 * Coverage for the OAuth redirect_uri helpers in `./steward-oauth-url.ts`.
 *
 * The authorize-time and exchange-time redirect_uri must be identical (Steward
 * rejects mismatches), and they must differ between web and native: native
 * Capacitor cannot use `${origin}/login` (origin is `capacitor://localhost`)
 * and instead returns through the app's custom URL scheme.
 */

import { describe, expect, it } from "vitest";
import {
  buildNativeOAuthRedirectUri,
  buildStewardOAuthRedirectUri,
  NATIVE_OAUTH_REDIRECT_URI,
  resolveOAuthRedirectUri,
} from "./steward-oauth-url";

describe("resolveOAuthRedirectUri", () => {
  it("returns the native custom-scheme URI when native", () => {
    expect(resolveOAuthRedirectUri(true, "https://elizacloud.ai")).toBe(
      "elizaos://login",
    );
    // Origin is ignored on native (it would be capacitor://localhost).
    expect(resolveOAuthRedirectUri(true, "capacitor://localhost")).toBe(
      "elizaos://login",
    );
  });

  it("returns origin + /login on web", () => {
    expect(resolveOAuthRedirectUri(false, "https://elizacloud.ai")).toBe(
      "https://elizacloud.ai/login",
    );
    expect(resolveOAuthRedirectUri(false, "http://localhost:2138")).toBe(
      "http://localhost:2138/login",
    );
  });

  it("agrees with buildStewardOAuthRedirectUri on web", () => {
    const origin = "https://staging.elizacloud.ai";
    expect(resolveOAuthRedirectUri(false, origin)).toBe(
      buildStewardOAuthRedirectUri(origin),
    );
  });

  it("agrees with buildNativeOAuthRedirectUri on native", () => {
    expect(resolveOAuthRedirectUri(true, "anything")).toBe(
      buildNativeOAuthRedirectUri(),
    );
  });
});

describe("NATIVE_OAUTH_REDIRECT_URI", () => {
  it("is the custom scheme with host `login` and no path", () => {
    expect(NATIVE_OAUTH_REDIRECT_URI).toBe("elizaos://login");
    const parsed = new URL(NATIVE_OAUTH_REDIRECT_URI);
    expect(parsed.protocol).toBe("elizaos:");
    expect(parsed.host).toBe("login");
    expect(parsed.pathname).toBe("");
  });
});
