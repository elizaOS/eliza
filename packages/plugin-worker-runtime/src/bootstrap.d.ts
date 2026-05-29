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
import { type WorkerPluginShape } from "./descriptor";
import { type WorkerChannel } from "./envelope";
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
export declare function bootstrap(
  plugin: WorkerPluginShape,
  options?: BootstrapOptions,
): Promise<void>;
//# sourceMappingURL=bootstrap.d.ts.map
