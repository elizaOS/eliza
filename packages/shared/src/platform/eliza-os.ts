/**
 * AOSP ElizaOS renderer detection. Re-exports the pure user-agent matcher from
 * `./aosp-user-agent` (the canonical, path-imported definition) and adds a
 * `navigator` probe, React-free so Node/Bun-reachable update-policy code can ask
 * "is this device an ElizaOS system image?" without importing the renderer's
 * platform barrel (Capacitor + bridge modules). `@elizaos/ui/platform`
 * re-exports these.
 */

export {
  isAospElizaUserAgent,
  userAgentHasElizaOSMarker,
} from "./aosp-user-agent.js";

import { userAgentHasElizaOSMarker } from "./aosp-user-agent.js";

/**
 * True when the current runtime is an ElizaOS AOSP system image, detected via
 * the renderer's `navigator.userAgent`. In non-browser runtimes (Node/Bun API
 * process) there is no `navigator`, so this is `false`.
 */
export function isElizaOS(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (!nav) return false;
  return userAgentHasElizaOSMarker(nav.userAgent ?? "");
}
