import type { IAgentRuntime, Plugin } from "@elizaos/core";
import type {
  RemotePluginWorkerMessage,
  WorkerRpcMessage,
} from "@elizaos/plugin-remote-manifest";
import { describe, expect, it, vi } from "vitest";
import { type BridgeChannel, RemotePluginBridge } from "./remote-plugin-bridge";

function createBridgeChannel(): BridgeChannel & {
  outbox: RemotePluginWorkerMessage[];
  emitFromWorker(message: RemotePluginWorkerMessage): void;
} {
  const handlers = new Set<(message: RemotePluginWorkerMessage) => void>();
  return {
    outbox: [],
    send(message) {
      this.outbox.push(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {},
    emitFromWorker(message) {
      for (const handler of handlers) {
        handler(message);
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RemotePluginBridge action callbacks", () => {
  it("marshals remote action callbacks back to the host callback", async () => {
    const channel = createBridgeChannel();
    const runtime = {
      registerPlugin: vi.fn(async (_registered: Plugin) => undefined),
      unloadPlugin: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;

    const bridge = new RemotePluginBridge({
      channel,
      runtime,
      rpcTimeoutMs: 1_000,
    });
    bridge.attach();

    channel.emitFromWorker({
      type: "worker-announce-plugin",
      descriptor: {
        name: "remote-test",
        actions: [
          {
            name: "REMOTE_TEST",
            description: "Remote test action",
            handler: { rpc: true, id: "action-1" },
          },
        ],
      },
    });
    await flush();

    expect(runtime.registerPlugin).toHaveBeenCalledOnce();
    const plugin = vi.mocked(runtime.registerPlugin).mock.calls[0]?.[0] as
      | Plugin
      | undefined;
    if (!plugin) throw new Error("expected registered plugin");
    const callback = vi.fn(async () => [
      {
        id: "00000000-0000-4000-8000-000000000001",
        entityId: "00000000-0000-4000-8000-000000000002",
        roomId: "00000000-0000-4000-8000-000000000003",
        content: { text: "from worker" },
      },
    ]);
    const actionPromise = plugin?.actions?.[0]?.handler(
      runtime,
      { id: "message-1", content: { text: "run" } } as never,
      undefined,
      {},
      callback,
      [],
    );

    await flush();
    const workerRpc = channel.outbox.find(
      (message): message is WorkerRpcMessage => message.type === "worker-rpc",
    );
    expect(workerRpc?.args).toMatchObject({
      callbackId: expect.any(String),
    });
    const callbackId = (workerRpc?.args as { callbackId: string }).callbackId;

    channel.emitFromWorker({
      type: "host-rpc",
      requestId: 100,
      api: "runtime",
      method: "actionCallback",
      args: {
        callbackId,
        response: { text: "from worker" },
        actionName: "REMOTE_TEST",
      },
    });
    await flush();

    expect(callback).toHaveBeenCalledWith(
      { text: "from worker" },
      "REMOTE_TEST",
    );
    expect(channel.outbox).toContainEqual(
      expect.objectContaining({
        type: "host-rpc-result",
        requestId: 100,
        ok: true,
        payload: [
          expect.objectContaining({
            id: "00000000-0000-4000-8000-000000000001",
          }),
        ],
      }),
    );

    if (!workerRpc) throw new Error("expected worker-rpc");
    channel.emitFromWorker({
      type: "worker-rpc-result",
      requestId: workerRpc.requestId,
      ok: true,
      payload: { success: true },
    });

    await expect(actionPromise).resolves.toEqual({ success: true });
    await bridge.detach();
  });
});

describe("RemotePluginBridge dynamic event registration", () => {
  it("registers host runtime events that proxy back to worker handlers", async () => {
    const channel = createBridgeChannel();
    const runtime = {
      registerPlugin: vi.fn(async (_registered: Plugin) => undefined),
      unloadPlugin: vi.fn(async () => undefined),
      registerEvent: vi.fn(),
    } as unknown as IAgentRuntime;

    const bridge = new RemotePluginBridge({
      channel,
      runtime,
      rpcTimeoutMs: 1_000,
    });
    bridge.attach();

    channel.emitFromWorker({
      type: "host-rpc",
      requestId: 200,
      api: "runtime",
      method: "registerEvent",
      args: {
        name: "REMOTE_DYNAMIC_EVENT",
        handlerRef: { rpc: true, id: "event-dynamic-1" },
      },
    });
    await flush();

    expect(runtime.registerEvent).toHaveBeenCalledWith(
      "REMOTE_DYNAMIC_EVENT",
      expect.any(Function),
    );
    expect(channel.outbox).toContainEqual(
      expect.objectContaining({
        type: "host-rpc-result",
        requestId: 200,
        ok: true,
        payload: null,
      }),
    );

    const registeredHandler = vi.mocked(runtime.registerEvent).mock
      .calls[0]?.[1] as ((payload: unknown) => Promise<void>) | undefined;
    if (!registeredHandler)
      throw new Error("expected registered event handler");

    const eventPromise = registeredHandler({ value: "payload" });
    await flush();

    const workerRpc = channel.outbox.find(
      (message): message is WorkerRpcMessage =>
        message.type === "worker-rpc" &&
        message.surface === "event" &&
        message.target === "event-dynamic-1",
    );
    expect(workerRpc).toMatchObject({
      type: "worker-rpc",
      surface: "event",
      target: "event-dynamic-1",
      args: { value: "payload" },
    });

    if (!workerRpc) throw new Error("expected worker-rpc");
    channel.emitFromWorker({
      type: "worker-rpc-result",
      requestId: workerRpc.requestId,
      ok: true,
      payload: null,
    });

    await expect(eventPromise).resolves.toBeUndefined();
    await bridge.detach();
  });
});
