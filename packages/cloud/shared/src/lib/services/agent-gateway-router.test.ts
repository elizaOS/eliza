/** Exercises connector-to-agent routing contracts with deterministic Cloud fixtures. */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import * as realDbSchemas from "../../db/schemas";
import { elizaSandboxService } from "./eliza-sandbox";

const findByPhoneNumberWithOrganization = mock();
const listByOrganization = mock();
const findRunningSandbox = mock();
const listOwnerSessions = mock();
const routeToSession = mock();
const bridge = mock();
const runOnboardingChat = mock();
const findByDiscordIdWithOrganization = mock();
const findByTelegramIdWithOrganization = mock();
const readManagedAgentDiscordBinding = mock(() => null as unknown);
const readManagedAgentDiscordGateway = mock(() => null as unknown);

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
    findByDiscordIdWithOrganization,
    findByTelegramIdWithOrganization,
    findByPrivyDidWithOrganization: mock(),
  },
}));

const listByOrganizationSpy = spyOn(
  agentSandboxesRepository,
  "listByOrganization",
).mockImplementation((...args) => listByOrganization(...args) as never);
const findRunningSandboxSpy = spyOn(
  agentSandboxesRepository,
  "findRunningSandbox",
).mockImplementation((...args) => findRunningSandbox(...args) as never);
const findByManagedDiscordGuildId = mock();
const findByManagedDiscordGuildIdSpy = spyOn(
  agentSandboxesRepository,
  "findByManagedDiscordGuildId",
).mockImplementation((...args) => findByManagedDiscordGuildId(...args) as never);

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

const bridgeSpy = spyOn(elizaSandboxService, "bridge").mockImplementation(
  (...args) => bridge(...args) as never,
);

mock.module("./eliza-agent-config", () => ({
  readManagedAgentDiscordBinding,
  readManagedAgentDiscordGateway,
}));

afterAll(() => {
  listByOrganizationSpy.mockRestore();
  findRunningSandboxSpy.mockRestore();
  findByManagedDiscordGuildIdSpy.mockRestore();
  bridgeSpy.mockRestore();
});

const { AgentGatewayRouterService } = await import("./agent-gateway-router");

