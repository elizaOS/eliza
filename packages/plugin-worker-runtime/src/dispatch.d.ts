/**
 * Worker-side dispatcher for inbound `worker-rpc` messages.
 *
 * The host invokes a registered surface (action, provider, etc.) by
 * sending a `worker-rpc` envelope carrying the rpc-id and JSON args. The
 * dispatcher resolves the id to the live handler via the
 * {@link HandlerRegistry}, marshals JSON args back into handler-shaped
 * arguments (synthesising a {@link RuntimeProxy} and surface-specific
 * helpers like the {@link CallbackProxy}), invokes, and posts the
 * result as a `worker-rpc-result`.
 */
import type {
  RemotePluginPermissionGrant,
  WorkerRpcMessage,
} from "@elizaos/plugin-remote-manifest";
import type { AuditDispatcher, KmsClient } from "@elizaos/security";
import type { HandlerRegistry } from "./descriptor";
import type { WorkerChannel } from "./envelope";
import type { RuntimeProxyApi } from "./runtime-proxy";
/** Subset of the runtime proxy that the dispatcher exposes to handlers. */
export interface DispatchContext {
  runtime: RuntimeProxyApi;
  channel: WorkerChannel;
  /**
   * SOC2 A-4: when set, every incoming `WorkerRpcMessage` MUST carry a
   * valid `mac` over `canonicalRpcBytes`. Messages without a MAC or
   * with a bad MAC are rejected.
   */
  rpcAuth?: {
    kms: KmsClient;
    keyId: string;
    /**
     * When `false` (legacy installs awaiting re-key), bad/missing macs
     * log a WARN but do not reject. New installs always set this true.
     */
    enforce?: boolean;
  };
  /**
   * SOC2 A-5: permission grants for this plugin install. When set, the
   * dispatcher checks the requested surface against the grant before
   * invoking and rejects with `plugin.denied` audit otherwise.
   */
  permissions?: {
    granted: RemotePluginPermissionGrant;
    pluginId: string;
    auditDispatcher?: AuditDispatcher;
  };
}
/**
 * Build the dispatcher's `onMessage` callback. The bootstrap wires this
 * to the worker channel.
 */
export declare function createWorkerRpcDispatcher(
  registry: HandlerRegistry,
  context: DispatchContext,
): (message: WorkerRpcMessage) => Promise<void>;
//# sourceMappingURL=dispatch.d.ts.map
