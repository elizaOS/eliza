import { beforeEach, describe, expect, mock, test } from "bun:test";

const findByPhoneNumberWithOrganization = mock();
const listByOrganization = mock();
const findRunningSandbox = mock();
const listOwnerSessions = mock();
const routeToSession = mock();
const bridge = mock();
const runOnboardingChat = mock();

let phoneContactsResult: Array<Record<string, unknown>> = [];
let selectCalls = 0;

const selectBuilder = {
  from: mock(() => selectBuilder),
  innerJoin: mock(() => selectBuilder),
  where: mock(() => selectBuilder),
  orderBy: mock(() => selectBuilder),
  limit: mock(async () => {
    selectCalls += 1;
    return phoneContactsResult;
  }),
};

mock.module("../../db/client", () => ({
  db: {},
  dbRead: {},
  dbWrite: {
    select: mock(() => selectBuilder),
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
    phoneContactsResult = [];
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
    phoneContactsResult = [
      {
        organizationId: "owner-org",
        agentId: "friend-agent",
      },
    ];
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
  });

  test("starts onboarding for phone numbers with no owner or contact relationship", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue(null);
    phoneContactsResult = [];
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
    phoneContactsResult = [];
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
    phoneContactsResult = [
      {
        organizationId: "owner-org",
        agentId: "friend-agent",
      },
    ];
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
