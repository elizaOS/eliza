/**
 * Verifies Worker dispatch uses the conversation coordinator exclusively.
 *
 * The fake namespace exercises the real request envelopes while the direct
 * sandbox service is a tripwire: any fallback would represent a DB-path leak.
 */

import { describe, expect, mock, test } from "bun:test";

const directBridge = mock(() => {
  throw new Error("direct bridge must not run");
});
const directStream = mock(() => {
  throw new Error("direct stream must not run");
});
const directHistory = mock(() => {
  throw new Error("direct history must not run");
});

mock.module("../eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge: directBridge,
    bridgeResolved: directBridge,
    bridgeStream: directStream,
    bridgeStreamResolved: directStream,
    getSharedConversationHistory: directHistory,
  },
}));

const {
  coordinateSharedBridge,
  coordinateSharedConversationPrewarm,
  coordinateSharedHistory,
  coordinateSharedStream,
  purgeSharedConversationRooms,
} = await import("./conversation-coordinator");

describe("shared conversation coordinator", () => {
  test("routes bridge, stream, prewarm, and history through one room object", async () => {
    const names: string[] = [];
    const envelopes: unknown[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            signals.push(init?.signal);
            const envelope = JSON.parse(String(init?.body));
            envelopes.push(envelope);
            if (envelope.operation === "stream") {
              return new Response("event: done\ndata: {}\n\n", {
                headers: { "Content-Type": "text/event-stream" },
              });
            }
            if (envelope.operation === "history") {
              return Response.json({
                history: [{ role: "assistant", content: "cached" }],
              });
            }
            if (envelope.operation === "prewarm") {
              return Response.json({ success: true });
            }
            return Response.json({
              jsonrpc: "2.0",
              id: envelope.rpc.id,
              result: { text: "coordinated" },
            });
          },
        };
      },
    };
    const agent = {
      id: "agent-1",
      organization_id: "org-1",
      user_id: "user-1",
      execution_tier: "shared",
    } as never;
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "hi", roomId: "room-1" },
    };
    const executionCtx = { waitUntil() {} };
    const abortController = new AbortController();

    expect(
      (await coordinateSharedBridge(agent, rpc, { namespace, executionCtx })).result?.text,
    ).toBe("coordinated");
    expect(
      await (
        await coordinateSharedStream(agent, rpc, {
          abortSignal: abortController.signal,
          namespace,
          executionCtx,
        })
      )?.text(),
    ).toContain("event: done");
    await coordinateSharedConversationPrewarm("agent-1", "room-1", { namespace });
    expect(await coordinateSharedHistory("agent-1", "room-1", { namespace })).toEqual([
      { role: "assistant", content: "cached" },
    ]);

    expect(names).toEqual(["agent-1:room-1", "agent-1:room-1", "agent-1:room-1", "agent-1:room-1"]);
    expect(envelopes.map((value) => (value as { operation: string }).operation)).toEqual([
      "bridge",
      "stream",
      "prewarm",
      "history",
    ]);
    expect(signals).toEqual([undefined, abortController.signal, undefined, undefined]);
    expect(directBridge).not.toHaveBeenCalled();
    expect(directStream).not.toHaveBeenCalled();
    expect(directHistory).not.toHaveBeenCalled();
  });

  test("preserves cache warming as a retryable coordinator error", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json(
            { error: "Conversation cache is warming. Retry shortly." },
            { status: 503 },
          ),
      }),
    };
    const agent = {
      id: "agent-1",
      organization_id: "org-1",
      user_id: "user-1",
      execution_tier: "shared",
    } as never;
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "hi", roomId: "room-1" },
    };
    const executionCtx = { waitUntil() {} };

    await expect(
      coordinateSharedBridge(agent, rpc, { namespace, executionCtx }),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
      message: "Conversation cache is warming. Retry shortly.",
    });
    await expect(
      coordinateSharedStream(agent, rpc, { namespace, executionCtx }),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    await expect(
      coordinateSharedConversationPrewarm("agent-1", "room-1", {
        namespace,
      }),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
  });

  test("rehydrates exact rate denial across the Durable Object boundary", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () =>
          Response.json(
            {
              error: "Organization rate limit exceeded.",
              code: "rate_limit_exceeded",
            },
            { status: 429, headers: { "Retry-After": "19" } },
          ),
      }),
    };
    const agent = {
      id: "agent-1",
      organization_id: "org-1",
      user_id: "user-1",
      execution_tier: "shared",
    } as never;
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "hi", roomId: "room-1" },
    };
    const executionCtx = { waitUntil() {} };

    await expect(
      coordinateSharedBridge(agent, rpc, { namespace, executionCtx }),
    ).rejects.toMatchObject({
      name: "RateLimitError",
      message: "Organization rate limit exceeded.",
      retryAfter: 19,
    });
    await expect(
      coordinateSharedStream(agent, rpc, { namespace, executionCtx }),
    ).rejects.toMatchObject({
      name: "RateLimitError",
      retryAfter: 19,
    });
  });

  test("missing namespace or execution context fails closed without the legacy service", async () => {
    const agent = {
      id: "agent-1",
      organization_id: "org-1",
      user_id: "user-1",
      execution_tier: "shared",
    } as never;
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "hi", roomId: "room-1" },
    };
    const namespace = {
      getByName: () => ({
        fetch: async () => {
          throw new Error("coordinator must not run");
        },
      }),
    };

    await expect(
      coordinateSharedBridge(agent, rpc, {
        namespace: undefined,
        executionCtx: { waitUntil() {} },
      } as never),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    await expect(
      coordinateSharedStream(agent, rpc, {
        namespace,
        executionCtx: undefined,
      } as never),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    await expect(
      coordinateSharedHistory("agent-1", "room-1", {
        namespace: undefined,
      } as never),
    ).rejects.toMatchObject({
      name: "SharedRuntimeCacheWarmingError",
    });
    expect(directBridge).not.toHaveBeenCalled();
    expect(directStream).not.toHaveBeenCalled();
    expect(directHistory).not.toHaveBeenCalled();
  });

  test("purge dispatches one delete envelope per room using the turn naming", async () => {
    const names: string[] = [];
    const envelopes: unknown[] = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            envelopes.push(JSON.parse(String(init?.body)));
            return Response.json({ success: true });
          },
        };
      },
    };

    const result = await purgeSharedConversationRooms("agent-1", ["room-1", "room-2"], {
      namespace,
    });

    expect(result).toEqual({ purged: 2, failures: 0 });
    expect(names).toEqual(["agent-1:room-1", "agent-1:room-2"]);
    expect(envelopes).toEqual([
      { operation: "delete", agentId: "agent-1" },
      { operation: "delete", agentId: "agent-1" },
    ]);
  });

  test("purge continues past a failed room and never throws", async () => {
    const names: string[] = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async () => {
            if (name.endsWith(":room-throws")) {
              throw new Error("stub fetch exploded");
            }
            if (name.endsWith(":room-500")) {
              return Response.json({ success: false }, { status: 500 });
            }
            return Response.json({ success: true });
          },
        };
      },
    };

    const result = await purgeSharedConversationRooms(
      "agent-1",
      ["room-throws", "room-500", "room-ok"],
      { namespace },
    );

    expect(result).toEqual({ purged: 1, failures: 2 });
    expect(names).toEqual(["agent-1:room-throws", "agent-1:room-500", "agent-1:room-ok"]);
  });
});
