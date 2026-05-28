import { describe, expect, it } from "bun:test";
import type {
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

function mockChannel(): {
  send: (m: WorkerRpcResultMessage) => void;
  outbox: WorkerRpcResultMessage[];
} {
  const outbox: WorkerRpcResultMessage[] = [];
  return {
    send: (m) => outbox.push(m),
    outbox,
  };
}

describe("dispatcher HMAC enforcement", () => {
  it("rejects messages without a MAC", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-rpc-test");
    await kms.getOrCreateKey(keyId);
    const channel = mockChannel();
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
    expect(channel.outbox[0]?.ok).toBe(false);
    expect(channel.outbox[0]?.error?.code).toBe("RPC_AUTH_FAILED");
  });

  it("accepts messages with a valid MAC", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-rpc-test");
    await kms.getOrCreateKey(keyId);
    const channel = mockChannel();
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
    expect(channel.outbox[0]?.ok).toBe(true);
  });
});

describe("dispatcher permission gating", () => {
  it("denies action surface when no host or bun:run permission granted", async () => {
    const sink = new InMemorySink();
    const auditDispatcher = new AuditDispatcher({ sinks: [sink] });
    const channel = mockChannel();
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
    expect(channel.outbox[0]?.ok).toBe(false);
    expect(channel.outbox[0]?.error?.code).toBe("PERMISSION_DENIED");
    expect(sink.snapshot()).toHaveLength(1);
    expect(sink.snapshot()[0]?.action).toBe("plugin.denied");
  });

  it("allows action surface when bun:run is granted", async () => {
    const sink = new InMemorySink();
    const auditDispatcher = new AuditDispatcher({ sinks: [sink] });
    const channel = mockChannel();
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
    expect(channel.outbox[0]?.ok).toBe(true);
  });
});
