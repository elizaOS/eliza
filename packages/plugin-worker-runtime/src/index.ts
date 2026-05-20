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

export { type BootstrapOptions, bootstrap } from "./bootstrap";
export {
  type AnyHandler,
  buildAnnounceDescriptor,
  createHandlerRegistry,
  type HandlerEntry,
  type HandlerRegistry,
  type WorkerPluginShape,
} from "./descriptor";
export {
  createWorkerRpcDispatcher,
  type DispatchContext,
} from "./dispatch";
export {
  createDefaultChannel,
  createRequestIdAllocator,
  createSubprocessChannel,
  createWorkerChannel,
  type WorkerChannel,
} from "./envelope";
export { fromWireError, toWireError, type WireError } from "./error";
export {
  buildRuntimeProxyApi,
  RuntimeProxy,
  type RuntimeProxyApi,
  type RuntimeProxyMethod,
  type RuntimeProxyOptions,
  SUPPORTED_RUNTIME_METHODS,
} from "./runtime-proxy";
