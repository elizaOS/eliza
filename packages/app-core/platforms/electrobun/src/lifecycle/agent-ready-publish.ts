/**
 * agent-ready-publish — publish the embedded agent's renderer-facing API base.
 *
 * Window-INDEPENDENT by design. `setCurrent` runs even when `targets` is
 * empty, so `apiBaseOwner` holds the correct value before any window exists.
 * A window that mounts later reads it via
 * `apiBaseOwner.injectIntoHtml` (static-server HTML inject) or its
 * `dom-ready` → `injectApiBase` handler. When windows are already open,
 * pushing keeps their live renderer in sync immediately.
 */
import * as apiBaseOwner from "./api-base-owner";

/** Minimal window shape that `apiBaseOwner.pushToWindow` accepts. */
export interface PushableWindow {
  webview: { rpc?: unknown };
}

export function publishAgentApiBase(
  rendererBase: string,
  apiToken: string,
  targets: Iterable<PushableWindow> = [],
): void {
  apiBaseOwner.setCurrent(rendererBase, apiToken);
  for (const win of targets) {
    apiBaseOwner.pushToWindow(win);
  }
}

/**
 * Publish an embedded/local agent only after resolving its canonical desktop
 * bearer.  The local bearer is minted by the native agent authority and is
 * not guaranteed to have originated in `process.env`.  Re-reading only the
 * environment here can therefore replace a valid startup token with an empty
 * string, leaving every subsequently-created detached window unauthorized.
 */
export function publishLocalAgentApiBase(
  rendererBase: string,
  resolveLocalApiToken: () => string,
  targets: Iterable<PushableWindow> = [],
): void {
  const apiToken = resolveLocalApiToken().trim();
  if (!apiToken) {
    throw new Error(
      "Local desktop API token authority returned an empty token",
    );
  }
  publishAgentApiBase(rendererBase, apiToken, targets);
}
