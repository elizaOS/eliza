/**
 * Narrow stub for `@elizaos/app-lifeops` so scenario-runner does not compile the full app-lifeops graph.
 * Live flows use the workspace package instead.
 */

import type { IAgentRuntime } from "@elizaos/core";

export async function executeLifeOpsSchedulerTask(
  _runtime: IAgentRuntime,
  _opts: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return { ok: false, skipped: true, reason: "scenario-runner shim" };
}
