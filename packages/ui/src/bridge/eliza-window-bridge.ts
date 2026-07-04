/**
 * eliza-window-bridge — the single namespaced RPC surface native hosts, devtools,
 * and e2e drivers use to invoke in-page capabilities.
 *
 * Executable capabilities are registered into a module-private registry and are
 * reachable only through the frozen `window.__ELIZA_BRIDGE__` object. No bare
 * function-valued `__ELIZA_*` window slot is written, so a same-origin script
 * cannot replace or wrap a capability: the bridge object is installed once and
 * defined non-writable / non-configurable, its capability slots are get-only
 * accessors that delegate to the private registry, and re-installation is a
 * no-op. A capability accessor returns a function only once its owner module has
 * registered it (so `typeof window.__ELIZA_BRIDGE__?.<cap> === "function"`
 * still means "installed and ready", matching the pre-bridge window-slot probe).
 */

import type {
  IosLocalAgentNativeRequestOptions,
  IosLocalAgentNativeRequestResult,
} from "../api/ios-local-agent-transport";
import type { invokeViewInteract } from "../components/views/view-interact-registry";

export interface ElizaWindowBridgeCapabilities {
  /** iOS native host → in-page local-agent request dispatch (ITTP transport). */
  iosLocalAgentRequest: (
    options: IosLocalAgentNativeRequestOptions,
  ) => Promise<IosLocalAgentNativeRequestResult>;
  /** Agent / devtools / e2e → invoke a mounted view's interact handler. */
  viewInteract: typeof invokeViewInteract;
}

export interface ElizaWindowBridge {
  readonly iosLocalAgentRequest?: ElizaWindowBridgeCapabilities["iosLocalAgentRequest"];
  readonly viewInteract?: ElizaWindowBridgeCapabilities["viewInteract"];
}

declare global {
  interface Window {
    __ELIZA_BRIDGE__?: ElizaWindowBridge;
  }
}

/**
 * Module-private capability registry. Shared across every importer of this
 * module (single package instance), so both the iOS transport and the view
 * registry contribute into one bridge. Mutable by design: last registration of
 * a capability wins, matching the previous last-writer-wins window assignment.
 */
const registry: Partial<ElizaWindowBridgeCapabilities> = {};

export function registerElizaBridgeCapability<
  K extends keyof ElizaWindowBridgeCapabilities,
>(capability: K, handler: ElizaWindowBridgeCapabilities[K]): void {
  registry[capability] = handler;
}

const bridge: ElizaWindowBridge = Object.freeze(
  Object.defineProperties({} as ElizaWindowBridge, {
    iosLocalAgentRequest: {
      enumerable: true,
      get: () => registry.iosLocalAgentRequest,
    },
    viewInteract: {
      enumerable: true,
      get: () => registry.viewInteract,
    },
  }),
);

/**
 * Install the frozen bridge on `window`. Idempotent and safe under duplicate
 * bundle copies: if `window.__ELIZA_BRIDGE__` already exists (installed by this
 * or another copy) the call is a no-op and returns the live object. The slot is
 * non-writable and non-configurable, so it cannot later be replaced or deleted.
 */
export function installElizaBridge(): ElizaWindowBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const existing = window.__ELIZA_BRIDGE__;
  if (existing) return existing;
  Object.defineProperty(window, "__ELIZA_BRIDGE__", {
    value: bridge,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return window.__ELIZA_BRIDGE__;
}
