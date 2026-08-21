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

function platformCredentialRow(overrides: Partial<PlatformCredentialRow>): PlatformCredentialRow {
  return {
    id: "33333333-3333-4333-8333-333333333331",
    organization_id: ORG_A,
    user_id: null,
    app_id: null,
    platform: "gmail",
    platform_user_id: "user-123",
    platform_username: "alice",
    platform_display_name: "Alice Example",
    platform_avatar_url: null,
    platform_email: "secret-alice@example.com",
    status: "active",
    error_message: null,
    access_token_secret_id: "44444444-4444-4444-8444-444444444441",
    refresh_token_secret_id: null,
    token_expires_at: null,
    scopes: ["gmail.readonly", "gmail.send"],
    api_key_secret_id: null,
    granted_permissions: [],
    source_type: null,
    source_context: null,
    profile_data: null,
    platform_user_id_ciphertext: "SECRET_CIPHERTEXT",
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
    created_at: PAST,
    linked_at: PAST,
    last_used_at: new Date("2026-08-19T09:30:00.000Z"),
    last_refreshed_at: null,
    expires_at: null,
    revoked_at: null,
    updated_at: PAST,
    deleted_at: null,
    ...overrides,
  };
}

function vendorConnectionRow(overrides: Partial<VendorConnectionRow>): VendorConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333332",
    organization_id: ORG_A,
    vendor: "linear",
    label: "workspace",
    access_token_encrypted: "SECRET_TOKEN",
    refresh_token_encrypted: null,
    encrypted_dek: "SECRET_DEK",
    token_nonce: "SECRET_NONCE",
    token_auth_tag: "SECRET_TAG",
    encryption_key_id: "key-1",
    expires_at: null,
    scopes: ["read", "issues:create"],
    connection_metadata: {},
    created_at: PAST,
    updated_at: PAST,
    deleted_at: null,
    ...overrides,
  };
}

function discordConnectionRow(overrides: Partial<DiscordConnectionRow>): DiscordConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG_A,
    character_id: null,
    application_id: "app-1",
    bot_user_id: "bot-1",
    bot_token_encrypted: "SECRET_BOT_TOKEN",
    encrypted_dek: "SECRET_DEK",
    token_nonce: "SECRET_NONCE",
    token_auth_tag: "SECRET_TAG",
    encryption_key_id: "key-1",
    assigned_pod: null,
    status: "connected",
    error_message: null,
    guild_count: 2,
    events_received: 0,
    events_routed: 0,
    last_heartbeat: new Date("2026-08-20T11:59:00.000Z"),
    connected_at: PAST,
    intents: 0,
    is_active: true,
    metadata: null,
    created_at: PAST,
    updated_at: PAST,
    ...overrides,
  };
}

function phoneGatewayDeviceRow(overrides: Partial<PhoneGatewayDeviceRow>): PhoneGatewayDeviceRow {
  return {
    id: "33333333-3333-4333-8333-333333333334",
    organization_id: ORG_A,
    provider: "imessage",
    phone_number: "+15555550100",
    bridge_id: "default",
    phone_account_id: null,
    phone_account_label: "Personal iPhone",
    friendly_name: null,
    send_method: null,
    cloud_webhook_url: null,
    local_webhook_url: null,
    is_active: true,
    can_send_sms: true,
    can_receive_sms: true,
    can_send_imessage: false,
    can_receive_imessage: true,
    metadata: "{}",
    created_at: PAST,
    updated_at: PAST,
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
      {
        capabilityId: "linear/issues:create",
        riskLevel: "R1",
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

  test("never leaks secret or identifying storage columns", async () => {
    const accounts = await projectConnectedAccounts(fullRows(), NOW);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("secret-alice@example.com");
    expect(serialized).not.toContain("+15555550100");
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
      discordConnections: [discordConnectionRow({ status: "error", error_message: "boom" })],
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
          refresh_token_encrypted: "SECRET_REFRESH",
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
