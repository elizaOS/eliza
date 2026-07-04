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
});
