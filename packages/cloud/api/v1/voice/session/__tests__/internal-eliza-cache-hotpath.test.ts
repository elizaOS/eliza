/**
 * Proves realtime voice reaches the conversation Durable Object from cached
 * scope without loading any legacy repository-backed turn implementation.
 */

import { afterEach, expect, test } from "bun:test";
import { ChannelType, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
import type { Bindings } from "@/types/cloud-worker-env";

process.env.MOCK_REDIS = "1";

const { cache } = await import("@/lib/cache/client");
const { CacheKeys } = await import("@/lib/cache/keys");
const { runWithCloudBindingsAsync } = await import(
  "@/lib/runtime/cloud-bindings"
);
const { createInternalElizaConversationFetch } = await import(
  "../lib/internal-eliza-conversation-fetch"
);

const AGENT_ID = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORGANIZATION_ID = "org-voice-hotpath";
const USER_ID = "user-voice-hotpath";
const CONVERSATION_ID = "conversation-voice-hotpath";
const CACHE_KEY = CacheKeys.sharedAgentScope.voice(
  ORGANIZATION_ID,
  USER_ID,
  AGENT_ID,
);
const blobBinding = {
  async get() {
    return null;
  },
  async put() {
    return undefined;
  },
  async delete() {
    return undefined;
  },
} satisfies Bindings["BLOB"];

const cachedAgent = {
  id: AGENT_ID,
  organization_id: ORGANIZATION_ID,
  user_id: USER_ID,
  execution_tier: "shared",
  agent_name: "Cache Voice",
};

afterEach(async () => {
  await cache.del(CACHE_KEY);
});

test("real cache + canonical coordinator dispatch performs no response-path DB work", async () => {
  const coordinatorCalls: Array<{
    name: string;
    input: RequestInfo | URL;
    init?: RequestInit;
  }> = [];
  const namespace = {
    getByName(name: string) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          coordinatorCalls.push({ name, input, init });
          return new Response(
            'event: chunk\ndata: {"chunk":"cache only"}\n\nevent: done\ndata: {}\n\n',
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      };
    },
  };
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  const env = {
    CACHE_ENABLED: "true",
    DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
    VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
    BLOB: blobBinding,
    SHARED_RUNTIME_CONVERSATIONS: namespace,
  };

  await runWithCloudBindingsAsync(env, () =>
    cache.set(CACHE_KEY, cachedAgent, 60),
  );

  const fetchImpl = createInternalElizaConversationFetch(
    env as Parameters<typeof createInternalElizaConversationFetch>[0],
    {
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    },
    executionCtx,
  );
  await fetchImpl.prewarm();
  expect(background).toHaveLength(0);
  const response = await fetchImpl(
    `https://voice.internal/api/v1/eliza/agents/${AGENT_ID}/api/conversations/${CONVERSATION_ID}/messages/stream`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Agent-Id": AGENT_ID,
        "X-Eliza-Conversation-Id": CONVERSATION_ID,
        "X-Eliza-Organization-Id": ORGANIZATION_ID,
        "X-Eliza-User-Id": USER_ID,
      },
      body: JSON.stringify({ text: "prove the hot path" }),
    },
  );

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toContain("cache only");
  expect(background).toHaveLength(0);
  expect(coordinatorCalls).toHaveLength(2);
  expect(coordinatorCalls.map(({ name }) => name)).toEqual([
    `${AGENT_ID}:${CONVERSATION_ID}`,
    `${AGENT_ID}:${CONVERSATION_ID}`,
  ]);
  expect(JSON.parse(String(coordinatorCalls[0]?.init?.body))).toEqual({
    operation: "prewarm",
    agentId: AGENT_ID,
    roomId: CONVERSATION_ID,
    startEmpty: false,
  });
  expect(JSON.parse(String(coordinatorCalls[1]?.init?.body))).toMatchObject({
    operation: "stream",
    agent: cachedAgent,
    channel: {
      type: ChannelType.VOICE_DM,
      source: MESSAGE_SOURCE_CLIENT_CHAT,
    },
    rpc: {
      method: "message.send",
      params: {
        text: "prove the hot path",
        roomId: CONVERSATION_ID,
        userId: USER_ID,
        source: "voice",
      },
    },
  });
});

test("rejects conversation-creation routes instead of creating per-turn conversations", async () => {
  await cache.set(CACHE_KEY, cachedAgent, 60);
  const fetchImpl = createInternalElizaConversationFetch(
    {
      CACHE_ENABLED: "true",
      DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      BLOB: blobBinding,
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName() {
          throw new Error("conversation coordinator must not be reached");
        },
      },
    } as Parameters<typeof createInternalElizaConversationFetch>[0],
    {
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    },
    {
      waitUntil() {
        throw new Error("hydration must not be scheduled");
      },
    },
  );

  await expect(
    fetchImpl(
      `https://voice.internal/api/v1/eliza/agents/${AGENT_ID}/api/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer voice-service",
          "Content-Type": "application/json",
          "X-Eliza-Agent-Id": AGENT_ID,
          "X-Eliza-Conversation-Id": CONVERSATION_ID,
          "X-Eliza-Organization-Id": ORGANIZATION_ID,
          "X-Eliza-User-Id": USER_ID,
        },
        body: JSON.stringify({ title: "must not exist on voice turn path" }),
      },
    ),
  ).rejects.toThrow("unsupported internal Eliza stream path");
});

test("missing Worker coordinator fails closed without selecting a legacy bridge", async () => {
  await cache.set(CACHE_KEY, cachedAgent, 60);
  const fetchImpl = createInternalElizaConversationFetch(
    {
      DATABASE_URL: "postgresql://must-not-connect.invalid/eliza",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      BLOB: blobBinding,
    } as Parameters<typeof createInternalElizaConversationFetch>[0],
    {
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
    },
  );

  const response = await fetchImpl(
    `https://voice.internal/api/v1/eliza/agents/${AGENT_ID}/api/conversations/${CONVERSATION_ID}/messages/stream`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Agent-Id": AGENT_ID,
        "X-Eliza-Conversation-Id": CONVERSATION_ID,
        "X-Eliza-Organization-Id": ORGANIZATION_ID,
        "X-Eliza-User-Id": USER_ID,
      },
      body: JSON.stringify({ text: "never use legacy" }),
    },
  );

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    code: "shared_runtime_unavailable",
    retryable: true,
  });
});

test("hot module and canonical handler structurally exclude legacy DB turn dependencies", async () => {
  const internalSource = await Bun.file(
    new URL("../lib/internal-eliza-conversation-fetch.ts", import.meta.url),
  ).text();
  const canonicalSource = await Bun.file(
    new URL(
      "../../../../../shared/src/lib/services/shared-runtime/canonical-scoped-stream.ts",
      import.meta.url,
    ),
  ).text();

  expect(internalSource).not.toContain('from "@/db/client"');
  expect(internalSource).not.toContain('from "@/lib/services/eliza-sandbox"');
  expect(internalSource).not.toContain("shared-runtime-history");
  expect(internalSource).not.toContain("ai-billing");
  expect(internalSource).toContain('import("./voice-agent-scope-hydration")');
  expect(internalSource).toContain("executionCtx.waitUntil(hydration)");

  expect(canonicalSource).not.toContain("elizaSandboxService");
  expect(canonicalSource).not.toContain('import("../eliza-sandbox")');
  expect(canonicalSource).toContain("agent: SharedRuntimeAgent;");
});
