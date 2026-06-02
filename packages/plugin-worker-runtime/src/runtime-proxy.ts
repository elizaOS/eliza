/**
 * RuntimeProxy — what a remote-mode plugin's handlers see in lieu of the
 * real {@link IAgentRuntime}. Every method call serialises as a
 * `host-rpc` message back to the host, where the real runtime resolves
 * the call and the result returns as a `host-rpc-result`.
 *
 * P1 ships the methods required by action / provider / event / model
 * handlers (`getService`, `useModel`, `getMemory`, `createMemory`,
 * `emitEvent`, `registerEvent`, `getSetting`, `setSetting`,
 * `composeState`) plus action callback marshalling. The remainder of the
 * runtime surface (database, routes, advanced event APIs) is added
 * incrementally as plugin authors reach for it; an `unknown method`
 * host-rpc returns a typed error rather than silently dropping the call.
 */

import type {
  HostRpcMessage,
  HostRpcResultMessage,
  JsonValue,
  RemoteFunctionRef,
  RemotePluginWorkerMessage,
} from "@elizaos/plugin-remote-manifest";
import type { WorkerChannel } from "./envelope";
import { fromWireError } from "./error";

/** Subset of host-rpc methods supported in P1. */
export const SUPPORTED_RUNTIME_METHODS = [
  "getService",
  "useModel",
  "getMemory",
  "createMemory",
  "updateMemory",
  "emitEvent",
  "registerEvent",
  "getSetting",
  "setSetting",
  "composeState",
  "actionCallback",
] as const;

export type RuntimeProxyMethod = (typeof SUPPORTED_RUNTIME_METHODS)[number];

/** Configuration for the RuntimeProxy. */
export interface RuntimeProxyOptions {
  channel: WorkerChannel;
  allocRequestId: () => number;
  /**
   * Optional default timeout per host-rpc call, in ms. Defaults to no
   * timeout; long-running operations (sub-agent runs, model streams)
   * rely on the caller to set its own timeout.
   */
  defaultTimeoutMs?: number;
}

/**
 * The RuntimeProxy itself. Exposes a `call` method that handlers reach
 * for via {@link buildRuntimeProxyApi} (which materialises a typed
 * `runtime.getService(...)`-style surface from the bare `call`).
 */
export class RuntimeProxy {
  private readonly channel: WorkerChannel;
  private readonly allocRequestId: () => number;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly pending = new Map<
    number,
    { resolve: (value: JsonValue) => void; reject: (error: Error) => void }
  >();
  private unsubscribe: (() => void) | undefined;

  constructor(options: RuntimeProxyOptions) {
    this.channel = options.channel;
    this.allocRequestId = options.allocRequestId;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  /** Wire up the proxy's response handler on the channel. */
  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.channel.onMessage((message) => {
      this.onHostMessage(message);
    });
  }

  /** Tear down the response handler. */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const error = new Error("RuntimeProxy detached before request resolved.");
    for (const [, slot] of this.pending) slot.reject(error);
    this.pending.clear();
  }

  /** Issue a host-rpc call and await the result. */
  async call<T extends JsonValue = JsonValue>(
    method: RuntimeProxyMethod,
    args: JsonValue,
  ): Promise<T> {
    const requestId = this.allocRequestId();
    const promise = new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      if (this.defaultTimeoutMs !== undefined) {
        setTimeout(() => {
          if (this.pending.delete(requestId)) {
            reject(
              new Error(
                `host-rpc ${method} timed out after ${this.defaultTimeoutMs}ms`,
              ),
            );
          }
        }, this.defaultTimeoutMs);
      }
    });

    const envelope: HostRpcMessage = {
      type: "host-rpc",
      requestId,
      api: "runtime",
      method,
      args,
    };
    this.channel.send(envelope);
    return (await promise) as T;
  }

  private onHostMessage(message: RemotePluginWorkerMessage): void {
    if (message.type !== "host-rpc-result") return;
    const result = message as HostRpcResultMessage;
    const slot = this.pending.get(result.requestId);
    if (!slot) return;
    this.pending.delete(result.requestId);
    if (result.ok) {
      slot.resolve((result.payload ?? null) as JsonValue);
    } else {
      slot.reject(
        fromWireError(
          result.error ?? {
            name: "Error",
            message: "Unknown host-rpc failure",
          },
          "remote worker",
        ),
      );
    }
  }
}

/**
 * Build the user-facing facade that handlers receive as their `runtime`
 * argument. Each method round-trips a host-rpc through the proxy.
 *
 * This is intentionally NOT a full `IAgentRuntime` — it's the subset
 * remote handlers can safely call. Live-object getters (e.g.
 * `runtime.databaseAdapter`) are absent by design; any access throws a
 * clear error explaining that remote-mode plugins go through the proxy
 * methods only.
 */
export interface RuntimeProxyApi {
  getService<T = JsonValue>(serviceType: string): Promise<T | null>;
  useModel<T = JsonValue>(modelType: string, params: JsonValue): Promise<T>;
  getMemory(memoryId: string): Promise<JsonValue | null>;
  createMemory(memory: JsonValue, tableName?: string): Promise<string>;
  updateMemory(memory: JsonValue): Promise<void>;
  emitEvent(name: string, payload: JsonValue): Promise<void>;
  registerEvent(
    name: string,
    handler: (payload: JsonValue) => Promise<void> | void,
  ): Promise<void>;
  getSetting(key: string): Promise<JsonValue | null>;
  setSetting(key: string, value: JsonValue): Promise<void>;
  composeState(message: JsonValue, options?: JsonValue): Promise<JsonValue>;
  actionCallback(
    callbackId: string,
    response: JsonValue,
    actionName?: string,
  ): Promise<JsonValue>;
}

export interface RuntimeProxyApiOptions {
  registerDynamicEventHandler?: (
    name: string,
    handler: (payload: JsonValue) => Promise<void> | void,
  ) => RemoteFunctionRef;
}

export function buildRuntimeProxyApi(
  proxy: RuntimeProxy,
  options: RuntimeProxyApiOptions = {},
): RuntimeProxyApi {
  return {
    getService: (serviceType) =>
      proxy.call("getService", { serviceType }) as Promise<never>,
    useModel: (modelType, params) =>
      proxy.call("useModel", { modelType, params }) as Promise<never>,
    getMemory: (memoryId) => proxy.call("getMemory", { memoryId }),
    createMemory: (memory, tableName) =>
      proxy.call("createMemory", {
        memory,
        tableName: tableName ?? null,
      }) as Promise<string>,
    updateMemory: async (memory) => {
      await proxy.call("updateMemory", { memory });
    },
    emitEvent: async (name, payload) => {
      await proxy.call("emitEvent", { name, payload });
    },
    registerEvent: async (name, handler) => {
      if (!options.registerDynamicEventHandler) {
        throw new Error(
          "runtime.registerEvent inside a remote-mode plugin requires a dynamic event handler registry.",
        );
      }
      const handlerRef = options.registerDynamicEventHandler(name, handler);
      await proxy.call("registerEvent", { name, handlerRef });
    },
    getSetting: (key) => proxy.call("getSetting", { key }),
    setSetting: async (key, value) => {
      await proxy.call("setSetting", { key, value });
    },
    composeState: (message, options) =>
      proxy.call("composeState", { message, options: options ?? null }),
    actionCallback: (callbackId, response, actionName) =>
      proxy.call("actionCallback", {
        callbackId,
        response,
        actionName: actionName ?? null,
      }),
  };
}
