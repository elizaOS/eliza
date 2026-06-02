import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";
import type {
  RemotePluginWorkerMessage,
  WorkerRpcMessage,
} from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
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
});
