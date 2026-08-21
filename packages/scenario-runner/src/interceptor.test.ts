/**
 * Unit tests for interceptor.ts. Covers the connector-dispatch delivered
 * default (`captureConnectorDispatchesFromAction`, no runtime) and the public
 * `attachInterceptor` idempotency contract against a light fake runtime: a
 * re-attach must return the live wrapper (whose closures the wrapped handlers
 * push into) and `detach()` must restore the original handlers.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { CapturedConnectorDispatch } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  attachInterceptor,
  captureConnectorDispatchesFromAction,
} from "./interceptor.ts";

interface FakeRuntime {
  actions: Array<{ name: string; handler: (...args: unknown[]) => unknown }>;
  createMemory: (...args: unknown[]) => Promise<unknown>;
  createTask: (...args: unknown[]) => Promise<unknown>;
}

function makeFakeRuntime(): FakeRuntime {
  return {
    actions: [
      {
        name: "DO_THING",
        handler: async () => ({ success: true, data: {} }),
      },
    ],
    createMemory: async () => "memory-id",
    createTask: async () => "task-id",
  };
}

const asRuntime = (rt: FakeRuntime): IAgentRuntime =>
  rt as unknown as IAgentRuntime;

describe("captureConnectorDispatchesFromAction evidence boundary", () => {
  it("does not mark delivery when an action merely reports success", () => {
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { success: true, data: {} },
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      delivered: false,
      evidenceSource: "action-result-inference",
      status: "reported_success",
    });
  });

  it("marks delivered=false when the action reports success: false", () => {
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { success: false, data: {} },
    );
    expect(dispatches[0]).toMatchObject({
      delivered: false,
      evidenceSource: "action-result-inference",
      status: "reported_failure",
    });
  });

  it("defaults delivered to false when no boolean success is present", () => {
    // Absent an explicit boolean success, delivered stays false so a
    // "messageDelivered" final check cannot pass on a handler that never
    // reported success. Mirrors the action-result success capture (undefined,
    // never true).
    const dispatches: CapturedConnectorDispatch[] = [];
    captureConnectorDispatchesFromAction(
      dispatches,
      "MESSAGE",
      { channel: "sms" },
      { data: {} },
    );
    expect(dispatches[0]?.delivered).toBe(false);
  });
});

describe("runtime connector boundary capture", () => {
  it("records structural provider acceptance from sendMessageToTarget", async () => {
    const runtime = {
      actions: [],
      async sendMessageToTarget(_target?: unknown, _content?: unknown) {
        return {
          kind: "delivered" as const,
          receipt: {
            providerMessageIds: ["provider-42"] as [string, ...string[]],
            acceptedAt: 123,
            persistence: {
              status: "persisted" as const,
              memoryIds: ["00000000-0000-0000-0000-000000000042"],
            },
          },
          memories: [],
        };
      },
    };
    const interceptor = attachInterceptor(runtime as never);

    await runtime.sendMessageToTarget(
      { source: "discord", accountId: "account-1", channelId: "channel-1" },
      {
        text: "hello",
        metadata: { scheduledDispatchKey: "dispatch-42" },
      },
    );

    expect(interceptor.connectorDispatches).toEqual([
      expect.objectContaining({
        channel: "discord",
        delivered: true,
        evidenceSource: "runtime-send-handler",
        status: "delivered",
        providerMessageIds: ["provider-42"],
        idempotencyKey: "dispatch-42",
      }),
    ]);
  });
});

describe("attachInterceptor idempotency contract", () => {
  it("returns the existing wrapper on re-attach and captures fired actions", async () => {
    const rt = makeFakeRuntime();
    const first = attachInterceptor(asRuntime(rt));
    // Docstring: "re-attaching the interceptor to the same runtime returns the
    // existing wrapper." The returned object must observe captures.
    const second = attachInterceptor(asRuntime(rt));
    expect(second).toBe(first);

    await rt.actions[0]!.handler(rt, {}, undefined, { foo: "bar" }, undefined);

    // Both references point at the same live capture arrays.
    expect(first.actions).toHaveLength(1);
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]!.actionName).toBe("DO_THING");
    expect(second.actions[0]!.parameters).toEqual({ foo: "bar" });

    first.detach();
  });

  it("restores the original handler on detach after a re-attach (no leak)", async () => {
    const rt = makeFakeRuntime();
    const original = rt.actions[0]!.handler;
    attachInterceptor(asRuntime(rt));
    const second = attachInterceptor(asRuntime(rt));

    // The wrapper replaced the handler on attach.
    expect(rt.actions[0]!.handler).not.toBe(original);

    // detach() from the re-attached reference must restore the original,
    // rather than being a silent no-op that leaks the wrapper permanently.
    second.detach();
    expect(rt.actions[0]!.handler).toBe(original);
  });

  it("attach -> detach -> attach yields a fresh, functional interceptor", async () => {
    const rt = makeFakeRuntime();
    const original = rt.actions[0]!.handler;

    const firstAttach = attachInterceptor(asRuntime(rt));
    firstAttach.detach();
    expect(rt.actions[0]!.handler).toBe(original);

    // A brand-new attach after detach must rebuild working wiring.
    const secondAttach = attachInterceptor(asRuntime(rt));
    expect(secondAttach).not.toBe(firstAttach);

    await rt.actions[0]!.handler(rt, {}, undefined, {}, undefined);
    expect(secondAttach.actions).toHaveLength(1);
    // The stale first interceptor must not receive the new capture.
    expect(firstAttach.actions).toHaveLength(0);

    secondAttach.detach();
    expect(rt.actions[0]!.handler).toBe(original);
  });

  it("a stale detach of an already-detached interceptor must not evict the live one", async () => {
    const rt = makeFakeRuntime();
    const original = rt.actions[0]!.handler;

    const first = attachInterceptor(asRuntime(rt));
    first.detach();
    expect(rt.actions[0]!.handler).toBe(original);

    // Re-attach installs a fresh live interceptor and re-wraps the handler.
    const second = attachInterceptor(asRuntime(rt));
    expect(second).not.toBe(first);
    expect(rt.actions[0]!.handler).not.toBe(original);

    // A stale detach of the ALREADY-detached first interceptor must be a no-op
    // for the cache: the identity guard in detach() sees the live `second`
    // instance in the cache slot and refuses to evict it. Without that guard an
    // unconditional delete would drop the live cache entry while `second`'s
    // wrapped handler stays installed, so the next attach would skip re-wrapping
    // and hand back a distinct, permanently-empty interceptor.
    first.detach();

    const third = attachInterceptor(asRuntime(rt));
    expect(third).toBe(second);

    second.detach();
    expect(rt.actions[0]!.handler).toBe(original);
  });

  it("observes createMemory/createTask through the re-attached wrapper and restores them", async () => {
    const rt = makeFakeRuntime();
    const originalCreateMemory = rt.createMemory;
    const originalCreateTask = rt.createTask;

    attachInterceptor(asRuntime(rt));
    const second = attachInterceptor(asRuntime(rt));

    await rt.createMemory(
      { entityId: "e1", roomId: "r1", content: { text: "hi" } },
      "messages",
    );
    expect(second.memoryWrites).toHaveLength(1);
    expect(second.memoryWrites[0]!.table).toBe("messages");
    expect(second.memoryWrites[0]!.entityId).toBe("e1");

    second.detach();
    expect(rt.createMemory).toBe(originalCreateMemory);
    expect(rt.createTask).toBe(originalCreateTask);
  });
});
