/**
 * Google incremental authorization and the Android server-auth-code exchange.
 * The real provider registry and OAuth flow run against deterministic HTTP,
 * cache, secret and database doubles.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "../../../db/client";
import * as realDbHelpers from "../../../db/helpers";
import * as realCacheClient from "../../cache/client";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import * as realSecrets from "../secrets";

const realCacheClientExports = { ...realCacheClient };
const realCloudBindingsExports = { ...realCloudBindings };
const realSecretsExports = { ...realSecrets };
const realDbClientExports = { ...realDbClient };
const realDbHelpersExports = { ...realDbHelpers };

const connectionWriteCalls: Array<Record<string, unknown>> = [];
const secretsCreateCalls: unknown[] = [];
const cacheSets: Array<{ key: string; value: unknown }> = [];
const tokenRequests: URLSearchParams[] = [];
let tokenResponse: { status: number; body: Record<string, unknown> };

const cacheClientActualModule = await import("../../cache/client");
mock.module("../../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: async () => null,
    del: async () => {},
    set: async (key: string, value: unknown) => {
      cacheSets.push({ key, value });
    },
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));
mock.module("../../runtime/cloud-bindings", () => ({
  ...realCloudBindingsExports,
  getCloudAwareEnv: () => ({
    NEXT_PUBLIC_APP_URL: "https://cloud.test",
    GOOGLE_CLIENT_ID: "cloud-web.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "cloud-web-secret",
  }),
}));
mock.module("../secrets", () => ({
  secretsService: {
    create: async (input: unknown) => {
      secretsCreateCalls.push(input);
      return { id: `secret-${secretsCreateCalls.length}` };
    },
    list: async () => [],
    rotate: async () => {},
    delete: async () => {},
  },
}));
mock.module("../../../db/client", () => ({
  dbWrite: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] as unknown[] }) }),
    }),
  },
}));
mock.module("../../../db/helpers", () => ({
  writeTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          connectionWriteCalls.push(value);
          return {
            onConflictDoUpdate: () => ({ returning: async () => [{ id: "conn-native" }] }),
          };
        },
      }),
    }),
}));

afterAll(() => {
  mock.module("../../cache/client", () => realCacheClientExports);
  mock.module("../../runtime/cloud-bindings", () => realCloudBindingsExports);
  mock.module("../secrets", () => realSecretsExports);
  mock.module("../../../db/client", () => realDbClientExports);
  mock.module("../../../db/helpers", () => realDbHelpersExports);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GRANTED = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  connectionWriteCalls.length = 0;
  secretsCreateCalls.length = 0;
  cacheSets.length = 0;
  tokenRequests.length = 0;
  tokenResponse = {
    status: 200,
    body: {
      access_token: "ya29.native",
      refresh_token: "1//refresh",
      expires_in: 3599,
      token_type: "Bearer",
      scope: GRANTED.join(" "),
    },
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://oauth2.googleapis.com/token") {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return jsonResponse(tokenResponse.body, tokenResponse.status);
    }
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo")
      return jsonResponse({ id: "google-sub-1", email: "owner@example.com", name: "Owner" });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Google authorize URL", () => {
  it("asks for incremental authorization so later consents keep earlier scopes", async () => {
    const { OAUTH_PROVIDERS } = await import("./provider-registry");
    const { initiateOAuth2 } = await import("./oauth2");
    const { authUrl } = await initiateOAuth2(OAUTH_PROVIDERS.google, {
      organizationId: "org-1",
      userId: "user-1",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
    });
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://cloud.test/api/v1/oauth/google/callback",
    );
  });

  it("the standalone Google URL helper asks for it too", async () => {
    const { generateGoogleAuthUrl } = await import("../../utils/google-api");
    const url = new URL(
      generateGoogleAuthUrl({
        clientId: "client",
        redirectUri: "https://cloud.test/cb",
        state: "state",
      }),
    );
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });
});

describe("Android server auth code exchange", () => {
  it("exchanges with Cloud's web client and an empty redirect_uri, then stores the granted scopes", async () => {
    const { OAUTH_PROVIDERS } = await import("./provider-registry");
    const { exchangeGoogleServerAuthCode } = await import("./oauth2");
    const result = await exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.google, {
      organizationId: "org-1",
      userId: "user-1",
      serverAuthCode: "4/0AeaYSHnative",
    });
    expect(tokenRequests).toHaveLength(1);
    const form = tokenRequests[0];
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("4/0AeaYSHnative");
    expect(form.get("client_id")).toBe("cloud-web.apps.googleusercontent.com");
    expect(form.get("client_secret")).toBe("cloud-web-secret");
    expect(form.has("redirect_uri")).toBe(true);
    expect(form.get("redirect_uri")).toBe("");
    expect(result).toEqual({
      connectionId: "conn-native",
      organizationId: "org-1",
      userId: "user-1",
      platformUserId: "google-sub-1",
      email: "owner@example.com",
      displayName: "Owner",
      scopes: GRANTED,
      refreshTokenIssued: true,
    });
    expect(connectionWriteCalls).toHaveLength(1);
    expect(connectionWriteCalls[0]).toMatchObject({
      organization_id: "org-1",
      user_id: "user-1",
      platform_user_id: "google-sub-1",
      scopes: GRANTED,
    });
    // Access and refresh tokens go to the secret store, never the row.
    expect(secretsCreateCalls).toHaveLength(2);
    expect(JSON.stringify(connectionWriteCalls[0])).not.toContain("ya29.native");
    // No OAuth state is created or consumed for a native code.
    expect(cacheSets).toHaveLength(0);
  });

  it("a refused code or a grant without reported scopes stores nothing", async () => {
    const { OAUTH_PROVIDERS } = await import("./provider-registry");
    const { exchangeGoogleServerAuthCode } = await import("./oauth2");
    tokenResponse = { status: 400, body: { error: "invalid_grant" } };
    await expect(
      exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.google, {
        organizationId: "org-1",
        userId: "user-1",
        serverAuthCode: "4/0used-code",
      }),
    ).rejects.toThrow("Token exchange failed: 400");
    tokenResponse = { status: 200, body: { access_token: "ya29.native" } };
    await expect(
      exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.google, {
        organizationId: "org-1",
        userId: "user-1",
        serverAuthCode: "4/0no-scopes",
      }),
    ).rejects.toThrow("GOOGLE_GRANTED_SCOPES_REQUIRED");
    expect(connectionWriteCalls).toHaveLength(0);
    expect(secretsCreateCalls).toHaveLength(0);
  });

  it("a code for another Google account than the signed-in one stores nothing", async () => {
    const { OAUTH_PROVIDERS } = await import("./provider-registry");
    const { exchangeGoogleServerAuthCode } = await import("./oauth2");
    await expect(
      exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.google, {
        organizationId: "org-1",
        userId: "user-1",
        serverAuthCode: "4/0AeaYSHnative",
        expectedPlatformUserId: "someone-else",
      }),
    ).rejects.toThrow("GOOGLE_SERVER_AUTH_CODE_ACCOUNT_MISMATCH");
    expect(connectionWriteCalls).toHaveLength(0);
    expect(secretsCreateCalls).toHaveLength(0);
    const matched = await exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.google, {
      organizationId: "org-1",
      userId: "user-1",
      serverAuthCode: "4/0AeaYSHnative",
      expectedPlatformUserId: "google-sub-1",
    });
    expect(matched.platformUserId).toBe("google-sub-1");
  });

  it("refuses a provider other than Google", async () => {
    const { OAUTH_PROVIDERS } = await import("./provider-registry");
    const { exchangeGoogleServerAuthCode } = await import("./oauth2");
    await expect(
      exchangeGoogleServerAuthCode(OAUTH_PROVIDERS.microsoft, {
        organizationId: "org-1",
        userId: "user-1",
        serverAuthCode: "4/0AeaYSHnative",
      }),
    ).rejects.toThrow("GOOGLE_SERVER_AUTH_CODE_PROVIDER_INVALID");
    expect(tokenRequests).toHaveLength(0);
  });
});
