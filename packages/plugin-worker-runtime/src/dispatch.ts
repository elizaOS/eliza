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
  WorkerRpcMessage,
  WorkerRpcResultMessage,
} from "@elizaos/plugin-remote-manifest";
import type { HandlerEntry, HandlerRegistry } from "./descriptor.ts";
import type { WorkerChannel } from "./envelope.ts";
import { toWireError } from "./error.ts";
import type { RuntimeProxyApi } from "./runtime-proxy.ts";

/** Subset of the runtime proxy that the dispatcher exposes to handlers. */
export interface DispatchContext {
  runtime: RuntimeProxyApi;
  channel: WorkerChannel;
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

function makeNoopCallback(): (data: JsonValue) => Promise<void> {
  return async () => {
    // P1: action callbacks are stubbed. The action-with-callback wiring
    // is implemented in the action-surface-parity step (P1 step 4). For
    // now, action handlers that don't reach for the callback work; ones
    // that do are no-ops (their text is delivered via the orchestrator's
    // own progress channel, which today owns the user-visible reply).
  };
}
