/**
 * Drives the production OAuth callback and refresh boundaries with deterministic
 * HTTP, database, secret, and cache collaborators. The suite verifies actual
 * returned Google scopes, exact owner consent binding and one-use OAuth state.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realDbClient from "../../../db/client";
import * as realDbHelpers from "../../../db/helpers";
import * as realGoogleConsentRepo from "../../../db/repositories/personal-google-context-consent";
import * as realCacheClient from "../../cache/client";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import * as realSecrets from "../secrets";
import { googlePersonalContextConsent } from "../shared-runtime/shared-google-consent";
import * as realUsersService from "../users";
import * as realProviderRegistry from "./provider-registry";

// bun's `mock.module` patches the process-global module registry, and this file
// only restored `globalThis.fetch` in afterEach — it never reinstalled the six
// modules stubbed below. Under the batched cloud-unit runner (`--isolate`
// occasionally fails to contain these on a memory-pressured runner) those
// db/client + db/helpers + cache/secrets doubles otherwise bleed into later
// suites (e.g. the oxapay payment adapter and orphan reconcilers, whose import
// chains pull the real db layer), turning them red. Snapshot the real exports
// now and reinstall them in afterAll so this file's stubs are strictly local.
const realCacheClientExports = { ...realCacheClient };
const realCloudBindingsExports = { ...realCloudBindings };
const realProviderRegistryExports = { ...realProviderRegistry };
const realSecretsExports = { ...realSecrets };
const realDbClientExports = { ...realDbClient };
const realDbHelpersExports = { ...realDbHelpers };
const realConsentRepoExports = { ...realGoogleConsentRepo };
const realUsersServiceExports = { ...realUsersService };
const boundConsentCalls: unknown[] = [];
let ownerReadsRemaining = Number.POSITIVE_INFINITY;
const connectionWriteCalls: Array<Record<string, unknown>> = [];
const invalidatedOwnerCalls: string[] = [];

const secretsCreateCalls: unknown[] = [];
const insertReturning = mock(async () => [{ id: "conn-1" }]);

let stateData: Record<string, unknown> | null;
let userInfoBody: Record<string, unknown>;
let originalFetch: typeof globalThis.fetch;

const cacheClientActualModule = await import("../../cache/client");

mock.module("../../../db/repositories/personal-google-context-consent", () => ({
  ...realConsentRepoExports,
  readPersonalGoogleContextOwner: async (args: { userId: string; organizationId: string }) => {
    ownerReadsRemaining -= 1;
    return ownerReadsRemaining >= 0
      ? { id: args.userId, organization_id: args.organizationId }
      : undefined;
  },
  lockPersonalGoogleContextOwner: async (
    _tx: unknown,
    args: { userId: string; organizationId: string },
  ) => {
    if (ownerReadsRemaining < 0) throw new Error("GOOGLE_PERSONAL_CONTEXT_OWNER_CHANGED");
    return { id: args.userId, organization_id: args.organizationId };
  },
  bindPersonalGoogleContextConsent: async (args: { userId: string }) => {
    boundConsentCalls.push(args);
    return { id: args.userId };
  },
}));
mock.module("../users", () => ({
  ...realUsersServiceExports,
  usersService: {
    ...realUsersServiceExports.usersService,
    invalidateCache: async (owner: { id: string }) => {
      invalidatedOwnerCalls.push(owner.id);
    },
  },
}));

mock.module("../../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: async () => stateData,
    del: async () => {
      stateData = null;
    },
    set: async () => {},
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://test.example" }),
}));

mock.module("./provider-registry", () => ({
  getClientId: () => "client-id",
  getClientSecret: () => "client-secret",
  getCallbackUrl: () => "https://test.example/callback",
  resolveRequestedScopes: (_p: unknown, s?: string[]) => s ?? [],
  getNestedValue: () => undefined,
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
      from: () => ({
        where: () => ({
          limit: async () => [] as unknown[],
        }),
      }),
    }),
  },
}));

mock.module("../../../db/helpers", () => ({
  writeTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          connectionWriteCalls.push(value);
          return { onConflictDoUpdate: () => ({ returning: insertReturning }) };
        },
      }),
    }),
}));

afterAll(() => {
  mock.module(
    "../../../db/repositories/personal-google-context-consent",
    () => realConsentRepoExports,
  );
  mock.module("../users", () => realUsersServiceExports);
  mock.module("../../cache/client", () => realCacheClientExports);
  mock.module("../../runtime/cloud-bindings", () => realCloudBindingsExports);
  mock.module("./provider-registry", () => realProviderRegistryExports);
  mock.module("../secrets", () => realSecretsExports);
  mock.module("../../../db/client", () => realDbClientExports);
  mock.module("../../../db/helpers", () => realDbHelpersExports);
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("personal Google context OAuth callback scope and binding", () => {
  beforeEach(() => {
    ownerReadsRemaining = Number.POSITIVE_INFINITY;
    secretsCreateCalls.length = 0;
    boundConsentCalls.length = 0;
    connectionWriteCalls.length = 0;
    invalidatedOwnerCalls.length = 0;
    insertReturning.mockClear();
    stateData = {
      organizationId: "org-1",
      userId: "user-1",
      providerId: "testprov",
      redirectUrl: "/done",
      scopes: ["a"],
      connectionRole: "OWNER",
      createdAt: Date.now(),
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/token")) {
        return jsonResponse({ access_token: "at-123", token_type: "Bearer" });
      }
      if (u.includes("/userinfo")) {
        return jsonResponse(userInfoBody);
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const googleProvider = {
    id: "google",
    endpoints: {
      authorization: "https://test.example/auth",
      token: "https://test.example/token",
      userInfo: "https://test.example/userinfo",
    },
    pkce: false,
  } as never;
  const readScopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ];

  it("personal-context callback binds the actual full grant to the original owner and consumes state", async () => {
    stateData = {
      ...stateData,
      providerId: "google",
      scopes: readScopes,
      personalGoogleContext: googlePersonalContextConsent(),
    };
    userInfoBody = { id: "google-person" };
    globalThis.fetch = mock(async (input: unknown) =>
      String(input).includes("/token")
        ? jsonResponse({
            access_token: "offline-token",
            scope: [...readScopes, "openid"].join(" "),
          })
        : jsonResponse(userInfoBody),
    ) as typeof fetch;
    const { handleOAuth2Callback } = await import("./oauth2");
    await handleOAuth2Callback(googleProvider, "offline-code", "offline-state");
    expect(boundConsentCalls).toEqual([
      {
        organizationId: "org-1",
        userId: "user-1",
        grantId: "conn-1",
        consent: googlePersonalContextConsent(),
      },
    ]);
    expect(invalidatedOwnerCalls).toEqual(["user-1"]);
    expect(connectionWriteCalls[0]?.scopes).toEqual([...readScopes, "openid"]);
    expect(stateData).toBeNull();
    await expect(
      handleOAuth2Callback(googleProvider, "offline-code", "offline-state"),
    ).rejects.toThrow("Invalid or expired OAuth state");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("personal-context callback rejects partial or unreported granted scopes before secret or connection storage", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    for (const scope of [readScopes[1], undefined]) {
      stateData = {
        organizationId: "org-1",
        userId: "user-1",
        providerId: "google",
        connectionRole: "OWNER",
        redirectUrl: "/done",
        scopes: readScopes,
        personalGoogleContext: googlePersonalContextConsent(),
        createdAt: Date.now(),
      };
      globalThis.fetch = mock(async () =>
        jsonResponse({ access_token: "offline-token", scope }),
      ) as typeof fetch;
      await expect(
        handleOAuth2Callback(googleProvider, "offline-code", "offline-state"),
      ).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_GRANTED_SCOPES_REQUIRED");
    }
    expect(secretsCreateCalls).toHaveLength(0);
    expect(insertReturning).not.toHaveBeenCalled();
    expect(boundConsentCalls).toHaveLength(0);
  });

  it("personal-context callback never enables a legacy generic Google connection", async () => {
    stateData = { ...stateData, providerId: "google", scopes: readScopes };
    userInfoBody = { id: "google-person" };
    const { handleOAuth2Callback } = await import("./oauth2");
    await handleOAuth2Callback(googleProvider, "offline-code", "offline-state");
    expect(insertReturning).toHaveBeenCalledTimes(1);
    expect(boundConsentCalls).toHaveLength(0);
    expect(invalidatedOwnerCalls).toHaveLength(0);
  });
  it("personal context requires current owner lifecycle before and after token exchange", async () => {
    const { handleOAuth2Callback } = await import("./oauth2");
    for (const remaining of [0, 1]) {
      ownerReadsRemaining = remaining;
      stateData = {
        organizationId: "org-1",
        userId: "user-1",
        providerId: "google",
        connectionRole: "OWNER",
        scopes: readScopes,
        redirectUrl: "/done",
        createdAt: Date.now(),
        personalGoogleContext: googlePersonalContextConsent(),
      };
      globalThis.fetch = mock(async () =>
        jsonResponse({ access_token: "offline-token", scope: readScopes.join(" ") }),
      ) as typeof fetch;
      await expect(
        handleOAuth2Callback(googleProvider, "offline-code", "offline-state"),
      ).rejects.toThrow("GOOGLE_PERSONAL_CONTEXT_OWNER_CHANGED");
      expect(globalThis.fetch).toHaveBeenCalledTimes(remaining);
    }
    expect(secretsCreateCalls).toHaveLength(0);
    expect(insertReturning).not.toHaveBeenCalled();
    expect(boundConsentCalls).toHaveLength(0);
  });
});
