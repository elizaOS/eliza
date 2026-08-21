/**
 * Regression for Dropbox surrogate truncation via production seams.
 *
 * DropboxClient request-rejected 400 was previously `bodyText.slice(0,200)`
 * and OAuth token exchange was `body.slice(0,500)` — slicing UTF-16 code units
 * mid-emoji leaves a lone surrogate in ElizaError message/context, which later
 * fails strict JSON parsing. The fix uses toWellFormedUnicode + truncateWellFormed.
 *
 * Contracts verified here against the real production paths:
 * - DropboxClient 400 raw-body fallback is capped at 200, never splits a pair,
 *   and never emits lone surrogates (mocked HTTP boundary).
 * - DropboxClient 400 parsed error_summary is sanitized but unbounded (preserves
 *   pre-existing diagnostic contract — only fallback is capped).
 * - exchangeDropboxAuthorizationCode 500 context body is capped at 500 well-formed.
 * Reverting either production edit to `.slice` must make this suite red.
 */

import type { ElizaError } from "@elizaos/core";
import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { DropboxClient } from "./client.js";
import { exchangeDropboxAuthorizationCode } from "./connector-account-provider.js";
import type { DropboxCredentialResolver } from "./types.js";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const native = (value as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof native === "function") return native.call(value);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

const resolver: DropboxCredentialResolver = {
  getCredential: async () => ({ accessToken: "sl.test" }),
};

function dropboxClient(fetchImpl: typeof fetch): DropboxClient {
  return new DropboxClient(resolver, {
    apiBaseUrl: "https://api.dropbox.test",
    contentBaseUrl: "https://content.dropbox.test",
    fetchImpl,
    timeoutMs: 30_000,
  });
}

describe("Dropbox client error surrogate safety via production seams", () => {
  it("keeps surrogate pairs intact at 200-char boundary in rejected request detail (real DropboxClient 400 fallback)", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // raw body is not JSON -> summary undefined -> fallback path capped at 200
    // fox spans indices 199 and 200, so a naive slice(0,200) would leave a lone high surrogate
    const rawBody = `${"d".repeat(199)}${fox}${"e".repeat(50)}`;
    const fetchImpl: typeof fetch = async () =>
      new Response(rawBody, { status: 400, headers: { "Content-Type": "text/plain" } });

    const error = (await dropboxClient(fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e)) as ElizaError;

    expect(error.code).toBe("DROPBOX_INVALID_REQUEST");
    const detail = error.message.replace("DropboxClient: request rejected: ", "");
    expect(isWellFormed(detail)).toBe(true);
    expect(detail.isWellFormed()).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
    // must not contain the split leading surrogate, and must back off to 199
    expect(detail.length).toBe(199);
    expect(detail).not.toContain("\uD83E");
    expect(detail).not.toContain(fox);
    expect(() => JSON.stringify({ message: error.message, context: error.context })).not.toThrow();
    // mutation proof: reverting to `bodyText.slice(0,200)` would leave a lone surrogate and fail isWellFormed
  });

  it("preserves unbounded well-formed summary on 400 (no 200 cap on parsed error_summary)", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // summary via JSON error_summary — unbounded by contract, sanitized only (covers P1 second point)
    const summary = `${"s".repeat(250)}${fox}${"t".repeat(10)}`;
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error_summary: summary }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    const error = (await dropboxClient(fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e)) as ElizaError;

    const detail = error.message.replace("DropboxClient: request rejected: ", "");
    const expected = toWellFormedUnicode(summary);
    expect(detail).toBe(expected);
    expect(detail.length).toBeGreaterThan(200);
    expect(isWellFormed(detail)).toBe(true);
    expect(detail.isWellFormed()).toBe(true);
    expect(detail).toContain(fox);
    expect(() => JSON.stringify({ message: error.message, context: error.context })).not.toThrow();
  });

  it("sanitizes lone surrogates in upstream 400 fallback text via production path", async () => {
    const loneHigh = String.fromCharCode(0xd800);
    const input = `Dropbox API error ${loneHigh} payload ${"x".repeat(300)}`;
    const fetchImpl: typeof fetch = async () =>
      new Response(input, { status: 400, headers: { "Content-Type": "text/plain" } });

    const error = (await dropboxClient(fetchImpl)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e)) as ElizaError;

    const detail = error.message.replace("DropboxClient: request rejected: ", "");
    expect(isWellFormed(detail)).toBe(true);
    expect(detail.isWellFormed()).toBe(true);
    expect(detail).toContain("�");
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(() => JSON.stringify(error.message)).not.toThrow();
  });

  it("sanitizes lone surrogates in unbounded summary without truncating", async () => {
    const lone = String.fromCharCode(0xd800);
    const summary = `summary ${lone} ${"y".repeat(260)}`;
    const fetchImpl2: typeof fetch = async () =>
      new Response(JSON.stringify({ error_summary: summary }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const error = (await dropboxClient(fetchImpl2)
      .listFolder({ accountId: "acct" })
      .catch((e: unknown) => e)) as ElizaError;
    const detail = error.message.replace("DropboxClient: request rejected: ", "");
    expect(isWellFormed(detail)).toBe(true);
    expect(detail).toContain("�");
    expect(detail.length).toBeGreaterThan(200);
    expect(detail).toBe(toWellFormedUnicode(summary));
  });

  it("keeps surrogate pairs intact at 500-char boundary in OAuth token exchange error body (real exchangeDropboxAuthorizationCode)", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const body = `${"o".repeat(499)}${fox}${"p".repeat(50)}`;
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 400, headers: { "Content-Type": "text/plain" } });

    let thrown: unknown;
    try {
      await exchangeDropboxAuthorizationCode(
        {
          clientId: "cid",
          clientSecret: "csec",
          redirectUri: "https://x.example/cb",
          code: "code-1",
        },
        fetchImpl
      );
    } catch (e) {
      thrown = e;
    }
    const error = thrown as ElizaError;
    expect(error.code).toBe("DROPBOX_OAUTH_TOKEN_EXCHANGE_FAILED");
    const contextBody = (error.context as { body?: string })?.body ?? "";
    expect(isWellFormed(contextBody)).toBe(true);
    expect(contextBody.isWellFormed()).toBe(true);
    expect(contextBody.length).toBeLessThanOrEqual(500);
    expect(contextBody.length).toBe(499);
    expect(contextBody).not.toContain("\uD83E");
    expect(contextBody).not.toContain(fox);
    expect(() => JSON.stringify(error.context)).not.toThrow();
    // mutation proof: reverting to body.slice(0,500) would leave lone surrogate at 500
  });

  it("sanitizes lone surrogates in OAuth exchange context body", async () => {
    const lone = String.fromCharCode(0xd800);
    const body = `Exchange failed ${lone} ${"z".repeat(600)}`;
    const fetchImpl: typeof fetch = async () =>
      new Response(body, { status: 500, headers: { "Content-Type": "text/plain" } });
    let thrown: unknown;
    try {
      await exchangeDropboxAuthorizationCode(
        {
          clientId: "cid",
          clientSecret: "csec",
          redirectUri: "https://x.example/cb",
          code: "code-1",
        },
        fetchImpl
      );
    } catch (e) {
      thrown = e;
    }
    const error = thrown as ElizaError;
    const contextBody = (error.context as { body?: string })?.body ?? "";
    expect(isWellFormed(contextBody)).toBe(true);
    expect(contextBody).toContain("�");
    expect(contextBody.length).toBeLessThanOrEqual(500);
    expect(() => JSON.stringify(error.context)).not.toThrow();
  });
});
