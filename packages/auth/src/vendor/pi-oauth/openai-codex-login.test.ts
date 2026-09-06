/** Verifies OpenAI Codex OAuth exchange and refresh validation with mocked Fetch and real Response objects. */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorizationCode,
  refreshOpenAICodexToken,
} from "./openai-codex-login.ts";

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
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: ok ? 200 : 400,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

function mockRawTokenResponse(body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

async function exchangeMockedAuthorizationCode() {
  return exchangeAuthorizationCode("code", "verifier");
}

describe("refreshOpenAICodexToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it.each([
    ["omitted", { access_token: fakeAccessToken(), expires_in: 3600 }],
    [
      "null",
      {
        access_token: fakeAccessToken(),
        refresh_token: null,
        expires_in: 3600,
      },
    ],
  ])("keeps the current refresh token when refresh_token is %s", async (_name, body) => {
    mockTokenResponse(body);
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.refresh).toBe("rt-old");
    expect(creds.access).toBe(fakeAccessToken());
  });

  it.each([
    ["null", null],
    ["empty", ""],
  ])("accepts an %s optional id_token without returning it", async (_name, idToken) => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      expires_in: 3600,
      id_token: idToken,
    });
    const creds = await refreshOpenAICodexToken("rt-old");
    expect(creds.idToken).toBeUndefined();
  });

  it.each([
    ["non-object root", null],
    ["missing access token", { refresh_token: "rt-new", expires_in: 3600 }],
    ["numeric access token", { access_token: 7, expires_in: 3600 }],
    [
      "numeric rotated refresh token",
      { access_token: fakeAccessToken(), refresh_token: 7, expires_in: 3600 },
    ],
    [
      "blank rotated refresh token",
      { access_token: fakeAccessToken(), refresh_token: " ", expires_in: 3600 },
    ],
    ["zero lifetime", { access_token: fakeAccessToken(), expires_in: 0 }],
    ["negative lifetime", { access_token: fakeAccessToken(), expires_in: -1 }],
    ["null lifetime", { access_token: fakeAccessToken(), expires_in: null }],
    [
      "overflowing lifetime",
      { access_token: fakeAccessToken(), expires_in: 1e308 },
    ],
    [
      "numeric id token",
      { access_token: fakeAccessToken(), expires_in: 3600, id_token: 7 },
    ],
  ])("fails a successful response with %s", async (_name, body) => {
    mockTokenResponse(body);
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });

  it("fails JSON numeric overflow before constructing credentials", async () => {
    mockRawTokenResponse(
      `{"access_token":${JSON.stringify(fakeAccessToken())},"expires_in":1e400}`,
    );
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });

  it("fails malformed successful JSON", async () => {
    mockRawTokenResponse("{not-json");
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
  });

  it("does not pass token values to diagnostics for an invalid response", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    mockTokenResponse({
      refresh_token: "refresh-secret-value",
      expires_in: 3600,
      id_token: "identity-secret-value",
    });
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
    const diagnosticArguments = JSON.stringify(errorSpy.mock.calls);
    expect(diagnosticArguments).not.toContain("refresh-secret-value");
    expect(diagnosticArguments).not.toContain("identity-secret-value");
  });

  it("does not pass a non-success response body to diagnostics", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    mockTokenResponse(
      {
        access_token: "access-secret-value",
        refresh_token: "refresh-secret-value",
      },
      false,
    );
    await expect(refreshOpenAICodexToken("rt-old")).rejects.toThrow(
      /Failed to refresh OpenAI Codex token/,
    );
    const diagnosticArguments = JSON.stringify(errorSpy.mock.calls);
    expect(diagnosticArguments).not.toContain("access-secret-value");
    expect(diagnosticArguments).not.toContain("refresh-secret-value");
  });
});

describe("OpenAI Codex authorization exchange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns complete credentials for a valid token response", async () => {
    mockTokenResponse({
      access_token: fakeAccessToken(),
      refresh_token: "rt-exchange",
      expires_in: 3600,
      id_token: "idt-exchange",
    });
    const result = await exchangeMockedAuthorizationCode();
    expect(result).toMatchObject({
      type: "success",
      access: fakeAccessToken(),
      refresh: "rt-exchange",
      idToken: "idt-exchange",
    });
  });

  it.each([
    ["non-object root", []],
    ["missing access token", { refresh_token: "rt-exchange", expires_in: 3600 }],
    ["missing refresh token", { access_token: fakeAccessToken(), expires_in: 3600 }],
    [
      "numeric refresh token",
      { access_token: fakeAccessToken(), refresh_token: 7, expires_in: 3600 },
    ],
    [
      "non-positive lifetime",
      { access_token: fakeAccessToken(), refresh_token: "rt-exchange", expires_in: 0 },
    ],
    [
      "overflowing lifetime",
      {
        access_token: fakeAccessToken(),
        refresh_token: "rt-exchange",
        expires_in: 1e308,
      },
    ],
    [
      "invalid id token",
      {
        access_token: fakeAccessToken(),
        refresh_token: "rt-exchange",
        expires_in: 3600,
        id_token: {},
      },
    ],
  ])("fails a successful response with %s", async (_name, body) => {
    mockTokenResponse(body);
    await expect(exchangeMockedAuthorizationCode()).resolves.toMatchObject({
      type: "failed",
    });
  });

  it("fails malformed successful JSON", async () => {
    mockRawTokenResponse("{not-json");
    await expect(exchangeMockedAuthorizationCode()).resolves.toMatchObject({
      type: "failed",
    });
  });

  it("does not pass a non-success response body to diagnostics", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    mockTokenResponse(
      {
        access_token: "access-secret-value",
        refresh_token: "refresh-secret-value",
      },
      false,
    );
    await expect(exchangeMockedAuthorizationCode()).resolves.toMatchObject({
      type: "failed",
    });
    const diagnosticArguments = JSON.stringify(errorSpy.mock.calls);
    expect(diagnosticArguments).not.toContain("access-secret-value");
    expect(diagnosticArguments).not.toContain("refresh-secret-value");
  });
});
