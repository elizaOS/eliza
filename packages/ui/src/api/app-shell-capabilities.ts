import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";
import { isDirectCloudSharedAgentBase } from "./client-cloud";

/**
 * Direct Cloud agent bases are chat adapters, not full desktop/app-shell
 * runtimes. They intentionally do not expose routes such as /api/views,
 * /api/apps/runs, /api/workbench/todos, /api/approvals, or orchestrator state.
 */
export function isLimitedCloudAgentApiBase(
  value: string | null | undefined,
): boolean {
  return (
    isDirectCloudSharedAgentBase(value) || isDedicatedCloudAgentBase(value)
  );
}

export function supportsFullAppShellRoutes(
  value: string | null | undefined,
): boolean {
  return !isLimitedCloudAgentApiBase(value);
}
