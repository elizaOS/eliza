import { beforeEach, describe, expect, mock, test } from "bun:test";

const blooioApiRequest = mock();
const secretsGet = mock();
const insertValues = mock();
const onConflictDoUpdate = mock();

const insertBuilder = {
  values: insertValues,
  onConflictDoUpdate,
};

const dbWrite = {
  insert: mock(() => insertBuilder),
};

mock.module("../../../db/client", () => ({
  db: {},
  dbRead: {},
  dbWrite,
  getDbConnectionInfo: mock(() => ({ databaseUrlConfigured: true })),
  runWithDbCache: (fn: () => unknown) => fn(),
  runWithDbCacheAsync: async (fn: () => Promise<unknown>) => fn(),
  withReadDb: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
  withWriteDb: async (fn: (db: unknown) => Promise<unknown>) => fn(dbWrite),
}));

mock.module("../../../db/schemas", () => ({
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
  phoneGatewayDevices: {},
}));

mock.module("../secrets", () => ({
  secretsService: {
    get: secretsGet,
  },
}));

mock.module("../../constants/secrets", () => ({
  BLOOIO_API_KEY: "BLOOIO_API_KEY",
  TWILIO_ACCOUNT_SID: "TWILIO_ACCOUNT_SID",
  TWILIO_AUTH_TOKEN: "TWILIO_AUTH_TOKEN",
  WHATSAPP_ACCESS_TOKEN: "WHATSAPP_ACCESS_TOKEN",
  WHATSAPP_PHONE_NUMBER_ID: "WHATSAPP_PHONE_NUMBER_ID",
}));

mock.module("../../utils/blooio-api", () => ({
  blooioApiRequest,
}));

const { messageRouterService } = await import("./index");

describe("MessageRouterService contact recording", () => {
  beforeEach(() => {
    blooioApiRequest.mockReset();
    secretsGet.mockReset();
    dbWrite.insert.mockClear();
    insertValues.mockReset();
    insertValues.mockReturnValue(insertBuilder);
    onConflictDoUpdate.mockReset();
    onConflictDoUpdate.mockResolvedValue(undefined);
  });

  test("records a phone contact after a successful agent outbound message", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockResolvedValue({ id: "sent-message" });

    const sent = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+1 (415) 555-0100",
      body: "hello friend",
      agentId: "agent-1",
      agentOrganizationId: "agent-org",
      agentUserId: "agent-user",
      contactDisplayName: "Friend",
    });

    expect(sent).toBe(true);
    expect(blooioApiRequest).toHaveBeenCalledWith(
      "blooio-api-key",
      "POST",
      "/chats/%2B1%20(415)%20555-0100/messages",
      {
        text: "hello friend",
        attachments: undefined,
      },
      {
        fromNumber: "+14159611510",
      },
    );
    expect(dbWrite.insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "agent-org",
        user_id: "agent-user",
        agent_id: "agent-1",
        provider: "blooio",
        contact_identifier: "+14155550100",
        contact_display_name: "Friend",
        is_active: true,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ["provider", "contact_identifier", "agent_id"],
        set: expect.objectContaining({
          organization_id: "agent-org",
          user_id: "agent-user",
          contact_display_name: "Friend",
          is_active: true,
        }),
      }),
    );
  });

  test("does not record a contact when agent ownership metadata is missing", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockResolvedValue({ id: "sent-message" });

    const sent = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
    });

    expect(sent).toBe(true);
    expect(dbWrite.insert).not.toHaveBeenCalled();
  });

  test("does not record a contact when provider send fails", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockRejectedValue(new Error("provider down"));

    const sent = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
      agentId: "agent-1",
      agentOrganizationId: "agent-org",
      agentUserId: "agent-user",
    });

    expect(sent).toBe(false);
    expect(dbWrite.insert).not.toHaveBeenCalled();
  });
});
