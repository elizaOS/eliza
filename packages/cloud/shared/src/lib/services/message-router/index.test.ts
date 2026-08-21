/** Exercises index behavior with deterministic cloud-shared lib fixtures. */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Load SQL metadata projections before this suite installs process-global
// schema doubles, so later batched PGlite suites retain the real columns.
import "../../../db/repositories/phone-metadata-readers";
import * as realDbSchemas from "../../../db/schemas";

const blooioApiRequest = mock();
const secretsGet = mock();
const insertValues = mock();
const onConflictDoUpdate = mock();
const findHydratedById = mock(async () => null);
const createPhoneMessage = mock(async () => "message-log-1");
const updateAgentResponse = mock(async () => undefined);
const markFailed = mock(async () => undefined);
const selectLimit = mock(async () => []);
const updateWhere = mock(async () => undefined);
const loggerInfo = mock();
const loggerDebug = mock();
const loggerWarn = mock();
const loggerError = mock();

const insertBuilder = {
  values: insertValues,
  onConflictDoUpdate,
};
const selectBuilder = {
  from: mock(() => selectBuilder),
  where: mock(() => selectBuilder),
  limit: selectLimit,
};
const updateBuilder = {
  set: mock(() => updateBuilder),
  where: updateWhere,
};

const dbWrite = {
  insert: mock(() => insertBuilder),
  select: mock(() => selectBuilder),
  update: mock(() => updateBuilder),
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

mock.module("../../../db/repositories/phone-message-logs", () => ({
  phoneMessageLogsRepository: {
    create: createPhoneMessage,
    findHydratedById,
    markFailed,
    updateAgentResponse,
  },
}));

mock.module("../../../db/schemas", () => ({
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
  phoneGatewayDevices: {},
  userCharacters: {},
  userMcps: {},
  userModerationStatus: {},
  users: {},
  vertexModelAssignments: {},
  vertexTunedModels: {},
  vertexTuningJobs: {},
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

mock.module("../../utils/logger", () => ({
  logger: {
    debug: loggerDebug,
    error: loggerError,
    info: loggerInfo,
    warn: loggerWarn,
  },
}));

const { messageRouterService } = await import("./index");

describe("MessageRouterService contact recording", () => {
  beforeEach(() => {
    blooioApiRequest.mockReset();
    secretsGet.mockReset();
    dbWrite.insert.mockClear();
    dbWrite.select.mockClear();
    dbWrite.update.mockClear();
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([]);
    updateWhere.mockReset();
    updateWhere.mockResolvedValue(undefined);
    createPhoneMessage.mockReset();
    createPhoneMessage.mockResolvedValue("message-log-1");
    insertValues.mockReset();
    insertValues.mockReturnValue(insertBuilder);
    onConflictDoUpdate.mockReset();
    onConflictDoUpdate.mockResolvedValue(undefined);
    loggerInfo.mockClear();
    loggerDebug.mockClear();
    loggerWarn.mockClear();
    loggerError.mockClear();
    findHydratedById.mockClear();
    findHydratedById.mockResolvedValue(null);
  });

  test("records a phone contact after a successful agent outbound message", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockResolvedValue({ id: "sent-message" });

    const delivery = await messageRouterService.sendMessage({
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

    expect(delivery).toBe(true);
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
    const recordedContact = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(recordedContact.contact_identifier).toBe("+14155550100");
    expect(recordedContact.contact_identifier).not.toBe("+14159611510");
    expect(recordedContact.organization_id).toBe("agent-org");
    expect(recordedContact.user_id).toBe("agent-user");
    expect(recordedContact.agent_id).toBe("agent-1");
    expect(recordedContact.last_outbound_at).toBeInstanceOf(Date);
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.arrayContaining(["provider", "contact_identifier", "agent_id"]),
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

    const delivery = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
    });

    expect(delivery).toBe(true);
    expect(dbWrite.insert).not.toHaveBeenCalled();
  });

  test("does not record a contact when provider send fails", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockRejectedValue(new Error("provider down"));

    const delivery = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
      agentId: "agent-1",
      agentOrganizationId: "agent-org",
      agentUserId: "agent-user",
    });

    expect(delivery).toBe(false);
    expect(dbWrite.insert).not.toHaveBeenCalled();
  });

  test("fails closed for an unsupported runtime provider", async () => {
    const sentinelProvider = "SENTINEL_UNSUPPORTED_PROVIDER";
    const delivery = await messageRouterService.sendMessage({
      provider: sentinelProvider as never,
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
    });

    expect(delivery).toBe(false);
    expect(blooioApiRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinelProvider);
  });

  test("keeps provider delivery authoritative when the phone-contact migration is absent", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockResolvedValue({ id: "sent-message" });
    onConflictDoUpdate.mockRejectedValueOnce(
      Object.assign(new Error('relation "agent_phone_contacts" does not exist'), {
        code: "42P01",
      }),
    );

    const delivery = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
      agentId: "agent-1",
      agentOrganizationId: "agent-org",
      agentUserId: "agent-user",
    });

    expect(delivery).toBe(true);
    expect(blooioApiRequest).toHaveBeenCalledTimes(1);
    expect(dbWrite.insert).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      "[MessageRouter] Contact record failed after delivery",
      expect.objectContaining({ errorClass: "schema_migration_required" }),
    );
  });

  test("keeps provider delivery authoritative when contact recording fails afterward", async () => {
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockResolvedValue({ id: "sent-message" });
    onConflictDoUpdate.mockRejectedValueOnce(new Error("contact database unavailable"));

    const delivery = await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+14159611510",
      to: "+14155550100",
      body: "hello friend",
      agentId: "agent-1",
      agentOrganizationId: "agent-org",
      agentUserId: "agent-user",
    });

    expect(delivery).toBe(true);
    expect(blooioApiRequest).toHaveBeenCalledTimes(1);
    expect(dbWrite.insert).toHaveBeenCalledTimes(1);
  });

  test("never writes phone numbers, message content, or provider error bodies to logs", async () => {
    const sentinelPhone = "+19995550123";
    const sentinelContent = "SENTINEL_PRIVATE_MESSAGE_BODY";
    const sentinelProviderBody = "SENTINEL_PROVIDER_RESPONSE_BODY";
    secretsGet.mockResolvedValue("blooio-api-key");
    blooioApiRequest.mockRejectedValue(new Error(sentinelProviderBody));

    await messageRouterService.sendMessage({
      provider: "blooio",
      organizationId: "gateway-org",
      from: "+19995550999",
      to: sentinelPhone,
      body: sentinelContent,
    });

    const serializedLogs = JSON.stringify([
      ...loggerInfo.mock.calls,
      ...loggerDebug.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(sentinelPhone);
    expect(serializedLogs).not.toContain(sentinelContent);
    expect(serializedLogs).not.toContain(sentinelProviderBody);
  });

  test("distinguishes a genuine routing miss from an unavailable lookup", async () => {
    const sentinelPhone = "+19995550123";
    const missing = await messageRouterService.routeIncomingMessage({
      provider: "twilio",
      from: "+19995550999",
      to: sentinelPhone,
      body: "private inbound body",
    });
    expect(missing).toEqual({
      success: false,
      error: "No active phone routing configuration",
    });
    const routingProjection = dbWrite.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(routingProjection).toHaveProperty("agent_id");
    expect(routingProjection).toHaveProperty("id");
    expect(routingProjection).toHaveProperty("organization_id");
    expect(routingProjection).not.toHaveProperty("metadata");
    expect(JSON.stringify(missing)).not.toContain(sentinelPhone);
    expect(createPhoneMessage).not.toHaveBeenCalled();

    const sentinelDatabaseBody = "SENTINEL_DATABASE_ERROR_BODY";
    const lookupFailure = new Error(sentinelDatabaseBody);
    selectLimit.mockRejectedValueOnce(lookupFailure);
    await expect(
      messageRouterService.routeIncomingMessage({
        provider: "twilio",
        from: "+19995550999",
        to: sentinelPhone,
        body: "private inbound body",
      }),
    ).rejects.toMatchObject({
      code: "PHONE_MESSAGE_ROUTING_UNAVAILABLE",
      cause: lookupFailure,
    });

    const serializedLogs = JSON.stringify([
      ...loggerInfo.mock.calls,
      ...loggerDebug.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(sentinelPhone);
    expect(serializedLogs).not.toContain(sentinelDatabaseBody);
    expect(loggerError).toHaveBeenCalledWith(
      "[MessageRouter] Error routing message",
      expect.objectContaining({ errorClass: "routing_lookup_failed" }),
    );
    expect(createPhoneMessage).not.toHaveBeenCalled();
  });

  test("propagates a canonical message write failure as a bounded retry signal", async () => {
    const sentinelStorageBody = "SENTINEL_PRIVATE_OBJECT_STORAGE_BODY";
    const storageFailure = Object.assign(new Error(sentinelStorageBody), {
      code: "OBJECT_STORAGE_UPLOAD_FAILED",
    });
    selectLimit.mockResolvedValueOnce([
      {
        id: "phone-number-1",
        agent_id: "agent-1",
        organization_id: "organization-1",
      },
    ]);
    createPhoneMessage.mockRejectedValueOnce(storageFailure);

    await expect(
      messageRouterService.routeIncomingMessage({
        provider: "whatsapp",
        from: "+19995550999",
        to: "+19995550123",
        body: "private inbound body",
      }),
    ).rejects.toMatchObject({
      code: "PHONE_MESSAGE_PERSISTENCE_FAILED",
      cause: storageFailure,
    });

    expect(createPhoneMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(sentinelStorageBody);
  });

  test("does not retry after only the denormalized timestamp update fails", async () => {
    const sentinelUpdateBody = "SENTINEL_TIMESTAMP_UPDATE_BODY";
    selectLimit.mockResolvedValueOnce([
      {
        id: "phone-number-1",
        agent_id: "agent-1",
        organization_id: "organization-1",
      },
    ]);
    updateWhere.mockRejectedValueOnce(new Error(sentinelUpdateBody));

    await expect(
      messageRouterService.routeIncomingMessage({
        provider: "whatsapp",
        from: "+19995550999",
        to: "+19995550123",
        body: "private inbound body",
      }),
    ).resolves.toEqual({
      success: true,
      agentId: "agent-1",
      phoneNumberId: "phone-number-1",
      organizationId: "organization-1",
    });

    expect(createPhoneMessage).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[MessageRouter] Last-message timestamp update failed after persistence",
      { errorClass: "unexpected_phone_failure" },
    );
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(sentinelUpdateBody);
  });

  test("delegates payload reads to the tenant-scoped canonical repository", async () => {
    await expect(messageRouterService.getMessageLog("org-1", "message-1")).resolves.toBeNull();
    expect(findHydratedById).toHaveBeenCalledWith("org-1", "message-1");
  });

  test("hydrates phone-number metadata from canonical SQL text before returning it", async () => {
    const extremeMetadata =
      '{"huge":1e400,"tiny":1e-400,"rounded":9007199254740993,"ordinary":3.5}';
    selectLimit.mockResolvedValueOnce([
      {
        id: "phone-number-1",
        agent_id: "agent-1",
        organization_id: "organization-1",
        metadata: extremeMetadata,
      },
    ]);

    const phoneNumber = await messageRouterService.getPhoneNumberById("phone-number-1");

    expect(phoneNumber).not.toBeNull();
    expect(JSON.stringify(phoneNumber?.metadata)).toBe(extremeMetadata);
    expect(dbWrite.select.mock.calls[0]?.[0]).toHaveProperty("metadata");
  });
});
