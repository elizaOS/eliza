/**
 * Unit coverage for Anthropic OAuth flow wrapper in anthropic.ts.
 *
 * Tests startAnthropicLogin lifecycle (auth URL generation, submitCode hook, credentials promise),
 * refreshAnthropicToken delegation, and export availability.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAnthropicAuthorizationCode,
  refreshAnthropicToken,
  startAnthropicLogin,
} from "./anthropic.js";

describe("anthropic auth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exports exchangeAnthropicAuthorizationCode function", () => {
    expect(typeof exchangeAnthropicAuthorizationCode).toBe("function");
  });

  it("initiates Anthropic OAuth login and resolves credentials on submitCode", async () => {
    const mockTokenResponse = {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      expires_in: 3600,
    };

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const flow = await startAnthropicLogin();

    expect(typeof flow.authUrl).toBe("string");
    expect(flow.authUrl).toContain("https://claude.ai/oauth/authorize");
    expect(typeof flow.submitCode).toBe("function");

    // Extract state from authUrl to construct a valid code#state
    const url = new URL(flow.authUrl);
    const state = url.searchParams.get("state") || "test-state";

    // Submit the code
    flow.submitCode(`mock-code#${state}`);

    const creds = await flow.credentials;
    expect(creds.access).toBe("mock-access-token");
    expect(creds.refresh).toBe("mock-refresh-token");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("delegates refreshAnthropicToken to underlying OAuth token exchange", async () => {
    const mockRefreshResponse = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 7200,
    };

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(mockRefreshResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const creds = await refreshAnthropicToken("existing-refresh-token");

    expect(creds.access).toBe("new-access-token");
    expect(creds.refresh).toBe("new-refresh-token");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });
});
