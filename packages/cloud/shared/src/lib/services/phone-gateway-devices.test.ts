/** Exercises phone-gateway persistence and authentication with deterministic Cloud fixtures. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDbClient from "../../db/client";
import * as realDbSchemas from "../../db/schemas";

// bun's `mock.module` patches the process-global module registry. Under the
// batched cloud-unit runner (`--isolate` occasionally fails to contain these on
// a memory-pressured runner), these db/client + db/schemas doubles otherwise
// bleed into later suites that import the real modules (e.g. the provisioning /
// stripe-payout suites), turning them red. Snapshot the real exports now and
// reinstall them in afterAll so this file's stubs are strictly local.
const realDbClientExports = { ...realDbClient };
const realDbSchemasExports = { ...realDbSchemas };

const values = mock();
const onConflictDoUpdate = mock();
const returning = mock();
const execute = mock();
const selectLimit = mock();
const updateSet = mock();
const updateWhere = mock();
const updateReturning = mock();
const transaction = mock();

const insertBuilder = {
  values,
  onConflictDoUpdate,
  returning,
};
const selectBuilder = {
  from: mock(() => selectBuilder),
  where: mock(() => selectBuilder),
  limit: selectLimit,
};
const updateBuilder = {
  set: updateSet,
  where: updateWhere,
  returning: updateReturning,
};

mock.module("../../db/client", () => ({
  db: {},
  dbRead: {
    select: mock(() => selectBuilder),
  },
  dbWrite: {
    insert: mock(() => insertBuilder),
    select: mock(() => selectBuilder),
    update: mock(() => updateBuilder),
    execute,
    transaction,
  },
  getDbConnectionInfo: mock(() => ({ databaseUrlConfigured: true })),
  runWithDbCache: (fn: () => unknown) => fn(),
  runWithDbCacheAsync: async (fn: () => Promise<unknown>) => fn(),
  withReadDb: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
  withWriteDb: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
}));

mock.module("../../db/schemas", () => ({
  ...realDbSchemas,
  anonymousSessions: {},
  agentPhoneContacts: {
    provider: "provider",
    contact_identifier: "contact_identifier",
    agent_id: "agent_id",
  },
  agentPhoneNumbers: {},
  appRequests: {},
  appAnalytics: {},
  apps: {},
  appUsers: {},
  adminUsers: {},
  containers: {},
  conversations: {},
  elizaRoomCharactersTable: {},
  invoices: {},
  mcpPricingTypeEnum: {},
  mcpStatusEnum: {},
  mcpUsage: {},
  moderationViolations: {},
  organizationEncryptionKeys: {},
  organizations: {},
  phoneMessageLog: {},
  phoneGatewayDevices: {
    id: "id",
    provider: "provider",
    phone_number: "phone_number",
    bridge_id: "bridge_id",
    organization_id: "organization_id",
    is_active: "is_active",
    metadata: "metadata",
  },
  userCharacters: {},
  userMcps: {},
  userModerationStatus: {},
  users: {},
  vertexModelAssignments: {},
  vertexTunedModels: {},
  vertexTuningJobs: {},
}));

const {
  authenticateBlueBubblesGateway,
  createBlueBubblesGatewayRegistration,
  hashBlueBubblesGatewayToken,
  registerPhoneGatewayDevice,
  revokeBlueBubblesGateway,
} = await import("./phone-gateway-devices");

afterAll(() => {
  mock.module("../../db/client", () => realDbClientExports);
  mock.module("../../db/schemas", () => realDbSchemasExports);
});

describe("registerPhoneGatewayDevice", () => {
  beforeEach(() => {
    values.mockReset();
    values.mockReturnValue(insertBuilder);
    onConflictDoUpdate.mockReset();
    onConflictDoUpdate.mockReturnValue(insertBuilder);
    returning.mockReset();
    returning.mockResolvedValue([{ id: "gateway-device-1" }]);
    execute.mockReset();
    execute.mockResolvedValue(undefined);
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([]);
    updateSet.mockReset();
    updateSet.mockReturnValue(updateBuilder);
    updateWhere.mockReset();
    updateWhere.mockReturnValue(updateBuilder);
    updateReturning.mockReset();
    updateReturning.mockResolvedValue([{ id: "gateway-device-1" }]);
    transaction.mockReset();
    transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        await fn({
          execute,
          insert: mock(() => insertBuilder),
          update: mock(() => updateBuilder),
        }),
    );
  });

  test("upserts a shared gateway device by provider, phone number, and bridge id", async () => {
    const result = await registerPhoneGatewayDevice({
      organizationId: "org-1",
      provider: "blooio",
      phoneNumber: "+1 (415) 961-1510",
      bridgeId: "local",
      phoneAccountId: "+14159611510",
      phoneAccountLabel: "Eliza Cloud Gateway",
      friendlyName: "Eliza Cloud Gateway",
      sendMethod: "bluebubbles-local-bridge",
      cloudWebhookUrl: "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles",
      metadata: { eventType: "new-message" },
    });

    expect(result).toEqual({ id: "gateway-device-1", registered: true });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        provider: "blooio",
        phone_number: "+14159611510",
        bridge_id: "local",
        phone_account_id: "+14159611510",
        phone_account_label: "Eliza Cloud Gateway",
        friendly_name: "Eliza Cloud Gateway",
        send_method: "bluebubbles-local-bridge",
        cloud_webhook_url: "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles",
        metadata: '{"eventType":"new-message"}',
        is_active: true,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.arrayContaining(["provider", "phone_number", "bridge_id"]),
        set: expect.objectContaining({
          organization_id: "org-1",
          phone_account_id: "+14159611510",
          is_active: true,
        }),
      }),
    );
  });

  test("repairs the gateway table on first use when the migration is missing", async () => {
    returning
      .mockRejectedValueOnce(new Error('relation "phone_gateway_devices" does not exist'))
      .mockResolvedValueOnce([{ id: "gateway-device-1" }]);

    const result = await registerPhoneGatewayDevice({
      provider: "blooio",
      phoneNumber: "+14159611510",
    });

    expect(result).toEqual({
      id: "gateway-device-1",
      registered: true,
    });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  test("registers a sender-owned BlueBubbles phone with a one-time hash-stored credential", async () => {
    const result = await createBlueBubblesGatewayRegistration({
      organizationId: "org-1",
      userId: "user-1",
      routingMode: "sender-owned",
      phoneNumber: "+1 (415) 555-0123",
      friendlyName: "Test iPhone",
    });

    expect(result).toMatchObject({
      id: "gateway-device-1",
      phoneNumber: "+14155550123",
      organizationId: "org-1",
      userId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
    });
    expect(result.bridgeId).toMatch(/^bb-[0-9a-f-]{36}$/);
    expect(result.token).toMatch(/^bbg_[0-9a-f]{64}$/);

    const inserted = values.mock.calls[0]?.[0] as {
      metadata: string;
      provider: string;
      bridge_id: string;
    };
    const metadata = JSON.parse(inserted.metadata) as Record<string, unknown>;
    expect(inserted.provider).toBe("blooio");
    expect(inserted.bridge_id).toBe(result.bridgeId);
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      gatewayKind: "bluebubbles",
      ownerUserId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
    });
    expect(metadata).not.toHaveProperty("token");
    expect(metadata.authTokenHash).toBe(await hashBlueBubblesGatewayToken(result.token));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ last_seen_at: null }));
  });

  test("atomically deactivates the prior credential before re-registration", async () => {
    await createBlueBubblesGatewayRegistration({
      organizationId: "org-1",
      userId: "user-1",
      routingMode: "sender-owned",
      phoneNumber: "+1 (415) 555-0123",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.anything());
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(updateWhere).toHaveBeenCalled();
  });

  test("authenticates only the token issued for a sender-owned registered bridge", async () => {
    const token = `bbg_${"b".repeat(64)}`;
    const authTokenHash = await hashBlueBubblesGatewayToken(token);
    selectLimit.mockResolvedValue([
      {
        id: "gateway-device-1",
        organization_id: "org-1",
        provider: "blooio",
        phone_number: "+14155550123",
        bridge_id: "bb-registered",
        friendly_name: "Test iPhone",
        is_active: true,
        last_seen_at: null,
        metadata: JSON.stringify({
          schemaVersion: 2,
          gatewayKind: "bluebubbles",
          ownerUserId: "user-1",
          routingMode: "sender-owned",
          agentId: null,
          authTokenHash,
          tokenCreatedAt: new Date().toISOString(),
        }),
      },
    ]);

    await expect(authenticateBlueBubblesGateway("bb-registered", token)).resolves.toMatchObject({
      id: "gateway-device-1",
      bridgeId: "bb-registered",
      organizationId: "org-1",
      userId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
    });
    await expect(
      authenticateBlueBubblesGateway("bb-registered", "wrong-token"),
    ).resolves.toBeNull();
  });

  test("keeps schema-version-one gateways on fixed-agent routing", async () => {
    const token = `bbg_${"c".repeat(64)}`;
    selectLimit.mockResolvedValue([
      {
        id: "legacy-gateway-device",
        organization_id: "org-1",
        provider: "blooio",
        phone_number: "+14155550123",
        bridge_id: "bb-legacy",
        friendly_name: "Legacy iPhone",
        is_active: true,
        last_seen_at: null,
        metadata: JSON.stringify({
          schemaVersion: 1,
          gatewayKind: "bluebubbles",
          ownerUserId: "user-1",
          agentId: "agent-1",
          authTokenHash: await hashBlueBubblesGatewayToken(token),
          tokenCreatedAt: new Date().toISOString(),
        }),
      },
    ]);

    await expect(authenticateBlueBubblesGateway("bb-legacy", token)).resolves.toMatchObject({
      routingMode: "fixed-agent",
      agentId: "agent-1",
    });
  });

  test("revokes only a gateway owned by the authenticated user", async () => {
    const token = `bbg_${"d".repeat(64)}`;
    const record = {
      id: "gateway-device-1",
      organization_id: "org-1",
      provider: "blooio",
      phone_number: "+14155550123",
      bridge_id: "bb-registered",
      friendly_name: "Test iPhone",
      is_active: true,
      last_seen_at: null,
      metadata: JSON.stringify({
        schemaVersion: 2,
        gatewayKind: "bluebubbles",
        ownerUserId: "user-1",
        routingMode: "sender-owned",
        agentId: null,
        authTokenHash: await hashBlueBubblesGatewayToken(token),
        tokenCreatedAt: new Date().toISOString(),
      }),
    };

    selectLimit.mockResolvedValueOnce([
      { ...record, metadata: record.metadata.replace("user-1", "user-2") },
    ]);
    await expect(revokeBlueBubblesGateway("org-1", "user-1", "gateway-device-1")).resolves.toBe(
      false,
    );
    expect(updateSet).not.toHaveBeenCalled();

    selectLimit.mockResolvedValueOnce([record]);
    await expect(revokeBlueBubblesGateway("org-1", "user-1", "gateway-device-1")).resolves.toBe(
      true,
    );
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });
});
