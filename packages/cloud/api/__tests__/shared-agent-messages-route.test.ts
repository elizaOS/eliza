// Exercises cloud API tests shared agent messages route.test behavior with deterministic Worker route fixtures.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { InsufficientCreditsError, RateLimitError } from "@/lib/api/errors";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";
import * as realSharedRestAdapter from "@/lib/services/shared-runtime/shared-rest-adapter";
import * as realLogger from "@/lib/utils/logger";

const resolveSharedAgent = mock();
const sharedRestMessageSend = mock();
const sharedRestMessagesGet = mock();
const loggerWarn = mock(() => undefined);

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  ...realSharedRestAdapter,
  sharedRestMessageSend,
  sharedRestMessagesGet,
}));

mock.module("@/lib/utils/logger", () => ({
  ...realLogger,
  logger: {
    ...realLogger.logger,
    warn: loggerWarn,
  },
}));

const messagesRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
  )
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
  mock.module(
    "@/lib/services/shared-runtime/shared-rest-adapter",
    () => realSharedRestAdapter,
  );
  mock.module("@/lib/utils/logger", () => realLogger);
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const APP_ORIGIN = "https://localhost";
const DEFAULT_AGENT = {
  id: AGENT,
  organization_id: ORG,
  execution_tier: "shared",
};
const DEFAULT_NAMESPACE = {
  getByName: mock(() => ({
    fetch: mock(async () => new Response()),
  })),
};

