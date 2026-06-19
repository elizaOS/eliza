import { describe, expect, it } from "bun:test";
import type { RemotePluginWorkerMessage } from "@elizaos/plugin-remote-manifest";
import type { WorkerChannel } from "./envelope.js";
import { buildRuntimeProxyApi, RuntimeProxy } from "./runtime-proxy.js";

class TestChannel implements WorkerChannel {
  readonly sent: RemotePluginWorkerMessage[] = [];
  private readonly subscribers = new Set<
    (message: RemotePluginWorkerMessage) => void
  >();

  send(message: RemotePluginWorkerMessage): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: RemotePluginWorkerMessage) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  close(): void {
    this.subscribers.clear();
  }

  deliver(message: RemotePluginWorkerMessage): void {
    for (const subscriber of this.subscribers) subscriber(message);
  }
}

describe("RuntimeProxy", () => {
  it("sends host-rpc envelopes and resolves the matching host result", async () => {
    const channel = new TestChannel();
    const proxy = new RuntimeProxy({
      channel,
      allocRequestId: () => 7,
    });
    proxy.attach();

    const result = proxy.call("getSetting", { key: "theme" });

    expect(channel.sent).toEqual([
      {
        type: "host-rpc",
        requestId: 7,
        api: "runtime",
        method: "getSetting",
        args: { key: "theme" },
      },
    ]);

    channel.deliver({
      type: "host-rpc-result",
      requestId: 7,
      ok: true,
      payload: "dark",
    });

    await expect(result).resolves.toBe("dark");
  });

  it("keeps concurrent host-rpc calls correlated and ignores unrelated messages", async () => {
    const channel = new TestChannel();
    let nextId = 0;
    const proxy = new RuntimeProxy({
      channel,
      allocRequestId: () => {
        nextId += 1;
        return nextId;
      },
    });
    proxy.attach();

    const first = proxy.call("getMemory", { memoryId: "m1" });
    const second = proxy.call("getMemory", { memoryId: "m2" });

    channel.deliver({
      type: "worker-rpc",
      requestId: 1,
      surface: "provider",
      target: "ignored",
      args: null,
    });
    channel.deliver({
      type: "host-rpc-result",
      requestId: 2,
      ok: true,
      payload: { id: "m2" },
    });
    channel.deliver({
      type: "host-rpc-result",
      requestId: 1,
      ok: true,
      payload: { id: "m1" },
    });

    await expect(first).resolves.toEqual({ id: "m1" });
    await expect(second).resolves.toEqual({ id: "m2" });
  });

  it("rejects failed host-rpc results as wire errors", async () => {
    const channel = new TestChannel();
    const proxy = new RuntimeProxy({
      channel,
      allocRequestId: () => 11,
    });
    proxy.attach();

    const result = proxy.call("useModel", {
      modelType: "TEXT_SMALL",
      params: { prompt: "hello" },
    });
    channel.deliver({
      type: "host-rpc-result",
      requestId: 11,
      ok: false,
      error: {
        name: "ModelError",
        message: "model denied",
        code: "MODEL_DENIED",
      },
    });

    await expect(result).rejects.toMatchObject({
      name: "ModelError",
      message: "model denied",
      code: "MODEL_DENIED",
    });
  });

  it("rejects pending calls when detached", async () => {
    const channel = new TestChannel();
    const proxy = new RuntimeProxy({
      channel,
      allocRequestId: () => 12,
    });
    proxy.attach();

    const result = proxy.call("composeState", { message: null, options: null });
    proxy.detach();

    await expect(result).rejects.toThrow(
      "RuntimeProxy detached before request resolved",
    );
  });
});

describe("buildRuntimeProxyApi", () => {
  it("serializes facade calls with stable method-specific argument shapes", async () => {
    const channel = new TestChannel();
    let nextId = 0;
    const proxy = new RuntimeProxy({
      channel,
      allocRequestId: () => {
        nextId += 1;
        return nextId;
      },
    });
    proxy.attach();
    const runtime = buildRuntimeProxyApi(proxy);

    const service = runtime.getService("quotes");
    const create = runtime.createMemory({ id: "m1" }, "memories");
    const compose = runtime.composeState({ text: "hi" });

    expect(channel.sent).toEqual([
      {
        type: "host-rpc",
        requestId: 1,
        api: "runtime",
        method: "getService",
        args: { serviceType: "quotes" },
      },
      {
        type: "host-rpc",
        requestId: 2,
        api: "runtime",
        method: "createMemory",
        args: { memory: { id: "m1" }, tableName: "memories" },
      },
      {
        type: "host-rpc",
        requestId: 3,
        api: "runtime",
        method: "composeState",
        args: { message: { text: "hi" }, options: null },
      },
    ]);

    channel.deliver({
      type: "host-rpc-result",
      requestId: 1,
      ok: true,
      payload: { serviceType: "quotes" },
    });
    channel.deliver({
      type: "host-rpc-result",
      requestId: 2,
      ok: true,
      payload: "memory-id",
    });
    channel.deliver({
      type: "host-rpc-result",
      requestId: 3,
      ok: true,
      payload: { composed: true },
    });

    await expect(service).resolves.toEqual({ serviceType: "quotes" });
    await expect(create).resolves.toBe("memory-id");
    await expect(compose).resolves.toEqual({ composed: true });
  });

  it("fails fast for unsupported in-worker registerEvent calls", async () => {
    const channel = new TestChannel();
    const runtime = buildRuntimeProxyApi(
      new RuntimeProxy({ channel, allocRequestId: () => 1 }),
    );

    await expect(runtime.registerEvent("event", () => {})).rejects.toThrow(
      "runtime.registerEvent inside a remote-mode plugin is not yet supported",
    );
    expect(channel.sent).toEqual([]);
  });
});
