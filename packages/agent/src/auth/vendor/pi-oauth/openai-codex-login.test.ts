import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOpenAICodexToken } from "./openai-codex-login.ts";

/** Unsigned JWT carrying the chatgpt_account_id claim getAccountId reads. */
function fakeAccessToken(accountId = "acct-123"): string {
  const payload = btoa(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  );
  return `header.${payload}.sig`;
}

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

describe("refreshOpenAICodexToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns rotated refresh token, accountId, and id_token from the response", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      refresh_token: "rt-new",
      expires_in: 3600,
      id_token: "idt-new",
    });
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.refresh).toBe("rt-new");
    expect(creds.accountId).toBe("acct-123");
    expect(creds.idToken).toBe("idt-new");
    expect(creds.expires).toBeGreaterThan(Date.now());
  });

  it("keeps the current refresh token when the response omits refresh_token (RFC 6749 §6)", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      expires_in: 3600,
    });
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.refresh).toBe("rt-old");
    expect(creds.access).toBe(fakeAccessToken());
  });

  it("fails when the response lacks an access token", async () => {
    mockTokenResponse({ refresh_token: "rt-new", expires_in: 3600 });
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });
});
