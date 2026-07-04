/**
 * Exercises RemotePluginBridge, which wires a worker-runtime channel to the host
 * AgentRuntime: parsing worker-announce descriptors into Plugins whose surfaces
 * proxy over worker-rpc, and zod-validating inbound host-rpc calls before touching
 * the runtime. Deterministic harness — an in-memory TestChannel stands in for the
 * worker transport with a stub runtime, while the real descriptor producer
 * (buildAnnounceDescriptor) is used to prove schema parity.
 */
import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Route,
} from "@elizaos/core";
import type {
  RemotePluginWorkerMessage,
  WorkerRpcMessage,
} from "@elizaos/plugin-remote-manifest";
import { describe, expect, it, vi } from "vitest";
import {
  buildAnnounceDescriptor,
  createHandlerRegistry,
  type RemoteServiceInstance,
  type WorkerPluginShape,
} from "../../../plugin-remote-manifest/src/worker-runtime/descriptor.ts";
import { type BridgeChannel, RemotePluginBridge } from "./remote-plugin-bridge";

class TestChannel implements BridgeChannel {
  sent: RemotePluginWorkerMessage[] = [];
  private handler: ((message: RemotePluginWorkerMessage) => void) | null = null;

  send(message: RemotePluginWorkerMessage): void {
    this.sent.push(message);
  }

  onMessage(handler: (message: RemotePluginWorkerMessage) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  close(): void {}

  async emit(message: RemotePluginWorkerMessage): Promise<void> {
    this.handler?.(message);
    await Promise.resolve();
  }
}

describe("RemotePluginBridge action callbacks", () => {
  it("routes worker callback payloads to the action callback", async () => {
    const channel = new TestChannel();
    let registeredActions: Action[] = [];
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registeredActions = plugin.actions ?? [];
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "remote-test",
        actions: [
          {
            name: "REMOTE_ACTION",
            description: "Remote action",
            handler: { rpc: true, id: "action:remote:handler" },
          },
        ],
      },
    });

    const action = registeredActions[0];
    expect(action?.name).toBe("REMOTE_ACTION");
    const callbacks: unknown[] = [];
    const actionPromise = action?.handler(
      runtime,
      { content: { text: "run" } } as never,
      undefined,
      undefined,
      async (payload) => {
        callbacks.push(payload);
        return [];
      },
      [],
    );

    const rpc = channel.sent[0] as WorkerRpcMessage;
    expect(rpc.type).toBe("worker-rpc");
    expect(rpc.surface).toBe("action");
    expect(rpc.args).toMatchObject({
      callbackId: expect.stringMatching(/^action-callback:/),
    });

    const callbackId = (rpc.args as { callbackId: string }).callbackId;
    await channel.emit({
      type: "worker-action-callback",
      callbackId,
      payload: { text: "progress" },
    });
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: { success: true },
    });

    await expect(actionPromise).resolves.toEqual({ success: true });
    expect(callbacks).toEqual([{ text: "progress" }]);
  });

  it("registers dynamically announced actions with the runtime", async () => {
    const channel = new TestChannel();
    let registeredPlugin: Plugin | null = null;
    const dynamicActions: Action[] = [];
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registeredPlugin = plugin;
      },
      registerAction: (action: Action) => {
        dynamicActions.push(action);
      },
      registerProvider: () => {},
      registerEvaluator: () => {},
      registerModel: () => {},
      registerEvent: () => {},
      registerService: async () => {},
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "remote-dynamic",
      },
    });
    await channel.emit({
      type: "worker-announce-dynamic",
      descriptor: {
        name: "remote-dynamic",
        actions: [
          {
            name: "DYNAMIC_ACTION",
            handler: { rpc: true, id: "action:dynamic:handler" },
          },
        ],
      },
    });

    expect(dynamicActions.map((action) => action.name)).toEqual([
      "DYNAMIC_ACTION",
    ]);
    const pluginAfterDynamic = registeredPlugin as Plugin | null;
    expect(pluginAfterDynamic?.actions?.map((action) => action.name)).toEqual([
      "DYNAMIC_ACTION",
    ]);

    const resultPromise = dynamicActions[0]?.handler(
      runtime,
      { content: { text: "run dynamic" } } as never,
      undefined,
      undefined,
      undefined,
      [],
    );
    const rpc = channel.sent[0] as WorkerRpcMessage;
    expect(rpc).toMatchObject({
      type: "worker-rpc",
      surface: "action",
      target: "action:dynamic:handler",
    });
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: { success: true },
    });

    await expect(resultPromise).resolves.toEqual({ success: true });
  });

  it("rejects malformed worker action results before returning to the runtime", async () => {
    const channel = new TestChannel();
    let registeredActions: Action[] = [];
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registeredActions = plugin.actions ?? [];
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "remote-test",
        actions: [
          {
            name: "REMOTE_ACTION",
            description: "Remote action",
            handler: { rpc: true, id: "action:remote:handler" },
          },
        ],
      },
    });

    const actionPromise = registeredActions[0]?.handler(
      runtime,
      { content: { text: "run" } } as never,
      undefined,
      undefined,
      undefined,
      [],
    );
    const rpc = channel.sent[0] as WorkerRpcMessage;
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: { ok: true },
    });

    await expect(actionPromise).rejects.toThrow();
  });
});

