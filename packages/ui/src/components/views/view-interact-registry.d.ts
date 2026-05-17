/**
 * view-interact-registry — bridges WS `view:interact` messages to loaded view modules.
 *
 * DynamicViewLoader registers an interact handler when a view module is loaded
 * and unregisters it on unmount.  The startup-phase WS listener calls
 * `dispatchViewInteract` when it receives a `view:interact` message from the
 * server, which routes it to the correct handler and sends the result back.
 */
type InteractHandler = (
  capability: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;
export declare function registerViewInteractHandler(
  viewId: string,
  handler: InteractHandler,
): () => void;
/**
 * Called by the startup-phase WS listener when a `view:interact` message
 * arrives.  Routes to the correct handler and sends the result back via WS.
 */
export declare function dispatchViewInteract(
  viewId: string,
  capability: string,
  params: Record<string, unknown> | undefined,
  requestId: string,
): Promise<void>;
//# sourceMappingURL=view-interact-registry.d.ts.map
