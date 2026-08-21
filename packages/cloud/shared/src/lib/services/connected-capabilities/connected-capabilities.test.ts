/**
 * Deterministic contract tests for the connected-capability projection
 * service. The real projection and paging logic run unmocked over typed
 * in-memory source rows (the exact Drizzle select models the DB loader
 * returns), so the harness is protocol-faithful without a database.
 */

import { describe, expect, test } from "bun:test";
import {
  ConnectedCapabilitiesService,
  type ConnectedCapabilitySourceRows,
  type DiscordConnectionRow,
  type PhoneGatewayDeviceRow,
  type PlatformCredentialRow,
  projectConnectedAccounts,
  type VendorConnectionRow,
} from "./service";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const PAST = new Date("2026-08-01T00:00:00.000Z");

/**
 * Row factories intentionally construct only the narrowed `Pick<>` shape the
 * DB loader (`./index.ts`) actually selects — not the full Drizzle row. That
 * narrowing IS the defect-1 fix: a factory that could still set
 * `access_token_encrypted` or `platform_user_id_ciphertext` would let a
 * secret column silently rejoin this contract. The "row shape" test below
 * additionally asserts what the real loader's query requests, independent of
 * these fixtures.
 */
function platformCredentialRow(overrides: Partial<PlatformCredentialRow>): PlatformCredentialRow {
  return {
    id: "33333333-3333-4333-8333-333333333331",
    platform: "gmail",
    platform_username: "alice",
    platform_display_name: "Alice Example",
    status: "active",
    scopes: ["gmail.readonly", "gmail.send"],
    last_used_at: new Date("2026-08-19T09:30:00.000Z"),
    deleted_at: null,
    ...overrides,
  };
}

function vendorConnectionRow(overrides: Partial<VendorConnectionRow>): VendorConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333332",
    vendor: "linear",
    label: "workspace",
    hasRefreshToken: false,
    expires_at: null,
    scopes: ["read", "issues:create"],
    deleted_at: null,
    ...overrides,
  };
}

function discordConnectionRow(overrides: Partial<DiscordConnectionRow>): DiscordConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    status: "connected",
    last_heartbeat: new Date("2026-08-20T11:59:00.000Z"),
    is_active: true,
    ...overrides,
  };
}

function phoneGatewayDeviceRow(overrides: Partial<PhoneGatewayDeviceRow>): PhoneGatewayDeviceRow {
  return {
    id: "33333333-3333-4333-8333-333333333334",
    phone_account_label: "Personal iPhone",
    friendly_name: null,
    is_active: true,
    can_send_sms: true,
    can_receive_sms: true,
    can_send_imessage: false,
    can_receive_imessage: true,
    last_seen_at: new Date("2026-08-20T11:00:00.000Z"),
    ...overrides,
  };
}

function emptyRows(): ConnectedCapabilitySourceRows {
  return {
    platformCredentials: [],
    vendorConnections: [],
    discordConnections: [],
    phoneGatewayDevices: [],
  };
}

function fullRows(): ConnectedCapabilitySourceRows {
  return {
    platformCredentials: [platformCredentialRow({})],
    vendorConnections: [vendorConnectionRow({})],
    discordConnections: [discordConnectionRow({})],
    phoneGatewayDevices: [phoneGatewayDeviceRow({})],
  };
}

function serviceFor(
  rowsByOrg: Record<string, ConnectedCapabilitySourceRows>,
): ConnectedCapabilitiesService {
  return new ConnectedCapabilitiesService(
    {
      async load(organizationId) {
        return rowsByOrg[organizationId] ?? emptyRows();
      },
    },
    () => NOW,
  );
}

