/** Verifies Anthropic OAuth exchange, refresh rotation, and callback state validation at the HTTP boundary. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAnthropicAuthorizationCode,
  refreshAnthropicToken,
  startAnthropicOAuthFlowRaw,
} from "./anthropic-login.ts";

function mockTokenResponse(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

describe("refreshAnthropicToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the rotated refresh token when the response supplies one", async () => {
    mockTokenResponse({
      refresh_token: "rt-new",
      access_token: "at-new",
      expires_in: 3600,
    });
    const creds = await refreshAnthropicToken("rt-old");
    expect(creds.refresh).toBe("rt-new");
    expect(creds.access).toBe("at-new");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("keeps the current refresh token when the response omits refresh_token (RFC 6749 §6)", async () => {
    mockTokenResponse({ access_token: "at-new", expires_in: 3600 });
    const creds = await refreshAnthropicToken("rt-old");
    expect(creds.refresh).toBe("rt-old");
    expect(creds.access).toBe("at-new");
  });

  it("throws when the response lacks an access token instead of persisting a broken blob", async () => {
    mockTokenResponse({ refresh_token: "rt-new", expires_in: 3600 });
    await expect(refreshAnthropicToken("rt-old")).rejects.toThrow(
      /missing access_token/,
    );
  });

  it("throws on a non-OK response with the server error text", async () => {
    mockTokenResponse({ error: "invalid_grant" }, false);
    await expect(refreshAnthropicToken("rt-old")).rejects.toThrow(
      /Anthropic token refresh failed/,
    );
  });
});

describe("Anthropic authorization exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a localhost callback through the state-checked flow", async () => {
    mockTokenResponse({
      refresh_token: "rt-new",
      access_token: "at-new",
      expires_in: 3600,
    });
    const flow = await startAnthropicOAuthFlowRaw();
    const verifier = new URL(flow.authUrl).searchParams.get("state");
    if (!verifier) throw new Error("authorization URL omitted state");

    flow.submitCode(
      `http://localhost:1455/auth/callback?code=auth-code&state=${encodeURIComponent(verifier)}`,
    );

    await expect(flow.completion).resolves.toMatchObject({
      refresh: "rt-new",
      access: "at-new",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://console.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        body: expect.stringContaining('"code":"auth-code"'),
      }),
    );
  });

  it("rejects a callback whose state does not match the active flow", async () => {
    const flow = await startAnthropicOAuthFlowRaw();
    flow.submitCode(
      "http://127.0.0.1:1455/auth/callback?code=auth-code&state=wrong-state",
    );
    await expect(flow.completion).rejects.toThrow("state mismatch");
  });

  it("rejects malformed and non-local callback inputs", async () => {
    await expect(
      exchangeAnthropicAuthorizationCode("missing-state"),
    ).rejects.toThrow("code#state");
    await expect(
      exchangeAnthropicAuthorizationCode(
        "https://attacker.example/callback?code=auth-code&state=state",
      ),
    ).rejects.toThrow("code#state");
  });
});
