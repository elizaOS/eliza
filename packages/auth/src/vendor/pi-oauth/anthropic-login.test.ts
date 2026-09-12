/** Verifies Anthropic OAuth exchange, token-response validation, refresh rotation, and callback state validation at the HTTP boundary. */

import { ElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAnthropicAuthorizationCode,
  refreshAnthropicToken,
  startAnthropicOAuthFlowRaw,
} from "./anthropic-login.ts";

function mockTokenResponse(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: ok ? 200 : 400,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

async function expectTokenError(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected Anthropic token operation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ElizaError);
    if (!(error instanceof ElizaError)) throw error;
    expect(error.code).toBe(code);
  }
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

  it("keeps the current refresh token when refresh_token is null", async () => {
    mockTokenResponse({
      access_token: "at-new",
      refresh_token: null,
      expires_in: 3600,
    });
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

  it.each([
    ["non-object root", null],
    ["numeric access token", { access_token: 7, expires_in: 3600 }],
    ["blank access token", { access_token: "   ", expires_in: 3600 }],
    [
      "invalid rotated refresh token",
      { access_token: "at-new", refresh_token: 7, expires_in: 3600 },
    ],
    ["zero lifetime", { access_token: "at-new", expires_in: 0 }],
    ["negative lifetime", { access_token: "at-new", expires_in: -1 }],
    ["null lifetime", { access_token: "at-new", expires_in: null }],
    ["overflowing lifetime", { access_token: "at-new", expires_in: 1e308 }],
    ["string lifetime", { access_token: "at-new", expires_in: "3600" }],
  ])("rejects a successful response with %s", async (_name, body) => {
    mockTokenResponse(body);
    await expectTokenError(
      refreshAnthropicToken("rt-old"),
      "anthropic_oauth.token_invalid_shape",
    );
  });

  it("wraps malformed successful JSON as a typed token response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{not-json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expectTokenError(
      refreshAnthropicToken("rt-old"),
      "anthropic_oauth.token_invalid_json",
    );
  });

  it("rejects a JSON lifetime that parses beyond the finite number range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"access_token":"at-new","expires_in":1e400}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expectTokenError(
      refreshAnthropicToken("rt-old"),
      "anthropic_oauth.token_invalid_shape",
    );
  });

  it("throws on a non-OK response with the server error text", async () => {
    mockTokenResponse({ error: "invalid_grant" }, false);
    await expect(refreshAnthropicToken("rt-old")).rejects.toThrow(
      /Anthropic token refresh failed/,
    );
  });

  it("sets expires to Date.now() + expires_in*1000 without premature buffer (single source is credentials.ts)", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockTokenResponse({
      refresh_token: "rt-new",
      access_token: "at-new",
      expires_in: 3600,
    });
    const creds = await refreshAnthropicToken("rt-old");
    // Must be exact wall-clock + TTL. The 5-minute refresh window lives only
    // in credentials.ts effectiveBufferMs; anthropic-login must not subtract
    // its own 5 min or the combined 10-min early refresh burns single-use
    // refresh tokens twice as fast.
    expect(creds.expires).toBe(now + 3600 * 1000);
    expect(creds.expires).not.toBe(now + 3600 * 1000 - 5 * 60 * 1000);
    vi.restoreAllMocks();
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

  it("exchange sets expires to Date.now() + expires_in*1000 without double buffer", async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockTokenResponse({
      refresh_token: "rt-ex",
      access_token: "at-ex",
      expires_in: 3600,
    });
    const creds = await exchangeAnthropicAuthorizationCode("code#state-value");
    expect(creds.expires).toBe(now + 3600 * 1000);
    expect(creds.expires).not.toBe(now + 3600 * 1000 - 5 * 60 * 1000);
    vi.restoreAllMocks();
  });

  it.each([
    ["non-object root", []],
    ["missing access token", { refresh_token: "rt-ex", expires_in: 3600 }],
    [
      "missing refresh token",
      { access_token: "at-ex", expires_in: 3600 },
    ],
    [
      "numeric access token",
      { access_token: 7, refresh_token: "rt-ex", expires_in: 3600 },
    ],
    [
      "blank refresh token",
      { access_token: "at-ex", refresh_token: " ", expires_in: 3600 },
    ],
    [
      "non-positive lifetime",
      { access_token: "at-ex", refresh_token: "rt-ex", expires_in: -1 },
    ],
    [
      "string lifetime",
      { access_token: "at-ex", refresh_token: "rt-ex", expires_in: "3600" },
    ],
    [
      "overflowing lifetime",
      { access_token: "at-ex", refresh_token: "rt-ex", expires_in: 1e308 },
    ],
  ])("rejects a successful response with %s", async (_name, body) => {
    mockTokenResponse(body);
    await expectTokenError(
      exchangeAnthropicAuthorizationCode("code#state-value"),
      "anthropic_oauth.token_invalid_shape",
    );
  });

  it("wraps malformed successful JSON with its parse cause", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{not-json", { status: 200 })),
    );
    try {
      await exchangeAnthropicAuthorizationCode("code#state-value");
      throw new Error("Expected token exchange to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      if (!(error instanceof ElizaError)) throw error;
      expect(error.code).toBe("anthropic_oauth.token_invalid_json");
      expect(error.cause).toBeInstanceOf(SyntaxError);
    }
  });
});
