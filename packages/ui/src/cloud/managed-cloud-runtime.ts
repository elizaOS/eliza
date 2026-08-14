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
