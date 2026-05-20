import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDbSchemas from "../../db/schemas";

const findByPhoneNumberWithOrganization = mock();
const listByOrganization = mock();
const findRunningSandbox = mock();
const listOwnerSessions = mock();
const routeToSession = mock();
const bridge = mock();
const runOnboardingChat = mock();

let selectResults: Array<Array<Record<string, unknown>>> = [];
let selectErrors: unknown[] = [];
let selectCalls = 0;
const updateSet = mock();
const updateWhere = mock();

const selectBuilder = {
  from: mock(() => selectBuilder),
  innerJoin: mock(() => selectBuilder),
  where: mock(() => selectBuilder),
  orderBy: mock(() => selectBuilder),
  limit: mock(async () => {
    selectCalls += 1;
    const error = selectErrors.shift();
    if (error) throw error;
    return selectResults.shift() ?? [];
  }),
};

const updateBuilder = {
  set: updateSet,
  where: updateWhere,
};

function queueSelectResult(...results: Array<Array<Record<string, unknown>>>) {
  selectResults = [...results];
}

function queueSelectError(...errors: unknown[]) {
  selectErrors = [...errors];
}

mock.module("../../db/client", () => ({
  db: {},
  dbRead: {},
  dbWrite: {
    select: mock(() => selectBuilder),
    update: mock(() => updateBuilder),
  },
  getDbConnectionInfo: mock(() => ({ databaseUrlConfigured: true })),
  runWithDbCache: (fn: () => unknown) => fn(),
  runWithDbCacheAsync: async (fn: () => Promise<unknown>) => fn(),
  withReadDb: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
  withWriteDb: async (fn: (db: unknown) => Promise<unknown>) => fn({}),
}));

mock.module("../../db/repositories/users", () => ({
  usersRepository: {
    findByPhoneNumberWithOrganization,
    findByEmailWithOrganization: mock(),
    findByDiscordIdWithOrganization: mock(),
    findByTelegramIdWithOrganization: mock(),
    findByPrivyDidWithOrganization: mock(),
  },
}));

mock.module("../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    listByOrganization,
    findRunningSandbox,
  },
}));

mock.module("../../db/schemas", () => ({
  ...realDbSchemas,
  anonymousSessions: {},
  agentPhoneContacts: {
    agent_id: "contact_agent_id",
    organization_id: "contact_organization_id",
    user_id: "contact_user_id",
    provider: "contact_provider",
    contact_identifier: "contact_identifier",
    is_active: "contact_is_active",
    last_contacted_at: "contact_last_contacted_at",
    last_inbound_at: "contact_last_inbound_at",
    updated_at: "contact_updated_at",
  },
  agentPhoneNumbers: {
    id: "id",
    agent_id: "agent_id",
    organization_id: "organization_id",
    is_active: "is_active",
  },
  phoneMessageLog: {
    phone_number_id: "phone_number_id",
    direction: "direction",
    to_number: "to_number",
    created_at: "created_at",
  },
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
  phoneGatewayDevices: {},
  userCharacters: {},
  userMcps: {},
  userModerationStatus: {},
  users: {},
  vertexModelAssignments: {},
  vertexTunedModels: {},
  vertexTuningJobs: {},
}));

mock.module("./agent-gateway-relay", () => ({
  agentGatewayRelayService: {
    listOwnerSessions,
    routeToSession,
  },
}));

mock.module("./eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge,
  },
}));

mock.module("./eliza-app/onboarding-chat", () => ({
  runOnboardingChat,
}));

mock.module("./eliza-agent-config", () => ({
  readManagedAgentDiscordBinding: mock(() => null),
  readManagedAgentDiscordGateway: mock(() => null),
}));

const { AgentGatewayRouterService } = await import("./agent-gateway-router");

function newRouter() {
  return new AgentGatewayRouterService();
}

function routeArgs(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "gateway-org",
    provider: "blooio" as const,
    from: "+1 (555) 555-0100",
    to: "+14159611510",
    body: "hello",
    providerMessageId: "msg-1",
    ...overrides,
  };
}

