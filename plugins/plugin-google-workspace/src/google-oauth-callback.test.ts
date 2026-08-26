/**
 * Regression tests for the canonical Google connector OAuth callback contract:
 * shared redirect URI between chat and Settings, and rejection of portless
 * loopback INTERNAL_URL-style defaults.
 */
import { describe, expect, it } from "vitest";
import {
  assessGoogleOAuthCallbackConfig,
  GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH,
  isPortlessLoopbackRedirectUrl,
  resolveGoogleConnectorOAuthCallbackUrl,
} from "./google-oauth-callback.js";

const CANONICAL = "http://127.0.0.1:31437/api/connectors/google/oauth/callback";

function runtimeWithRedirect(uri?: string) {
  return {
    getSetting: (key: string) => (key === "GOOGLE_REDIRECT_URI" ? uri : undefined),
  };
}

describe("google oauth callback contract", () => {
  it("accepts a loopback callback with an explicit port", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL));
    expect(assessment.configured).toBe(true);
    expect(assessment.redirectUri).toBe(CANONICAL);
    expect(assessment.issues).toEqual([]);
    expect(resolveGoogleConnectorOAuthCallbackUrl(runtimeWithRedirect(CANONICAL))).toBe(CANONICAL);
  });

  it("rejects a portless loopback callback derived from INTERNAL_URL", () => {
    const portless = "http://127.0.0.1/api/connectors/google/oauth/callback";
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(portless));
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "portless_loopback")).toBe(true);
    expect(isPortlessLoopbackRedirectUrl(new URL(portless))).toBe(true);
    expect(() => resolveGoogleConnectorOAuthCallbackUrl(runtimeWithRedirect(portless))).toThrow(
      /portless loopback/i
    );
  });

  it("rejects a missing redirect URI", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect());
    expect(assessment.configured).toBe(false);
    expect(assessment.issues[0]?.code).toBe("missing");
  });

  it("reports the exact served callback when the redirect URI is missing", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(), {
      servedOrigin: "http://127.0.0.1:43232/api/lifeops/connectors/google/start",
    });
    expect(assessment.issues[0]?.message).toContain(
      "http://127.0.0.1:43232/api/connectors/google/oauth/callback"
    );
    expect(assessment.issues[0]?.message).not.toContain(":31437");
  });

  it("reports the exact served callback for a portless loopback setting", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect("http://127.0.0.1/api/connectors/google/oauth/callback"),
      {
        servedOrigin: "http://127.0.0.1:43232/api/lifeops/connectors/google/start",
      }
    );
    const issue = assessment.issues.find((candidate) => candidate.code === "portless_loopback");
    expect(issue?.message).toContain("http://127.0.0.1:43232/api/connectors/google/oauth/callback");
    expect(issue?.message).not.toContain(":31437");
  });

  it("rejects a callback on the wrong path", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect("http://127.0.0.1:31437/oauth/google/callback")
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "wrong_path")).toBe(true);
    expect(GOOGLE_CONNECTOR_OAUTH_CALLBACK_PATH).toBe("/api/connectors/google/oauth/callback");
  });

  it("allows production https callbacks without an explicit port", () => {
    const production = "https://eliza.example/api/connectors/google/oauth/callback";
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(production));
    expect(assessment.configured).toBe(true);
    expect(isPortlessLoopbackRedirectUrl(new URL(production))).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    for (const uri of [
      "ftp://127.0.0.1:31437/api/connectors/google/oauth/callback",
      "javascript:alert(1)",
    ]) {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(uri));
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_scheme")).toBe(true);
    }
  });

  it("rejects plain http on a non-loopback host", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect("http://eliza.example/api/connectors/google/oauth/callback")
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "wrong_scheme")).toBe(true);
  });

  it("rejects credential-bearing callbacks", () => {
    const secret = "callback-password-must-not-leak";
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect(
        `http://user:${secret}@127.0.0.1:31437/api/connectors/google/oauth/callback`
      )
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.redirectUri).toBeNull();
    expect(JSON.stringify(assessment)).not.toContain(secret);
    expect(assessment.issues.some((issue) => issue.code === "credentials")).toBe(true);
  });

  it("rejects query-bearing callbacks", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect(`${CANONICAL}?next=https://evil.example`)
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "query")).toBe(true);
  });

  it("rejects fragment-bearing callbacks", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(`${CANONICAL}#frag`));
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "fragment")).toBe(true);
  });

  it("rejects callbacks carrying an explicitly empty query or fragment", () => {
    for (const uri of [`${CANONICAL}?`, `${CANONICAL}#`]) {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(uri));
      expect(assessment.configured).toBe(false);
      expect(assessment.redirectUri).toBeNull();
    }
  });

  it("rejects a trailing slash instead of normalizing a different callback path", () => {
    const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(`${CANONICAL}/`));
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "wrong_path")).toBe(true);
  });

  it("treats a portless bracketed ::1 loopback as portless loopback", () => {
    const assessment = assessGoogleOAuthCallbackConfig(
      runtimeWithRedirect("http://[::1]/api/connectors/google/oauth/callback")
    );
    expect(assessment.configured).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === "portless_loopback")).toBe(true);
  });

  describe("served-origin comparison", () => {
    it("rejects a callback on a different host than the served origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("https://other.example/api/connectors/google/oauth/callback"),
        { servedOrigin: new URL("http://eliza.example/api/lifeops/connectors/google") }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });

    it("rejects a loopback callback on a different port than the served origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL), {
        servedOrigin: new URL("http://127.0.0.1:2138/api/lifeops/connectors/google"),
      });
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_port")).toBe(true);
    });

    it("rejects a loopback callback when the API is served on a public host", () => {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL), {
        servedOrigin: new URL("http://eliza.example/api/lifeops/connectors/google"),
      });
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });

    it("rejects distinct loopback spellings without proof that one listener covers both", () => {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL), {
        servedOrigin: new URL("http://localhost:31437/api/lifeops/connectors/google"),
      });
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });

    it("accepts a production https callback served behind a default-port proxy", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("https://eliza.example/api/connectors/google/oauth/callback"),
        { servedOrigin: new URL("https://eliza.example/api/lifeops/connectors/google") }
      );
      expect(assessment.configured).toBe(true);
    });

    it("rejects a loopback callback when a portless origin says the API is on port 80", () => {
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL), {
        servedOrigin: new URL("http://127.0.0.1/"),
      });
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_port")).toBe(true);
    });

    it("rejects a callback whose scheme differs from the served origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("https://eliza.example/api/connectors/google/oauth/callback"),
        { servedOrigin: "http://eliza.example" }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_scheme")).toBe(true);
    });

    it("rejects a custom callback port for a default-port public origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("https://eliza.example:8443/api/connectors/google/oauth/callback"),
        { servedOrigin: "https://eliza.example" }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_port")).toBe(true);
    });

    it("rejects a default-port callback for a custom-port public origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("https://eliza.example/api/connectors/google/oauth/callback"),
        { servedOrigin: "https://eliza.example:8443" }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_port")).toBe(true);
    });

    it("rejects a malformed served origin without echoing it", () => {
      const secret = "external-origin-secret";
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(CANONICAL), {
        servedOrigin: `not a URL ${secret}`,
      });
      expect(assessment.configured).toBe(false);
      expect(assessment.redirectUri).toBeNull();
      expect(assessment.issues.some((issue) => issue.code === "served_origin_malformed")).toBe(
        true
      );
      expect(JSON.stringify(assessment)).not.toContain(secret);
    });
  });

  describe("loopback host classification", () => {
    it("rejects a DNS name beginning with 127. as a plain-http callback host", () => {
      const probe = "http://127.0.0.1.attacker.example:31437/api/connectors/google/oauth/callback";
      const assessment = assessGoogleOAuthCallbackConfig(runtimeWithRedirect(probe));
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_scheme")).toBe(true);
    });

    it("rejects a short 127.-prefixed DNS name as a plain-http callback host", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("http://127.evil:31437/api/connectors/google/oauth/callback")
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_scheme")).toBe(true);
    });

    it("does not treat a 127.-prefixed DNS name as host-equivalent to a served loopback origin", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect(
          "https://127.0.0.1.attacker.example:31437/api/connectors/google/oauth/callback"
        ),
        { servedOrigin: new URL("http://127.0.0.1:31437/api/lifeops/connectors/google") }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });

    it("accepts the same genuinely numeric 127.0.0.0/8 address", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("http://127.0.0.2:31437/api/connectors/google/oauth/callback"),
        { servedOrigin: new URL("http://127.0.0.2:31437/") }
      );
      expect(assessment.configured).toBe(true);
    });

    it("rejects a callback on another numeric 127/8 address", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("http://127.0.0.2:31437/api/connectors/google/oauth/callback"),
        { servedOrigin: new URL("http://127.0.0.1:31437/") }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });

    it("rejects an IPv6 callback for an IPv4-only served listener", () => {
      const assessment = assessGoogleOAuthCallbackConfig(
        runtimeWithRedirect("http://[::1]:31437/api/connectors/google/oauth/callback"),
        { servedOrigin: new URL("http://127.0.0.1:31437/") }
      );
      expect(assessment.configured).toBe(false);
      expect(assessment.issues.some((issue) => issue.code === "wrong_host")).toBe(true);
    });
  });
});
