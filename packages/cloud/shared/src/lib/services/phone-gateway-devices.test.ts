/** Exercises phone-gateway persistence and authentication with deterministic Cloud fixtures. */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

const { registerPhoneGatewayDevice } = await import("./phone-gateway-devices");

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
      sendMethod: "blooio-hosted",
      cloudWebhookUrl: "https://api.example.test/api/webhooks/blooio/org-1",
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
        send_method: "blooio-hosted",
        cloud_webhook_url: "https://api.example.test/api/webhooks/blooio/org-1",
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
});
