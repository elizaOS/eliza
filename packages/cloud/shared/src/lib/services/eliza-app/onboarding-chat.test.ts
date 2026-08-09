/**
 * Exercises onboarding chat behavior with deterministic cloud-shared fixtures,
 * including trusted gateway continuations and authenticated identity matching.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import type { OnboardingChatMessage, OnboardingSession } from "./onboarding-chat";

function continuationToken(result: { loginUrl: string }): string {
  const token = new URL(result.loginUrl).searchParams.get("onboardingSession");
  if (!token) {
    throw new Error("onboarding login URL has no continuation token");
  }
  return token;
}

const sessionCache = new Map<string, unknown>();
const ensureElizaAppProvisioning = mock();
const getElizaAppProvisioningStatus = mock();
const findOrCreateByPhone = mock();
const linkPhoneToUser = mock();
const launchManagedElizaAgent = mock();
const loggerWarn = mock();
let cloudEnv: Record<string, string | undefined> = {};
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };

mock.module("../../cache/client", () => ({
  CacheClient: class CacheClient {
    private values = new Map<string, unknown>();
    isAvailable() {
      return true;
    }
    async get(key: string) {
      return this.values.get(key) ?? null;
    }
    async set(key: string, value: unknown) {
      this.values.set(key, value);
    }
    async expire() {}
    async del(key: string) {
      this.values.delete(key);
    }
  },
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  ...REAL_CLOUD_BINDINGS,
  getCloudAwareEnv: mock(() => cloudEnv),
}));

mock.module("../../utils/logger", () => ({
  logger: {
    warn: loggerWarn,
  },
}));

mock.module("../eliza-managed-launch", () => ({
  launchManagedElizaAgent,
}));

mock.module("./provisioning", () => ({
  ensureElizaAppProvisioning,
  getElizaAppProvisioningStatus,
}));

mock.module("./user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone,
    linkPhoneToUser,
  },
}));

const { runOnboardingChat, validateTelegramOnboardingContinuation } = await import(
  `./onboarding-chat.ts?test=onboarding-chat-${Date.now()}`
);

describe("runOnboardingChat", () => {
  beforeEach(() => {
    sessionCache.clear();
    ensureElizaAppProvisioning.mockReset();
    getElizaAppProvisioningStatus.mockReset();
    findOrCreateByPhone.mockReset();
    linkPhoneToUser.mockReset();
    linkPhoneToUser.mockResolvedValue({ success: true });
    launchManagedElizaAgent.mockReset();
    loggerWarn.mockReset();
    cloudEnv = {};
  });

  afterEach(() => {
    cloudEnv = process.env;
  });

  afterAll(() => {
    mock.module("../../runtime/cloud-bindings", () => REAL_CLOUD_BINDINGS);
  });

  test("asks for a name before provisioning a trusted phone onboarding session", async () => {
    getElizaAppProvisioningStatus.mockResolvedValue({
      status: "none",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });

    const result = await runOnboardingChat({
      message: "Hi, what is Eliza Cloud?",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });

    expect(result.provisioning.status).toBe("none");
    expect(result.session.name).toBeUndefined();
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/what should I call you\?/i);
    expect(result.reply).toContain("$5");
  });

  test("sends a login link after a trusted phone user provides a preferred name", async () => {
    const result = await runOnboardingChat({
      message: "My name is Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(true);
    expect(result.provisioning.status).toBe("none");
    expect(continuationToken(result)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.loginUrl).not.toContain("platform%3A");
    expect(result.loginUrl).not.toContain("14155550123");
    expect(result.reply).toContain("connect your account here");
    expect(result.reply).toContain(result.loginUrl);
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
    expect(findOrCreateByPhone).not.toHaveBeenCalled();
  });

  test("requires Telegram OAuth when continuing a trusted Telegram session", async () => {
    const result = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });

    const loginUrl = new URL(result.loginUrl);
    expect(loginUrl.origin).toBe("https://eliza.app");
    expect(loginUrl.searchParams.get("method")).toBe("telegram");
    expect(loginUrl.searchParams.get("link")).toBe("true");
    expect(loginUrl.searchParams.get("onboardingSession")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.loginUrl).not.toContain("123456789");
  });

  test("preflights a bot-issued Telegram continuation before account mutation", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    const token = continuationToken(gatewayTurn);

    await expect(
      validateTelegramOnboardingContinuation({
        continuationToken: token,
        telegramId: "123456789",
      }),
    ).resolves.toEqual({
      sessionId: "platform:telegram:123456789",
      userId: undefined,
      organizationId: undefined,
    });
    await expect(
      validateTelegramOnboardingContinuation({
        continuationToken: token,
        telegramId: "different-telegram-user",
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
    });
    await expect(
      validateTelegramOnboardingContinuation({
        continuationToken: "unknown-opaque-continuation",
        telegramId: "123456789",
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
  });

  test("strict Telegram redemption rejects an organization mismatch for the same user", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "pending",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
    const token = continuationToken(gatewayTurn);

    await runOnboardingChat({
      sessionId: token,
      platform: "telegram",
      continuationMode: "trusted-telegram",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
        telegramId: "123456789",
      },
      idempotencyKey: "telegram-auth-continuation",
    });

    await expect(
      runOnboardingChat({
        sessionId: token,
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-2",
          telegramId: "123456789",
        },
        idempotencyKey: "telegram-auth-continuation",
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
  });

  test("strict Telegram replay revalidates the signed Telegram identity before cache lookup", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "pending",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
    const token = continuationToken(gatewayTurn);
    const input = {
      sessionId: token,
      platform: "telegram" as const,
      continuationMode: "trusted-telegram" as const,
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
        telegramId: "123456789",
      },
      idempotencyKey: "telegram-auth-continuation",
    };
    await runOnboardingChat(input);

    await expect(
      runOnboardingChat({
        ...input,
        authenticatedUser: {
          ...input.authenticatedUser,
          telegramId: "different-telegram-user",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
    });
  });

  test("rejects a partially bound Telegram continuation without mutating it", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    const storedKey = `eliza-app:onboarding:${gatewayTurn.session.id}`;
    const stored = sessionCache.get(storedKey) as OnboardingSession;
    const partial = { ...stored, userId: "user-1", organizationId: undefined };
    sessionCache.set(storedKey, partial);

    await expect(
      validateTelegramOnboardingContinuation({
        continuationToken: continuationToken(gatewayTurn),
        telegramId: "123456789",
        authenticatedAccount: { userId: "user-1", organizationId: "org-1" },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
    await expect(
      runOnboardingChat({
        sessionId: continuationToken(gatewayTurn),
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
          telegramId: "123456789",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
    expect(sessionCache.get(storedKey)).toEqual(partial);
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("strict Telegram redemption rejects an expired continuation", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    const storedKey = `eliza-app:onboarding:${gatewayTurn.session.id}`;
    const stored = sessionCache.get(storedKey) as OnboardingSession;
    sessionCache.set(storedKey, {
      ...stored,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(
      runOnboardingChat({
        sessionId: continuationToken(gatewayTurn),
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
          telegramId: "123456789",
        },
        idempotencyKey: "telegram-auth-continuation",
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
  });

  test("rejects an authenticated continuation without the gateway Telegram identity", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });

    await expect(
      runOnboardingChat({
        sessionId: continuationToken(gatewayTurn),
        platform: "web",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
    });
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("continues when the signed session matches the gateway Telegram identity", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "pending",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });

    const continued = await runOnboardingChat({
      sessionId: continuationToken(gatewayTurn),
      platform: "web",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
        telegramId: "123456789",
      },
    });

    expect(continued.session.userId).toBe("user-1");
    expect(continued.session.organizationId).toBe("org-1");
    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  test("strict Telegram redemption rejects an unknown continuation", async () => {
    await expect(
      runOnboardingChat({
        sessionId: "unknown-opaque-continuation",
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
          telegramId: "123456789",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("strict Telegram redemption rejects a continuation from another platform", async () => {
    const discordTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "discord",
      platformUserId: "discord-user-1",
      sessionId: "platform:discord:discord-user-1",
      trustedPlatformIdentity: true,
    });

    await expect(
      runOnboardingChat({
        sessionId: continuationToken(discordTurn),
        platform: "telegram",
        continuationMode: "trusted-telegram",
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
          telegramId: "123456789",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
  });

  test("strict Telegram redemption rejects missing or mismatched signed identity", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    const sessionId = continuationToken(gatewayTurn);

    for (const telegramId of [undefined, "different-telegram-user"]) {
      await expect(
        runOnboardingChat({
          sessionId,
          platform: "telegram",
          continuationMode: "trusted-telegram",
          authenticatedUser: {
            userId: "user-1",
            organizationId: "org-1",
            telegramId,
          },
        }),
      ).rejects.toMatchObject({
        code: "ONBOARDING_PLATFORM_IDENTITY_MISMATCH",
      });
    }
    expect(ensureElizaAppProvisioning).not.toHaveBeenCalled();
  });

  test("strict Telegram redemption is idempotent for the same account", async () => {
    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "telegram",
      platformUserId: "123456789",
      sessionId: "platform:telegram:123456789",
      trustedPlatformIdentity: true,
    });
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "pending",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
    const input = {
      sessionId: continuationToken(gatewayTurn),
      platform: "telegram" as const,
      continuationMode: "trusted-telegram" as const,
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
        telegramId: "123456789",
      },
      idempotencyKey: "telegram-auth-continuation",
    };

    const first = await runOnboardingChat(input);
    const retry = await runOnboardingChat(input);

    expect(first.session.userId).toBe("user-1");
    expect(retry).toEqual(first);
    expect(ensureElizaAppProvisioning).toHaveBeenCalledTimes(1);

    await expect(
      runOnboardingChat({
        ...input,
        authenticatedUser: {
          userId: "user-2",
          organizationId: "org-2",
          telegramId: "123456789",
        },
      }),
    ).rejects.toMatchObject({
      code: "ONBOARDING_TRUSTED_CONTINUATION_INVALID",
    });
  });

  test("discord login handoff carries a CTA and keeps the raw URL out of the text", async () => {
    const result = await runOnboardingChat({
      message: "call me Sam",
      platform: "discord",
      platformUserId: "discord-user-1",
      sessionId: "platform:discord:discord-user-1",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(true);
    expect(result.cta).toEqual({ label: "Connect", url: result.loginUrl });
    // The button carries the URL; the message body must not repeat it.
    expect(result.reply).not.toContain(result.loginUrl);
    expect(result.reply).not.toContain("https://");
    expect(result.reply).toContain("Sam");
    expect(result.reply).toContain("$5");
  });

  test("discord handoff falls back to the inline-URL copy when the login URL cannot be a button (http scheme)", async () => {
    cloudEnv = { ELIZA_ONBOARDING_LOGIN_APP_URL: "http://localhost:3000" };
    const result = await runOnboardingChat({
      message: "call me Sam",
      platform: "discord",
      platformUserId: "discord-user-http",
      sessionId: "platform:discord:discord-user-http",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(true);
    // No CTA: an http URL cannot ride a Discord link button. The copy must
    // not say "tap below" at an affordance that will not render - the URL
    // stays inline exactly like the no-button platforms.
    expect(result.cta).toBeNull();
    expect(result.reply).not.toContain("tap below");
    expect(result.reply).toContain(result.loginUrl);
  });

  test("discord handoff falls back to the inline-URL copy when the login URL exceeds Discord's 512-char button bound", async () => {
    cloudEnv = {
      ELIZA_ONBOARDING_LOGIN_APP_URL: `https://example.com/${"a".repeat(520)}`,
    };
    const result = await runOnboardingChat({
      message: "call me Sam",
      platform: "discord",
      platformUserId: "discord-user-long",
      sessionId: "platform:discord:discord-user-long",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(true);
    expect(result.cta).toBeNull();
    expect(result.reply).not.toContain("tap below");
    expect(result.reply).toContain(result.loginUrl);
  });

  test("phone login handoff keeps the inline URL and no CTA (no buttons on SMS)", async () => {
    const result = await runOnboardingChat({
      message: "call me Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(true);
    expect(result.cta).toBeNull();
    expect(result.reply).toContain(result.loginUrl);
  });

  test("discord greeting (no name yet) has no CTA", async () => {
    getElizaAppProvisioningStatus.mockResolvedValue({
      status: "none",
      agentId: null,
      bridgeUrl: null,
      sandbox: null,
    });
    const result = await runOnboardingChat({
      message: "hi, what is this?",
      platform: "discord",
      platformUserId: "discord-user-2",
      sessionId: "platform:discord:discord-user-2",
      trustedPlatformIdentity: true,
    });

    expect(result.session.name).toBeUndefined();
    expect(result.cta).toBeNull();
    expect(result.reply).toMatch(/what should I call you\?/i);
  });

  test("stays deterministic and model-free even when a Cerebras key is configured", async () => {
    cloudEnv = {
      CEREBRAS_API_KEY: "test-key",
      ELIZA_ONBOARDING_LOGIN_APP_URL: "https://elizaos-homepage.pages.dev",
    };
    const first = await runOnboardingChat({
      message: "My name is Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });
    sessionCache.clear();
    const second = await runOnboardingChat({
      message: "My name is Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });

    expect(first.reply.replace(first.loginUrl, "<login>")).toBe(
      second.reply.replace(second.loginUrl, "<login>"),
    );
    expect(first.reply).toContain("$5");
    expect(first.reply.endsWith(`on me: ${first.loginUrl}`)).toBe(true);
    expect(first.reply).not.toMatch(/[^\x09\x0A\x0D\x20-\x7E]/);
  });

  test("copies the onboarding transcript into memory once the provisioned agent is running", async () => {
    const originalFetch = globalThis.fetch;
    const rememberRequests: Array<{
      url: string;
      body: unknown;
      authorization: string | null;
    }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      rememberRequests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization:
          init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : ((init?.headers as Record<string, string> | undefined)?.Authorization ?? null),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      findOrCreateByPhone.mockResolvedValue({
        user: { id: "user-1", name: null },
        organization: { id: "org-1" },
        isNew: true,
      });
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "running",
        agentId: "agent-1",
        bridgeUrl: "https://agent-1.example",
        sandbox: {
          id: "agent-1",
          status: "running",
          bridge_url: "https://agent-1.example",
        },
      });
      launchManagedElizaAgent.mockResolvedValue({
        appUrl: "https://app.elizacloud.ai/dashboard/agents/agent-1",
        connection: {
          apiBase: "https://agent-1.example/",
          token: "agent-token",
        },
      });

      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: "+14155550123",
        sessionId: "platform:blooio:+14155550123",
        trustedPlatformIdentity: true,
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
        },
      });

      expect(result.handoffComplete).toBe(true);
      expect(result.launchUrl).toBe("https://app.elizacloud.ai/dashboard/agents/agent-1");
      expect(result.session.userId).toBe("user-1");
      expect(result.session.organizationId).toBe("org-1");
      expect(result.session.agentId).toBe("agent-1");
      expect(result.session.launchUrl).toBe("https://app.elizacloud.ai/dashboard/agents/agent-1");
      expect(result.session.handoffCopiedAt).toBeTruthy();
      expect(result.reply).toContain("already knows everything from this chat");
      expect(launchManagedElizaAgent).toHaveBeenCalledWith({
        agentId: "agent-1",
        organizationId: "org-1",
        userId: "user-1",
      });
      expect(rememberRequests).toHaveLength(1);
      const rememberRequest = rememberRequests[0];
      expect(rememberRequest).toBeDefined();
      if (!rememberRequest) {
        throw new Error("Expected the onboarding memory request");
      }
      expect(rememberRequest.url).toBe("https://agent-1.example/api/memory/remember");
      expect(rememberRequest.authorization).toBe("Bearer agent-token");
      expect((rememberRequest.body as { text: string }).text).toContain(
        "Onboarding conversation transcript copied from Eliza Cloud.",
      );
      expect((rememberRequest.body as { text: string }).text).toContain("User: My name is Sam");
      expect((rememberRequest.body as { text: string }).text).toContain(
        "User's preferred name: Sam",
      );

      launchManagedElizaAgent.mockClear();
      const continued = await runOnboardingChat({
        platform: "blooio",
        platformUserId: "+14155550123",
        sessionId: continuationToken(result),
        authenticatedUser: {
          userId: "user-1",
          organizationId: "org-1",
        },
      });

      expect(continued.handoffComplete).toBe(true);
      expect(continued.session.agentId).toBe("agent-1");
      expect(continued.session.handoffCopiedAt).toBe(result.session.handoffCopiedAt);
      expect(continued.launchUrl).toBe("https://app.elizacloud.ai/dashboard/agents/agent-1");
      expect(launchManagedElizaAgent).not.toHaveBeenCalled();
      expect(rememberRequests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("continues an authenticated phone onboarding session without requiring another message", async () => {
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "provisioning",
      agentId: "agent-1",
      bridgeUrl: null,
      sandbox: null,
    });

    const gatewayTurn = await runOnboardingChat({
      message: "My name is Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });
    ensureElizaAppProvisioning.mockClear();
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "provisioning",
      agentId: "agent-1",
      bridgeUrl: null,
      sandbox: null,
    });

    const result = await runOnboardingChat({
      platform: "blooio",
      sessionId: continuationToken(gatewayTurn),
      authenticatedUser: {
        userId: "phone-user",
        organizationId: "phone-org",
      },
    });

    expect(ensureElizaAppProvisioning).toHaveBeenCalledWith({
      userId: "phone-user",
      organizationId: "phone-org",
    });
    expect(linkPhoneToUser).toHaveBeenCalledWith("phone-user", "+14155550123");
    expect(result.provisioning.agentId).toBe("agent-1");
  });

  const PHONE = "+14155550123";
  const PLATFORM_SESSION = `platform:blooio:${PHONE}`;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const NON_ASCII_PATTERN = /[^\x09\x0A\x0D\x20-\x7E]/;

  function noProvisioning() {
    return { status: "none", agentId: null, bridgeUrl: null, sandbox: null };
  }

  function cacheKey(sessionId: string): string {
    return `eliza-app:onboarding:${sessionId}`;
  }

  function isOnboardingSession(value: unknown): value is OnboardingSession {
    return typeof value === "object" && value !== null && "id" in value && "history" in value;
  }

  function getCachedSession(sessionId: string): OnboardingSession {
    const value = sessionCache.get(cacheKey(sessionId));
    if (!isOnboardingSession(value)) {
      throw new Error(`no cached onboarding session for ${sessionId}`);
    }
    return value;
  }

  async function runTrustedPhoneTurn(message: string) {
    return runOnboardingChat({
      message,
      platform: "blooio",
      platformUserId: PHONE,
      sessionId: PLATFORM_SESSION,
      trustedPlatformIdentity: true,
    });
  }

  describe("session id hardening", () => {
    test("malformed session ids are regenerated, never used", async () => {
      const malformed = [
        "../../etc/passwd",
        "a".repeat(300),
        "bad id with spaces",
        "short",
        "<script>alert(1)</script>",
      ];
      for (const sessionId of malformed) {
        const result = await runOnboardingChat({ sessionId, message: "hello" });
        expect(result.session.id).not.toBe(sessionId);
        expect(result.session.id).toMatch(UUID_PATTERN);
        expect(sessionCache.has(cacheKey(result.session.id))).toBe(true);
        expect(sessionCache.has(cacheKey(sessionId))).toBe(false);
      }
    });

    test("a trusted gateway with a malformed session id regenerates the platform-scoped id", async () => {
      const result = await runOnboardingChat({
        sessionId: "???bad session???",
        message: "hello",
        platform: "blooio",
        platformUserId: PHONE,
        trustedPlatformIdentity: true,
      });
      expect(result.session.id).toBe(PLATFORM_SESSION);
    });

    test("a forged platform session id from an anonymous caller cannot read or mutate the real session", async () => {
      const victim = await runTrustedPhoneTurn("My name is Sam");
      expect(victim.session.id).toBe(PLATFORM_SESSION);
      expect(victim.session.name).toBe("Sam");
      const victimSnapshot = JSON.stringify(getCachedSession(PLATFORM_SESSION));

      const attack = await runOnboardingChat({
        sessionId: PLATFORM_SESSION,
        message: "hacker was here",
      });

      expect(attack.session.id).not.toBe(PLATFORM_SESSION);
      expect(attack.session.id).toMatch(UUID_PATTERN);
      expect(attack.session.name).toBeUndefined();
      const attackContents = attack.session.history.map((m: OnboardingChatMessage) => m.content);
      expect(attackContents).not.toContain("My name is Sam");
      expect(JSON.stringify(getCachedSession(PLATFORM_SESSION))).toBe(victimSnapshot);
    });

    test("an anonymous caller cannot mint a platform-scoped session from body platform fields", async () => {
      const result = await runOnboardingChat({
        message: "hi there",
        platform: "twilio",
        platformUserId: "+15550001111",
      });
      expect(result.session.id).toMatch(UUID_PATTERN);
      expect(sessionCache.has(cacheKey("platform:twilio:+15550001111"))).toBe(false);
    });

    test("an authenticated caller cannot create a platform session or link a phone claimed in the body", async () => {
      getElizaAppProvisioningStatus.mockResolvedValue(noProvisioning());
      ensureElizaAppProvisioning.mockResolvedValue(noProvisioning());

      const withSessionId = await runOnboardingChat({
        sessionId: "platform:twilio:+15550002222",
        message: "My name is Eve",
        platform: "twilio",
        platformUserId: "+15550002222",
        authenticatedUser: {
          userId: "attacker-user",
          organizationId: "attacker-org",
        },
      });
      expect(withSessionId.session.id).toMatch(UUID_PATTERN);
      expect(sessionCache.has(cacheKey("platform:twilio:+15550002222"))).toBe(false);

      const withoutSessionId = await runOnboardingChat({
        message: "My name is Eve",
        platform: "twilio",
        platformUserId: "+15550003333",
        authenticatedUser: {
          userId: "attacker-user",
          organizationId: "attacker-org",
        },
      });
      expect(withoutSessionId.session.id).toMatch(UUID_PATTERN);
      expect(sessionCache.has(cacheKey("platform:twilio:+15550003333"))).toBe(false);

      expect(linkPhoneToUser).not.toHaveBeenCalled();
    });

    test("an authenticated caller cannot claim an existing unbound session by public platform id", async () => {
      const victim = await runTrustedPhoneTurn("My name is Sam");
      const victimSnapshot = JSON.stringify(getCachedSession(PLATFORM_SESSION));
      ensureElizaAppProvisioning.mockResolvedValue(noProvisioning());
      getElizaAppProvisioningStatus.mockResolvedValue(noProvisioning());

      const attacker = await runOnboardingChat({
        sessionId: PLATFORM_SESSION,
        authenticatedUser: {
          userId: "attacker-user",
          organizationId: "attacker-org",
        },
      });

      expect(attacker.session.id).not.toBe(PLATFORM_SESSION);
      expect(attacker.session.id).toMatch(UUID_PATTERN);
      expect(attacker.session.name).toBeUndefined();
      expect(
        attacker.session.history.map((message: OnboardingChatMessage) => message.content),
      ).not.toContain("My name is Sam");
      expect(JSON.stringify(getCachedSession(PLATFORM_SESSION))).toBe(victimSnapshot);
      expect(continuationToken(victim)).toMatch(UUID_PATTERN);
    });

    test("a session bound to one user never carries over to a different authenticated user", async () => {
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "provisioning",
        agentId: "agent-v",
        bridgeUrl: null,
        sandbox: null,
      });
      getElizaAppProvisioningStatus.mockResolvedValue(noProvisioning());

      const victim = await runTrustedPhoneTurn("My name is Sam");
      const victimBound = await runOnboardingChat({
        sessionId: continuationToken(victim),
        platform: "blooio",
        authenticatedUser: {
          userId: "victim-user",
          organizationId: "victim-org",
        },
      });
      expect(victimBound.session.id).toBe(PLATFORM_SESSION);
      expect(victimBound.session.userId).toBe("victim-user");

      const attacker = await runOnboardingChat({
        sessionId: PLATFORM_SESSION,
        authenticatedUser: {
          userId: "attacker-user",
          organizationId: "attacker-org",
        },
      });

      expect(attacker.session.id).not.toBe(PLATFORM_SESSION);
      expect(attacker.session.id).toMatch(UUID_PATTERN);
      expect(attacker.session.userId).toBe("attacker-user");
      const attackerContents = attacker.session.history.map(
        (m: OnboardingChatMessage) => m.content,
      );
      expect(attackerContents).not.toContain("My name is Sam");
      expect(getCachedSession(PLATFORM_SESSION).userId).toBe("victim-user");
      expect(linkPhoneToUser).not.toHaveBeenCalledWith("attacker-user", PHONE);
    });

    test("an opaque web continuation cannot mutate the platform identity and still links the phone", async () => {
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "provisioning",
        agentId: "agent-1",
        bridgeUrl: null,
        sandbox: null,
      });

      const gatewayTurn = await runTrustedPhoneTurn("My name is Sam");
      const continued = await runOnboardingChat({
        sessionId: continuationToken(gatewayTurn),
        platform: "web",
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });

      expect(continued.session.platform).toBe("blooio");
      expect(continued.session.platformUserId).toBe(PHONE);
      expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    });
  });

  describe("confused user messages", () => {
    test("empty and whitespace-only messages are not stored and still get a helpful reply", async () => {
      const first = await runTrustedPhoneTurn("");
      // Proactive first turn (client posts an empty message on load): the agent
      // greets AND explicitly offers to get the new user set up, then asks the
      // name — a proactive hello, not a passive prompt.
      expect(first.reply).toMatch(/i can get you set up|get you started/i);
      expect(first.reply).toMatch(/what should I call you\?/i);
      expect(first.session.history).toHaveLength(1);
      expect(first.session.history[0]?.role).toBe("assistant");

      const second = await runTrustedPhoneTurn("   \n\t  ");
      expect(second.session.history).toHaveLength(2);
      expect(
        second.session.history.every((m: OnboardingChatMessage) => m.role === "assistant"),
      ).toBe(true);
    });

    test("emoji-only messages never capture a name and the reply stays ASCII", async () => {
      const result = await runTrustedPhoneTurn("🎉🔥🚀");
      expect(result.session.name).toBeUndefined();
      expect(result.session.history[0]?.content).toBe("🎉🔥🚀");
      expect(result.reply).toMatch(/what should I call you\?/i);
      expect(result.reply).not.toMatch(NON_ASCII_PATTERN);
    });

    test("a 10k+ character message is truncated to the storage bound without crashing", async () => {
      const result = await runTrustedPhoneTurn("x".repeat(10_500));
      expect(result.session.history[0]?.content).toHaveLength(4000);
      expect(typeof result.reply).toBe("string");
      expect(result.reply.length).toBeGreaterThan(0);
    });

    test("double-sending the same name message keeps the name and the login link", async () => {
      const first = await runTrustedPhoneTurn("My name is Sam");
      const second = await runTrustedPhoneTurn("My name is Sam");
      expect(second.session.name).toBe("Sam");
      expect(second.session.history).toHaveLength(4);
      for (const result of [first, second]) {
        expect(result.reply).toContain(`on me: ${result.loginUrl}`);
      }
    });

    test("an explicit rename wins; a later bare word does not", async () => {
      await runTrustedPhoneTurn("call me Sam");
      const renamed = await runTrustedPhoneTurn("actually, call me Alex");
      expect(renamed.session.name).toBe("Alex");
      expect(renamed.reply).toContain("Alex");

      const bare = await runTrustedPhoneTurn("Bob");
      expect(bare.session.name).toBe("Alex");
    });

    test("greeting-like and filler replies are never captured as names", async () => {
      const fillers = [
        "Hi",
        "Ok",
        "Nice",
        "Yes",
        "Thanks",
        "Help",
        "I'm lost",
        "I am confused",
        "i'm not sure",
      ];
      for (const message of fillers) {
        sessionCache.clear();
        const result = await runTrustedPhoneTurn(message);
        expect(result.session.name).toBeUndefined();
        expect(result.reply).toMatch(/what should I call you\?/i);
      }
    });

    test("markdown and URL injection in a name message is rejected and never echoed", async () => {
      const result = await runTrustedPhoneTurn("my name is https://evil.example **bold**");
      expect(result.session.name).toBeUndefined();
      expect(result.reply).not.toContain("evil.example");
      expect(result.reply).not.toContain("**");
      expect(result.reply).toMatch(/what should I call you\?/i);
    });

    test("a non-ASCII explicit name is captured in ASCII-safe form and the reply stays ASCII", async () => {
      const result = await runTrustedPhoneTurn("My name is José");
      expect(result.session.name).toBe("Jos");
      expect(result.reply).toContain("Jos");
      expect(result.reply).not.toMatch(NON_ASCII_PATTERN);
    });

    test("a fully non-ASCII display name is not auto-captured; the user is asked for a name", async () => {
      const result = await runOnboardingChat({
        message: "hello",
        platform: "blooio",
        platformUserId: PHONE,
        sessionId: PLATFORM_SESSION,
        trustedPlatformIdentity: true,
        platformDisplayName: "Жозе 🎉",
      });
      expect(result.session.name).toBeUndefined();
      expect(result.reply).toMatch(/what should I call you\?/i);
      expect(result.reply).not.toMatch(NON_ASCII_PATTERN);
    });

    test("placeholder display names are never treated as a captured preferred name", async () => {
      const placeholders = ["User ***0123", "WhatsApp ***4567", "User ab***cd", PHONE, "***12"];
      for (const displayName of placeholders) {
        sessionCache.clear();
        const result = await runOnboardingChat({
          message: "hello",
          platform: "blooio",
          platformUserId: PHONE,
          sessionId: PLATFORM_SESSION,
          trustedPlatformIdentity: true,
          platformDisplayName: displayName,
        });
        expect(result.session.name).toBeUndefined();
        expect(result.reply).toMatch(/what should I call you\?/i);
      }
    });

    test("a stored placeholder name is not a preferred name and is replaced by an explicit one", async () => {
      const createdAt = new Date().toISOString();
      const legacy: OnboardingSession = {
        id: PLATFORM_SESSION,
        createdAt,
        updatedAt: createdAt,
        platform: "blooio",
        platformUserId: PHONE,
        name: "User ***0123",
        platformIdentityTrusted: true,
        history: [],
      };
      sessionCache.set(cacheKey(PLATFORM_SESSION), legacy);

      const beforeName = await runTrustedPhoneTurn("hello");
      expect(beforeName.reply).toMatch(/what should I call you\?/i);

      const named = await runTrustedPhoneTurn("call me Sam");
      expect(named.session.name).toBe("Sam");
      expect(named.reply).toContain("Sam");
    });
  });

  describe("history bounding and concurrency", () => {
    test("history stays bounded at 200 messages over a long conversation", async () => {
      const createdAt = new Date().toISOString();
      const seededHistory: OnboardingChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn-${i}`,
        createdAt,
      }));
      const seeded: OnboardingSession = {
        id: PLATFORM_SESSION,
        createdAt,
        updatedAt: createdAt,
        platform: "blooio",
        platformUserId: PHONE,
        name: "Sam",
        platformIdentityTrusted: true,
        history: seededHistory,
      };
      sessionCache.set(cacheKey(PLATFORM_SESSION), seeded);

      const result = await runTrustedPhoneTurn("one more message");

      expect(result.session.history).toHaveLength(200);
      const contents = result.session.history.map((m: OnboardingChatMessage) => m.content);
      expect(contents).toContain("one more message");
      expect(contents).not.toContain("turn-0");
      expect(contents).not.toContain("turn-1");
      expect(contents).toContain("turn-2");
      expect(result.session.history[199]?.role).toBe("assistant");
    });

    test("concurrent turns on the same session do not crash and keep history bounded", async () => {
      const [a, b] = await Promise.all([
        runTrustedPhoneTurn("first hello"),
        runTrustedPhoneTurn("second hello"),
      ]);
      expect(typeof a.reply).toBe("string");
      expect(typeof b.reply).toBe("string");
      expect([a.session.history.length, b.session.history.length].sort()).toEqual([2, 4]);
      const cached = getCachedSession(PLATFORM_SESSION);
      expect(cached.history.length).toBe(4);
      expect(cached.history.map((message) => message.content)).toEqual(
        expect.arrayContaining(["first hello", "second hello"]),
      );
    });
  });

  describe("provisioning-state replies without an LLM", () => {
    test("provisioning error reply promises the queued retry and never claims the agent is live", async () => {
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "error",
        agentId: "agent-1",
        bridgeUrl: null,
        sandbox: null,
      });
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: PHONE,
        sessionId: PLATFORM_SESSION,
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.provisioning.status).toBe("error");
      expect(result.handoffComplete).toBe(false);
      // The retry is queued automatically now (#17924), so the reply must say
      // so rather than send the user to a dashboard that has no button to fix
      // this — that instruction was a dead end for every stranded org.
      expect(result.reply.toLowerCase()).toContain("queued");
      expect(result.reply.toLowerCase()).not.toContain("dashboard");
      // Still must not overclaim: the row is `error` at this instant and only
      // becomes `provisioning` when the daemon claims the job.
      expect(result.reply).not.toContain("agent is live");
      expect(result.reply.toLowerCase()).not.toContain("running");
    });

    test("provisioning-in-progress reply does not claim the agent is live or copied", async () => {
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "provisioning",
        agentId: "agent-1",
        bridgeUrl: null,
        sandbox: null,
      });
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: PHONE,
        sessionId: PLATFORM_SESSION,
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.reply).toContain("spinning up now");
      expect(result.reply).not.toContain("agent is live");
      expect(result.reply).not.toContain("knows everything");
    });

    test("insufficient-credits reply is deterministic and points at billing", async () => {
      cloudEnv = { CEREBRAS_API_KEY: "test-key" };
      ensureElizaAppProvisioning.mockResolvedValue({
        status: "insufficient_credits",
        agentId: null,
        bridgeUrl: null,
        sandbox: null,
      });
      const result = await runOnboardingChat({
        message: "My name is Sam",
        platform: "blooio",
        platformUserId: PHONE,
        sessionId: PLATFORM_SESSION,
        trustedPlatformIdentity: true,
        authenticatedUser: { userId: "user-1", organizationId: "org-1" },
      });
      expect(result.provisioning.status).toBe("insufficient_credits");
      expect(result.handoffComplete).toBe(false);
      expect(result.reply).toContain("you're out of credits, Sam");
      expect(result.reply).toContain("/dashboard/billing");
      expect(result.reply).not.toContain("agent is live");
      expect(result.reply).not.toContain("knows everything");
    });

    test("login-required fallback reply always ends with the exact login link", async () => {
      const result = await runTrustedPhoneTurn("My name is Sam");
      expect(result.requiresLogin).toBe(true);
      expect(result.reply.endsWith(`on me: ${result.loginUrl}`)).toBe(true);
    });

    test("a failed transcript handoff is retried on the next turn and copied exactly once", async () => {
      const originalFetch = globalThis.fetch;
      let rememberCalls = 0;
      let rememberStatus = 500;
      globalThis.fetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        rememberCalls++;
        return new Response("{}", { status: rememberStatus });
      }) as typeof fetch;

      try {
        ensureElizaAppProvisioning.mockResolvedValue({
          status: "running",
          agentId: "agent-1",
          bridgeUrl: "https://agent-1.example",
          sandbox: {
            id: "agent-1",
            status: "running",
            bridge_url: "https://agent-1.example",
          },
        });
        launchManagedElizaAgent.mockResolvedValue({
          appUrl: "https://app.elizacloud.ai/dashboard/agents/agent-1",
          connection: {
            apiBase: "https://agent-1.example",
            token: "agent-token",
          },
        });

        const first = await runOnboardingChat({
          message: "My name is Sam",
          platform: "blooio",
          platformUserId: PHONE,
          sessionId: PLATFORM_SESSION,
          trustedPlatformIdentity: true,
          authenticatedUser: { userId: "user-1", organizationId: "org-1" },
        });
        expect(first.handoffComplete).toBe(false);
        expect(first.session.handoffCopiedAt).toBeUndefined();
        expect(first.reply).toContain("finishing setup");
        expect(first.reply).not.toContain("knows everything");
        expect(rememberCalls).toBe(1);
        const browserContinuation = continuationToken(first);

        rememberStatus = 200;
        const second = await runOnboardingChat({
          platform: "blooio",
          sessionId: browserContinuation,
          authenticatedUser: { userId: "user-1", organizationId: "org-1" },
        });
        expect(second.handoffComplete).toBe(true);
        expect(second.session.handoffCopiedAt).toBeTruthy();
        expect(rememberCalls).toBe(2);

        const third = await runOnboardingChat({
          platform: "blooio",
          sessionId: browserContinuation,
          authenticatedUser: { userId: "user-1", organizationId: "org-1" },
        });
        expect(third.handoffComplete).toBe(true);
        expect(rememberCalls).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("a failed remember error body read is logged without fabricating handoff success", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return {
          ok: false,
          status: 502,
          text: mock(async () => {
            throw new Error("body stream broke");
          }),
        } as Response;
      }) as typeof fetch;

      try {
        ensureElizaAppProvisioning.mockResolvedValue({
          status: "running",
          agentId: "agent-1",
          bridgeUrl: "https://agent-1.example",
          sandbox: {
            id: "agent-1",
            status: "running",
            bridge_url: "https://agent-1.example",
          },
        });
        launchManagedElizaAgent.mockResolvedValue({
          appUrl: "https://app.elizacloud.ai/dashboard/agents/agent-1",
          connection: {
            apiBase: "https://agent-1.example",
            token: "agent-token",
          },
        });

        const result = await runOnboardingChat({
          message: "My name is Sam",
          platform: "blooio",
          platformUserId: PHONE,
          sessionId: PLATFORM_SESSION,
          trustedPlatformIdentity: true,
          authenticatedUser: { userId: "user-1", organizationId: "org-1" },
        });

        expect(result.handoffComplete).toBe(false);
        expect(result.session.handoffCopiedAt).toBeUndefined();
        expect(loggerWarn).toHaveBeenCalledWith(
          "[eliza-app onboarding] failed to read remember error body",
          expect.objectContaining({
            agentId: "agent-1",
            status: 502,
            error: "body stream broke",
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