function newRouter() {
  return new AgentGatewayRouterService({ runOnboardingChat });
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

// These collaborators span phone and Discord cases, so file-level reset keeps
// either suite valid when test ordering or filtering changes.
beforeEach(() => {
  findByDiscordIdWithOrganization.mockReset();
  findByTelegramIdWithOrganization.mockReset();
  findByManagedDiscordGuildId.mockReset();
  readManagedAgentDiscordBinding.mockReset();
  readManagedAgentDiscordBinding.mockReturnValue(null);
  readManagedAgentDiscordGateway.mockReset();
  readManagedAgentDiscordGateway.mockReturnValue(null);
});

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

  test("routes to the sender's own running Cloud agent before checking friend contacts", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "sender-user",
      organization_id: "sender-org",
    });
    listOwnerSessions.mockResolvedValue([]);
    listByOrganization.mockResolvedValue([
      {
        id: "sender-cloud-agent",
        organization_id: "sender-org",
        user_id: "sender-user",
        status: "running",
        agent_config: {},
      },
    ]);
    queueSelectResult([
      {
        organizationId: "friend-owner-org",
        agentId: "friend-agent",
        userId: "friend-owner-user",
      },
    ]);
    bridge.mockResolvedValue({
      result: {
        text: "own cloud agent reply",
      },
    });

    const result = await newRouter().routePhoneMessage(routeArgs());

    expect(result).toMatchObject({
      handled: true,
      replyText: "own cloud agent reply",
      agentId: "sender-cloud-agent",
      organizationId: "sender-org",
      userId: "sender-user",
    });
    expect(selectCalls).toBe(0);
    expect(bridge).toHaveBeenCalledWith(
      "sender-cloud-agent",
      "sender-org",
      expect.objectContaining({
        method: "message.send",
      }),
    );
    expect(findRunningSandbox).not.toHaveBeenCalled();
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
        platformReplyAddress: "+14159611510",
        sessionId: "platform:blooio:+1 (555) 555-0100",
        trustedPlatformIdentity: true,
        idempotencyKey: "blooio:msg-1",
      }),
    );
  });

  test("re-resolves an unknown sender immediately after authenticated phone linking", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "newly-linked-user",
      organization_id: "newly-linked-org",
    });
    queueSelectResult([], []);
    runOnboardingChat.mockResolvedValue({
      reply: "connect here",
      session: {},
      provisioning: {},
    });
    listOwnerSessions.mockResolvedValue([
      {
        runtimeAgentId: "newly-linked-agent",
        organizationId: "newly-linked-org",
      },
    ]);
    routeToSession.mockResolvedValue({ result: { text: "linked agent reply" } });
    const router = newRouter();

    const onboarding = await router.routePhoneMessage(routeArgs());
    const linked = await router.routePhoneMessage(
      routeArgs({ body: "I'm signed in", providerMessageId: "msg-2" }),
    );

    expect(onboarding).toMatchObject({ reason: "unknown_owner", replyText: "connect here" });
    expect(linked).toMatchObject({
      handled: true,
      replyText: "linked agent reply",
      agentId: "newly-linked-agent",
      userId: "newly-linked-user",
    });
    expect(findByPhoneNumberWithOrganization).toHaveBeenCalledTimes(2);
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
        platformReplyAddress: "+14159611510",
        trustedPlatformIdentity: true,
        idempotencyKey: "blooio:msg-1",
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
        platformReplyAddress: "+14159611510",
        authenticatedUser: {
          userId: "known-user",
          organizationId: "known-org",
        },
        trustedPlatformIdentity: true,
        idempotencyKey: "blooio:msg-1",
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
        platformReplyAddress: "+14159611510",
        authenticatedUser: {
          userId: "known-user",
          organizationId: "known-org",
        },
        trustedPlatformIdentity: true,
        idempotencyKey: "blooio:msg-1",
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

  test("routes a registered BlueBubbles bridge to its bound agent", async () => {
    findRunningSandbox.mockResolvedValue({
      id: "registered-agent",
      organization_id: "registered-org",
      user_id: "registered-user",
      status: "running",
      agent_config: {},
    });
    bridge.mockResolvedValue({ result: { text: "registered agent reply" } });

    const result = await newRouter().routeRegisteredBlueBubblesMessage({
      organizationId: "registered-org",
      userId: "registered-user",
      agentId: "registered-agent",
      from: "+1 (555) 555-0100",
      to: "+1 (415) 555-0123",
      body: "hello from Messages",
      providerMessageId: "bb-message-1",
      metadata: { bluebubblesChatGuid: "iMessage;-;+15555550100" },
    });

    expect(findRunningSandbox).toHaveBeenCalledWith("registered-agent", "registered-org");
    expect(bridge).toHaveBeenCalledWith(
      "registered-agent",
      "registered-org",
      expect.objectContaining({
        method: "message.send",
        params: expect.objectContaining({
          text: "hello from Messages",
          source: "bluebubbles",
          channelType: "DM",
          metadata: expect.objectContaining({
            provider: "bluebubbles",
            providerMessageId: "bb-message-1",
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      handled: true,
      replyText: "registered agent reply",
      agentId: "registered-agent",
      organizationId: "registered-org",
      userId: "registered-user",
    });
    expect(findByPhoneNumberWithOrganization).not.toHaveBeenCalled();
  });
});

describe("AgentGatewayRouterService discord DM onboarding (#17341)", () => {
  beforeEach(() => {
    listOwnerSessions.mockReset();
    listByOrganization.mockReset();
    runOnboardingChat.mockReset();
  });

  function discordArgs(overrides: Record<string, unknown> = {}) {
    return {
      guildId: null,
      channelId: "chan-1",
      messageId: "msg-1",
      content: "hi eliza",
      sender: { id: "discord-user-1", username: "newuser", displayName: "New User" },
      ...overrides,
    };
  }

  test("a first-contact DM onboards instead of silence", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue(null);
    runOnboardingChat.mockResolvedValue({
      reply: "Welcome! Here is your login link.",
      cta: { label: "Connect", url: "https://app.elizacloud.ai/get-started/?onboardingSession=t1" },
      session: { userId: undefined, organizationId: undefined },
      provisioning: { agentId: null },
    });

    const result = await newRouter().routeDiscordMessage(discordArgs());

    expect(result.handled).toBe(true);
    expect(result.replyText).toBe("Welcome! Here is your login link.");
    expect(result.replyCta).toEqual({
      label: "Connect",
      url: "https://app.elizacloud.ai/get-started/?onboardingSession=t1",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "discord",
        platformUserId: "discord-user-1",
        platformDisplayName: "New User",
        sessionId: "platform:discord:discord-user-1",
        trustedPlatformIdentity: true,
        idempotencyKey: "discord:msg-1",
      }),
    );
  });

  test("an authenticated user with ZERO sandboxes continues onboarding under their identity", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    listOwnerSessions.mockResolvedValue([]);
    listByOrganization.mockResolvedValue([]);
    runOnboardingChat.mockResolvedValue({
      reply: "Let's finish setting up your agent.",
      session: { userId: "user-1", organizationId: "org-1" },
      provisioning: { agentId: null },
    });

    const result = await newRouter().routeDiscordMessage(discordArgs());

    expect(result.handled).toBe(true);
    expect(result.replyText).toBe("Let's finish setting up your agent.");
    expect(result.replyCta).toBeNull();
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "discord",
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
        trustedPlatformIdentity: true,
        idempotencyKey: "discord:msg-1",
      }),
    );
  });

  test("GUILD context never onboards — the login URL must not land in a public channel", async () => {
    // This fixture reaches unknown_owner through the guild resolver, proving
    // the DM guard is enforced on the shared reason rather than assumed.
    findByManagedDiscordGuildId.mockResolvedValue([
      { id: "sb-1", agent_config: {}, organization_id: "org-1" },
    ]);
    readManagedAgentDiscordBinding.mockReturnValue({ adminDiscordUserId: "discord-user-1" });
    readManagedAgentDiscordGateway.mockReturnValue({ gateway: true });
    findByDiscordIdWithOrganization.mockResolvedValue(null);

    const result = await newRouter().routeDiscordMessage(discordArgs({ guildId: "guild-9" }));

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("unknown_owner");
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });

  test("fail-open: a resolver throw on a first-contact DM still greets instead of dropping", async () => {
    // Canon step 1 (ONBOARDING-CANON-2026-08-06): parity with routePhoneMessage.
    // Before the fix, a throw here propagated and the DM died in silence.
    findByDiscordIdWithOrganization.mockRejectedValue(new Error("db connection reset"));
    runOnboardingChat.mockResolvedValue({
      reply: "Welcome! Here is your login link.",
      cta: { label: "Connect", url: "https://app.elizacloud.ai/get-started/?onboardingSession=t2" },
      session: { userId: undefined, organizationId: undefined },
      provisioning: { agentId: null },
    });

    const result = await newRouter().routeDiscordMessage(discordArgs());

    expect(result.handled).toBe(true);
    expect(result.reason).toBe("bridge_failed");
    expect(result.replyText).toBe("Welcome! Here is your login link.");
    expect(result.replyCta).toEqual({
      label: "Connect",
      url: "https://app.elizacloud.ai/get-started/?onboardingSession=t2",
    });
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "discord",
        platformUserId: "discord-user-1",
        sessionId: "platform:discord:discord-user-1",
        trustedPlatformIdentity: true,
        idempotencyKey: "discord:msg-1",
      }),
    );
  });

  test("fail-open: a resolver throw in a GUILD channel never onboards (no credential in public)", async () => {
    findByManagedDiscordGuildId.mockRejectedValue(new Error("db connection reset"));

    const result = await newRouter().routeDiscordMessage(discordArgs({ guildId: "guild-9" }));

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("bridge_failed");
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });

  test("a stopped-agent owner keeps today's silence (parity with the phone path)", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
    listOwnerSessions.mockResolvedValue([]);
    listByOrganization.mockResolvedValue([
      { id: "sb-stopped", status: "stopped", user_id: "user-1", agent_config: {} },
    ]);

    const result = await newRouter().routeDiscordMessage(discordArgs());

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("owner_agent_not_running");
    expect(result.agentId).toBe("sb-stopped");
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });
});

