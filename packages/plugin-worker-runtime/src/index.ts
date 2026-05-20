/**
 * @elizaos/plugin-worker-runtime — worker-side bootstrap for remote-mode
 * elizaOS plugins.
 *
 * Primary entrypoint: {@link bootstrap}. See `./bootstrap.ts` for the
 * worker authoring pattern.
 *
 * Re-exports the building blocks for advanced integrations (custom
 * transports, host-side test harnesses):
 *
 * - {@link WorkerChannel} — transport adapter contract
 * - {@link createWorkerChannel} — default Worker postMessage adapter
 * - {@link RuntimeProxy} / {@link buildRuntimeProxyApi} — host-rpc client
 * - {@link buildAnnounceDescriptor} — Plugin → JSON descriptor
 * - {@link createWorkerRpcDispatcher} — worker-rpc handler
 */

export { bootstrap, type BootstrapOptions } from "./bootstrap.ts";
export {
	createWorkerChannel,
	createRequestIdAllocator,
	type WorkerChannel,
} from "./envelope.ts";
export {
	RuntimeProxy,
	buildRuntimeProxyApi,
	SUPPORTED_RUNTIME_METHODS,
	type RuntimeProxyApi,
	type RuntimeProxyMethod,
	type RuntimeProxyOptions,
} from "./runtime-proxy.ts";
export {
	buildAnnounceDescriptor,
	createHandlerRegistry,
	type AnyHandler,
	type HandlerEntry,
	type HandlerRegistry,
	type WorkerPluginShape,
} from "./descriptor.ts";
export {
	createWorkerRpcDispatcher,
	type DispatchContext,
} from "./dispatch.ts";
export { toWireError, fromWireError, type WireError } from "./error.ts";
