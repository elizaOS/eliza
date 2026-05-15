/**
 * view-interact-registry — bridges WS `view:interact` messages to loaded view modules.
 *
 * DynamicViewLoader registers an interact handler when a view module is loaded
 * and unregisters it on unmount.  The startup-phase WS listener calls
 * `dispatchViewInteract` when it receives a `view:interact` message from the
 * server, which routes it to the correct handler and sends the result back.
 */

import { client } from "../../api";

type InteractHandler = (
  capability: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

/** viewId → handler registered by the mounted DynamicViewLoader. */
const handlers = new Map<string, InteractHandler>();

export function registerViewInteractHandler(
  viewId: string,
  handler: InteractHandler,
): () => void {
  handlers.set(viewId, handler);
  return () => {
    if (handlers.get(viewId) === handler) {
      handlers.delete(viewId);
    }
  };
}

/**
 * Called by the startup-phase WS listener when a `view:interact` message
 * arrives.  Routes to the correct handler and sends the result back via WS.
 */
export async function dispatchViewInteract(
  viewId: string,
  capability: string,
  params: Record<string, unknown> | undefined,
  requestId: string,
): Promise<void> {
  const handler = handlers.get(viewId);

  if (!handler) {
    client.sendWsMessage({
      type: "view:interact:result",
      requestId,
      success: false,
      error: `No interact handler registered for view "${viewId}" — view may not be mounted`,
    });
    return;
  }

  try {
    const result = await handler(capability, params);
    client.sendWsMessage({
      type: "view:interact:result",
      requestId,
      success: true,
      result,
    });
  } catch (err) {
    client.sendWsMessage({
      type: "view:interact:result",
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
