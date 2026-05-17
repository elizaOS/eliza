/**
 * useDesktopBridgeEvent — declarative wrapper around
 * `subscribeDesktopBridgeEvent` from `../bridge/electrobun-rpc`.
 *
 * The underlying bridge API takes a structured options object with both an
 * `rpcMessage` (the Electrobun renderer-side message name) and an
 * `ipcChannel` (the bun-side IPC channel). Both are required by the bridge,
 * so this hook surfaces them rather than the simplified `eventType: string`
 * signature originally proposed — calling the bridge with only one would
 * either drop the renderer-side subscription or break IPC routing.
 *
 * Resolved signature:
 *
 *   useDesktopBridgeEvent<T>(
 *     options: { rpcMessage: string; ipcChannel: string },
 *     handler: (payload: T) => void,
 *   ): void;
 *
 * The handler is captured via a ref so callers can pass an inline arrow
 * function without triggering re-subscription on every render. The
 * subscription is torn down on unmount and re-established when either of
 * the channel identifiers changes.
 */
export interface DesktopBridgeEventOptions {
  rpcMessage: string;
  ipcChannel: string;
}
export declare function useDesktopBridgeEvent<T = unknown>(
  options: DesktopBridgeEventOptions,
  handler: (payload: T) => void,
): void;
//# sourceMappingURL=useDesktopBridgeEvent.d.ts.map