describe("projectConnectedAccounts", () => {
  test("projects every source into contract-normalized accounts", async () => {
    const accounts = await projectConnectedAccounts(fullRows(), NOW);
    expect(accounts).toHaveLength(4);
    const byProvider = Object.fromEntries(accounts.map((account) => [account.providerId, account]));

    expect(byProvider.gmail.mode).toBe("cloud");
    expect(byProvider.gmail.status).toBe("connected");
    expect(byProvider.gmail.displayName).toBe("Alice Example");
    expect(byProvider.gmail.lastUsedAt).toBe("2026-08-19T09:30:00.000Z");
    expect(byProvider.gmail.capabilities).toEqual([
      {
        capabilityId: "gmail/gmail.readonly",
        riskLevel: "R1",
        status: "available",
      },
      { capabilityId: "gmail/gmail.send", riskLevel: "R2", status: "available" },
    ]);

    expect(byProvider.linear.mode).toBe("cloud");
    expect(byProvider.linear.capabilities).toEqual([
      { capabilityId: "linear/read", riskLevel: "R1", status: "available" },
      // "issues:create" is a mutating scope that the old write-verb allowlist
      // missed (defect 3); it must fail closed to R2, not default to R1.
      {
        capabilityId: "linear/issues:create",
        riskLevel: "R2",
        status: "available",
      },
    ]);

    expect(byProvider.discord.mode).toBe("connector");
    expect(byProvider.discord.capabilities).toEqual([
      { capabilityId: "discord/messaging", riskLevel: "R2", status: "available" },
    ]);

    expect(byProvider["phone-gateway"].mode).toBe("native");
    expect(byProvider["phone-gateway"].displayName).toBe("Personal iPhone");
    expect(byProvider["phone-gateway"].capabilities).toEqual([
      {
        capabilityId: "phone-gateway/sms.send",
        riskLevel: "R2",
        status: "available",
      },
      {
        capabilityId: "phone-gateway/sms.receive",
        riskLevel: "R1",
        status: "available",
      },
      {
        capabilityId: "phone-gateway/imessage.send",
        riskLevel: "R2",
        status: "unsupported",
      },
      {
        capabilityId: "phone-gateway/imessage.receive",
        riskLevel: "R1",
        status: "available",
      },
    ]);
  });

  test("never leaks raw storage row IDs", async () => {
    // Secret columns (tokens/ciphertext/DEKs/nonces) cannot appear here even
    // in principle: the `Pick<>` row types these fixtures build don't carry
    // those fields at all. This test covers the remaining identifying value —
    // the raw row ID — is never serialized verbatim; the DB-loader test suite
    // covers the query-shape half of the secret-column fix (defect 1).
    const accounts = await projectConnectedAccounts(fullRows(), NOW);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain("33333333-3333-4333-8333");
    for (const account of accounts) {
      expect(account.accountId).toMatch(/^ca_[0-9a-f]{32}$/);
    }
  });

  test("account handles are stable across projections", async () => {
    const first = await projectConnectedAccounts(fullRows(), NOW);
    const second = await projectConnectedAccounts(fullRows(), NOW);
    expect(first.map((a) => a.accountId)).toEqual(second.map((a) => a.accountId));
  });

  test("maps credential lifecycle states onto account statuses", async () => {
    const rows = {
      ...emptyRows(),
      platformCredentials: [
        platformCredentialRow({ id: "43333333-3333-4333-8333-333333333331" }),
        platformCredentialRow({
          id: "43333333-3333-4333-8333-333333333332",
          status: "expired",
        }),
        platformCredentialRow({
          id: "43333333-3333-4333-8333-333333333333",
          status: "revoked",
        }),
        platformCredentialRow({
          id: "43333333-3333-4333-8333-333333333334",
          status: "error",
        }),
        platformCredentialRow({
          id: "43333333-3333-4333-8333-333333333335",
          status: "pending",
        }),
      ],
    };
    const statuses = (await projectConnectedAccounts(rows, NOW)).map((account) => account.status);
    expect(statuses.sort()).toEqual([
      "connected",
      "error",
      "reauth_required",
      "revoked",
      "unavailable",
    ]);
  });

  test("revoked and errored accounts surface unavailable capability codes", async () => {
    const rows = {
      ...emptyRows(),
      platformCredentials: [platformCredentialRow({ status: "revoked" })],
      discordConnections: [discordConnectionRow({ status: "error" })],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    const revoked = accounts.find((a) => a.providerId === "gmail");
    const errored = accounts.find((a) => a.providerId === "discord");
    expect(revoked?.capabilities.every((c) => c.status === "account_revoked")).toBe(true);
    expect(errored?.status).toBe("error");
    expect(errored?.capabilities[0]?.status).toBe("account_error");
  });

  test("vendor expiry without a refresh token requires reauth; soft delete is revoked", async () => {
    const rows = {
      ...emptyRows(),
      vendorConnections: [
        vendorConnectionRow({
          id: "53333333-3333-4333-8333-333333333331",
          expires_at: PAST,
        }),
        vendorConnectionRow({
          id: "53333333-3333-4333-8333-333333333332",
          expires_at: PAST,
          hasRefreshToken: true,
        }),
        vendorConnectionRow({
          id: "53333333-3333-4333-8333-333333333333",
          deleted_at: PAST,
        }),
      ],
    };
    const statuses = (await projectConnectedAccounts(rows, NOW)).map((account) => account.status);
    expect(statuses.sort()).toEqual(["connected", "reauth_required", "revoked"]);
  });

  test("soft-deleted OAuth credentials are excluded and empty scopes collapse to a base capability", async () => {
    const rows = {
      ...emptyRows(),
      platformCredentials: [
        platformCredentialRow({ deleted_at: PAST }),
        platformCredentialRow({
          id: "63333333-3333-4333-8333-333333333331",
          platform: "notion",
          scopes: [],
        }),
      ],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.capabilities).toEqual([
      { capabilityId: "notion/connection", riskLevel: "R1", status: "available" },
    ]);
  });

  test("malformed upstream scope strings are dropped, not projected", async () => {
    const rows = {
      ...emptyRows(),
      vendorConnections: [
        vendorConnectionRow({
          scopes: ["   ", "x".repeat(500), "read", "read"],
        }),
      ],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    expect(accounts[0]?.capabilities).toEqual([
      { capabilityId: "linear/read", riskLevel: "R1", status: "available" },
    ]);
  });

  test("unrecognized scope strings fail closed to elevated risk, not the low-risk default", async () => {
    // "custom_scope" matches neither a known write verb nor a known
    // read-only verb — an unrecognized scope must never under-classify its
    // risk (defect 3).
    const rows = {
      ...emptyRows(),
      vendorConnections: [vendorConnectionRow({ scopes: ["custom_scope"] })],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    expect(accounts[0]?.capabilities).toEqual([
      { capabilityId: "linear/custom_scope", riskLevel: "R2", status: "available" },
    ]);
  });

  test("a NULL/unrecorded scope set projects unsupported, not a live available grant", async () => {
    // scopes: null means the grant set was never recorded — distinct from an
    // explicitly-verified empty array — and must not read as a healthy,
    // available base capability (defect 2). Mirrors the ungranted ->
    // "unsupported" handling projectPhoneGatewayDevice already does for
    // native device permissions.
    const rows = {
      ...emptyRows(),
      platformCredentials: [platformCredentialRow({ scopes: null, status: "active" })],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    expect(accounts[0]?.status).toBe("connected");
    expect(accounts[0]?.capabilities).toEqual([
      { capabilityId: "gmail/connection", riskLevel: "R1", status: "unsupported" },
    ]);
  });

  test("an explicitly empty scope array still projects an available base capability", async () => {
    // Contrast case for the NULL test above: a verified-empty grant set ([])
    // is not the same as an unrecorded one (null) and keeps its existing
    // available-base-capability behavior.
    const rows = {
      ...emptyRows(),
      platformCredentials: [platformCredentialRow({ scopes: [], status: "active" })],
    };
    const accounts = await projectConnectedAccounts(rows, NOW);
    expect(accounts[0]?.capabilities).toEqual([
      { capabilityId: "gmail/connection", riskLevel: "R1", status: "available" },
    ]);
  });
});

describe("ConnectedCapabilitiesService", () => {
  test("lists with pagination and reports the unfiltered total", async () => {
    const service = serviceFor({ [ORG_A]: fullRows() });
    const page = await service.list({
      organizationId: ORG_A,
      limit: 2,
      offset: 1,
    });
    expect(page.total).toBe(4);
    expect(page.accounts).toHaveLength(2);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);

    const tail = await service.list({
      organizationId: ORG_A,
      limit: 10,
      offset: 4,
    });
    expect(tail.accounts).toEqual([]);
    expect(tail.total).toBe(4);
  });

  test("filters by providerId and mode", async () => {
    const service = serviceFor({ [ORG_A]: fullRows() });
    const byProvider = await service.list({
      organizationId: ORG_A,
      limit: 10,
      offset: 0,
      providerId: "discord",
    });
    expect(byProvider.total).toBe(1);
    expect(byProvider.accounts[0]?.providerId).toBe("discord");

    const byMode = await service.list({
      organizationId: ORG_A,
      limit: 10,
      offset: 0,
      mode: "cloud",
    });
    expect(byMode.total).toBe(2);
    expect(byMode.accounts.every((a) => a.mode === "cloud")).toBe(true);
  });

  test("designed-empty organization projects an empty page, not an error", async () => {
    const service = serviceFor({});
    const page = await service.list({
      organizationId: ORG_B,
      limit: 10,
      offset: 0,
    });
    expect(page).toEqual({ accounts: [], total: 0, limit: 10, offset: 0 });
  });

  test("detail resolves a handle only inside its own organization", async () => {
    const service = serviceFor({ [ORG_A]: fullRows(), [ORG_B]: emptyRows() });
    const page = await service.list({
      organizationId: ORG_A,
      limit: 10,
      offset: 0,
    });
    const handle = page.accounts[0]?.accountId;
    expect(handle).toBeDefined();
    if (handle === undefined) throw new Error("missing handle");

    const own = await service.get(ORG_A, handle);
    expect(own?.accountId).toBe(handle);

    const crossOrg = await service.get(ORG_B, handle);
    expect(crossOrg).toBeNull();

    const unknown = await service.get(ORG_A, `ca_${"0".repeat(32)}`);
    expect(unknown).toBeNull();
  });

  test("source load failure fails closed with tenant context", async () => {
    const service = new ConnectedCapabilitiesService(
      {
        async load() {
          throw new Error("db down");
        },
      },
      () => NOW,
    );
    await expect(service.list({ organizationId: ORG_A, limit: 10, offset: 0 })).rejects.toThrow(
      /Failed to load connection sources/,
    );
  });
});
