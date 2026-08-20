/** Exercises internal voice-stream path validation before authorization and dispatch. */
import { describe, expect, mock, test } from "bun:test";
import type { Bindings } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module("@/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
    del: mock(async () => undefined),
  },
}));

mock.module("@/lib/cache/keys", () => ({
  CacheKeys: {
    sharedAgentScope: {
      voice: () => "voice-scope-key",
    },
  },
}));

mock.module("@/lib/runtime/cloud-bindings", () => ({
  hasCloudBindingsContext: () => false,
  runWithCloudBindingsAsync: async (
    _env: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

mock.module("@/lib/auth/cron", () => ({
  timingSafeEqualSecret: () => false,
}));

mock.module("@/lib/services/shared-runtime/canonical-scoped-stream", () => ({
  handleCanonicalScopedAgentStream: mock(),
}));

mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  commitPersonalProvisionalHistoryConvergence: mock(),
  coordinateSharedConversationPrewarm: mock(),
  coordinateSharedLifecycleEvent: mock(),
  preparePersonalProvisionalHistoryConvergence: mock(),
  purgeSharedConversationRooms: mock(),
  releasePersonalProvisionalHistoryConvergence: mock(),
}));

mock.module("@/lib/services/shared-runtime/personal-shared-agent", () => ({
  isPersonalSharedAgentId: () => false,
  personalSharedAgent: () => null,
  personalSharedAgentId: () => "personal-agent",
}));

const { createInternalElizaConversationFetch } = await import(
  "../lib/internal-eliza-conversation-fetch"
);

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conv-1";

function fetchImpl() {
  return createInternalElizaConversationFetch(
    {
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
    } as Bindings,
    {
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      organizationId: "org-1",
      userId: "user-1",
    },
  );
}

function streamUrl(agentId: string, conversationId: string): string {
  return `https://voice.internal/api/v1/eliza/agents/${agentId}/api/conversations/${conversationId}/messages/stream`;
}

describe("internal Eliza conversation stream path encoding", () => {
  test("unsupported path is untouched", async () => {
    await expect(
      fetchImpl()("https://voice.internal/api/v1/eliza/other", {
        method: "POST",
      }),
    ).rejects.toThrow("unsupported internal Eliza stream path");
  });

  test("canonical ids still reach auth after decode", async () => {
    const response = await fetchImpl()(streamUrl(AGENT_ID, CONVERSATION_ID), {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Agent not found",
      code: "agent_not_found",
    });
  });

  test("canonical percent-encoded hyphen still decodes before auth", async () => {
    const response = await fetchImpl()(streamUrl("agent%2D1", "conv%2D1"), {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: "Agent not found",
      code: "agent_not_found",
    });
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed conversation id %s with 400",
    async (token) => {
      const response = await fetchImpl()(streamUrl(AGENT_ID, token), {
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        success: false,
        error: "invalid conversation path: malformed URL encoding",
      });
    },
  );

  test.each(["%", "%2", "%ZZ"])(
    "rejects malformed agent id %s with 400",
    async (token) => {
      const response = await fetchImpl()(streamUrl(token, CONVERSATION_ID), {
        method: "POST",
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        success: false,
        error: "invalid conversation path: malformed URL encoding",
      });
    },
  );
});
