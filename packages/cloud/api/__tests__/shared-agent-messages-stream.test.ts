/**
 * Exercises shared-agent SSE routing across HTTP, Worker Durable Object, and
 * in-process realtime voice callers. The voice cases tripwire legacy bridge and
 * repository access while preserving streaming, CORS, and error contracts.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { Hono } from "hono";
import * as realAgentSandboxes from "@/db/repositories/agent-sandboxes";
import { InsufficientCreditsError } from "@/lib/api/errors";
import { CacheKeys } from "@/lib/cache/keys";
// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global, so a blanket `mock.restore()` here would strand sibling test
// files that import the full eliza-sandbox / resolve-shared-agent surface.
import * as realElizaSandbox from "@/lib/services/eliza-sandbox";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();
const bridgeStream = mock(() => {
  throw new Error("legacy bridgeStream must not run");
});
const coordinatorFetch =
  mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const findByIdAndOrg = mock();

mock.module("@/db/repositories/agent-sandboxes", () => ({
  ...realAgentSandboxes,
  agentSandboxesRepository: {
    ...realAgentSandboxes.agentSandboxesRepository,
    findByIdAndOrg,
  },
}));

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...realElizaSandbox,
  elizaSandboxService: {
    ...realElizaSandbox.elizaSandboxService,
    bridgeStream,
  },
}));

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

// Imported after the mocks so the route binds to our stubs.
const { cache } = await import("@/lib/cache/client");
const streamRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route"
  )
).default;
const {
  createInternalElizaConversationFetch,
  createInternalElizaConversationFetchFactory,
} = await import("../v1/voice/session/lib/internal-eliza-conversation-fetch");
const { hasDbCacheContext } = await import("@/db/client");
const { getCloudAwareEnv, hasCloudBindingsContext, runWithCloudBindingsAsync } =
  await import("@/lib/runtime/cloud-bindings");

// Restore the real modules so this file's process-global mocks don't strand later
// test files that use the full elizaSandboxService / resolveSharedAgent surface.
afterAll(() => {
  mock.module("@/db/repositories/agent-sandboxes", () => realAgentSandboxes);
  mock.module("@/lib/services/eliza-sandbox", () => realElizaSandbox);
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const VOICE_USER = "user-voice";
const VOICE_CONVERSATION = "conv-voice-service";
const voiceServiceApp = new Hono();
voiceServiceApp.route(
  "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream",
  streamRoute,
);

// The route is a sub-app whose handlers are registered at "/" (the generated
// router mounts it at its full path; agentId/conversationId are injected by the
// parent mount). With resolveSharedAgent mocked, the route reads agentId/orgId
// from the resolver result and conversationId falls back to r.agentId, so the
// standalone app can be driven at "/" without those params.
function postStream(body: unknown, origin?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return streamRoute.request(
    "/",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    {
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName: () => ({ fetch: coordinatorFetch }),
      },
    } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

function postWorkerStream(body: unknown, namespace: object) {
  return streamRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer user-api-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { SHARED_RUNTIME_CONVERSATIONS: namespace } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

function postVoiceServiceStream(body: unknown) {
  return requestVoiceServiceRoute({
    method: "POST",
    headers: {
      Authorization: "Bearer voice-service",
      "Content-Type": "application/json",
      "X-Eliza-Agent-Id": AGENT,
      "X-Eliza-Conversation-Id": VOICE_CONVERSATION,
      "X-Eliza-Organization-Id": ORG,
      "X-Eliza-User-Id": "user-voice",
    },
    body: JSON.stringify(body),
  });
}

function requestVoiceServiceRoute(init: RequestInit) {
  return voiceServiceApp.request(
    `/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
    init,
    {
      CACHE_ENABLED: "true",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName: () => ({ fetch: coordinatorFetch }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    },
  );
}

describe("shared agent messages/stream", () => {
  beforeEach(async () => {
    resolveSharedAgent.mockReset();
    bridgeStream.mockReset();
    bridgeStream.mockImplementation(() => {
      throw new Error("legacy bridgeStream must not run");
    });
    coordinatorFetch.mockReset();
    findByIdAndOrg.mockReset();
    await cache.del(CacheKeys.sharedAgentScope.voice(ORG, VOICE_USER, AGENT));
    resolveSharedAgent.mockResolvedValue({
      agent: {
        id: AGENT,
        organization_id: ORG,
        execution_tier: "shared",
      },
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
  });

  function cachedVoiceAgent() {
    return {
      id: AGENT,
      organization_id: ORG,
      user_id: VOICE_USER,
      execution_tier: "shared",
      agent_name: "Voice Agent",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:00:00.000Z",
      deleted_at: null,
      claimed_at: null,
      pool_ready_at: null,
      last_backup_at: null,
      last_heartbeat_at: null,
      last_billed_at: null,
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    };
  }

  async function seedVoiceScope() {
    await cache.set(
      CacheKeys.sharedAgentScope.voice(ORG, VOICE_USER, AGENT),
      cachedVoiceAgent(),
      60,
    );
  }

  function voiceRequest(text: string) {
    return {
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Agent-Id": AGENT,
        "X-Eliza-Conversation-Id": VOICE_CONVERSATION,
        "X-Eliza-Organization-Id": ORG,
        "X-Eliza-User-Id": VOICE_USER,
      },
      body: JSON.stringify({ text }),
    } satisfies RequestInit;
  }

  function voiceWorkerRuntime(sseText = "adapter ok") {
    const fetch = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          `event: chunk\ndata: ${JSON.stringify({ chunk: sseText })}\n\nevent: done\ndata: {}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const namespace = {
      getByName: mock(() => ({ fetch })),
    };
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    };
    return { background, executionCtx, fetch, namespace };
  }

  test("forwards message.send only through the conversation coordinator", async () => {
    coordinatorFetch.mockResolvedValue(
      new Response(
        'event: chunk\ndata: {"text":"hi"}\n\nevent: done\ndata: {"text":"hi"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const res = await postStream({ text: "say hi" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(res.text()).resolves.toContain("event: done");

    const envelope = JSON.parse(
      String(coordinatorFetch.mock.calls[0]?.[1]?.body),
    ) as {
      operation: string;
      rpc: { method: string; params: Record<string, unknown> };
    };
    expect(envelope.operation).toBe("stream");
    expect(envelope.rpc.method).toBe("message.send");
    expect(envelope.rpc.params).toMatchObject({
      text: "say hi",
      roomId: AGENT,
    });
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("Worker production path uses the conversation Durable Object without the legacy bridge", async () => {
    const fetch = mock(
      async () =>
        new Response(
          'event: chunk\ndata: {"text":"cached"}\n\nevent: done\ndata: {"text":"cached"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const namespace = {
      getByName: mock(() => ({ fetch })),
    };

    const res = await postWorkerStream({ text: "say hi" }, namespace);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('"cached"');
    expect(resolveSharedAgent.mock.calls[0]?.[1]).toMatchObject({
      cacheOnly: true,
    });
    expect(namespace.getByName).toHaveBeenCalledWith(`${AGENT}:${AGENT}`);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("missing Durable Object binding fails closed before auth or repository work", async () => {
    const res = await streamRoute.request(
      "/",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer user-api-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "must not dispatch" }),
      },
      {} as never,
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      } as never,
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "shared_runtime_context_unavailable",
      retryable: true,
    });
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(coordinatorFetch).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("voice service credential uses cached identity and the requested conversation", async () => {
    await seedVoiceScope();
    coordinatorFetch.mockResolvedValue(
      new Response('event: chunk\ndata: {"chunk":"voice ok"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postVoiceServiceStream({ text: "voice transcript" });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("voice ok");
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    const envelope = JSON.parse(
      String(coordinatorFetch.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      operation: "stream",
      rpc: {
        jsonrpc: "2.0",
        method: "message.send",
        params: {
          text: "voice transcript",
          roomId: "conv-voice-service",
          userId: "user-voice",
          source: "voice",
        },
      },
    });
  });

  test("internal voice fetch adapter dispatches cached scope through the conversation Durable Object", async () => {
    await seedVoiceScope();
    const runtime = voiceWorkerRuntime();

    const fetchImpl = createInternalElizaConversationFetch(
      {
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
        SHARED_RUNTIME_CONVERSATIONS: runtime.namespace,
      } as unknown as Parameters<
        typeof createInternalElizaConversationFetch
      >[0],
      {
        agentId: AGENT,
        conversationId: VOICE_CONVERSATION,
        organizationId: ORG,
        userId: VOICE_USER,
      },
      runtime.executionCtx,
    );

    const res = await fetchImpl(
      `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
      voiceRequest("adapter transcript"),
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("adapter ok");
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(runtime.namespace.getByName).toHaveBeenCalledWith(
      `${AGENT}:${VOICE_CONVERSATION}`,
    );
    const operation = JSON.parse(
      String(runtime.fetch.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(operation).toMatchObject({
      operation: "stream",
      agent: cachedVoiceAgent(),
      rpc: {
        method: "message.send",
        params: {
          text: "adapter transcript",
          roomId: VOICE_CONVERSATION,
          userId: VOICE_USER,
          source: "voice",
        },
      },
    });
  });

  test("late voice callback restores captured Worker bindings without creating a DB context", async () => {
    await seedVoiceScope();
    const runtime = voiceWorkerRuntime("late callback ok");
    const env = {
      CACHE_ENABLED: "true",
      DATABASE_URL: "postgresql://captured.example/eliza",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      SHARED_RUNTIME_CONVERSATIONS: runtime.namespace,
    } as unknown as Parameters<
      typeof createInternalElizaConversationFetchFactory
    >[0];
    let createLateFetch!: ReturnType<
      typeof createInternalElizaConversationFetchFactory
    >;

    await runWithCloudBindingsAsync(env, async () => {
      expect(hasCloudBindingsContext()).toBe(true);
      expect(hasDbCacheContext()).toBe(false);
      createLateFetch = createInternalElizaConversationFetchFactory(
        env,
        runtime.executionCtx,
      );
    });

    // Route setup has returned. This models the later WebSocket message event,
    // whose async chain no longer owns the upgrade request's ALS stores.
    expect(hasCloudBindingsContext()).toBe(false);
    expect(hasDbCacheContext()).toBe(false);

    runtime.fetch.mockImplementation(async () => {
      expect(hasCloudBindingsContext()).toBe(true);
      expect(hasDbCacheContext()).toBe(false);
      expect(getCloudAwareEnv().DATABASE_URL).toBe(env.DATABASE_URL);
      return new Response(
        'event: chunk\ndata: {"chunk":"late callback ok"}\n\nevent: done\ndata: {}\n\n',
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });

    const fetchImpl = createLateFetch({
      agentId: AGENT,
      conversationId: VOICE_CONVERSATION,
      organizationId: ORG,
      userId: VOICE_USER,
    });
    await fetchImpl.prewarm();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();

    const res = await fetchImpl(
      `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
      voiceRequest("late callback transcript"),
    );

    expect(res.status).toBe(200);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
  });

  test("cache miss returns warming without joining in-flight DB hydration", async () => {
    const runtime = voiceWorkerRuntime("hydrated ok");
    const env = {
      CACHE_ENABLED: "true",
      DATABASE_URL: "postgresql://captured.example/eliza",
      VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      SHARED_RUNTIME_CONVERSATIONS: runtime.namespace,
    } as unknown as Parameters<
      typeof createInternalElizaConversationFetchFactory
    >[0];

    let releaseHydration!: (agent: ReturnType<typeof cachedVoiceAgent>) => void;
    let markHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      markHydrationStarted = resolve;
    });
    findByIdAndOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHydration = resolve;
          markHydrationStarted();
        }),
    );

    const fetchImpl = createInternalElizaConversationFetchFactory(
      env,
      runtime.executionCtx,
    )({
      agentId: AGENT,
      conversationId: VOICE_CONVERSATION,
      organizationId: ORG,
      userId: VOICE_USER,
    });
    await fetchImpl.prewarm();
    expect(runtime.background).toHaveLength(1);
    await hydrationStarted;

    const res = await fetchImpl(
      `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
      voiceRequest("warming transcript"),
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "agent_cache_warming",
      retryable: true,
    });
    expect(findByIdAndOrg).toHaveBeenCalledTimes(1);
    expect(runtime.fetch).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();

    releaseHydration(cachedVoiceAgent());
    await runtime.background[0];

    const retry = await fetchImpl(
      `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
      voiceRequest("hydrated transcript"),
    );
    expect(retry.status).toBe(200);
    await expect(retry.text()).resolves.toContain("hydrated ok");
    expect(findByIdAndOrg).toHaveBeenCalledTimes(1);
    expect(runtime.fetch).toHaveBeenCalledTimes(1);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("internal voice fetch adapter rejects mismatched verified scope before persistence", async () => {
    findByIdAndOrg.mockResolvedValue({
      id: AGENT,
      organization_id: ORG,
      user_id: "user-voice",
      agent_name: "Voice Agent",
    });

    const fetchImpl = createInternalElizaConversationFetch(
      {
        CACHE_ENABLED: "true",
        VOICE_REALTIME_ELIZA_AUTHORIZATION: "Bearer voice-service",
      } as Parameters<typeof createInternalElizaConversationFetch>[0],
      {
        agentId: AGENT,
        conversationId: VOICE_CONVERSATION,
        organizationId: ORG,
        userId: "user-voice",
      },
    );

    const res = await fetchImpl(
      `https://api-staging.elizacloud.ai/api/v1/eliza/agents/${AGENT}/api/conversations/${VOICE_CONVERSATION}/messages/stream`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer voice-service",
          "Content-Type": "application/json",
          "X-Service-Key": "Bearer voice-service",
          "X-Eliza-Agent-Id": AGENT,
          "X-Eliza-Conversation-Id": VOICE_CONVERSATION,
          "X-Eliza-Organization-Id": ORG,
          "X-Eliza-User-Id": "different-user",
        },
        body: JSON.stringify({ text: "do not persist" }),
      },
    );

    expect(res.status).toBe(404);
    expect(bridgeStream).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Agent not found",
      code: "agent_not_found",
    });
  });

  test("voice service credential rejects missing structural voice identity", async () => {
    findByIdAndOrg.mockResolvedValue({
      id: AGENT,
      organization_id: ORG,
      user_id: "user-voice",
      agent_name: "Voice Agent",
    });

    const res = await requestVoiceServiceRoute({
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Organization-Id": ORG,
        "X-Eliza-User-Id": "user-voice",
      },
      body: JSON.stringify({ text: "do not persist" }),
    });

    expect(res.status).toBe(404);
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("voice service credential rejects mismatched conversation identity", async () => {
    findByIdAndOrg.mockResolvedValue({
      id: AGENT,
      organization_id: ORG,
      user_id: "user-voice",
      agent_name: "Voice Agent",
    });

    const res = await requestVoiceServiceRoute({
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Agent-Id": AGENT,
        "X-Eliza-Conversation-Id": "wrong-conversation",
        "X-Eliza-Organization-Id": ORG,
        "X-Eliza-User-Id": "user-voice",
      },
      body: JSON.stringify({ text: "do not persist" }),
    });

    expect(res.status).toBe(404);
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("voice service credential rejects mismatched agent identity", async () => {
    findByIdAndOrg.mockResolvedValue({
      id: AGENT,
      organization_id: ORG,
      user_id: "user-voice",
      agent_name: "Voice Agent",
    });

    const res = await requestVoiceServiceRoute({
      method: "POST",
      headers: {
        Authorization: "Bearer voice-service",
        "Content-Type": "application/json",
        "X-Eliza-Agent-Id": "wrong-agent",
        "X-Eliza-Conversation-Id": VOICE_CONVERSATION,
        "X-Eliza-Organization-Id": ORG,
        "X-Eliza-User-Id": "user-voice",
      },
      body: JSON.stringify({ text: "do not persist" }),
    });

    expect(res.status).toBe(404);
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("voice service credential rejects an agent outside the scoped user or org before persistence", async () => {
    await cache.set(
      CacheKeys.sharedAgentScope.voice(ORG, VOICE_USER, AGENT),
      {
        ...cachedVoiceAgent(),
        user_id: "different-user",
        agent_name: "Wrong Agent",
      },
      60,
    );

    const res = await postVoiceServiceStream({ text: "do not persist" });

    expect(res.status).toBe(404);
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(coordinatorFetch).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      success: false,
      error: "Agent not found",
    });
  });

  test("forwards a multi-chunk body incrementally — the route never awaits/buffers res.body", async () => {
    // Prove the route's pass-through contract: it returns `upstream.body` as-is
    // and never reads it to completion. A dedicated-agent reply is a live
    // token-by-token upstream SSE socket; here we model that with a
    // ReadableStream we feed by hand and never close, then assert the route
    // surfaces frame #1 to the reader BEFORE frame #2 is enqueued. If the route
    // buffered (awaited res.text()/arrayBuffer()), this read would hang.
    let enqueue!: (s: string) => void;
    let closeStream!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        enqueue = (s) => controller.enqueue(enc.encode(s));
        closeStream = () => controller.close();
      },
    });
    coordinatorFetch.mockResolvedValue(
      new Response(upstreamBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postStream({ text: "stream please" });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();

    enqueue('event: chunk\ndata: {"text":"to"}\n\n');
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(dec.decode(first.value)).toContain('"to"');

    // Only now produce the second frame. Reading it proves frame #1 reached the
    // client before frame #2 existed — i.e. true incremental forwarding.
    enqueue('event: chunk\ndata: {"text":"ken"}\n\n');
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(dec.decode(second.value)).toContain('"ken"');

    closeStream();
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  test("reflects the app WebView origin + credentials for a credentialed SSE read", async () => {
    coordinatorFetch.mockResolvedValue(
      new Response('event: done\ndata: {"text":"ok"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postStream({ text: "hi" }, "https://localhost");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("exposes pre-header phase timing on successful streams", async () => {
    coordinatorFetch.mockResolvedValue(
      new Response('event: done\ndata: {"text":"ok"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postStream({ text: "timed" }, "https://localhost");

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "Server-Timing",
    );
    expect(res.headers.get("server-timing")).toContain("scope;dur=");
    expect(res.headers.get("server-timing")).toContain("body;dur=");
    expect(res.headers.get("server-timing")).toContain("bridge;dur=");
    expect(res.headers.get("x-eliza-stream-scope-ms")).not.toBeNull();
    expect(res.headers.get("x-eliza-stream-bridge-ms")).not.toBeNull();
  });

  test("empty text → 400 (not a stream)", async () => {
    const res = await postStream({ text: "  " });
    expect(res.status).toBe(400);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("no stream body → SSE error frame (200), never a 404", async () => {
    coordinatorFetch.mockResolvedValue(new Response(null));
    const res = await postStream({ text: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(res.text()).resolves.toContain("event: error");
  });

  // Insufficient credits is rejected before any SSE bytes exist (bridgeStream's
  // shared branch throws the typed 402), so the route answers with the same
  // canonical 402 JSON as the non-stream send — not an error frame buried in a
  // 200 stream the app would read as a transient turn failure.
  test("insufficient credits → non-retryable 402 JSON, not an SSE frame", async () => {
    coordinatorFetch.mockRejectedValue(
      new InsufficientCreditsError(
        "Insufficient credits. Required: $0.0500, Available: $0.0000",
      ),
    );

    const res = await postStream({ text: "hi" }, "https://localhost");

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("server-timing")).toContain("bridge;dur=");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      code: "insufficient_credits",
      retryable: false,
    });
  });

  test("auth/tier failure surfaces the resolver error status", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Not a shared-runtime agent",
      status: 404,
    });
    const res = await postStream({ text: "hi" });
    expect(res.status).toBe(404);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("scope warming is explicitly retryable and never reaches the coordinator", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Agent authorization cache is warming. Retry shortly.",
      code: "agent_cache_warming",
      status: 503,
    });

    const res = await postStream({ text: "must not dispatch" });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Agent authorization cache is warming. Retry shortly.",
      code: "agent_cache_warming",
      retryable: true,
    });
    expect(coordinatorFetch).not.toHaveBeenCalled();
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("OPTIONS preflight returns 204 with app-origin CORS", async () => {
    const res = await streamRoute.request("/", {
      method: "OPTIONS",
      headers: { Origin: "https://localhost" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
