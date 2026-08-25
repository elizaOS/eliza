/**
 * The real connector OAuth start boundary: createGoogleConnectorAccountProvider
 * startOAuth must validate GOOGLE_REDIRECT_URI against the served origin the
 * manager forwards from the HTTP request (Settings route / LifeOps), accept
 * local, staging, and production deployments whose callback matches, and fail
 * closed when the callback cannot reach the served origin. Deterministic: no
 * network is touched before the authorization redirect, the manager is stubbed.
 */
import type { ConnectorAccountManager, ConnectorOAuthFlow } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

function runtimeWith(redirectUri: string) {
  return {
    getSetting: (key: string) =>
      ({
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REDIRECT_URI: redirectUri,
      })[key],
    getService: () => null,
  } as never;
}

function flow(): ConnectorOAuthFlow {
  const now = Date.now();
  return {
    id: "oauth_test",
    provider: "google",
    state: "state_test",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

const managerStub = {} as ConnectorAccountManager;

async function startWith(redirectUri: string, servedOrigin?: string) {
  const provider = createGoogleConnectorAccountProvider(runtimeWith(redirectUri));
  if (!provider.startOAuth) throw new Error("google provider must support startOAuth");
  return provider.startOAuth(
    {
      provider: "google",
      flow: flow(),
      scopes: ["gmail.read"],
      servedOrigin,
      metadata: { requestedRole: "OWNER" },
    },
    managerStub
  );
}

describe("google provider startOAuth served-origin boundary", () => {
  const CASES = [
    {
      name: "local",
      redirect: "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
      servedOrigin: "http://127.0.0.1:31437",
    },
    {
      name: "staging",
      redirect: "https://staging.eliza.example/api/connectors/google/oauth/callback",
      servedOrigin: "https://staging.eliza.example",
    },
    {
      name: "production behind a TLS-terminating proxy",
      redirect: "https://eliza.example/api/connectors/google/oauth/callback",
      servedOrigin: "https://eliza.example",
    },
  ];

  for (const { name, redirect, servedOrigin } of CASES) {
    it(`starts OAuth for a ${name} deployment whose callback matches the served origin`, async () => {
      const result = await startWith(redirect, servedOrigin);
      const authUrl = new URL(result.authUrl);
      expect(result.redirectUri).toBe(redirect);
      expect(result.authUrl).toContain(encodeURIComponent(redirect));
      expect(authUrl.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(result.metadata?.oidcNonce).toBe(authUrl.searchParams.get("nonce"));
    });
  }

  it("starts OAuth when the caller has no request origin (chat action)", async () => {
    const result = await startWith("https://eliza.example/api/connectors/google/oauth/callback");
    expect(result.authUrl).toContain(
      encodeURIComponent("https://eliza.example/api/connectors/google/oauth/callback")
    );
  });

  it("fails closed when the callback targets a different host than the served origin", async () => {
    await expect(
      startWith(
        "https://other.example/api/connectors/google/oauth/callback",
        "https://eliza.example"
      )
    ).rejects.toThrow(/targets other\.example/);
  });

  it("fails closed when a loopback callback misses the served API port", async () => {
    await expect(
      startWith(
        "http://127.0.0.1:31437/api/connectors/google/oauth/callback",
        "http://127.0.0.1:2138"
      )
    ).rejects.toThrow(/served on port 2138/);
  });

  it("fails closed when proxy metadata reports a different served scheme", async () => {
    await expect(
      startWith(
        "https://eliza.example/api/connectors/google/oauth/callback",
        "http://eliza.example"
      )
    ).rejects.toThrow(/served over http/);
  });

  it("fails closed on a malformed served origin without echoing it", async () => {
    const secret = "origin-secret-must-not-leak";
    await expect(startWith(CASES[0].redirect, `not a URL ${secret}`)).rejects.toThrow(
      /^The configured external connector origin is not a valid URL\.$/
    );
  });
});
