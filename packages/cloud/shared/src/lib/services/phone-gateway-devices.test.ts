/** Exercises phone-gateway persistence and authentication with deterministic Cloud fixtures. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import * as realDbClient from "../../db/client";
// Load SQL metadata projections before this suite installs process-global
// schema doubles, so later batched PGlite suites retain the real columns.
import "../../db/repositories/phone-metadata-readers";
import * as realDbSchemas from "../../db/schemas";
import * as realLogger from "../utils/logger";

// bun's `mock.module` patches the process-global module registry. Under the
// batched cloud-unit runner (`--isolate` occasionally fails to contain these on
// a memory-pressured runner), these db/client + db/schemas doubles otherwise
// bleed into later suites that import the real modules (e.g. the provisioning /
// stripe-payout suites), turning them red. Snapshot the real exports now and
// reinstall them in afterAll so this file's stubs are strictly local.
const realDbClientExports = { ...realDbClient };
const realDbSchemasExports = { ...realDbSchemas };
const realLoggerExports = { ...realLogger };

const values = mock();
const onConflictDoUpdate = mock();
const returning = mock();
const execute = mock();
const selectLimit = mock();
const selectWhere = mock();
const updateSet = mock();
const updateWhere = mock();
const updateReturning = mock();
const transaction = mock();
const loggerWarn = mock();

const insertBuilder = {
  values,
  onConflictDoUpdate,
  returning,
};
const selectBuilder = {
  from: mock(() => selectBuilder),
  where: selectWhere,
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

mock.module("../utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: loggerWarn,
  },
}));

const {
  authenticateBlueBubblesGateway,
  createBlueBubblesGatewayRegistration,
  hashBlueBubblesGatewayToken,
  listBlueBubblesGateways,
  registerPhoneGatewayDevice,
  revokeBlueBubblesGateway,
  touchBlueBubblesGateway,
} = await import("./phone-gateway-devices");

afterAll(() => {
  mock.module("../../db/client", () => realDbClientExports);
  mock.module("../../db/schemas", () => realDbSchemasExports);
  mock.module("../utils/logger", () => realLoggerExports);
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
    selectWhere.mockReset();
    selectWhere.mockReturnValue(selectBuilder);
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
    loggerWarn.mockClear();
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
        metadata: { eventType: "new-message" },
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

  test("fails closed without recreating the gateway table when its migration is missing", async () => {
    returning.mockRejectedValueOnce(
      Object.assign(new Error('relation "phone_gateway_devices" does not exist'), {
        code: "42P01",
      }),
    );

    await expect(
      registerPhoneGatewayDevice({
        provider: "blooio",
        phoneNumber: "+14159611510",
      }),
    ).rejects.toMatchObject({ code: "PHONE_SCHEMA_MIGRATION_REQUIRED" });
    expect(execute).not.toHaveBeenCalled();
  });

  test("rejects non-JSON gateway metadata before insert without logging its contents", async () => {
    const secret = "gateway-secret-that-must-not-appear";
    try {
      await registerPhoneGatewayDevice({
        provider: "blooio",
        phoneNumber: "+14159611510",
        metadata: { invalid: undefined, secret },
      });
      throw new Error("Expected invalid gateway metadata");
    } catch (error) {
      // error-policy:J3 the test inspects the typed invalid-input boundary.
      expect(error).toMatchObject({ code: "PHONE_GATEWAY_METADATA_INVALID" });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(returning).not.toHaveBeenCalled();
  });

  test("uses bounded diagnostics when gateway persistence fails", async () => {
    const sentinelPhone = "+19995550123";
    const sentinelBridge = "SENTINEL_PROVIDER_BRIDGE_ID";
    const sentinelDatabaseBody = "SENTINEL_GATEWAY_DATABASE_BODY";
    returning.mockRejectedValueOnce(
      Object.assign(
        new Error(`${sentinelDatabaseBody}-message`, {
          cause: Object.assign(new Error(`${sentinelDatabaseBody}-cause`), {
            name: `${sentinelDatabaseBody}-cause-name`,
          }),
        }),
        {
          name: `${sentinelDatabaseBody}-name`,
        },
      ),
    );

    await expect(
      registerPhoneGatewayDevice({
        provider: "blooio",
        phoneNumber: sentinelPhone,
        bridgeId: sentinelBridge,
      }),
    ).resolves.toEqual({
      id: null,
      registered: false,
      skippedReason: "write_failed",
    });

    const serializedLogs = JSON.stringify(loggerWarn.mock.calls);
    expect(serializedLogs).not.toContain(sentinelPhone);
    expect(serializedLogs).not.toContain(sentinelBridge);
    expect(serializedLogs).not.toContain(sentinelDatabaseBody);
    expect(serializedLogs).toContain('"errorClass":"unexpected_phone_failure"');
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
      metadata: Record<string, unknown>;
      provider: string;
      bridge_id: string;
    };
    expect(inserted.provider).toBe("blooio");
    expect(inserted.bridge_id).toBe(result.bridgeId);
    expect(inserted.metadata).toMatchObject({
      schemaVersion: 2,
      gatewayKind: "bluebubbles",
      ownerUserId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
    });
    expect(inserted.metadata).not.toHaveProperty("token");
    expect(inserted.metadata.authTokenHash).toBe(await hashBlueBubblesGatewayToken(result.token));
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

  test("rotates a phone credential across trusted administrators", async () => {
    await createBlueBubblesGatewayRegistration({
      organizationId: "org-1",
      userId: "first-admin",
      routingMode: "sender-owned",
      phoneNumber: "+1 (415) 555-0123",
    });
    await createBlueBubblesGatewayRegistration({
      organizationId: "org-1",
      userId: "second-admin",
      routingMode: "sender-owned",
      phoneNumber: "+1 (415) 555-0123",
    });

    const dialect = new PgDialect();
    const lockParameters = execute.mock.calls.map(
      ([statement]) => dialect.sqlToQuery(statement).params,
    );
    expect(lockParameters).toEqual([["org-1:+14155550123"], ["org-1:+14155550123"]]);

    for (const [predicate] of updateWhere.mock.calls) {
      const query = dialect.sqlToQuery(predicate);
      const parameters = query.params;
      expect(parameters).toContain("org-1");
      expect(parameters).toContain("+14155550123");
      expect(parameters).not.toContain("first-admin");
      expect(parameters).not.toContain("second-admin");
      expect(query.sql).not.toContain("::jsonb");
    }
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

  test("translates missing gateway schema across every read and mutation boundary", async () => {
    const missingTable = () =>
      Object.assign(new Error('relation "phone_gateway_devices" does not exist'), {
        code: "42P01",
      });

    selectLimit.mockRejectedValueOnce(missingTable());
    await expect(authenticateBlueBubblesGateway("bb-registered", "token")).rejects.toMatchObject({
      code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
    });

    selectWhere.mockRejectedValueOnce(missingTable());
    await expect(listBlueBubblesGateways("org-1", "user-1")).rejects.toMatchObject({
      code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
    });

    updateWhere.mockRejectedValueOnce(missingTable());
    await expect(touchBlueBubblesGateway("gateway-device-1")).rejects.toMatchObject({
      code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
    });

    selectLimit.mockRejectedValueOnce(missingTable());
    await expect(
      revokeBlueBubblesGateway("org-1", "user-1", "gateway-device-1"),
    ).rejects.toMatchObject({ code: "PHONE_SCHEMA_MIGRATION_REQUIRED" });
  });

  test("revokes only a gateway owned by the authenticated user", async () => {
    const token = `bbg_${"d".repeat(64)}`;
    const metadata = {
      schemaVersion: 2,
      gatewayKind: "bluebubbles",
      ownerUserId: "user-1",
      routingMode: "sender-owned",
      agentId: null,
      authTokenHash: await hashBlueBubblesGatewayToken(token),
      tokenCreatedAt: new Date().toISOString(),
    };
    const record = {
      id: "gateway-device-1",
      organization_id: "org-1",
      provider: "blooio",
      phone_number: "+14155550123",
      bridge_id: "bb-registered",
      friendly_name: "Test iPhone",
      is_active: true,
      last_seen_at: null,
      metadata: JSON.stringify(metadata),
    };

    selectLimit.mockResolvedValueOnce([
      { ...record, metadata: JSON.stringify({ ...metadata, ownerUserId: "user-2" }) },
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
