import { describe, expect, it } from "bun:test";
import type {
  RemotePluginWorkerMessage,
  WorkerRpcMessage,
  WorkerRpcResultMessage,
} from "@elizaos/plugin-remote-manifest";
import {
  canonicalRpcBytes,
  hexEncode,
} from "@elizaos/plugin-remote-manifest/rpc-mac";
import {
  AuditDispatcher,
  InMemorySink,
  MemoryKmsAdapter,
  systemKey,
} from "@elizaos/security";
import fc from "fast-check";
import type { HandlerEntry, HandlerRegistry } from "./descriptor.js";
import { createWorkerRpcDispatcher } from "./dispatch.js";

function makeRegistry(entry?: HandlerEntry): HandlerRegistry {
  const map = new Map<string, HandlerEntry>();
  if (entry) map.set(entry.id, entry);
  return {
    get: (id) => map.get(id),
    set: (id, e) => map.set(id, e),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

function createTestChannel(): {
  send: (m: RemotePluginWorkerMessage) => void;
  outbox: RemotePluginWorkerMessage[];
} {
  const outbox: RemotePluginWorkerMessage[] = [];
  return {
    send: (m) => outbox.push(m),
    outbox,
  };
}

function rpcResult(message: RemotePluginWorkerMessage): WorkerRpcResultMessage {
  expect(message.type).toBe("worker-rpc-result");
  return message as WorkerRpcResultMessage;
}

describe("dispatcher HMAC enforcement", () => {
  it("rejects messages without a MAC", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-rpc-test");
    await kms.getOrCreateKey(keyId);
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "a",
      surface: "provider",
      target: "p",
      handler: async () => ({ ok: true }),
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      rpcAuth: { kms, keyId },
    });
    await dispatch({
      type: "worker-rpc",
      requestId: 1,
      surface: "provider",
      target: "a",
      args: { message: null, state: null },
    } as WorkerRpcMessage);
    expect(channel.outbox).toHaveLength(1);
    const result = rpcResult(channel.outbox[0] as RemotePluginWorkerMessage);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RPC_AUTH_FAILED");
  });

  it("accepts messages with a valid MAC", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-rpc-test");
    await kms.getOrCreateKey(keyId);
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "a",
      surface: "provider",
      target: "p",
      handler: async () => ({ ok: true }),
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      rpcAuth: { kms, keyId },
    });
    const args = { message: null, state: null };
    const tagBytes = await kms.hmac(
      keyId,
      canonicalRpcBytes({
        requestId: 1,
        surface: "provider",
        target: "a",
        args,
      }),
    );
    await dispatch({
      type: "worker-rpc",
      requestId: 1,
      surface: "provider",
      target: "a",
      args,
      mac: hexEncode(tagBytes),
    } as WorkerRpcMessage);
    expect(channel.outbox).toHaveLength(1);
    expect(rpcResult(channel.outbox[0] as RemotePluginWorkerMessage).ok).toBe(
      true,
    );
  });

  it("rejects hostile MAC strings without invoking handlers", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-rpc-test");
    await kms.getOrCreateKey(keyId);

    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 128 }), async (mac) => {
        fc.pre(mac.length === 0 || !/^[a-fA-F0-9]{64}$/.test(mac));
        let invoked = false;
        const channel = createTestChannel();
        const registry = makeRegistry({
          id: "a",
          surface: "provider",
          target: "p",
          handler: async () => {
            invoked = true;
            return { ok: true };
          },
        } as HandlerEntry);
        const dispatch = createWorkerRpcDispatcher(registry, {
          runtime: {} as never,
          channel: { send: channel.send } as never,
          rpcAuth: { kms, keyId },
        });

        await dispatch({
          type: "worker-rpc",
          requestId: 2,
          surface: "provider",
          target: "a",
          args: { message: null, state: null },
          mac,
        } as WorkerRpcMessage);

        expect(invoked).toBe(false);
        expect(channel.outbox[0]).toMatchObject({
          requestId: 2,
          ok: false,
          error: { code: "RPC_AUTH_FAILED" },
        });
      }),
      { numRuns: 100 },
    );
  });
});

describe("dispatcher permission gating", () => {
  it("denies action surface when no host or bun:run permission granted", async () => {
    const sink = new InMemorySink();
    const auditDispatcher = new AuditDispatcher({ sinks: [sink] });
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "a",
      surface: "action",
      target: "doStuff",
      handler: async () => null,
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      permissions: {
        pluginId: "test-plugin",
        granted: { host: {}, bun: { read: true } },
        auditDispatcher,
      },
    });
    await dispatch({
      type: "worker-rpc",
      requestId: 1,
      surface: "action",
      target: "a",
      args: { message: null, state: null, options: null, responses: null },
    } as WorkerRpcMessage);
    const result = rpcResult(channel.outbox[0] as RemotePluginWorkerMessage);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PERMISSION_DENIED");
    expect(sink.snapshot()).toHaveLength(1);
    expect(sink.snapshot()[0]?.action).toBe("plugin.denied");
  });

  it("allows action surface when bun:run is granted", async () => {
    const sink = new InMemorySink();
    const auditDispatcher = new AuditDispatcher({ sinks: [sink] });
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "a",
      surface: "action",
      target: "doStuff",
      handler: async () => null,
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      permissions: {
        pluginId: "test-plugin",
        granted: { bun: { run: true } },
        auditDispatcher,
      },
    });
    await dispatch({
      type: "worker-rpc",
      requestId: 1,
      surface: "action",
      target: "a",
      args: { message: null, state: null, options: null, responses: null },
    } as WorkerRpcMessage);
    expect(rpcResult(channel.outbox[0] as RemotePluginWorkerMessage).ok).toBe(
      true,
    );
  });
});

