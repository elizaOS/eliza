/**
 * The worker entrypoint. Imports the author's Plugin module, walks its
 * surfaces, announces them to the host, then enters the dispatch loop.
 *
 * Author-side plugin code looks like a normal direct-mode Plugin:
 *
 * ```ts
 * // worker.ts
 * import { bootstrap } from "@elizaos/plugin-worker-runtime";
 * import { pluginFooRemote } from "./plugin";
 * bootstrap(pluginFooRemote);
 * ```
 *
 * `bootstrap()` returns a `Promise<void>` that resolves when the worker
 * has finished announcing and is ready to dispatch. It does not block
 * the event loop afterwards — the channel keeps the worker alive.
 */

import type {
  JsonObject,
  JsonValue,
  RemotePluginWorkerMessage,
  WorkerAnnouncePluginMessage,
  WorkerInitCompleteMessage,
  WorkerRpcMessage,
} from "@elizaos/plugin-remote-manifest";
import {
  buildAnnounceDescriptor,
  createHandlerRegistry,
  type WorkerPluginShape,
} from "./descriptor";
import { createWorkerRpcDispatcher } from "./dispatch";
import {
  createDefaultChannel,
  createRequestIdAllocator,
  type WorkerChannel,
} from "./envelope";
import { toWireError } from "./error";
import { buildRuntimeProxyApi, RuntimeProxy } from "./runtime-proxy";

/** Options accepted by {@link bootstrap}. */
export interface BootstrapOptions {
  /** Override the message transport. Defaults to a Worker channel. */
  channel?: WorkerChannel;
  /** Override the host-rpc timeout. Default: no timeout. */
  runtimeRpcTimeoutMs?: number;
  /** Optional plugin config map passed to `plugin.init` if present. */
  initConfig?: Record<string, string>;
}

/**
 * Bootstrap the remote-mode plugin.
 *
 * @param plugin   The author's Plugin object. The bootstrap walks every
 *                 surface (`actions`, `providers`, …) and announces the
 *                 contributions to the host. After `init-complete` the
 *                 worker is in steady-state dispatch mode.
 * @param options  Transport overrides for testing.
 */
export async function bootstrap(
  plugin: WorkerPluginShape,
  options: BootstrapOptions = {},
): Promise<void> {
  const channel = options.channel ?? createDefaultChannel();
  const allocRequestId = createRequestIdAllocator();
  const registry = createHandlerRegistry();
  const proxy = new RuntimeProxy({
    channel,
    allocRequestId,
    ...(options.runtimeRpcTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.runtimeRpcTimeoutMs }
      : {}),
  });
  proxy.attach();
  let dynamicEventCounter = 0;
  const runtimeApi = buildRuntimeProxyApi(proxy, {
    registerDynamicEventHandler: (name, handler) => {
      dynamicEventCounter += 1;
      const id = `event:${name}.dynamic:${dynamicEventCounter}`;
      registry.set(id, {
        id,
        surface: "event",
        target: `${name}#dynamic:${dynamicEventCounter}`,
        handler: (payload: unknown) => handler(payload as JsonValue),
      });
      return { rpc: true, id };
    },
  });

  const dispatchRpc = createWorkerRpcDispatcher(registry, {
    runtime: runtimeApi,
    channel,
  });

  channel.onMessage((message) => {
    if (message.type === "worker-rpc") {
      void dispatchRpc(message as WorkerRpcMessage);
    }
  });

  // Build + send the announce payload.
  const descriptor: JsonObject = buildAnnounceDescriptor(plugin, registry);
  const announce: WorkerAnnouncePluginMessage = {
    type: "worker-announce-plugin",
    descriptor,
  };
  channel.send(announce);

  // Run author init (if any). Surface registrations made from inside init
  // can be reported as worker-announce-dynamic in a follow-up; for now we
  // require the static surface arrays on the Plugin object to be complete.
  if (typeof plugin.init === "function") {
    try {
      await (plugin.init as (config: unknown, runtime: unknown) => unknown)(
        options.initConfig ?? {},
        runtimeApi,
      );
    } catch (error) {
      channel.send({
        type: "event",
        name: "plugin.init.failed",
        payload: { error: toWireError(error) as unknown as JsonValue },
      } as RemotePluginWorkerMessage);
      throw error;
    }
  }

  const initComplete: WorkerInitCompleteMessage = { type: "init-complete" };
  channel.send(initComplete);
}
