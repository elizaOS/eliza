import { beforeEach, describe, expect, mock, test } from "bun:test";

const sessionCache = new Map<string, unknown>();
const ensureElizaAppProvisioning = mock();
const getElizaAppProvisioningStatus = mock();
const findOrCreateByPhone = mock();
const generateText = mock();
const launchManagedElizaAgent = mock();
let cloudEnv: Record<string, string | undefined> = {};

mock.module("../../cache/client", () => ({
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: mock(() => cloudEnv),
}));

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: mock(() => ({
    chat: mock(() => "mock-model"),
  })),
}));

mock.module("ai", () => ({
  generateText,
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
  },
}));

const { runOnboardingChat } = await import("./onboarding-chat");

describe("runOnboardingChat", () => {
  beforeEach(() => {
    sessionCache.clear();
    ensureElizaAppProvisioning.mockReset();
    getElizaAppProvisioningStatus.mockReset();
    findOrCreateByPhone.mockReset();
    generateText.mockReset();
    launchManagedElizaAgent.mockReset();
    cloudEnv = {};
  });

  test("asks for a name before provisioning a trusted phone onboarding session", async () => {
    findOrCreateByPhone.mockResolvedValue({
      user: { id: "user-1", name: "***0123" },
      organization: { id: "org-1" },
      isNew: true,
    });
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
    expect(result.reply).toContain("What should I call you?");
    expect(result.reply).toContain("$5");
  });

  test("sanitizes duplicated URL schemes from generated onboarding replies", async () => {
    cloudEnv = { CEREBRAS_API_KEY: "test-key" };
    generateText.mockResolvedValue({
      text: "Open <httpshttps://elizacloud.ai/dashboard/containers>.",
    });
    findOrCreateByPhone.mockResolvedValue({
      user: { id: "user-1", name: null },
      organization: { id: "org-1" },
    });
    ensureElizaAppProvisioning.mockResolvedValue({
      status: "provisioning",
      agentId: "agent-1",
      bridgeUrl: null,
      sandbox: null,
    });

    const result = await runOnboardingChat({
      message: "My name is Sam",
      platform: "blooio",
      platformUserId: "+14155550123",
      sessionId: "platform:blooio:+14155550123",
      trustedPlatformIdentity: true,
    });

    expect(result.reply).toBe("Open <https://elizacloud.ai/dashboard/containers>.");
  });

  test("copies the onboarding transcript into memory once the provisioned agent is running", async () => {
    const originalFetch = globalThis.fetch;
    const rememberRequests: Array<{ url: string; body: unknown; authorization: string | null }> =
      [];
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
        sandbox: { id: "agent-1", status: "running", bridge_url: "https://agent-1.example" },
      });
      launchManagedElizaAgent.mockResolvedValue({
        appUrl: "https://app.elizacloud.ai/dashboard/containers/agents/agent-1",
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
      });

      expect(result.handoffComplete).toBe(true);
      expect(result.launchUrl).toBe(
        "https://app.elizacloud.ai/dashboard/containers/agents/agent-1",
      );
      expect(result.session.handoffCopiedAt).toBeTruthy();
      expect(launchManagedElizaAgent).toHaveBeenCalledWith({
        agentId: "agent-1",
        organizationId: "org-1",
        userId: "user-1",
      });
      expect(rememberRequests).toHaveLength(1);
      expect(rememberRequests[0]?.url).toBe("https://agent-1.example/api/memory/remember");
      expect(rememberRequests[0]?.authorization).toBe("Bearer agent-token");
      expect((rememberRequests[0]?.body as { text: string }).text).toContain(
        "Onboarding conversation transcript copied from Eliza Cloud.",
      );
      expect((rememberRequests[0]?.body as { text: string }).text).toContain(
        "User: My name is Sam",
      );
      expect((rememberRequests[0]?.body as { text: string }).text).toContain(
        "User's preferred name: Sam",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
