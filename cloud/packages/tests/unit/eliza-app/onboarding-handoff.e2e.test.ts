import { afterEach, describe, expect, mock, test } from "bun:test";

type SandboxState = {
  id: string;
  status: string;
  bridge_url: string | null;
};

type TestState = {
  cache: Map<string, unknown>;
  sandboxes: SandboxState[];
  createdAgents: unknown[];
  enqueuedJobs: unknown[];
  launchedAgents: unknown[];
  rememberedTranscripts: Array<{
    url: string;
    authorization: string | null;
    text: string;
  }>;
  phoneBindings: string[];
};

const originalFetch = globalThis.fetch;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function setupMocks(): TestState {
  const state: TestState = {
    cache: new Map(),
    sandboxes: [],
    createdAgents: [],
    enqueuedJobs: [],
    launchedAgents: [],
    rememberedTranscripts: [],
    phoneBindings: [],
  };

  mock.module("@/lib/cache/client", () => ({
    cache: {
      get: mock(async (key: string) => {
        const value = state.cache.get(key);
        return value ? clone(value) : null;
      }),
      set: mock(async (key: string, value: unknown) => {
        state.cache.set(key, clone(value));
      }),
    },
  }));

  mock.module("@/db/repositories/agent-sandboxes", () => ({
    agentSandboxesRepository: {
      listByOrganization: mock(async () => state.sandboxes.map((sandbox) => ({ ...sandbox }))),
    },
  }));

  mock.module("@/lib/services/eliza-sandbox", () => ({
    elizaSandboxService: {
      createAgent: mock(async (params: unknown) => {
        state.createdAgents.push(params);
        const sandbox = {
          id: "agent-1",
          status: "provisioning",
          bridge_url: null,
        };
        state.sandboxes.push(sandbox);
        return { ...sandbox };
      }),
    },
  }));

  mock.module("@/lib/services/provisioning-jobs", () => ({
    provisioningJobService: {
      enqueueAgentProvision: mock(async (params: unknown) => {
        state.enqueuedJobs.push(params);
      }),
    },
  }));

  mock.module("@/lib/services/eliza-managed-launch", () => ({
    launchManagedElizaAgent: mock(async (params: unknown) => {
      state.launchedAgents.push(params);
      return {
        appUrl: "https://app.elizacloud.ai/agents/agent-1?cloudLaunchSession=session-1",
        launchSessionId: "session-1",
        connection: {
          apiBase: "https://agent-runtime.example",
          token: "agent-runtime-token",
        },
        agentId: "agent-1",
        agentName: "Eliza",
        issuedAt: new Date().toISOString(),
      };
    }),
  }));

  mock.module("@/lib/services/eliza-app/user-service", () => ({
    elizaAppUserService: {
      findOrCreateByPhone: mock(async (phone: string) => {
        state.phoneBindings.push(phone);
        return {
          user: { id: "phone-user-1", organizationId: "phone-org-1", name: "Sam" },
          organization: { id: "phone-org-1" },
        };
      }),
    },
  }));

  mock.module("@/lib/runtime/cloud-bindings", () => ({
    getCloudAwareEnv: () => ({
      NEXT_PUBLIC_ELIZA_APP_URL: "https://app.elizacloud.ai",
    }),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: {
      debug: mock(() => {}),
      error: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
    },
  }));

  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://agent-runtime.example/api/memory/remember") {
      const body = (await request.json()) as { text?: string };
      state.rememberedTranscripts.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        text: body.text ?? "",
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in onboarding handoff test: ${request.url}`);
  }) as unknown as typeof fetch;

  return state;
}

async function importOnboardingChat() {
  return import(
    new URL(
      `../../../lib/services/eliza-app/onboarding-chat.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

describe("eliza-app onboarding handoff e2e", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test("carries an anonymous chat through login, provisioning, transcript copy, and idempotent handoff", async () => {
    const state = setupMocks();
    const { runOnboardingChat } = await importOnboardingChat();

    const anonymous = await runOnboardingChat({
      sessionId: "session-ada-001",
      message: "My name is Ada.",
      platform: "web",
    });

    expect(anonymous.requiresLogin).toBe(true);
    expect(anonymous.provisioning.status).toBe("none");
    expect(anonymous.loginUrl).toBe(
      "https://app.elizacloud.ai/get-started?onboardingSession=session-ada-001",
    );
    expect(anonymous.controlPanelUrl).toBe("https://app.elizacloud.ai/dashboard/containers");
    expect(anonymous.session.name).toBe("Ada");
    expect(state.createdAgents).toHaveLength(0);
    expect(state.enqueuedJobs).toHaveLength(0);
    expect(state.rememberedTranscripts).toHaveLength(0);

    const authenticated = await runOnboardingChat({
      sessionId: "session-ada-001",
      message: "I'm signed in. Please start my agent.",
      platform: "web",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
      },
    });

    expect(authenticated.requiresLogin).toBe(false);
    expect(authenticated.provisioning.status).toBe("provisioning");
    expect(authenticated.provisioning.agentId).toBe("agent-1");
    expect(authenticated.controlPanelUrl).toBe(
      "https://app.elizacloud.ai/dashboard/containers/agents/agent-1",
    );
    expect(state.createdAgents).toHaveLength(1);
    expect(state.enqueuedJobs).toHaveLength(1);
    expect(
      authenticated.session.history.map((message: { content: string }) => message.content),
    ).toContain(
      "My name is Ada.",
    );

    state.sandboxes[0] = {
      ...state.sandboxes[0],
      status: "running",
      bridge_url: "https://agent-runtime.example",
    };

    const handedOff = await runOnboardingChat({
      sessionId: "session-ada-001",
      platform: "web",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
      },
    });

    expect(handedOff.provisioning.status).toBe("running");
    expect(handedOff.handoffComplete).toBe(true);
    expect(handedOff.launchUrl).toBe(
      "https://app.elizacloud.ai/agents/agent-1?cloudLaunchSession=session-1",
    );
    expect(handedOff.reply).toContain("container is running");
    expect(handedOff.reply).toContain("copied this onboarding chat");
    expect(state.launchedAgents).toHaveLength(1);
    expect(state.rememberedTranscripts).toHaveLength(1);
    expect(state.rememberedTranscripts[0]?.authorization).toBe("Bearer agent-runtime-token");
    expect(state.rememberedTranscripts[0]?.text).toContain("User's preferred name: Ada");
    expect(state.rememberedTranscripts[0]?.text).toContain("User: My name is Ada.");
    expect(state.rememberedTranscripts[0]?.text).toContain(
      "User: I'm signed in. Please start my agent.",
    );

    const polledAgain = await runOnboardingChat({
      sessionId: "session-ada-001",
      platform: "web",
      authenticatedUser: {
        userId: "user-1",
        organizationId: "org-1",
      },
    });

    expect(polledAgain.handoffComplete).toBe(true);
    expect(state.launchedAgents).toHaveLength(1);
    expect(state.rememberedTranscripts).toHaveLength(1);
  });

  test("trusted phone onboarding provisions from Twilio or Blooio identity without a separate login", async () => {
    const state = setupMocks();
    const { runOnboardingChat } = await importOnboardingChat();

    const result = await runOnboardingChat({
      sessionId: "platform:twilio:+15551234567",
      message: "I am Sam",
      platform: "twilio",
      platformUserId: "+15551234567",
      trustedPlatformIdentity: true,
    });

    expect(result.requiresLogin).toBe(false);
    expect(result.session.userId).toBe("phone-user-1");
    expect(result.session.organizationId).toBe("phone-org-1");
    expect(result.provisioning.status).toBe("provisioning");
    expect(result.provisioning.agentId).toBe("agent-1");
    expect(state.phoneBindings).toEqual(["+15551234567"]);
    expect(state.createdAgents).toHaveLength(1);
    expect(state.enqueuedJobs).toHaveLength(1);
  });
});
