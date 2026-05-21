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
  JsonValue,
  PluginSurfaceKind,
  RemotePluginPermissionGrant,
  WorkerRpcMessage,
  WorkerRpcResultMessage,
} from "@elizaos/plugin-remote-manifest";
import {
  canonicalRpcBytes,
  hexDecode,
} from "@elizaos/plugin-remote-manifest/rpc-mac";
import type { AuditDispatcher, KmsClient } from "@elizaos/security";
import type { HandlerEntry, HandlerRegistry } from "./descriptor";
import type { WorkerChannel } from "./envelope";
import { toWireError } from "./error";
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
export function createWorkerRpcDispatcher(
  registry: HandlerRegistry,
  context: DispatchContext,
): (message: WorkerRpcMessage) => Promise<void> {
  return async (message: WorkerRpcMessage) => {
    const reply = (result: WorkerRpcResultMessage): void => {
      context.channel.send(result);
    };

    // SOC2 A-4: HMAC verification.
    if (context.rpcAuth) {
      const enforce = context.rpcAuth.enforce !== false;
      const macOk = await verifyMac(message, context.rpcAuth);
      if (!macOk) {
        if (enforce) {
          reply({
            type: "worker-rpc-result",
            requestId: message.requestId,
            ok: false,
            error: {
              name: "RpcAuthError",
              message: "Worker RPC message MAC missing or invalid",
              code: "RPC_AUTH_FAILED",
            },
          });
          return;
        }
        process.stderr.write(
          "[worker-rpc] WARN: legacy unsigned RPC accepted; re-key plugin to enforce MAC.\n",
        );
      }
    }

    // SOC2 A-5: permission enforcement.
    if (context.permissions) {
      const denial = checkPermission(message.surface, context.permissions.granted);
      if (denial) {
        if (context.permissions.auditDispatcher) {
          try {
            await context.permissions.auditDispatcher.emit({
              actor: { type: "system", id: "agent" },
              action: "plugin.denied",
              result: "denied",
              resource: {
                type: "plugin",
                id: context.permissions.pluginId,
              },
              metadata: {
                plugin_id: context.permissions.pluginId,
                surface: message.surface,
                target: message.target,
                permission: denial,
                reason: "permission_not_granted",
              },
            });
          } catch {
            // Audit must not break dispatch.
          }
        }
        reply({
          type: "worker-rpc-result",
          requestId: message.requestId,
          ok: false,
          error: {
            name: "PermissionDeniedError",
            message: `Plugin ${context.permissions.pluginId} not granted permission for surface ${message.surface}`,
            code: "PERMISSION_DENIED",
          },
        });
        return;
      }
    }

    const entry = registry.get(message.target);
    if (!entry) {
      reply({
        type: "worker-rpc-result",
        requestId: message.requestId,
        ok: false,
        error: {
          name: "UnknownTargetError",
          message: `No handler registered for ${message.surface}:${message.target}`,
          code: "UNKNOWN_TARGET",
        },
      });
      return;
    }

    try {
      const payload = await invokeBySurface(entry, message, context);
      reply({
        type: "worker-rpc-result",
        requestId: message.requestId,
        ok: true,
        payload,
      });
    } catch (error) {
      reply({
        type: "worker-rpc-result",
        requestId: message.requestId,
        ok: false,
        error: toWireError(error),
      });
    }
  };
}

/**
 * Surface-specific handler shapes the dispatcher routes JSON args into.
 * Adding a new surface is a new case here; everything else stays the
 * same.
 */
