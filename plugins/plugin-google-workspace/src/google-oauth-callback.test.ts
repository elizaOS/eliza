/**
 * Regression tests for the canonical Google connector OAuth callback contract:
 * shared redirect URI between chat and Settings, and rejection of portless
 * loopback INTERNAL_URL-style defaults.
 */
import { describe, expect, it } from "vitest";
import {
  assessGoogleOAuthCallbackConfig,
  assertCanonicalGoogleOAuthRedirectUri,
  GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH,
  isPortlessLoopbackRedirectUrl,
  resolveGoogleConnectorOAuthCallbackUrl,
} from "./google-oauth-callback.js";

const CANONICAL =
  "http://127.0.0.1:31437/api/connectors/google/oauth/callback";

function runtimeWithRedirect(uri?: string) {
  return {
    getSetting: (key: string) =>
      key === "GOOGLE_REDIRECT_URI" ? uri : undefined,
  };
}

describe("google oauth callback contract", () => {
  it("accepts a loopback callback with an explicit port", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect(CANONICAL),
    );
    expect(assessment.configured).toBe(true);
    expect(assessment.redirectUri).toBe(CANONICAL);
    expect(assessment.issues).toEqual([]);
    expect(resolveGoogleConnectorOAuthCallbackUrl(runtimeWithRedirect(CANONICAL)))
      .toBe(CANONICAL);
  });

  it("rejects a portless loopback callback derived from INTERNAL_URL", () => {
    const portless =
      "http://127.0.0.1/api/connectors/google/oauth/callback";
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect(portless),
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "portless_loopback"))
      .toBe(true);
    expect(isPortlessLoopbackRedirectUrl(new URL(portless))).toBe(true);
    expect(() =>
      resolveGoogleConnectorOAuthCallbackUrl(runtimeWithRedirect(portless)),
    ).toThrow(/portless loopback/i);
  });

  it("rejects a missing redirect URI", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect());
    expect(assessment.configured).toBe(false);
    expect(assessment.issues[0]?.code).toBe("missing");
  });

  it("rejects a callback on the wrong path", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect("http://127.0.0.1:31437/oauth/google/callback"),
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "wrong_path"))
      .toBe(true);
    expect(GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH).toBe(
      "/api/connectors/google/oauth/callback",
    );
  });

  it("allows production https callbacks without an explicit port", () => {
    const production =
      "https://eliza.example/api/connectors/google/oauth/callback";
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect(production),
    );
    expect(assessment.configured).toBe(true);
    expect(isPortlessLoopbackRedirectUrl(new URL(production))).toBe(false);
  });

  it("rejects a requested redirect URI that disagrees with the canonical value", () => {
    expect(() =>
      assertCanonicalGoogleOAuthRedirectUri(
        CANONICAL,
        "http://127.0.0.1/api/connectors/google/oauth/callback",
      ),
    ).toThrow(/redirect uri mismatch/i);
    assertCanonicalGoogleOAuthRedirectUri(CANONICAL, CANONICAL);
    assertCanonicalGoogleOAuthRedirectUri(CANONICAL, undefined);
  });
});
