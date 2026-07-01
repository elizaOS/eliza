import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "./anthropic-login.ts";

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
