import { describe, expect, test } from "bun:test";
import { buildStewardOAuthAuthorizeUrl } from "@/apps/frontend/src/pages/login/steward-oauth-url";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";

describe("buildStewardOAuthAuthorizeUrl", () => {
  test("uses tenant_id for the Steward OAuth authorize URL", () => {
    const STEWARD_TENANT_ID = "elizacloud";
    const authorizeUrl = buildStewardOAuthAuthorizeUrl("google", "https://app.elizacloud.ai", {
      stewardApiUrl: "https://eliza.steward.fi",
      stewardTenantId: STEWARD_TENANT_ID,
    });
    const capturedUrl = new URL(authorizeUrl);

    expect(capturedUrl.pathname).toBe("/auth/oauth/google/authorize");
    expect(capturedUrl.searchParams.get("redirect_uri")).toBe("https://app.elizacloud.ai/login");
    expect(capturedUrl.searchParams.get("tenant_id")).toBe(STEWARD_TENANT_ID);
    expect(capturedUrl.searchParams.get("tenantId")).toBeNull();
  });

  test("preserves the login query string in the redirect_uri", () => {
    const authorizeUrl = buildStewardOAuthAuthorizeUrl("github", "https://app.elizacloud.ai", {
      redirectSearch: "?returnTo=%2Fauth%2Fcli-login%3Fsession%3Dabc",
      stewardApiUrl: "https://eliza.steward.fi",
      stewardTenantId: "elizacloud",
    });
    const capturedUrl = new URL(authorizeUrl);

    expect(capturedUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.elizacloud.ai/login?returnTo=%2Fauth%2Fcli-login%3Fsession%3Dabc",
    );
  });

  test("defaults to the same-origin Steward mount", () => {
    const previous = process.env.NEXT_PUBLIC_STEWARD_API_URL;
    delete process.env.NEXT_PUBLIC_STEWARD_API_URL;
    try {
      const authorizeUrl = buildStewardOAuthAuthorizeUrl("google", "https://app.elizacloud.ai");
      const capturedUrl = new URL(authorizeUrl);

      expect(capturedUrl.origin).toBe("https://app.elizacloud.ai");
      expect(capturedUrl.pathname).toBe("/steward/auth/oauth/google/authorize");
    } finally {
      if (previous === undefined) {
        delete process.env.NEXT_PUBLIC_STEWARD_API_URL;
      } else {
        process.env.NEXT_PUBLIC_STEWARD_API_URL = previous;
      }
    }
  });
});

describe("resolveServerStewardApiUrlFromEnv", () => {
  test("uses explicit server env before public env", () => {
    expect(
      resolveServerStewardApiUrlFromEnv({
        STEWARD_API_URL: "https://steward.internal/",
        NEXT_PUBLIC_STEWARD_API_URL: "https://public.example/steward",
      }),
    ).toBe("https://steward.internal");
  });

  test("derives same-origin Steward URL only when a request origin is provided", () => {
    expect(resolveServerStewardApiUrlFromEnv({}, "https://app.elizacloud.ai")).toBe(
      "https://app.elizacloud.ai/steward",
    );
    expect(() => resolveServerStewardApiUrlFromEnv({})).toThrow(
      /Steward API URL is not configured/,
    );
  });
});
