/**
 * Classifies an OpenAI Codex refresh failure through the real credential
 * resolver: isolated on-disk account storage, the vendored Codex token client,
 * and a stubbed token endpoint (`fetch`) standing in for auth.openai.com.
 * The pool keep-alive sweep and the coding-account bridge park an account as
 * needs-reauth only on the `auth` kind, so that kind must mean "the refresh
 * token was refused" and nothing else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIsolatedAccountStoragePolicy,
  saveAccount,
} from "./account-storage.ts";
import { getAccessToken } from "./credentials.ts";

const roots: string[] = [];

function seedExpiredCodexAccount() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-"));
  roots.push(root);
  const storagePolicy = createIsolatedAccountStoragePolicy(root);
  saveAccount(
    {
      id: "acct1",
      providerId: "openai-codex",
      label: "Codex",
      source: "oauth",
      credentials: {
        access: "stale-access",
        refresh: "stored-refresh",
        expires: Date.now() - 1_000,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    storagePolicy,
  );
  return storagePolicy;
}

function stubTokenEndpoint(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function refreshOutcome() {
  return getAccessToken("openai-codex", "acct1", {
    outcome: true,
    storagePolicy: seedExpiredCodexAccount(),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenAI Codex refresh failure classification", () => {
  it.each([
    [
      400,
      { error: "invalid_grant", error_description: "Refresh token revoked" },
    ],
    [401, { error: { code: "refresh_token_reused", message: "already used" } }],
    [403, { error: "access_denied" }],
  ])(
    "classifies a token endpoint rejection (HTTP %i) as auth",
    async (status, body) => {
      const fetchMock = stubTokenEndpoint(status, body);
      const outcome = await refreshOutcome();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({
        ok: false,
        kind: "auth",
        message: `OpenAI Codex rejected the refresh token (HTTP ${status}); sign in again`,
      });
    },
  );

  // A WAF challenge, a proxy error page or a temporary OAuth error on 400/403
  // does not prove the refresh token was refused; parking every pooled
  // account as needs-reauth on one would take the whole pool offline.
  it.each([
    [
      "a Cloudflare challenge page (HTTP 403)",
      403,
      "<html><title>Just a moment...</title></html>",
      "text/html; charset=UTF-8",
    ],
    [
      "a proxy error page (HTTP 400)",
      400,
      "<html><body>400 Bad Request</body></html>",
      "text/html",
    ],
    [
      "a temporary OAuth error (HTTP 400)",
      400,
      JSON.stringify({ error: "temporarily_unavailable" }),
      "application/json",
    ],
    // Client-level answers describe the shared OAuth client, not this
    // account's refresh token; parking would take every pooled account.
    [
      "a client authentication failure (HTTP 400 invalid_client)",
      400,
      JSON.stringify({ error: "invalid_client" }),
      "application/json",
    ],
    [
      "a client grant-type refusal (HTTP 403 unauthorized_client)",
      403,
      JSON.stringify({ error: { code: "unauthorized_client" } }),
      "application/json",
    ],
  ])("keeps %s transient", async (_label, status, body, contentType) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status,
            headers: { "content-type": contentType },
          }),
      ),
    );
    const outcome = await refreshOutcome();
    expect(outcome).toEqual({
      ok: false,
      kind: "transient",
      message: "Failed to refresh OpenAI Codex token",
    });
  });

  it("classifies HTTP 401 as auth whatever the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("Unauthorized", {
            status: 401,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    const outcome = await refreshOutcome();
    expect(outcome.ok ? null : outcome.kind).toBe("auth");
  });

  it("keeps a provider outage (HTTP 503) transient", async () => {
    stubTokenEndpoint(503, { error: "temporarily_unavailable" });
    const outcome = await refreshOutcome();
    expect(outcome).toEqual({
      ok: false,
      kind: "transient",
      message: "Failed to refresh OpenAI Codex token",
    });
  });

  it("keeps rate limiting (HTTP 429) transient", async () => {
    stubTokenEndpoint(429, { error: "rate_limited" });
    const outcome = await refreshOutcome();
    expect(outcome.ok ? null : outcome.kind).toBe("transient");
  });

  it("keeps a transport failure transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const outcome = await refreshOutcome();
    expect(outcome).toEqual({
      ok: false,
      kind: "transient",
      message: "Failed to refresh OpenAI Codex token",
    });
  });
});
