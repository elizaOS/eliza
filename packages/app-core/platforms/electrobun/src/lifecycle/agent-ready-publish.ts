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