async function invokeBySurface(
  entry: HandlerEntry,
  message: WorkerRpcMessage,
  context: DispatchContext,
): Promise<JsonValue> {
  const args = (message.args ?? null) as JsonValue;
  switch (entry.surface) {
    case "provider": {
      // Provider.get(runtime, message, state)
      const params = args as {
        message: JsonValue;
        state: JsonValue;
      };
      const result = await (entry.handler as ProviderHandler)(
        context.runtime,
        params.message,
        params.state,
      );
      return (result ?? null) as JsonValue;
    }
    case "event": {
      // Event handler takes a single payload arg; no return.
      await (entry.handler as EventHandler)(args);
      return null;
    }
    case "model": {
      // Model handler(runtime, params) → result
      const params = args as { params: JsonValue };
      const result = await (entry.handler as ModelHandler)(
        context.runtime,
        params.params,
      );
      return (result ?? null) as JsonValue;
    }
    case "action": {
      // Action handler(runtime, message, state, options, callback, responses)
      // `callback` is replaced by a CallbackProxy that round-trips back
      // to the host as a worker-rpc surface=action.callback. Implemented
      // in P1 step 4.
      const params = args as {
        message: JsonValue;
        state: JsonValue;
        options: JsonValue;
        responses: JsonValue;
        /** Identifier for the host-side callback channel. */
        callbackId?: string;
      };
      const callback = makeNoopCallback();
      const result = await (entry.handler as ActionHandler)(
        context.runtime,
        params.message,
        params.state,
        params.options,
        callback,
        params.responses,
      );
      return (result ?? null) as JsonValue;
    }
    case "evaluator": {
      const params = args as { message: JsonValue; state: JsonValue };
      const result = await (entry.handler as EvaluatorHandler)(
        context.runtime,
        params.message,
        params.state,
      );
      return (result ?? null) as JsonValue;
    }
    case "route": {
      const params = args as { ctx: JsonValue };
      const result = await (entry.handler as RouteHandler)(params.ctx);
      return (result ?? null) as JsonValue;
    }
    case "service": {
      // Trampoline expects (runtime, ...methodArgs). The host sends
      // `{ args: unknown[] }`; pass through.
      const params = args as { args: unknown[] };
      const result = await (entry.handler as ServiceHandler)(
        context.runtime,
        ...(params.args ?? []),
      );
      return (result ?? null) as JsonValue;
    }
    case "tests":
      throw new Error(
        `Surface "tests" is not host-RPC reachable; run via the worker's existing test runner.`,
      );
    default: {
      const _exhaustive: never = entry.surface;
      throw new Error(`Unknown surface: ${String(_exhaustive)}`);
    }
  }
}

type ProviderHandler = (
  runtime: RuntimeProxyApi,
  message: JsonValue,
  state: JsonValue,
) => Promise<JsonValue> | JsonValue;
type EventHandler = (payload: JsonValue) => Promise<void> | void;
type ModelHandler = (
  runtime: RuntimeProxyApi,
  params: JsonValue,
) => Promise<JsonValue> | JsonValue;
type ActionHandler = (
  runtime: RuntimeProxyApi,
  message: JsonValue,
  state: JsonValue,
  options: JsonValue,
  callback: (data: JsonValue) => Promise<void> | void,
  responses: JsonValue,
) => Promise<JsonValue | void> | JsonValue | void;
type EvaluatorHandler = (
  runtime: RuntimeProxyApi,
  message: JsonValue,
  state: JsonValue,
) => Promise<JsonValue> | JsonValue;
type RouteHandler = (ctx: JsonValue) => Promise<JsonValue> | JsonValue;
type ServiceHandler = (
  runtime: RuntimeProxyApi,
  ...args: unknown[]
) => Promise<JsonValue> | JsonValue;

async function verifyMac(
  message: WorkerRpcMessage,
  auth: NonNullable<DispatchContext["rpcAuth"]>,
): Promise<boolean> {
  if (!message.mac) return false;
  let tag: Uint8Array;
  try {
    tag = hexDecode(message.mac);
  } catch {
    return false;
  }
  const data = canonicalRpcBytes(message);
  try {
    return await auth.kms.hmacVerify(auth.keyId, data, tag);
  } catch {
    return false;
  }
}

/**
 * Map a surface kind to the host-permission gate that must be granted.
 * Returns the missing permission label when denied, or null when allowed.
 *
 * This is intentionally coarse — finer per-action permission gates can
 * layer on top once the action surface contract is stable.
 */
function checkPermission(
  surface: PluginSurfaceKind,
  granted: RemotePluginPermissionGrant,
): string | null {
  // `tests` is never host-RPC reachable; the surface switch will reject.
  if (surface === "tests") return null;
  // Treat any surface as allowed when the grant is empty/absent. The
  // tighter mapping below applies once any grants are set.
  if (!granted || (Object.keys(granted.bun ?? {}).length === 0 && Object.keys(granted.host ?? {}).length === 0)) {
    return null;
  }
  // Surfaces that touch host services need bun:run OR a host:* grant.
  const bun = granted.bun ?? {};
  const host = granted.host ?? {};
  const hasAnyHost = Object.values(host).some(Boolean);
  switch (surface) {
    case "action":
    case "service":
    case "route":
      // Mutating surfaces require some host or run permission.
      if (bun.run || hasAnyHost) return null;
      return "bun:run | host:*";
    case "provider":
    case "evaluator":
    case "model":
    case "event":
      // Read-only-ish surfaces: allow when any permission is granted.
      if (bun.read || bun.run || hasAnyHost) return null;
      return "bun:read | host:*";
    default:
      return null;
  }
}

function makeNoopCallback(): (data: JsonValue) => Promise<void> {
  return async () => {
    // P1: action callbacks are stubbed. The action-with-callback wiring
    // is implemented in the action-surface-parity step (P1 step 4). For
    // now, action handlers that don't reach for the callback work; ones
    // that do are no-ops (their text is delivered via the orchestrator's
    // own progress channel, which today owns the user-visible reply).
  };
}
