/**
 * Server-attested historyCutoffAt is leftover pairing after #21385 path
 * encoding. Only an authenticated voice-service turn may elevate a finite
 * positive integer cutoff onto the canonical stream request. Malformed or
 * untrusted values must not reach handleCanonicalScopedAgentStream.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bindings } from "@/types/cloud-worker-env";

const handleCanonicalScopedAgentStream = mock(async () => new Response("ok"));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

mock.module("@/lib/cache/client", () => ({
  cache: {
    get: mock(async () => ({
      id: "agent-1",
      organization_id: "org-1",
      user_id: "user-1",
      execution_tier: "shared",
    })),
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
  timingSafeEqualSecret: (presented: string, configured: string) =>
    presented === configured,
}));

mock.module("@/lib/services/shared-runtime/canonical-scoped-stream", () => ({
  handleCanonicalScopedAgentStream,
}));

mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedConversationPrewarm: mock(),
  coordinateSharedLifecycleEvent: mock(),
}));

mock.module("@/lib/services/shared-runtime/personal-shared-agent", () => ({
  isPersonalSharedAgentId: () => false,
  personalSharedAgent: () => null,
}));

const { createInternalElizaConversationFetch } = await import(
  "../lib/internal-eliza-conversation-fetch"
);

const AGENT_ID = "agent-1";
const CONVERSATION_ID = "conv-1";
const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const CUTOFF_AT = 1_724_000_000_000;

function fetchImpl() {
  return createInternalElizaConversationFetch(
    {
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName() {
          throw new Error("coordinator must not be reached");
        },
      },
    } as Bindings,
    {
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    },
    {
      waitUntil() {
        return undefined;
      },
    },
  );
}

function streamUrl(): string {
  return `https://voice.internal/api/v1/eliza/agents/${AGENT_ID}/api/conversations/${CONVERSATION_ID}/messages/stream`;
}

function streamInit(
  body: Record<string, unknown>,
  authorization = "Bearer voice-service",
): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      "X-Eliza-Agent-Id": AGENT_ID,
      "X-Eliza-Conversation-Id": CONVERSATION_ID,
      "X-Eliza-Organization-Id": ORGANIZATION_ID,
      "X-Eliza-User-Id": USER_ID,
    },
    body: JSON.stringify(body),
  };
}

describe("internal Eliza conversation historyCutoffAt transport", () => {
  beforeEach(() => {
    handleCanonicalScopedAgentStream.mockClear();
  });

  test("authenticated elevation passes finite positive historyCutoffAt and strips it from body", async () => {
    const response = await fetchImpl()(
      streamUrl(),
      streamInit({
        text: "open the call",
        messageRole: "system",
        historyCutoffAt: CUTOFF_AT,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleCanonicalScopedAgentStream).toHaveBeenCalledTimes(1);
    const request = handleCanonicalScopedAgentStream.mock.calls[0]?.[0] as {
      historyCutoffAt?: unknown;
      trustedMessageRole?: unknown;
      body?: { historyCutoffAt?: unknown; text?: unknown };
    };
    expect(request.historyCutoffAt).toBe(CUTOFF_AT);
    expect(request.trustedMessageRole).toBe("system");
    expect(request.body).toEqual({
      text: "open the call",
      messageRole: "system",
    });
    expect(request.body).not.toHaveProperty("historyCutoffAt");
  });

  test.each([
    { label: "prefix-coerced string", token: "123" },
    { label: "prefix-coerced mixed string", token: "123abc" },
    { label: "ISO timestamp string", token: "2026-08-17T00:00:00Z" },
    { label: "zero", token: 0 },
    { label: "negative", token: -1 },
    { label: "float", token: 1.5 },
    { label: "NaN", token: Number.NaN },
    { label: "Infinity", token: Number.POSITIVE_INFINITY },
    { label: "boolean", token: true },
    { label: "null", token: null },
    { label: "object", token: { at: CUTOFF_AT } },
    { label: "array", token: [CUTOFF_AT] },
  ])(
    "malformed historyCutoffAt $label is denied with 400 after auth",
    async ({ token }) => {
      const response = await fetchImpl()(
        streamUrl(),
        streamInit({
          text: "open the call",
          historyCutoffAt: token,
        }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error:
          "invalid historyCutoffAt: expected a finite positive integer timestamp",
      });
      expect(handleCanonicalScopedAgentStream).not.toHaveBeenCalled();
    },
  );

  test("untrusted request cannot elevate historyCutoffAt", async () => {
    const response = await fetchImpl()(
      streamUrl(),
      streamInit(
        {
          text: "open the call",
          historyCutoffAt: CUTOFF_AT,
        },
        "Bearer attacker",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "Agent not found",
      code: "agent_not_found",
    });
    expect(handleCanonicalScopedAgentStream).not.toHaveBeenCalled();
  });
});
