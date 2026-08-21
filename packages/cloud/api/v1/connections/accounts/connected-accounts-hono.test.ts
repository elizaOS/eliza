/**
 * Hono route tests for the connected-capability projection API. Auth and the
 * DB-backed singleton are mocked at the module boundary, but the mocked
 * singleton is a real ConnectedCapabilitiesService over deterministic typed
 * source rows, so the live route handlers, pagination/filter validation, and
 * the real projection contract are exercised end to end in-process.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  CONNECTED_ACCOUNT_MODES,
  ConnectedCapabilitiesService,
  type ConnectedCapabilitySourceRows,
  type PlatformCredentialRow,
} from "../../../../shared/src/lib/services/connected-capabilities/service";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-20T12:00:00.000Z");

let authedOrg = ORG_A;
let authShouldFail = false;

class TestAuthError extends Error {}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (authShouldFail) {
      throw new TestAuthError("unauthorized");
    }
    return { id: "user-1", organization_id: authedOrg };
  },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  ApiError: TestAuthError,
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "UNAUTHORIZED" }, 401),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(() => undefined), debug: mock(() => undefined) },
}));

function credentialRow(
  overrides: Partial<PlatformCredentialRow>,
): PlatformCredentialRow {
  const base = {
    id: "33333333-3333-4333-8333-333333333331",
    organization_id: ORG_A,
    user_id: null,
    app_id: null,
    platform: "gmail",
    platform_user_id: "user-123",
    platform_username: "alice",
    platform_display_name: "Alice Example",
    platform_avatar_url: null,
    platform_email: null,
    status: "active",
    error_message: null,
    access_token_secret_id: null,
    refresh_token_secret_id: null,
    token_expires_at: null,
    scopes: ["gmail.readonly", "gmail.send"],
    api_key_secret_id: null,
    granted_permissions: [],
    source_type: null,
    source_context: null,
    profile_data: null,
    platform_user_id_ciphertext: null,
    platform_user_id_nonce: null,
    platform_user_id_auth_tag: null,
    platform_user_id_kms_key_id: null,
    platform_user_id_kms_key_version: null,
    platform_email_ciphertext: null,
    platform_email_nonce: null,
    platform_email_auth_tag: null,
    platform_email_kms_key_id: null,
    platform_email_kms_key_version: null,
    platform_display_name_ciphertext: null,
    platform_display_name_nonce: null,
    platform_display_name_auth_tag: null,
    platform_display_name_kms_key_id: null,
    platform_display_name_kms_key_version: null,
    created_at: NOW,
    linked_at: NOW,
    last_used_at: NOW,
    last_refreshed_at: null,
    expires_at: null,
    revoked_at: null,
    updated_at: NOW,
    deleted_at: null,
  } satisfies PlatformCredentialRow;
  return { ...base, ...overrides };
}

function emptyRows(): ConnectedCapabilitySourceRows {
  return {
    platformCredentials: [],
    vendorConnections: [],
    discordConnections: [],
    phoneGatewayDevices: [],
  };
}

let loadShouldFail = false;
const rowsByOrg: Record<string, ConnectedCapabilitySourceRows> = {
  [ORG_A]: {
    ...emptyRows(),
    platformCredentials: [
      credentialRow({}),
      credentialRow({
        id: "33333333-3333-4333-8333-333333333332",
        platform: "notion",
        status: "revoked",
        scopes: [],
      }),
    ],
  },
  [ORG_B]: emptyRows(),
};

const testService = new ConnectedCapabilitiesService(
  {
    async load(organizationId) {
      if (loadShouldFail) {
        throw new Error("db down");
      }
      return rowsByOrg[organizationId] ?? emptyRows();
    },
  },
  () => NOW,
);

mock.module("@/lib/services/connected-capabilities", () => ({
  CONNECTED_ACCOUNT_MODES,
  connectedCapabilitiesService: testService,
}));

const { default: listRoute } = await import("./route");
const { default: detailRoute } = await import("./[accountId]/route");

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const app = new Hono<AppEnv>();
app.route("/api/v1/connections/accounts/:accountId", detailRoute);
app.route("/api/v1/connections/accounts", listRoute);

async function get(path: string): Promise<Response> {
  return await app.request(path, {}, ENV);
}

interface AccountDto {
  accountId: string;
  providerId: string;
  status: string;
  capabilities: { capabilityId: string; status: string }[];
}
interface PageDto {
  accounts: AccountDto[];
  total: number;
  limit: number;
  offset: number;
}

beforeEach(() => {
  authedOrg = ORG_A;
  authShouldFail = false;
  loadShouldFail = false;
});

describe("GET /api/v1/connections/accounts", () => {
  test("lists the org's projected accounts with defaults", async () => {
    const res = await get("/api/v1/connections/accounts");
    expect(res.status).toBe(200);
    const page = (await res.json()) as PageDto;
    expect(page.total).toBe(2);
    expect(page.limit).toBe(50);
    expect(page.offset).toBe(0);
    expect(page.accounts.map((a) => a.providerId).sort()).toEqual([
      "gmail",
      "notion",
    ]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("33333333-3333-4333-8333");
    expect(serialized).not.toContain("token");
  });

  test("paginates deterministically", async () => {
    const first = (await (
      await get("/api/v1/connections/accounts?limit=1&offset=0")
    ).json()) as PageDto;
    const second = (await (
      await get("/api/v1/connections/accounts?limit=1&offset=1")
    ).json()) as PageDto;
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.accounts).toHaveLength(1);
    expect(second.accounts).toHaveLength(1);
    expect(first.accounts[0]?.accountId).not.toBe(
      second.accounts[0]?.accountId,
    );
  });

  test("rejects malformed pagination, provider, and mode input", async () => {
    expect((await get("/api/v1/connections/accounts?limit=1e3")).status).toBe(
      400,
    );
    expect((await get("/api/v1/connections/accounts?limit=0")).status).toBe(
      400,
    );
    expect((await get("/api/v1/connections/accounts?offset=-1")).status).toBe(
      400,
    );
    expect(
      (await get("/api/v1/connections/accounts?providerId=Bad%20Provider"))
        .status,
    ).toBe(400);
    expect((await get("/api/v1/connections/accounts?mode=magic")).status).toBe(
      400,
    );
  });

  test("filters by providerId and surfaces revoked status", async () => {
    const res = await get("/api/v1/connections/accounts?providerId=notion");
    const page = (await res.json()) as PageDto;
    expect(page.total).toBe(1);
    expect(page.accounts[0]?.status).toBe("revoked");
    expect(page.accounts[0]?.capabilities[0]?.status).toBe("account_revoked");
  });

  test("designed-empty organization returns an empty page", async () => {
    authedOrg = ORG_B;
    const page = (await (
      await get("/api/v1/connections/accounts")
    ).json()) as PageDto;
    expect(page).toEqual({ accounts: [], total: 0, limit: 50, offset: 0 });
  });

  test("auth failure returns 401 without projecting", async () => {
    authShouldFail = true;
    expect((await get("/api/v1/connections/accounts")).status).toBe(401);
  });

  test("source failure returns a structured 500 without storage context", async () => {
    loadShouldFail = true;
    const res = await get("/api/v1/connections/accounts");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("CONNECTED_ACCOUNTS_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("db down");
  });
});

describe("GET /api/v1/connections/accounts/:accountId", () => {
  test("resolves an owned handle and 404s cross-org and unknown handles", async () => {
    const page = (await (
      await get("/api/v1/connections/accounts")
    ).json()) as PageDto;
    const handle = page.accounts[0]?.accountId;
    if (handle === undefined) throw new Error("missing handle");

    const detail = await get(`/api/v1/connections/accounts/${handle}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { account: AccountDto };
    expect(body.account.accountId).toBe(handle);

    authedOrg = ORG_B;
    expect((await get(`/api/v1/connections/accounts/${handle}`)).status).toBe(
      404,
    );

    authedOrg = ORG_A;
    expect(
      (await get(`/api/v1/connections/accounts/ca_${"0".repeat(32)}`)).status,
    ).toBe(404);
  });

  test("rejects handles that are not opaque capability handles", async () => {
    const raw = await get(
      "/api/v1/connections/accounts/33333333-3333-4333-8333-333333333331",
    );
    expect(raw.status).toBe(400);
  });

  test("auth failure returns 401", async () => {
    authShouldFail = true;
    expect(
      (await get(`/api/v1/connections/accounts/ca_${"0".repeat(32)}`)).status,
    ).toBe(401);
  });
});
