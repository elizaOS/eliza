/**
 * Verifies the anonymous admission client keeps authoritative hydration and
 * counter persistence in `waitUntil` while warm identity reads stay DB-free.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { AnonymousChatGate } from "../src/anonymous-chat-gate";

const getGateHydrationByToken = mock(async () => ({
  sessionId: "session-a",
  userId: "user-a",
  messageCount: 0,
  messagesLimit: 10,
  hourlyMessageCount: 0,
  hourlyResetAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  gateRevision: 0,
}));
const persistGateCounterSnapshot = mock(async () => true);

mock.module("@/db/repositories/anonymous-sessions", () => ({
  anonymousSessionsRepository: {
    getGateHydrationByToken,
    persistGateCounterSnapshot,
  },
}));
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser: mock(async () => false),
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock() },
}));

const {
  commitAnonymousChatSlot,
  markAnonymousChatSlotDispatched,
  refundAnonymousChatSlot,
  reserveAnonymousChatSlot,
  resolveAnonymousChatContext,
} = await import("@/lib/services/anonymous-chat-admission");

class TestStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async transaction<T>(
    closure: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      setAlarm(scheduledTime: number): Promise<void>;
      deleteAlarm(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const stagedValues = new Map(this.values);
    let stagedAlarm = this.alarm;
    const result = await closure({
      put: async (key, value) => {
        stagedValues.set(key, structuredClone(value));
      },
      setAlarm: async (scheduledTime) => {
        stagedAlarm = scheduledTime;
      },
      deleteAlarm: async () => {
        stagedAlarm = undefined;
      },
    });
    this.values.clear();
    for (const [key, value] of stagedValues) {
      this.values.set(key, value);
    }
    this.alarm = stagedAlarm;
    return result;
  }
}

function createBindings(
  gate: AnonymousChatGate,
  intercept?: (request: Request) => Promise<Response>,
) {
  return {
    ANONYMOUS_CHAT_GATES: {
      getByName(name: string) {
        expect(name).not.toContain("secret-session-token");
        return {
          fetch: (request: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(request, init);
            return intercept ? intercept(incoming) : gate.fetch(incoming);
          },
        };
      },
    },
  };
}

async function hydrateDirectly(gate: AnonymousChatGate): Promise<void> {
  const response = await gate.fetch(
    new Request("https://anonymous-chat-gate/hydrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-a",
        userId: "user-a",
        messageCount: 0,
        messagesLimit: 10,
        hourlyMessageCount: 0,
        hourlyResetAtMs: null,
        hourlyLimit: 10,
        expiresAtMs: Date.now() + 86_400_000,
        revision: 0,
        blocked: false,
      }),
    }),
  );
  expect(response.status).toBe(200);
}

beforeEach(() => {
  getGateHydrationByToken.mockClear();
  persistGateCounterSnapshot.mockClear();
});

describe("anonymous chat admission client", () => {
  test("hydrates cold state off-path, then leases and mirrors counters off-path", async () => {
    const gate = new AnonymousChatGate(
      { storage: new TestStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    const waitUntilTasks: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
    };
    const request = new Request("https://api.test/api/v1/chat", {
      headers: {
        cookie: "eliza-anon-session=secret-session-token",
      },
    });

    await runWithCloudBindingsAsync(createBindings(gate), async () => {
      expect(await resolveAnonymousChatContext(request, executionCtx)).toEqual({
        kind: "warming",
      });
      expect(waitUntilTasks).toHaveLength(1);
      await Promise.all(waitUntilTasks.splice(0));

      const warm = await resolveAnonymousChatContext(request, executionCtx);
      expect(warm).toMatchObject({
        kind: "ready",
        blocked: false,
        credential: {
          context: {
            sessionId: "session-a",
            userId: "user-a",
            messageCount: 0,
          },
        },
      });
      expect(getGateHydrationByToken).toHaveBeenCalledTimes(1);

      if (warm.kind !== "ready") throw new Error("expected warm context");
      const lease = await reserveAnonymousChatSlot(
        warm.credential,
        "request-a",
        executionCtx,
      );
      expect(lease).toMatchObject({
        kind: "admitted",
        remaining: 9,
        limit: 10,
      });
      expect(waitUntilTasks).toHaveLength(1);
      await Promise.all(waitUntilTasks.splice(0));
      expect(persistGateCounterSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          revision: 1,
          messageCount: 1,
        }),
      );

      if (lease.kind !== "admitted") throw new Error("expected lease");
      await markAnonymousChatSlotDispatched(lease.lease);
      await refundAnonymousChatSlot(lease.lease, executionCtx);
      await refundAnonymousChatSlot(lease.lease, executionCtx);
      await Promise.all(waitUntilTasks.splice(0));
      expect(persistGateCounterSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          revision: 2,
          messageCount: 0,
        }),
      );
    });
  });

  test("replays lost acknowledgements without duplicating quota or terminal state", async () => {
    const gate = new AnonymousChatGate(
      { storage: new TestStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    await hydrateDirectly(gate);
    const loseFirstResponse = new Set([
      "/context",
      "/lease",
      "/dispatch",
      "/refund",
      "/commit",
    ]);
    const attempts = new Map<string, number>();
    const bindings = createBindings(gate, async (request) => {
      const path = new URL(request.url).pathname;
      attempts.set(path, (attempts.get(path) ?? 0) + 1);
      const response = await gate.fetch(request);
      if (loseFirstResponse.delete(path)) {
        throw new Error(`lost ${path} acknowledgement`);
      }
      return response;
    });
    const background: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil(promise: Promise<unknown>) {
        background.push(promise);
      },
    };
    const request = new Request("https://api.test/api/v1/chat", {
      headers: { cookie: "eliza-anon-session=secret-session-token" },
    });

    await runWithCloudBindingsAsync(bindings, async () => {
      const resolution = await resolveAnonymousChatContext(
        request,
        executionCtx,
      );
      if (resolution.kind !== "ready") {
        throw new Error("expected warm anonymous context");
      }

      const first = await reserveAnonymousChatSlot(
        resolution.credential,
        "request-lost-refund",
        executionCtx,
      );
      if (first.kind !== "admitted") {
        throw new Error("expected first lease");
      }
      await markAnonymousChatSlotDispatched(first.lease);
      await refundAnonymousChatSlot(first.lease, executionCtx);

      const second = await reserveAnonymousChatSlot(
        resolution.credential,
        "request-lost-commit",
        executionCtx,
      );
      if (second.kind !== "admitted") {
        throw new Error("expected second lease");
      }
      await markAnonymousChatSlotDispatched(second.lease);
      await commitAnonymousChatSlot(second.lease);
      await Promise.all(background.splice(0));
    });

    expect(Object.fromEntries(attempts)).toEqual({
      "/context": 2,
      "/lease": 3,
      "/dispatch": 3,
      "/refund": 2,
      "/commit": 2,
    });
    const context = await gate.fetch(
      new Request("https://anonymous-chat-gate/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(await context.json()).toMatchObject({
      context: { messageCount: 1 },
    });
    expect(persistGateCounterSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        revision: 3,
        messageCount: 1,
      }),
    );
  });

  test("bounds stalled context reads and fails closed after two attempts", async () => {
    let attempts = 0;
    let aborts = 0;
    const bindings = {
      ANONYMOUS_CHAT_GATES: {
        getByName: (_name: string) => ({
          fetch: (_request: RequestInfo | URL, init?: RequestInit) => {
            attempts++;
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborts++;
                  reject(init.signal?.reason);
                },
                { once: true },
              );
            });
          },
        }),
      },
    };
    const startedAt = performance.now();
    const resolution = await runWithCloudBindingsAsync(bindings, () =>
      resolveAnonymousChatContext(
        new Request("https://api.test/api/v1/chat", {
          headers: { cookie: "eliza-anon-session=secret-session-token" },
        }),
        { waitUntil() {} },
      ),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(resolution).toEqual({ kind: "unavailable" });
    expect(attempts).toBe(2);
    expect(aborts).toBe(2);
    expect(elapsedMs).toBeLessThan(2_500);
  });

  test("preserves only matching positive hourly retry advice", async () => {
    const gate = new AnonymousChatGate(
      { storage: new TestStorage() } as unknown as DurableObjectState,
      {} as never,
    );
    const credential = {
      sessionToken: "secret-session-token",
      context: {
        sessionId: "session-a",
        userId: "user-a",
        messageCount: 10,
        messagesLimit: 20,
      },
    };
    const executionCtx = { waitUntil() {} };
    const reserveWith = (response: Response) =>
      runWithCloudBindingsAsync(
        createBindings(gate, async () => response),
        () =>
          reserveAnonymousChatSlot(
            credential,
            "request-hourly-limited",
            executionCtx,
          ),
      );

    await expect(
      reserveWith(
        Response.json(
          {
            admitted: false,
            reason: "hourly_limit",
            remaining: 0,
            limit: 10,
            retryAfter: 17,
          },
          { status: 429, headers: { "Retry-After": "17" } },
        ),
      ),
    ).resolves.toEqual({
      kind: "limited",
      reason: "hourly_limit",
      remaining: 0,
      limit: 10,
      retryAfter: 17,
    });

    for (const [bodyRetryAfter, headerRetryAfter] of [
      [17, "18"],
      [0, "0"],
      [1.5, "1.5"],
      [17, "017"],
    ] as const) {
      await expect(
        reserveWith(
          Response.json(
            {
              admitted: false,
              reason: "hourly_limit",
              remaining: 0,
              limit: 10,
              retryAfter: bodyRetryAfter,
            },
            { status: 429, headers: { "Retry-After": headerRetryAfter } },
          ),
        ),
      ).resolves.toEqual({ kind: "unavailable" });
    }

    for (const response of [
      Response.json(
        {
          admitted: false,
          reason: "hourly_limit",
          remaining: 0,
          limit: 10,
          retryAfter: 17,
        },
        { status: 429 },
      ),
      Response.json(
        {
          admitted: false,
          reason: "hourly_limit",
          remaining: 0,
          limit: 10,
        },
        { status: 429, headers: { "Retry-After": "17" } },
      ),
    ]) {
      await expect(reserveWith(response)).resolves.toEqual({
        kind: "unavailable",
      });
    }

    await expect(
      reserveWith(
        Response.json(
          {
            admitted: false,
            reason: "message_limit",
            remaining: 0,
            limit: 10,
          },
          { status: 429 },
        ),
      ),
    ).resolves.toEqual({
      kind: "limited",
      reason: "message_limit",
      remaining: 0,
      limit: 10,
    });
  });
});
