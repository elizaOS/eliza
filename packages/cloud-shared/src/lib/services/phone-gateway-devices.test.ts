import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDbSchemas from "../../db/schemas";

const values = mock();
const onConflictDoUpdate = mock();
const returning = mock();
const execute = mock();

const insertBuilder = {
  values,
  onConflictDoUpdate,
  returning,
};

mock.module("../../db/client", () => ({
  db: {},
  dbRead: {},
  dbWrite: {
    insert: mock(() => insertBuilder),
    execute,
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
  appUsers: {},
  phoneMessageLog: {},
  phoneGatewayDevices: {
    id: "id",
    provider: "provider",
    phone_number: "phone_number",
    bridge_id: "bridge_id",
  },
}));

const { registerPhoneGatewayDevice } = await import("./phone-gateway-devices");

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
        target: ["provider", "phone_number", "bridge_id"],
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
});
