/** Unit tests for `buildAppAuthorizeUrl` — asserts the canonical app-authorize URL shape and query params. Pure, no network. */

import { describe, expect, it } from "vitest";
import { APP_AUTHORIZE_PATH, buildAppAuthorizeUrl } from "./app-auth.js";

describe("buildAppAuthorizeUrl", () => {
  it("builds the canonical third-party app authorize URL", () => {
    const url = new URL(
      buildAppAuthorizeUrl({
        appId: "app_123",
        redirectUri: "https://example.app/auth/callback",
        state: "csrf-value",
        baseUrl: "https://elizacloud.ai/",
      }),
    );

    expect(url.origin).toBe("https://elizacloud.ai");
    expect(url.pathname).toBe(APP_AUTHORIZE_PATH);
    expect(url.searchParams.get("app_id")).toBe("app_123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.app/auth/callback",
    );
    expect(url.searchParams.get("state")).toBe("csrf-value");
  });

  it("normalizes 100k trailing base-url slashes", () => {
    const url = new URL(
      buildAppAuthorizeUrl({
        appId: "app_123",
        redirectUri: "https://example.app/auth/callback",
        baseUrl: `https://elizacloud.ai${"/".repeat(100_000)}`,
      }),
    );

    expect(url.origin).toBe("https://elizacloud.ai");
    expect(url.pathname).toBe(APP_AUTHORIZE_PATH);
  });
  it("requires caller-bound state for delegated authorization", () => {
    expect(() =>
      buildAppAuthorizeUrl({
        appId: "app_123",
        redirectUri: "https://example.app/callback",
        delegation: { clientId: "client_123", scopes: ["identity"] },
      }),
    ).toThrow("state");
    const url = new URL(
      buildAppAuthorizeUrl({
        appId: "app_123",
        redirectUri: "https://example.app/callback",
        state: "session-bound-nonce",
        delegation: {
          clientId: "client_123",
          scopes: ["identity", "billing:read"],
        },
      }),
    );
    expect(url.searchParams.get("state")).toBe("session-bound-nonce");
    expect(url.searchParams.get("flow")).toBe("app_delegation");
    expect(url.searchParams.get("scopes")).toBe("identity billing:read");
  });
});