describe("AgentGatewayRouterService telegram onboarding", () => {
  beforeEach(() => {
    listOwnerSessions.mockReset();
    listByOrganization.mockReset();
    runOnboardingChat.mockReset();
  });

  function telegramArgs(overrides: Record<string, unknown> = {}) {
    return {
      organizationId: "org-1",
      chatId: "chat-1",
      messageId: "tg-msg-1",
      content: "hi eliza",
      sender: { id: "telegram-user-1", username: "newuser", displayName: "New User" },
      onboardUnknownOwner: true,
      ...overrides,
    };
  }

  test("an unknown telegram_id onboards instead of silence", async () => {
    findByTelegramIdWithOrganization.mockResolvedValue(null);
    runOnboardingChat.mockResolvedValue({
      reply: "Welcome! Here is your login link.",
      cta: null,
      session: { userId: undefined, organizationId: undefined },
      provisioning: { agentId: null },
    });

    const result = await newRouter().routeTelegramMessage(telegramArgs());

    // handled:true is load-bearing: the webhook route only delivers replyText
    // when the router claims the message, otherwise it falls through to the
    // app-automation canned response.
    expect(result.handled).toBe(true);
    expect(result.reason).toBe("unknown_owner");
    expect(result.replyText).toBe("Welcome! Here is your login link.");
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "hi eliza",
        platform: "telegram",
        platformUserId: "telegram-user-1",
        platformDisplayName: "New User",
        // Same key the gateway webhook uses, so both Telegram entry points
        // append to one transcript instead of restarting the greeting.
        sessionId: "platform:telegram:telegram-user-1",
        trustedPlatformIdentity: true,
        idempotencyKey: "telegram:org-1:chat-1:tg-msg-1",
      }),
    );
  });

  test("overlapping message ids stay isolated across organization bot chats", async () => {
    findByTelegramIdWithOrganization.mockResolvedValue(null);
    runOnboardingChat.mockResolvedValue({
      reply: "Connect",
      cta: null,
      session: { userId: undefined, organizationId: undefined },
      provisioning: { agentId: null },
    });

    await newRouter().routeTelegramMessage(telegramArgs());
    await newRouter().routeTelegramMessage(
      telegramArgs({ organizationId: "org-2", chatId: "chat-2" }),
    );

    expect(runOnboardingChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "telegram:org-1:chat-1:tg-msg-1",
      }),
    );
    expect(runOnboardingChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "telegram:org-2:chat-2:tg-msg-1",
      }),
    );
  });

  test("an active app automation can retain unknown-owner precedence", async () => {
    findByTelegramIdWithOrganization.mockResolvedValue(null);

    const result = await newRouter().routeTelegramMessage(
      telegramArgs({ onboardUnknownOwner: false }),
    );

    expect(result).toEqual({ handled: false, reason: "unknown_owner" });
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });

  test("the onboarding identity is carried back on the result", async () => {
    findByTelegramIdWithOrganization.mockResolvedValue(null);
    runOnboardingChat.mockResolvedValue({
      reply: "Your agent is provisioning.",
      cta: null,
      session: { userId: "user-9", organizationId: "org-9" },
      provisioning: { agentId: "sb-new" },
    });

    const result = await newRouter().routeTelegramMessage(telegramArgs());

    expect(result).toMatchObject({
      handled: true,
      reason: "unknown_owner",
      userId: "user-9",
      organizationId: "org-9",
      agentId: "sb-new",
    });
  });

  test("a sender known under another organization keeps today's silence", async () => {
    // Onboarding here would run a personal setup flow on somebody else's bot.
    findByTelegramIdWithOrganization.mockResolvedValue({
      id: "user-1",
      organization_id: "other-org",
    });

    const result = await newRouter().routeTelegramMessage(telegramArgs());

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("owner_org_mismatch");
    expect(runOnboardingChat).not.toHaveBeenCalled();
  });
});