describe("RemotePluginBridge descriptor schema", () => {
  // Parity proof: the bridge's descriptor schema must accept the EXACT output
  // of the real producer (buildAnnounceDescriptor in @elizaos/plugin-worker-runtime),
  // and the resulting Plugin must wire every surface. If the schema were stricter
  // than the producer, remote plugins would fail to load — this guards against that.
  function fullSurfacePlugin(): WorkerPluginShape {
    return {
      name: "full-surface",
      description: "full surface plugin",
      mode: "direct",
      priority: 7,
      dependencies: ["dep-a"],
      config: { enabled: true },
      schema: { type: "object" },
      actions: [
        {
          name: "ACT",
          similes: ["DO"],
          description: "an action",
          examples: [{ user: "u", content: { text: "hi" } }] as never,
          validate: () => true,
          handler: () => ({ ok: true }),
        },
      ],
      providers: [
        {
          name: "PROV",
          description: "a provider",
          dynamic: true,
          position: 10,
          private: true,
          get: () => ({ text: "context" }),
        },
      ],
      models: { TEXT_SMALL: () => "model-output" },
      events: { MESSAGE_RECEIVED: [() => undefined, () => undefined] },
      services: [
        {
          serviceType: "quotes",
          capabilityDescription: "Quote service",
          rpcMethods: ["quote"] as const,
          async start(_runtime: unknown): Promise<RemoteServiceInstance> {
            return {
              quote: (symbol: string) => `${symbol}:42`,
            } as RemoteServiceInstance;
          },
        },
      ],
      routes: [
        {
          type: "POST",
          name: "route",
          path: "/route",
          public: true,
          publicReason: "Remote bridge fixture public route.",
          isMultipart: false,
          routeHandler: () => new Response("ok"),
        },
      ],
      views: [{ name: "view" }],
      widgets: [{ name: "widget" }],
      componentTypes: [{ name: "component" }],
    };
  }

  it("parses a real buildAnnounceDescriptor payload and wires every surface", async () => {
    const descriptor = buildAnnounceDescriptor(
      fullSurfacePlugin(),
      createHandlerRegistry(),
    );

    const channel = new TestChannel();
    let registered: Plugin | null = null;
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registered = plugin;
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({ type: "worker-announce-plugin", descriptor });

    const plugin = registered as Plugin | null;
    expect(plugin?.name).toBe("full-surface");
    expect(plugin?.description).toBe("full surface plugin");
    expect(plugin?.mode).toBe("remote");
    expect(plugin?.priority).toBe(7);
    expect(plugin?.dependencies).toEqual(["dep-a"]);

    // Every callable surface materialised.
    expect(plugin?.actions?.map((a: Action) => a.name)).toEqual(["ACT"]);
    expect(plugin?.actions?.[0]?.similes).toEqual(["DO"]);
    expect(typeof plugin?.actions?.[0]?.validate).toBe("function");
    expect(plugin?.providers?.map((p: Provider) => p.name)).toEqual(["PROV"]);
    expect(plugin?.providers?.[0]?.dynamic).toBe(true);
    expect(plugin?.providers?.[0]?.private).toBe(true);
    expect(plugin?.providers?.[0]?.position).toBe(10);
    expect(Object.keys(plugin?.models ?? {})).toEqual(["TEXT_SMALL"]);
    const events = plugin?.events as Record<string, unknown[]> | undefined;
    expect(events?.MESSAGE_RECEIVED).toHaveLength(2);
    expect(plugin?.services).toHaveLength(1);
    expect(plugin?.routes?.map((r: Route) => r.path)).toEqual(["/route"]);
    // Metadata surfaces pass through unchanged.
    expect(plugin?.views).toEqual([{ name: "view" }]);
    expect(plugin?.widgets).toEqual([{ name: "widget" }]);
    expect(plugin?.componentTypes).toEqual([{ name: "component" }]);

    // The action proxy forwards to the worker over the wire using the
    // schema-parsed rpc id (proves the ref was narrowed, not blind-cast).
    const actionResult = plugin?.actions?.[0]?.handler(
      runtime,
      { content: { text: "go" } } as never,
      undefined,
      undefined,
      undefined,
      [],
    );
    const rpc = channel.sent.at(-1) as WorkerRpcMessage;
    expect(rpc.type).toBe("worker-rpc");
    expect(rpc.surface).toBe("action");
    expect(typeof rpc.target).toBe("string");
    expect(rpc.target.length).toBeGreaterThan(0);
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: { success: true },
    });
    await expect(actionResult).resolves.toEqual({ success: true });

    // The service proxy exposes only the allowlisted rpcMethod and forwards it.
    const ServiceClass = plugin?.services?.[0] as unknown as {
      serviceType: string;
      start(): Promise<Record<string, (...a: unknown[]) => Promise<unknown>>>;
    };
    expect(ServiceClass.serviceType).toBe("quotes");
    const instance = await ServiceClass.start();
    expect(typeof instance.quote).toBe("function");
    const quotePromise = instance.quote("ETH");
    const svcRpc = channel.sent.at(-1) as WorkerRpcMessage;
    expect(svcRpc.surface).toBe("service");
    await channel.emit({
      type: "worker-rpc-result",
      requestId: svcRpc.requestId,
      ok: true,
      payload: { quoted: "ETH:42" },
    });
    await expect(quotePromise).resolves.toEqual({ quoted: "ETH:42" });
  });

  it("defaults remote routes to GET and validates route handler results", async () => {
    const descriptor = buildAnnounceDescriptor(
      {
        name: "route-surface",
        routes: [
          {
            path: "/route",
            routeHandler: () => ({ status: 200, body: { ok: true } }),
          },
        ],
      },
      createHandlerRegistry(),
    );

    const channel = new TestChannel();
    let registered: Plugin | null = null;
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registered = plugin;
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({ type: "worker-announce-plugin", descriptor });

    const plugin = registered as Plugin | null;
    const route = plugin?.routes?.[0] as Route | undefined;
    expect(route?.type).toBe("GET");

    const badResult = route?.routeHandler?.({} as never);
    const badRpc = channel.sent.at(-1) as WorkerRpcMessage;
    await channel.emit({
      type: "worker-rpc-result",
      requestId: badRpc.requestId,
      ok: true,
      payload: { body: "missing status" },
    });
    await expect(badResult).rejects.toThrow();

    const goodResult = route?.routeHandler?.({} as never);
    const goodRpc = channel.sent.at(-1) as WorkerRpcMessage;
    await channel.emit({
      type: "worker-rpc-result",
      requestId: goodRpc.requestId,
      ok: true,
      payload: { status: 200, body: { ok: true } },
    });
    await expect(goodResult).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it("parses a minimal descriptor and a descriptor that only carries metadata", async () => {
    const minimal = buildAnnounceDescriptor(
      { name: "minimal" },
      createHandlerRegistry(),
    );
    const metadataOnly = buildAnnounceDescriptor(
      { name: "meta", views: [{ name: "v" }] },
      createHandlerRegistry(),
    );

    for (const [descriptor, expected] of [
      [minimal, { name: "minimal", views: undefined }],
      [metadataOnly, { name: "meta", views: [{ name: "v" }] }],
    ] as const) {
      const channel = new TestChannel();
      let registered: Plugin | null = null;
      const runtime = {
        registerPlugin: async (plugin: Plugin) => {
          registered = plugin;
        },
        unloadPlugin: async () => {},
      } as unknown as IAgentRuntime;
      const bridge = new RemotePluginBridge({ channel, runtime });
      bridge.attach();
      await channel.emit({ type: "worker-announce-plugin", descriptor });
      const plugin = registered as Plugin | null;
      expect(plugin?.name).toBe(expected.name);
      expect(plugin?.views).toEqual(expected.views);
    }
  });

  it("rejects a descriptor whose function ref is malformed", async () => {
    // The producer always emits `{ rpc: true, id: <string> }`. A descriptor
    // where a handler ref is structurally broken (missing `id`) must be
    // rejected at the parse boundary so the bridge never builds a proxy that
    // forwards to an undefined rpc target. The announce handler's rejection is
    // surfaced via attach()'s `void this.onMessage(...)` as an unhandled
    // rejection, so this test drives the parse path directly to assert it.
    const channel = new TestChannel();
    let registerCalls = 0;
    const runtime = {
      registerPlugin: async () => {
        registerCalls += 1;
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });

    // Subscribe with a handler we can await, instead of attach()'s void wrapper.
    const rejection = new Promise<unknown>((resolve) => {
      channel.onMessage((message) => {
        void (
          bridge as unknown as {
            onMessage(m: RemotePluginWorkerMessage): Promise<void>;
          }
        )
          .onMessage(message)
          .then(() => resolve(null))
          .catch((error) => resolve(error));
      });
    });

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "broken",
        actions: [{ name: "X", handler: { rpc: true } }],
      },
    });

    expect(await rejection).toBeTruthy();
    expect(registerCalls).toBe(0);
  });

  it("rejects handled worker messages that do not match the wire envelope", async () => {
    const channel = new TestChannel();
    const runtime = {
      registerPlugin: async () => {},
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });

    await expect(
      (
        bridge as unknown as {
          onMessage(m: RemotePluginWorkerMessage): Promise<void>;
        }
      ).onMessage({
        type: "worker-rpc-result",
        ok: true,
        payload: null,
      } as unknown as RemotePluginWorkerMessage),
    ).rejects.toThrow("Invalid remote plugin worker message");
  });

  it("rejects non-object remote provider results instead of returning empty context", async () => {
    const channel = new TestChannel();
    let registered: Plugin | null = null;
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registered = plugin;
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "bad-provider",
        providers: [
          {
            name: "BAD_PROVIDER",
            get: { rpc: true, id: "provider:bad:get" },
          },
        ],
      },
    });

    const plugin = registered as unknown as Plugin;
    expect(plugin).toBeTruthy();
    const providerPromise = plugin.providers?.[0]?.get(
      runtime,
      { content: { text: "read context" } } as never,
      {} as never,
    );
    const rpc = channel.sent.at(-1) as WorkerRpcMessage;
    expect(rpc).toMatchObject({
      type: "worker-rpc",
      surface: "provider",
      target: "provider:bad:get",
    });
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: "not a provider result",
    });

    await expect(providerPromise).rejects.toThrow(
      "Remote provider BAD_PROVIDER returned invalid ProviderResult",
    );
  });

  it("rejects malformed remote action results at the worker-rpc boundary", async () => {
    const channel = new TestChannel();
    let registered: Plugin | null = null;
    const runtime = {
      registerPlugin: async (plugin: Plugin) => {
        registered = plugin;
      },
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "worker-announce-plugin",
      descriptor: {
        name: "bad-action-result",
        actions: [
          {
            name: "BAD_ACTION",
            description: "Bad action result",
            handler: { rpc: true, id: "action:bad:handler" },
          },
        ],
      },
    });

    const plugin = registered as unknown as Plugin;
    expect(plugin).toBeTruthy();
    const actionPromise = plugin.actions?.[0]?.handler(
      runtime,
      { content: { text: "run" } } as never,
      undefined,
      undefined,
      undefined,
      [],
    );
    const rpc = channel.sent.at(-1) as WorkerRpcMessage;
    expect(rpc).toMatchObject({
      type: "worker-rpc",
      surface: "action",
      target: "action:bad:handler",
    });
    await channel.emit({
      type: "worker-rpc-result",
      requestId: rpc.requestId,
      ok: true,
      payload: "not an action result",
    });

    await expect(actionPromise).rejects.toThrow();
  });

  it("rejects malformed host createMemory payloads before invoking runtime", async () => {
    const channel = new TestChannel();
    const createMemory = vi.fn();
    const runtime = {
      createMemory,
      registerPlugin: async () => {},
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "host-rpc",
      requestId: 77,
      api: "runtime",
      method: "createMemory",
      args: {
        memory: {
          content: { text: "missing identity and room" },
        },
      },
    } as unknown as RemotePluginWorkerMessage);

    expect(createMemory).not.toHaveBeenCalled();
    expect(channel.sent.at(-1)).toMatchObject({
      type: "host-rpc-result",
      requestId: 77,
      ok: false,
      error: {
        name: "ZodError",
      },
    });
  });

  it("rejects malformed host event payloads before invoking runtime", async () => {
    const channel = new TestChannel();
    const emitEvent = vi.fn();
    const runtime = {
      emitEvent,
      registerPlugin: async () => {},
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "host-rpc",
      requestId: 78,
      api: "runtime",
      method: "emitEvent",
      args: {
        name: "MESSAGE_RECEIVED",
        payload: "not an event payload",
      },
    } as unknown as RemotePluginWorkerMessage);

    expect(emitEvent).not.toHaveBeenCalled();
    expect(channel.sent.at(-1)).toMatchObject({
      type: "host-rpc-result",
      requestId: 78,
      ok: false,
      error: {
        name: "ZodError",
      },
    });
  });
});

describe("RemotePluginBridge host-rpc validation", () => {
  it("rejects malformed createMemory payloads before calling the runtime", async () => {
    const channel = new TestChannel();
    let createMemoryCalls = 0;
    const runtime = {
      createMemory: async () => {
        createMemoryCalls += 1;
        return "memory-id";
      },
      registerPlugin: async () => {},
      unloadPlugin: async () => {},
    } as unknown as IAgentRuntime;
    const bridge = new RemotePluginBridge({ channel, runtime });
    bridge.attach();

    await channel.emit({
      type: "host-rpc",
      requestId: 1,
      api: "runtime",
      method: "createMemory",
      args: {
        memory: {
          content: { text: "missing entityId and roomId" },
        },
        tableName: "messages",
      },
    });

    const reply = channel.sent[0] as { type: string; ok: boolean };
    expect(reply.type).toBe("host-rpc-result");
    expect(reply.ok).toBe(false);
    expect(createMemoryCalls).toBe(0);
  });
});
