/**
 * Unit coverage for OpenAI Codex OAuth flow in openai-codex.ts.
 *
 * Tests startCodexLogin lifecycle, auth URL state extraction, submitCode / close hooks,
 * and refreshCodexToken token exchange mapping.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCodexToken, startCodexLogin } from "./openai-codex.js";

describe("openai-codex auth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("initiates Codex OAuth login and extracts flow state", async () => {
    const flow = await startCodexLogin();

    expect(typeof flow.authUrl).toBe("string");
    expect(flow.authUrl).toContain("https://auth.openai.com/oauth/authorize");
    expect(typeof flow.state).toBe("string");
    expect(flow.state.length).toBeGreaterThan(0);
    expect(typeof flow.submitCode).toBe("function");
    expect(typeof flow.close).toBe("function");

    // Close server cleanly
    flow.close();
  });

  it("delegates refreshCodexToken to OAuth refresh flow and formats credentials", async () => {
    // Construct mock JWT with payload containing account details for access token
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = btoa(
      JSON.stringify({
        "https://api.openai.com/auth": {
          user_id: "user-123",
          chatgpt_account_id: "acc-456",
        },
      }),
    );
    const mockJwt = `${header}.${payload}.signature`;

    const mockTokenResponse = {
      access_token: mockJwt,
      refresh_token: "new-codex-refresh",
      expires_in: 3600,
      id_token: mockJwt,
    };

    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(mockTokenResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const creds = await refreshCodexToken("existing-codex-refresh");

    expect(creds.access).toBe(mockJwt);
    expect(creds.refresh).toBe("new-codex-refresh");
    expect(creds.expires).toBeGreaterThan(Date.now());
    expect(creds.idToken).toBe(mockJwt);
  });
});