describe("dispatcher action callbacks", () => {
  it("sends callback payloads back to the host callback channel", async () => {
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "a",
      surface: "action",
      target: "doStuff",
      handler: async (_runtime, _message, _state, _options, callback) => {
        await (callback as (data: { text: string }) => Promise<void>)({
          text: "progress",
        });
        return { ok: true };
      },
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 1,
      surface: "action",
      target: "a",
      args: {
        message: null,
        state: null,
        options: null,
        responses: null,
        callbackId: "callback-1",
      },
    } as WorkerRpcMessage);

    expect(channel.outbox[0]).toEqual({
      type: "worker-action-callback",
      callbackId: "callback-1",
      payload: { text: "progress" },
    });
    expect(rpcResult(channel.outbox[1] as RemotePluginWorkerMessage)).toEqual({
      type: "worker-rpc-result",
      requestId: 1,
      ok: true,
      payload: { ok: true },
    });
  });

  it("allows provider surface with bun:read and passes runtime/message/state to the handler", async () => {
    const channel = createTestChannel();
    const runtime = { marker: "runtime-proxy" };
    const calls: unknown[][] = [];
    const registry = makeRegistry({
      id: "provider-1",
      surface: "provider",
      target: "contextProvider",
      handler: async (...args: unknown[]) => {
        calls.push(args);
        return { text: "provided context" };
      },
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: runtime as never,
      channel: { send: channel.send } as never,
      permissions: {
        pluginId: "test-plugin",
        granted: { bun: { read: true } },
      },
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 3,
      surface: "provider",
      target: "provider-1",
      args: {
        message: { id: "message-1", text: "hello" },
        state: { roomId: "room-1" },
      },
    } as WorkerRpcMessage);

    expect(calls).toEqual([
      [runtime, { id: "message-1", text: "hello" }, { roomId: "room-1" }],
    ]);
    expect(channel.outbox[0]).toMatchObject({
      type: "worker-rpc-result",
      requestId: 3,
      ok: true,
      payload: { text: "provided context" },
    });
  });

  it("denies provider surface when grants exist but no read/run/host grant is present", async () => {
    const sink = new InMemorySink();
    const auditDispatcher = new AuditDispatcher({ sinks: [sink] });
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "provider-1",
      surface: "provider",
      target: "contextProvider",
      handler: async () => ({ text: "should not run" }),
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      permissions: {
        pluginId: "test-plugin",
        granted: { bun: { env: true }, host: {} },
        auditDispatcher,
      },
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 4,
      surface: "provider",
      target: "provider-1",
      args: { message: null, state: null },
    } as WorkerRpcMessage);

    expect(channel.outbox[0]).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
    expect(sink.snapshot()[0]?.metadata).toMatchObject({
      plugin_id: "test-plugin",
      surface: "provider",
      target: "provider-1",
      permission: "bun:read | host:*",
      reason: "permission_not_granted",
    });
  });

  it("rejects a message whose declared surface does not match the registered target", async () => {
    let invoked = false;
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "action-1",
      surface: "action",
      target: "doStuff",
      handler: async () => {
        invoked = true;
        return { ok: true };
      },
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
      permissions: {
        pluginId: "test-plugin",
        granted: { bun: { read: true } },
      },
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 5,
      surface: "provider",
      target: "action-1",
      args: { message: null, state: null },
    } as WorkerRpcMessage);

    expect(invoked).toBe(false);
    expect(channel.outbox[0]).toMatchObject({
      type: "worker-rpc-result",
      requestId: 5,
      ok: false,
      error: {
        name: "SurfaceMismatchError",
        code: "SURFACE_MISMATCH",
      },
    });
  });
});

describe("dispatcher target and handler errors", () => {
  it("returns UNKNOWN_TARGET when no handler is registered for the rpc target", async () => {
    const channel = createTestChannel();
    const dispatch = createWorkerRpcDispatcher(makeRegistry(), {
      runtime: {} as never,
      channel: { send: channel.send } as never,
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 10,
      surface: "provider",
      target: "missing-provider",
      args: { message: null, state: null },
    } as WorkerRpcMessage);

    expect(channel.outbox[0]).toMatchObject({
      type: "worker-rpc-result",
      requestId: 10,
      ok: false,
      error: {
        name: "UnknownTargetError",
        code: "UNKNOWN_TARGET",
      },
    });
  });

  it("serializes handler exceptions into failed worker-rpc results", async () => {
    const channel = createTestChannel();
    const registry = makeRegistry({
      id: "route-1",
      surface: "route",
      target: "/boom",
      handler: async () => {
        const err = new Error("route exploded");
        (err as { code?: string }).code = "ROUTE_FAILED";
        throw err;
      },
    } as HandlerEntry);
    const dispatch = createWorkerRpcDispatcher(registry, {
      runtime: {} as never,
      channel: { send: channel.send } as never,
    });

    await dispatch({
      type: "worker-rpc",
      requestId: 11,
      surface: "route",
      target: "route-1",
      args: { ctx: { path: "/boom" } },
    } as WorkerRpcMessage);

    expect(channel.outbox[0]).toMatchObject({
      type: "worker-rpc-result",
      requestId: 11,
      ok: false,
      error: {
        name: "Error",
        message: "route exploded",
        code: "ROUTE_FAILED",
      },
    });
  });
});
