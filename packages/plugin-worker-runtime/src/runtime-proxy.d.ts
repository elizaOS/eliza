/**
 * RuntimeProxy — what a remote-mode plugin's handlers see in lieu of the
 * real {@link IAgentRuntime}. Every method call serialises as a
 * `host-rpc` message back to the host, where the real runtime resolves
 * the call and the result returns as a `host-rpc-result`.
 *
 * P1 ships the methods required by action / provider / event / model
 * handlers (`getService`, `useModel`, `getMemory`, `createMemory`,
 * `emitEvent`, `registerEvent`, `getSetting`, `setSetting`,
 * `composeState`). The remainder of the runtime surface (database,
 * routes, advanced event APIs) is added incrementally as plugin authors
 * reach for it; an `unknown method` host-rpc returns a typed error rather
 * than silently dropping the call.
 */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type { WorkerChannel } from "./envelope";
/** Subset of host-rpc methods supported in P1. */
export declare const SUPPORTED_RUNTIME_METHODS: readonly ["getService", "useModel", "getMemory", "createMemory", "updateMemory", "emitEvent", "registerEvent", "getSetting", "setSetting", "composeState"];
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
export declare class RuntimeProxy {
    private readonly channel;
    private readonly allocRequestId;
    private readonly defaultTimeoutMs;
    private readonly pending;
    private unsubscribe;
    constructor(options: RuntimeProxyOptions);
    /** Wire up the proxy's response handler on the channel. */
    attach(): void;
    /** Tear down the response handler. */
    detach(): void;
    /** Issue a host-rpc call and await the result. */
    call<T extends JsonValue = JsonValue>(method: RuntimeProxyMethod, args: JsonValue): Promise<T>;
    private onHostMessage;
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
    registerEvent(name: string, handler: (payload: JsonValue) => void): Promise<void>;
    getSetting(key: string): Promise<JsonValue | null>;
    setSetting(key: string, value: JsonValue): Promise<void>;
    composeState(message: JsonValue, options?: JsonValue): Promise<JsonValue>;
}
export declare function buildRuntimeProxyApi(proxy: RuntimeProxy): RuntimeProxyApi;
//# sourceMappingURL=runtime-proxy.d.ts.map