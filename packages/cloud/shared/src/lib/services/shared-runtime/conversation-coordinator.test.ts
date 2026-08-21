/**
 * Verifies Worker dispatch uses the conversation coordinator exclusively.
 *
 * The fake namespace exercises the real request envelopes while the direct
 * sandbox service is a tripwire: any fallback would represent a DB-path leak.
 */

import { describe, expect, mock, test } from "bun:test";
import { ChannelType } from "@elizaos/core/edge";

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
  commitPersonalProvisionalHistoryConvergence,
  coordinateSharedBridge,
  coordinateSharedConversationPrewarm,
  coordinateSharedHistory,
  coordinateSharedLifecycleEvent,
  coordinateSharedStream,
  coordinatorFetch,
  preparePersonalProvisionalHistoryConvergence,
  purgeSharedConversationRooms,
} = await import("./conversation-coordinator");
const { normalizeSharedRuntimeRoom, sharedRuntimeChannelId, sharedRuntimeRoomKey } = await import(
  "./shared-runtime-chat"
);

describe("shared conversation coordinator", () => {
  test("uses one exact room normalization for coordinator and runtime identities", () => {
    expect(normalizeSharedRuntimeRoom("  room-1  ", "fallback-user")).toBe("room-1");
    expect(normalizeSharedRuntimeRoom(" ", "  fallback-user  ")).toBe("fallback-user");
    expect(normalizeSharedRuntimeRoom(undefined, " ")).toBe("default");
    expect(sharedRuntimeRoomKey("agent-1", "  room-1  ", "fallback-user")).toBe(
      sharedRuntimeChannelId("agent-1", "room-1"),
    );
  });

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
          traceId: "trace-coordinator-stream",
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
    expect(signals[1]).not.toBe(abortController.signal);
    // bridge / prewarm / history carry no caller signal, so they now fail
    // closed at the shared-runtime hop timeout instead of pinning forever.
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    abortController.abort();
    expect(signals[1]?.aborted).toBe(true);
    expect(envelopes[1]).toMatchObject({ traceId: "trace-coordinator-stream" });
    expect(directBridge).not.toHaveBeenCalled();
    expect(directStream).not.toHaveBeenCalled();
    expect(directHistory).not.toHaveBeenCalled();
  });

  test("keeps trusted roles server-side and sends stable lifecycle event ids", async () => {
    const envelopes: Array<Record<string, unknown>> = [];
    const namespace = {
      getByName: () => ({
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
          envelopes.push(envelope);
          return envelope.operation === "personal-stream"
            ? new Response("event: done\ndata: {}\n\n")
            : Response.json({ success: true });
        },
      }),
    };
    const agent = {
      id: "personal:11111111-1111-4111-a111-111111111111",
      organization_id: "org-1",
      user_id: "11111111-1111-4111-a111-111111111111",
      execution_tier: "shared",
    } as never;
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "call started", roomId: agent.id },
    };
    const executionCtx = { waitUntil() {} };

    await coordinateSharedStream(agent, rpc, {
      namespace,
      executionCtx,
      agentKind: "personal",
      trustedMessageRole: "system",
      trustedHistoryCutoffAt: 1_725_000_000_000,
      trustedUserUtterance: "email Bob now",
      channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
      transientInput: true,
    });
    await coordinateSharedLifecycleEvent(
      agent.id,
      agent.id,
      { id: "twilio-call:CA1:ended", content: "Call ended.", createdAt: 123 },
      { namespace },
    );

    expect(envelopes).toEqual([
      {
        operation: "personal-stream",
        agent,
        rpc,
        trustedMessageRole: "system",
        trustedHistoryCutoffAt: 1_725_000_000_000,
        trustedUserUtterance: "email Bob now",
        channel: { type: ChannelType.VOICE_DM, source: "client_chat" },
        transientInput: true,
      },
      {
        operation: "lifecycle",
        agentId: agent.id,
        roomId: agent.id,
        event: {
          id: "twilio-call:CA1:ended",
          content: "Call ended.",
          createdAt: 123,
        },
      },
    ]);
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

  test("keeps history import behind the account-commit boundary and makes replay explicit", async () => {
    const operations: string[] = [];
    const names: string[] = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const envelope = JSON.parse(String(init?.body)) as { operation: string };
            operations.push(envelope.operation);
            if (envelope.operation === "provisional-convergence-seal") {
              return Response.json({
                success: true,
                alreadyAliased: false,
                history: [{ id: "phone-1", role: "user", content: "remember this" }],
              });
            }
            if (envelope.operation === "provisional-convergence-import") {
              return Response.json({ success: true, alreadyImported: false });
            }
            return Response.json({ success: true });
          },
        };
      },
    };
    const plan = {
      token: "phone-telegram:source:target",
      holderId: "login-attempt-1",
      sourceAgentId: "personal:source",
      targetAgentId: "personal:target",
      targetUserId: "target-user",
      targetOrganizationId: "target-org",
      leaseMs: 60_000,
    };

    const prepared = await preparePersonalProvisionalHistoryConvergence(plan, { namespace });
    expect(operations).toEqual(["provisional-convergence-reserve", "provisional-convergence-seal"]);
    expect(prepared).toEqual({
      alreadyAliased: false,
      history: [{ id: "phone-1", role: "user", content: "remember this" }],
    });

    // The account transaction is the caller-controlled boundary between these
    // calls. Preparation reserves the target but cannot mutate its history.
    await commitPersonalProvisionalHistoryConvergence(plan, prepared, { namespace });
    expect(operations).toEqual([
      "provisional-convergence-reserve",
      "provisional-convergence-seal",
      "provisional-convergence-import",
      "provisional-convergence-alias",
      "provisional-convergence-release",
      "provisional-convergence-release",
    ]);
    expect(names).toEqual([
      "personal:target:personal:target",
      "personal:source:personal:source",
      "personal:target:personal:target",
      "personal:source:personal:source",
      "personal:source:personal:source",
      "personal:target:personal:target",
    ]);
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

  test("coordinatorFetch aborts a hung Durable Object hop at the timeout", async () => {
    // A coordinator that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the default shared-runtime hop timeout).
    const hungStub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    };
    const start = Date.now();
    await expect(
      coordinatorFetch(hungStub, "https://shared-runtime.internal/history", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("coordinatorFetch composes caller cancellation with the hop deadline", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const stub = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal;
        return Response.json({ ok: true });
      },
    };
    await coordinatorFetch(stub, "https://shared-runtime.internal/bridge", {
      signal: controller.signal,
    });
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  test("coordinatorFetch preserves Request inputs through the deadline wrapper", async () => {
    const request = new Request("https://shared-runtime.internal/bridge", {
      method: "POST",
      body: "{}",
    });
    let seenInput: RequestInfo | URL | undefined;
    const stub = {
      fetch: async (input: RequestInfo | URL) => {
        seenInput = input;
        return Response.json({ ok: true });
      },
    };

    await coordinatorFetch(stub, request);

    expect(seenInput).toBe(request);
  });

  test("coordinatorFetch still times out when the caller signal never aborts", async () => {
    const caller = new AbortController();
    const hungStub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              init.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    };

    await expect(
      coordinatorFetch(
        hungStub,
        "https://shared-runtime.internal/stream",
        { signal: caller.signal },
        100,
      ),
    ).rejects.toThrow(/timed out|timeout/i);
    expect(caller.signal.aborted).toBe(false);
  });

  test("coordinateSharedStream keeps the caller abort signal on the DO hop", async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const namespace = {
      getByName: () => ({
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          seen = init?.signal;
          return new Response("event: done\ndata: {}\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      }),
    };
    const rpc = {
      jsonrpc: "2.0" as const,
      id: "rpc-1",
      method: "message.send",
      params: { text: "hi", roomId: "room-1" },
    };
    await (
      await coordinateSharedStream(
        {
          id: "agent-1",
          organization_id: "org-1",
          user_id: "user-1",
          execution_tier: "shared",
        } as never,
        rpc,
        {
          abortSignal: controller.signal,
          namespace,
          executionCtx: { waitUntil() {} },
        },
      )
    )?.text();
    expect(seen).not.toBe(controller.signal);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});
