import type { AgentRuntime } from "@elizaos/core";
import { getDiscoveryConfig } from "./config";
import { ensureDiscoveryTask, runElizaOkDiscoveryCycle } from "./worker";

export async function setupElizaOkDiscovery(
  runtime: AgentRuntime,
): Promise<void> {
  const config = getDiscoveryConfig();
  await ensureDiscoveryTask(runtime);

  if (config.enabled && config.runOnStartup) {
    await runElizaOkDiscoveryCycle(runtime, "startup");
  }
}
