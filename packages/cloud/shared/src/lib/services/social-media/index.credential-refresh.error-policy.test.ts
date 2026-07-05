/**
 * Fail-closed pin for `socialMediaService.getCredentialsForPlatform`'s
 * token-refresh boundary (#13415, J1 at index.ts:144-168). Complements
 * `index.error-policy.test.ts` (analytics read paths) by covering the one
 * load-bearing fail-closed branch it does not: when a stored OAuth token needs
 * refresh and the outbound refresh FAILS, credential resolution must THROW
 * "Token expired." (surfacing the failure so the caller refunds and the user
 * reconnects) — it must NEVER swallow the failure into stale/`null` creds.
 *
 * The distinct, legitimately-empty case (a provider that is simply not
 * configured — no DB row and no env secrets) must stay a `null` return, not a
 * throw. Failure != designed-empty.
 *
 * Drives the real exported method; the DB client, secrets service, and
 * token-refresh module are mocked so the branch runs without infrastructure.
 * Each mock reads a mutable module-level config so tests stay isolated.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

interface CredentialRow {
  id: string;
  organization_id: string;
  platform: string;
  status: string;
  api_key_secret_id: string | null;
  access_token_secret_id: string | null;
  refresh_token_secret_id: string | null;
  token_expires_at: Date | null;
  platform_username: string | null;
  platform_user_id: string | null;
  source_context: unknown;
}

// Mutable per-test config the mocks read. Reset in beforeEach.
let dbRows: CredentialRow[] = [];
let decryptedValue: string | null = null;
let envSecret: string | null = null;
let refreshNeeded = false;
let refreshThrows = false;

// Spread the real module so sibling exports (getDbConnectionInfo, withReadDb, …)
// stay present for other importers; override only the two lazy query Proxies so
// no real connection is ever opened.
const realDbClient = await import("../../../db/client");
mock.module("../../../db/client", () => ({
  ...realDbClient,
  dbRead: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbRows,
        }),
      }),
    }),
  },
  dbWrite: {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

mock.module("../secrets", () => ({
  secretsService: {
    getDecryptedValue: async () => decryptedValue,
    get: async () => envSecret,
    create: async () => "new-secret-id",
  },
}));

mock.module("./token-refresh", () => ({
  needsRefresh: () => refreshNeeded,
  isTokenExpired: () => refreshNeeded,
  refreshToken: async () => {
    if (refreshThrows) throw new Error("Twitter token refresh failed: missing access token");
    return { accessToken: "fresh", refreshToken: "fresh-refresh" };
  },
  getRefreshGuidance: () => "Please reconnect your account.",
}));

mock.module("./alerts", () => ({ alertOnPostFailure: async () => {} }));

const { socialMediaService } = await import("./index");

const ORG_ID = "00000000-0000-4000-8000-00000000c001";

function activeOAuthRow(): CredentialRow {
  return {
    id: "cred-1",
    organization_id: ORG_ID,
    platform: "twitter",
    status: "active",
    api_key_secret_id: null,
    access_token_secret_id: "acc-secret",
    refresh_token_secret_id: "ref-secret",
    token_expires_at: new Date(Date.now() - 60_000),
    platform_username: "tester",
    platform_user_id: "uid-1",
    source_context: null,
  };
}

beforeEach(() => {
  dbRows = [];
  decryptedValue = null;
  envSecret = null;
  refreshNeeded = false;
  refreshThrows = false;
});

afterEach(() => {
  dbRows = [];
});

describe("getCredentialsForPlatform — refresh failure fails closed (#13415)", () => {
  test("THROWS 'Token expired' when a needed refresh fails (failure never becomes null/stale)", async () => {
    dbRows = [activeOAuthRow()];
    decryptedValue = "stale-access-token";
    refreshNeeded = true;
    refreshThrows = true;

    // The outbound refresh failure is caught (J1) and normalized to null, then
    // the !refreshed branch rethrows a typed guidance error. It must surface as
    // a throw — returning the stale token here would post with a dead credential.
    await expect(socialMediaService.getCredentialsForPlatform(ORG_ID, "twitter")).rejects.toThrow(
      /Token expired\. Please reconnect your account\./,
    );
  });

  test("returns refreshed credentials (not stale) when the refresh succeeds", async () => {
    dbRows = [activeOAuthRow()];
    decryptedValue = "stale-access-token";
    refreshNeeded = true;
    refreshThrows = false;

    const creds = await socialMediaService.getCredentialsForPlatform(ORG_ID, "twitter");
    expect(creds).not.toBeNull();
    // A successful refresh must swap in the new token, never keep the stale one.
    expect(creds?.accessToken).toBe("fresh");
  });

  test("not-configured provider returns null (designed-empty stays distinct from failure)", async () => {
    // No DB credential row and no env secret: a legitimately unconfigured
    // provider is an empty domain result, NOT an internal failure — so this
    // path returns null, unlike the throwing refresh-failure above.
    dbRows = [];
    envSecret = null;

    const creds = await socialMediaService.getCredentialsForPlatform(ORG_ID, "twitter");
    expect(creds).toBeNull();
  });
});
