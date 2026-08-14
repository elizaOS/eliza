/**
 * Resolves whether the current app shell is managing an Eliza Cloud agent.
 * The hosted Cloud app remains management-capable while its persisted agent
 * binding is still restoring; local and self-hosted runtimes do not.
 */

import type { RuntimeTarget } from "../state/startup-coordinator";
import { isAppModeHost } from "./app-mode/app-mode";

export function isManagedCloudRuntime(
  target: RuntimeTarget | null | undefined,
): boolean {
  return target === "cloud-managed" || isAppModeHost();
}

/**
 * Cloud account and lifecycle controls remain reachable when the managed
 * agent runtime is unavailable. Other app-shell pages still wait for startup
 * because their data and actions belong to that runtime.
 */
export function managedCloudPageOwnsStartupFailure(
  navigationPath: string,
  target: RuntimeTarget | null | undefined,
): boolean {
  const pathname = navigationPath.split(/[?#]/, 1)[0] ?? "/";
  const isCloudPath = pathname === "/cloud" || pathname.startsWith("/cloud/");
  return isCloudPath && isManagedCloudRuntime(target);
}
