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
import {
  installElizaBridge,
  registerElizaBridgeCapability,
} from "../../bridge/eliza-window-bridge";

type InteractHandler = (
  capability: string,
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

type ViewType = AgentViewType;

function handlerKey(viewId: string, viewType: ViewType): string {
  return `${viewType}:${viewId}`;
}

interface HandlerRegistration {
  handler: InteractHandler;
  installationId: string | undefined;
  token: symbol;
}

/**
 * viewType:viewId → mounted handlers in ownership order. Overlapping
 * providers intentionally share one agent registry; the newest visible owner
 * answers container-scoped capabilities, and removing it restores the still-
 * mounted predecessor instead of leaving the shared registry unreachable.
 */
const handlers = new Map<string, HandlerRegistration[]>();
const handledRequestIds = new Map<string, ReturnType<typeof setTimeout>>();
const HANDLED_REQUEST_TTL_MS = 60_000;

export function registerViewInteractHandler(
  viewId: string,
  viewType: ViewType,
  handler: InteractHandler,
  installationId?: string,
): () => void {
  const key = handlerKey(viewId, viewType);
  const registration = { handler, installationId, token: Symbol(key) };
  const registrations = handlers.get(key) ?? [];
  registrations.push(registration);
  handlers.set(key, registrations);
  return () => {
    const current = handlers.get(key);
    if (!current) return;
    const index = current.findIndex(
      ({ token }) => token === registration.token,
    );
    if (index === -1) return;
    current.splice(index, 1);
    if (current.length === 0) {
      handlers.delete(key);
    }
  };
}

function currentHandler(
  viewId: string,
  viewType: ViewType,
): InteractHandler | undefined {
  return handlers.get(handlerKey(viewId, viewType))?.at(-1)?.handler;
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
  installationId: string,
): Promise<void> {
  const resolvedViewType = viewType ?? "gui";
  if (!installationId) return;
  const registration = handlers
    .get(handlerKey(viewId, resolvedViewType))
    ?.at(-1);
  const handler =
    registration?.installationId === installationId
      ? registration.handler
      : undefined;
  const identity = { viewId, viewType: resolvedViewType, installationId };

  const missingNativeReader =
    !handler && capability === "get-text" && params?.nativeOnly === true;
  // A retained or differently installed view cannot claim a replacement's work.
  if (!handler && !missingNativeReader) return;
  if (registration && registration.installationId !== installationId) return;
  if (handledRequestIds.has(requestId)) {
    return;
  }
  const timeout = setTimeout(() => {
    handledRequestIds.delete(requestId);
  }, HANDLED_REQUEST_TTL_MS);
  (timeout as { unref?: () => void }).unref?.();
  handledRequestIds.set(requestId, timeout);

  let claimId: string | undefined;
  try {
    const claim = await client.fetch<{ claimId: string }>(
      "/api/views/interact-claim",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...identity,
          requestId,
          clientId: client.clientId,
        }),
      },
    );
    claimId = claim.claimId;
    if (!claimId) return;
    if (
      handlers.get(handlerKey(viewId, resolvedViewType))?.at(-1) !==
      registration
    )
      throw new Error(
        "The mounted view changed before execution; no effect was started.",
      );
    if (!handler)
      throw new Error(
        `The ${viewId} view is not mounted on the requesting client. Show that view with VIEWS before reading its native page.`,
      );
    const result = await handler(capability, params);
    client.sendWsMessage({
      type: "view:interact:result",
      ...identity,
      claimId,
      requestId,
      success: true,
      result,
    });
  } catch (err) {
    // A lost claim response is an unknown outcome. Never execute or retry it.
    if (!claimId) return;
    client.sendWsMessage({
      type: "view:interact:result",
      ...identity,
      claimId,
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Invoke a mounted view's interact handler and RETURN its result — the same path
 * `dispatchViewInteract` runs, minus the WS round-trip. This is what lets the
 * agent (and devtools / e2e) read and drive any view's agent surface directly
 * through the frozen bridge:
 * `window.__ELIZA_BRIDGE__.viewInteract("settings","gui","list-elements",{})`,
 * `…("agent-fill",{ id, value })`, `…("agent-click",{ id })`.
 */
export async function invokeViewInteract(
  viewId: string,
  viewType: ViewType | undefined,
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const handler = currentHandler(viewId, viewType ?? "gui");
  if (!handler) {
    throw new Error(
      `No interact handler mounted for ${viewType ?? "gui"}:${viewId}`,
    );
  }
  return handler(capability, params);
}

registerElizaBridgeCapability("viewInteract", invokeViewInteract);
installElizaBridge();