function postMessage(body: unknown, origin?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return messagesRoute.request(
    "/",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    { SHARED_RUNTIME_CONVERSATIONS: DEFAULT_NAMESPACE } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

function postMessageWithWorkerBindings(
  body: unknown,
  namespace: {
    getByName(name: string): {
      fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  },
) {
  return messagesRoute.request(
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

function getMessagesWithWorkerBindings(
  namespace: {
    getByName(name: string): {
      fetch(request: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    };
  } = DEFAULT_NAMESPACE,
) {
  return messagesRoute.request(
    "/",
    {
      headers: {
        Authorization: "Bearer user-api-key",
      },
    },
    { SHARED_RUNTIME_CONVERSATIONS: namespace } as never,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

describe("shared agent messages route", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    sharedRestMessageSend.mockReset();
    sharedRestMessagesGet.mockReset();
    loggerWarn.mockClear();
    resolveSharedAgent.mockResolvedValue({
      agent: DEFAULT_AGENT,
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
  });

  test("returns assistant text from the shared REST adapter", async () => {
    sharedRestMessageSend.mockResolvedValue({
      text: "hello",
      agentName: "Eliza",
    });

    const res = await postMessage({ text: "say hi" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      text: "hello",
      agentName: "Eliza",
    });
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      DEFAULT_AGENT,
      AGENT,
      "say hi",
      "Eliza",
      expect.objectContaining({ waitUntil: expect.any(Function) }),
      DEFAULT_NAMESPACE,
      undefined,
    );
  });

  test("passes the resolved agent and Durable Object namespace on the Worker path", async () => {
    const agent = {
      id: AGENT,
      organization_id: ORG,
      execution_tier: "shared",
    };
    const namespace = {
      getByName: mock(() => ({
        fetch: mock(async () => new Response()),
      })),
    };
    resolveSharedAgent.mockResolvedValueOnce({
      agent,
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
    sharedRestMessageSend.mockResolvedValue({
      text: "hello",
      agentName: "Eliza",
    });

    const res = await postMessageWithWorkerBindings(
      { text: "say hi" },
      namespace,
    );

    expect(res.status).toBe(200);
    expect(resolveSharedAgent.mock.calls[0]?.[1]).toMatchObject({
      cacheOnly: true,
    });
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      agent,
      AGENT,
      "say hi",
      "Eliza",
      expect.objectContaining({ waitUntil: expect.any(Function) }),
      namespace,
      undefined,
    );
  });

  test("missing Durable Object binding fails closed before auth or adapter work", async () => {
    const res = await messagesRoute.request(
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
    expect(res.headers.get("Retry-After")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      code: "shared_runtime_context_unavailable",
      retryable: true,
    });
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(sharedRestMessagesGet).not.toHaveBeenCalled();
  });

  test("returns a sanitized retryable 503 when shared runtime inference fails", async () => {
    sharedRestMessageSend.mockRejectedValue(
      new Error("provider secret detail: upstream 500"),
    );

    const res = await postMessage({ text: "hello" }, APP_ORIGIN);

    expect(res.status).toBe(503);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "The agent is temporarily unavailable. Please try again.",
      code: "inference_unavailable",
      retryable: true,
    });
    expect(loggerWarn).toHaveBeenCalledWith(
      "[shared-runtime REST] message.send failed",
      {
        agentId: AGENT,
        error: "provider secret detail: upstream 500",
      },
    );
  });

  test("preserves coordinator warming for history as an explicit retryable 503", async () => {
    const warming = new Error("Conversation cache is warming. Retry shortly.");
    warming.name = "SharedRuntimeCacheWarmingError";
    sharedRestMessagesGet.mockRejectedValue(warming);

    const res = await getMessagesWithWorkerBindings();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Conversation cache is warming. Retry shortly.",
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("preserves coordinator warming for sends before provider dispatch", async () => {
    const warming = new Error("Conversation cache is warming. Retry shortly.");
    warming.name = "SharedRuntimeCacheWarmingError";
    sharedRestMessageSend.mockRejectedValue(warming);

    const res = await postMessage({ text: "hello" });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Conversation cache is warming. Retry shortly.",
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
  });

  test("preserves coordinator rate denial as a retryable 429", async () => {
    sharedRestMessageSend.mockRejectedValue(
      new RateLimitError("Organization rate limit exceeded.", 37),
    );

    const res = await postMessage({ text: "hello" }, APP_ORIGIN);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("37");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Organization rate limit exceeded.",
      code: "rate_limit_exceeded",
      retryable: true,
    });
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  test("empty text returns 400 without calling the adapter", async () => {
    const res = await postMessage({ text: "  " });
    expect(res.status).toBe(400);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("forwards a validated clientMessageId to shared admission", async () => {
    sharedRestMessageSend.mockResolvedValue({
      text: "hello",
      agentName: "Eliza",
    });
    const res = await postMessage({
      text: "hello",
      clientMessageId: " turn-1 ",
    });
    expect(res.status).toBe(200);
    expect(sharedRestMessageSend.mock.calls[0]?.[6]).toBe("turn-1");
  });

  test("rejects invalid clientMessageId before shared admission", async () => {
    const res = await postMessage({ text: "hello", clientMessageId: " " });
    expect(res.status).toBe(400);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("returns terminal 409 for a shared idempotency conflict", async () => {
    const { ElizaError } = await import("@elizaos/core");
    sharedRestMessageSend.mockRejectedValue(
      new ElizaError("clientMessageId conflict", {
        code: "SHARED_RUNTIME_IDEMPOTENCY_CONFLICT",
      }),
    );
    const res = await postMessage({ text: "hello", clientMessageId: "turn-1" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "shared_runtime_idempotency_conflict",
      retryable: false,
    });
  });

  // The bug this pins: insufficient credits is a PERMANENT add-credits
  // condition (welcome-bonus-withheld signups, drained orgs), and the blanket
  // 503 above disguised it as a transient outage — "try again" forever. The
  // route must return the canonical 402 so the app can route to top-up.
  test("insufficient credits returns a non-retryable 402, not the retryable 503", async () => {
    sharedRestMessageSend.mockRejectedValue(
      new InsufficientCreditsError(
        "Insufficient credits. Required: $0.0500, Available: $0.0000",
      ),
    );

    const res = await postMessage({ text: "hello" }, APP_ORIGIN);

    expect(res.status).toBe(402);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      code: "insufficient_credits",
      retryable: false,
    });
  });
});
