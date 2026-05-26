/**
 * Build the {@link WorkerAnnouncePluginMessage.descriptor} payload from
 * the author's Plugin object.
 *
 * The descriptor is a JSON-safe copy of the Plugin where every function
 * value is replaced by a `{ rpc: true, id: <stable-id> }` tag. The host
 * uses the tags as the `target` in subsequent `worker-rpc` invocations.
 *
 * The mapping of `id → handler` is kept in a per-worker
 * {@link HandlerRegistry} so the dispatcher can resolve incoming
 * worker-rpc calls back to the live function.
 */
import type { JsonObject, JsonValue, PluginSurfaceKind } from "@elizaos/plugin-remote-manifest";
/** Live handler registered by the descriptor builder. */
export type AnyHandler = (...args: unknown[]) => unknown;
/**
 * Shape a service class must satisfy to be exported from a remote-mode
 * plugin. Note the `static rpcMethods` opt-in: only methods named in
 * this array are reachable from the host. The host runtime synthesises
 * a `ServiceProxy` with exactly those methods, plus the standard
 * `start` / `stop` lifecycle. Constructors and other methods stay
 * private to the worker.
 */
export type RemoteServiceClass = {
    /** Identifier used by `runtime.getService(serviceType)`. */
    serviceType: string;
    /** Explicit allowlist of methods that can be invoked via host RPC. */
    rpcMethods: readonly string[];
    /** Optional human-readable description; passes through to the host. */
    capabilityDescription?: string;
    /** Factory; the bootstrap calls this to materialise the service. */
    start: (runtime: unknown) => Promise<RemoteServiceInstance>;
    /** Optional per-runtime teardown. */
    stopRuntime?: (runtime: unknown) => Promise<void>;
};
export interface RemoteServiceInstance {
    stop?: () => Promise<void> | void;
}
/** Mapping from rpc.id → live handler, plus its surface kind for routing. */
export interface HandlerRegistry {
    get(id: string): HandlerEntry | undefined;
    set(id: string, entry: HandlerEntry): void;
    clear(): void;
    readonly size: number;
}
export interface HandlerEntry {
    id: string;
    surface: PluginSurfaceKind;
    /** Surface-specific target name (action name, service.method, etc.). */
    target: string;
    handler: AnyHandler;
}
export declare function createHandlerRegistry(): HandlerRegistry;
/** Plugin object as seen by the worker bootstrap (loose typing to avoid pulling in @elizaos/core internals here). */
export type WorkerPluginShape = {
    name: string;
    description?: string;
    mode?: "direct" | "remote";
    priority?: number;
    dependencies?: string[];
    config?: Record<string, JsonValue>;
    schema?: Record<string, JsonValue>;
    actions?: Array<{
        name: string;
        similes?: string[];
        description?: string;
        examples?: JsonValue;
        validate?: AnyHandler;
        handler: AnyHandler;
    }>;
    providers?: Array<{
        name: string;
        description?: string;
        dynamic?: boolean;
        position?: number;
        private?: boolean;
        get: AnyHandler;
    }>;
    services?: Array<RemoteServiceClass>;
    models?: Record<string, AnyHandler>;
    events?: Record<string, Array<AnyHandler>>;
    routes?: Array<{
        type?: string;
        name?: string;
        path: string;
        public?: boolean;
        isMultipart?: boolean;
        routeHandler?: AnyHandler;
    }>;
    views?: Array<JsonValue>;
    widgets?: Array<JsonValue>;
    componentTypes?: Array<JsonValue>;
    evaluators?: Array<{
        name: string;
        description?: string;
        validate?: AnyHandler;
        handler: AnyHandler;
    }>;
    init?: AnyHandler;
    [key: string]: unknown;
};
export declare function buildAnnounceDescriptor(plugin: WorkerPluginShape, registry: HandlerRegistry): JsonObject;
//# sourceMappingURL=descriptor.d.ts.map