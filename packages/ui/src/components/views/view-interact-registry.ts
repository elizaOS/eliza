/**
 * view-interact-registry — bridges WS `view:interact` messages to loaded view modules.
 *
 * DynamicViewLoader registers an interact handler when a view module is loaded
 * and unregisters it on unmount.  The startup-phase WS listener calls
 * `dispatchViewInteract` when it receives a `view:interact` message from the
 * server, which routes it to the correct handler and sends the result back.
 */

import type { AgentViewType } from "../../agent-surface";
import { client } from "../../api";

type InteractHandler = (
  capability: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

type ViewType = AgentViewType;

function handlerKey(viewId: string, viewType: ViewType): string {
  return `${viewType}:${viewId}`;
}

/** viewType:viewId → handler registered by the mounted DynamicViewLoader. */
const handlers = new Map<string, InteractHandler>();
const handledRequestIds = new Map<string, ReturnType<typeof setTimeout>>();
const HANDLED_REQUEST_TTL_MS = 60_000;

export function registerViewInteractHandler(
  viewId: string,
  viewType: ViewType,
  handler: InteractHandler,
): () => void {
  const key = handlerKey(viewId, viewType);
  handlers.set(key, handler);
  return () => {
    if (handlers.get(key) === handler) {
      handlers.delete(key);
    }
  };
}

/**
 * Called by the startup-phase WS listener when a `view:interact` message
 * arrives.  Routes to the correct handler and sends the result back via WS.
 */
export async function dispatchViewInteract(
  viewId: string,
  viewType: ViewType | undefined,
  capability: string,
  params: Record<string, unknown> | undefined,
  requestId: string,
): Promise<void> {
  const resolvedViewType = viewType ?? "gui";
  const handler = handlers.get(handlerKey(viewId, resolvedViewType));

  if (!handler) {
    // The API broadcasts view-interact requests to every connected shell.
    // Clients that do not currently mount the target view must stay silent so
    // they do not race the mounted client and resolve the request as failed.
    return;
  }
  if (handledRequestIds.has(requestId)) {
    return;
  }
  const timeout = setTimeout(() => {
    handledRequestIds.delete(requestId);
  }, HANDLED_REQUEST_TTL_MS);
  (timeout as { unref?: () => void }).unref?.();
  handledRequestIds.set(requestId, timeout);

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