describe("AgentGatewayRouterService phone routing", () => {
  beforeEach(() => {
    findByPhoneNumberWithOrganization.mockReset();
    listByOrganization.mockReset();
    findRunningSandbox.mockReset();
    listOwnerSessions.mockReset();
    routeToSession.mockReset();
    bridge.mockReset();
    runOnboardingChat.mockReset();
    selectBuilder.from.mockClear();
    selectBuilder.innerJoin.mockClear();
    selectBuilder.where.mockClear();
    selectBuilder.orderBy.mockClear();
    selectBuilder.limit.mockClear();
    updateSet.mockReset();
    updateSet.mockReturnValue(updateBuilder);
    updateWhere.mockReset();
    updateWhere.mockResolvedValue(undefined);
    selectResults = [];
    selectErrors = [];
    selectCalls = 0;
  });

  test("routes to the sender's own active agent before checking friend contacts", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "sender-user",
      organization_id: "sender-org",
    });
    listOwnerSessions.mockResolvedValue([
      {
        runtimeAgentId: "sender-agent",
        organizationId: "sender-org",
      },
    ]);
    routeToSession.mockResolvedValue({
      result: {
        text: "own agent reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "own agent reply",
      agentId: "sender-agent",
      organizationId: "sender-org",
      userId: "sender-user",
    });
    expect(selectCalls).toBe(0);
    expect(routeToSession).toHaveBeenCalledTimes(1);
  });

  test("routes unknown senders to an agent that previously messaged them", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    queueSelectResult([
      {
        organizationId: "owner-org",
        agentId: "friend-agent",
        userId: "owner-user",
      },
    ]);
    listOwnerSessions.mockResolvedValue([]);
    findRunningSandbox.mockResolvedValue({
      id: "friend-agent",
      organization_id: "owner-org",
      user_id: "owner-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockResolvedValue({
      result: {
        text: "friend agent reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "friend agent reply",
      agentId: "friend-agent",
      organizationId: "owner-org",
      userId: "owner-user",
    });
    expect(findRunningSandbox).toHaveBeenCalledWith("friend-agent", "owner-org");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        last_contacted_at: expect.any(Date),
        last_inbound_at: expect.any(Date),
        updated_at: expect.any(Date),
      }),
    );
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  test("falls back to outbound phone message log when no contact row exists", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    queueSelectResult(
      [],
      [
        {
          organizationId: "owner-org",
          agentId: "logged-agent",
        },
      ],
    );
    findRunningSandbox.mockResolvedValue({
      id: "logged-agent",
      organization_id: "owner-org",
      user_id: "owner-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockResolvedValue({
      result: {
        text: "logged agent reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "logged agent reply",
      agentId: "logged-agent",
      organizationId: "owner-org",
      userId: "owner-user",
    });
    expect(selectCalls).toBe(2);
    expect(findRunningSandbox).toHaveBeenCalledWith("logged-agent", "owner-org");
  });

  test("falls back to outbound phone message log when contact table is not migrated", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    const missingTable = new Error('relation "agent_phone_contacts" does not exist');
    (missingTable as Error & { code?: string }).code = "42P01";
    queueSelectError(missingTable);
    queueSelectResult([
      {
        organizationId: "owner-org",
        agentId: "logged-agent",
      },
    ]);
    findRunningSandbox.mockResolvedValue({
      id: "logged-agent",
      organization_id: "owner-org",
      user_id: "owner-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockResolvedValue({
      result: {
        text: "logged agent reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "logged agent reply",
      agentId: "logged-agent",
      organizationId: "owner-org",
      userId: "owner-user",
    });
    expect(selectCalls).toBe(2);
    expect(findRunningSandbox).toHaveBeenCalledWith("logged-agent", "owner-org");
  });

  test("starts onboarding for phone numbers with no owner or contact relationship", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    queueSelectResult([], []);
    runOnboardingChat.mockResolvedValue({
      reply: "onboarding reply",
      session: {
        userId: "onboarded-user",
        organizationId: "onboarded-org",
      },
      provisioning: {
        agentId: "onboarded-agent",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "onboarding reply",
      reason: "unknown_owner",
      userId: "onboarded-user",
      organizationId: "onboarded-org",
      agentId: "onboarded-agent",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "hello",
        platform: "blooio",
        platformUserId: "+1 (555) 555-0100",
        sessionId: "platform:blooio:+1 (555) 555-0100",
        trustedPlatformIdentity: true,
      }),
    );
  });

  test("starts onboarding instead of throwing when phone target resolution fails", async () => {
    findByPhoneNumberWithOrganization.mockRejectedValue(new Error("lookup failed"));
    runOnboardingChat.mockResolvedValue({
      reply: "resolver fallback reply",
      session: {
        userId: "fallback-user",
        organizationId: "fallback-org",
      },
      provisioning: {},
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "resolver fallback reply",
      reason: "bridge_failed",
      userId: "fallback-user",
      organizationId: "fallback-org",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedPlatformIdentity: true,
      }),
    );
  });

  test("falls back to authenticated onboarding when owner runtime lookup fails", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "known-user",
      organization_id: "known-org",
    });
    listOwnerSessions.mockRejectedValue(new Error("relay lookup failed"));
    queueSelectResult([], []);
    runOnboardingChat.mockResolvedValue({
      reply: "known user provisioning reply",
      session: {
        userId: "known-user",
        organizationId: "known-org",
      },
      provisioning: {
        agentId: "new-agent",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "known user provisioning reply",
      reason: "owner_agent_not_running",
      userId: "known-user",
      organizationId: "known-org",
      agentId: "new-agent",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedUser: {
          userId: "known-user",
          organizationId: "known-org",
        },
      }),
    );
  });

  test("routes known senders without an active own agent to their friend contact route", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "known-user",
      organization_id: "known-org",
    });
    listOwnerSessions.mockResolvedValue([]);
    listByOrganization.mockResolvedValue([]);
    queueSelectResult([
      {
        organizationId: "friend-owner-org",
        agentId: "friend-agent",
        userId: "friend-owner-user",
      },
    ]);
    findRunningSandbox.mockResolvedValue({
      id: "friend-agent",
      organization_id: "friend-owner-org",
      user_id: "friend-owner-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockResolvedValue({
      result: {
        text: "friend route reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "friend route reply",
      agentId: "friend-agent",
      organizationId: "friend-owner-org",
      userId: "friend-owner-user",
    });
    expect(runOnboardingChat).not.toHaveBeenCalled();
    expect(findRunningSandbox).toHaveBeenCalledWith("friend-agent", "friend-owner-org");
  });

  test("falls back to authenticated onboarding when the sender's own agent route throws", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "known-user",
      organization_id: "known-org",
    });
    listOwnerSessions.mockResolvedValue([
      {
        runtimeAgentId: "known-agent",
        organizationId: "known-org",
      },
    ]);
    routeToSession.mockRejectedValue(new Error("relay unavailable"));
    runOnboardingChat.mockResolvedValue({
      reply: "known user fallback reply",
      session: {
        userId: "known-user",
        organizationId: "known-org",
      },
      provisioning: {
        agentId: "known-agent",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "known user fallback reply",
      reason: "bridge_failed",
      userId: "known-user",
      organizationId: "known-org",
      agentId: "known-agent",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedUser: {
          userId: "known-user",
          organizationId: "known-org",
        },
      }),
    );
  });

  test("returns bridge_failed instead of onboarding when a friend contact target throws", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    queueSelectResult([
      {
        organizationId: "owner-org",
        agentId: "friend-agent",
        userId: "owner-user",
      },
    ]);
    listOwnerSessions.mockResolvedValue([]);
    findRunningSandbox.mockResolvedValue({
      id: "friend-agent",
      organization_id: "owner-org",
      user_id: "owner-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockRejectedValue(new Error("sandbox unavailable"));

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: false,
      reason: "bridge_failed",
      agentId: "friend-agent",
      organizationId: "owner-org",
      userId: "owner-user",
    });
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });
});
