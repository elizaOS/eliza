/** Attacks provider-owned OAuth registration, account grants, state, redirect, tenant, and refresh binding. */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type RunningFakeProvider,
  startFakeProvider,
} from "../../src/provider-contract";

const running: RunningFakeProvider[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((provider) => provider.stop()));
});

describe("provider-owned OAuth boundary", () => {
  test("rejects altered redirect/account/tenant and binds refresh to its client", async () => {
    const provider = await startFakeProvider({
      accounts: [
        {
          accountId: "acct-owner",
          tenantId: "org-owner",
          capabilities: ["items.read"],
        },
      ],
      oauthClients: [
        {
          clientId: "registered-client",
          clientType: "confidential",
          clientSecret: "registered-client-secret",
          redirectUris: ["https://adapter.test/callback"],
          accountIds: ["acct-owner"],
        },
      ],
      fixtures: [
        {
          id: "tenant-items",
          method: "GET",
          path: "/v1/items",
          requiresAccessToken: true,
          requiresOrganization: true,
          expectedOrganizationId: "org-owner",
          response: { status: 200, body: { items: [] } },
        },
      ],
    });
    running.push(provider);
    const verifier = "provider-owned-verifier-with-enough-entropy-0123456789";
    const authorize = new URL(provider.oauthAuthorizeUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "registered-client",
      redirect_uri: "https://adapter.test/callback",
      state: "expected-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const authorizationResponse = await fetch(authorize, {
      redirect: "manual",
    });
    expect(authorizationResponse.status).toBe(302);
    const callback = authorizationResponse.headers.get("location") ?? "";
    const callbackUrl = new URL(callback);
    expect(callbackUrl.searchParams.get("state")).toBe("expected-state");
    const code = callbackUrl.searchParams.get("code") ?? "";
    const tokenParameters = {
      grant_type: "authorization_code",
      code,
      client_id: "registered-client",
      redirect_uri: "https://adapter.test/callback",
      code_verifier: verifier,
    };
    for (const clientSecret of [undefined, "wrong-client-secret"]) {
      const rejected = await fetch(provider.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          ...tokenParameters,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }),
      });
      expect(rejected.status).toBe(400);
    }
    const tokenResponse = await fetch(provider.oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...tokenParameters,
        client_secret: "registered-client-secret",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };

    for (const [field, value] of [
      ["redirect_uri", "https://attacker.example/callback"],
      ["account_id", "acct-owner"],
      ["organization_id", "org-owner"],
    ] as const) {
      const altered = new URL(authorize);
      altered.searchParams.set("state", `altered-${field}`);
      altered.searchParams.set(field, value);
      expect((await fetch(altered, { redirect: "manual" })).status).toBe(400);
    }

    expect(
      (
        await fetch(`${provider.url}/v1/items`, {
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "x-organization-id": "org-owner",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${provider.url}/v1/items`, {
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "x-organization-id": "org-victim",
          },
        })
      ).status,
    ).toBe(403);

    const wrongClientRefresh = await fetch(provider.oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "attacker-client",
        client_secret: "registered-client-secret",
      }),
    });
    expect(wrongClientRefresh.status).toBe(400);
    for (const clientSecret of [undefined, "wrong-client-secret"]) {
      const rejected = await fetch(provider.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: "registered-client",
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }),
      });
      expect(rejected.status).toBe(400);
    }
    const rotatedResponse = await fetch(provider.oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "registered-client",
        client_secret: "registered-client-secret",
      }),
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as { refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
  });
});
