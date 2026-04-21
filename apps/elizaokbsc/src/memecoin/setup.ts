import type { AgentRuntime } from "@elizaos/core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDiscoveryConfig } from "./config";
import { loadPaperAgents, savePaperAgents, spawnDefaultAgentFleet, buildGooPaperSummary } from "./goo-paper-engine";
import { pushNotification, setLatestSnapshot, setPaperAgents, setPaperSummary } from "./store";
import { ensureDiscoveryTask, runElizaOkDiscoveryCycle } from "./worker";

export async function setupElizaOkDiscovery(
  runtime: AgentRuntime,
): Promise<void> {
  const config = getDiscoveryConfig();
  const reportsDir = path.resolve(config.reportsDir);

  // Pre-load latest snapshot from disk so dashboard renders immediately
  try {
    const snapshotRaw = await readFile(path.join(reportsDir, "latest.json"), "utf-8");
    const snapshot = JSON.parse(snapshotRaw);
    setLatestSnapshot(snapshot);
    runtime.logger.info("ElizaOK: Pre-loaded latest snapshot from disk");
  } catch {
    runtime.logger.info("ElizaOK: No previous snapshot found on disk");
  }

  // Pre-load Goo agents from disk so dashboard has data immediately,
  // even if the first discovery cycle is slow or fails.
  try {
    let agents = await loadPaperAgents(config.reportsDir);
    if (agents.length === 0) {
      agents = spawnDefaultAgentFleet(1.0);
      await savePaperAgents(config.reportsDir, agents);
      for (const a of agents) {
        pushNotification({
          type: "respawn",
          severity: "info",
          title: `Agent spawned: ${a.agentName}`,
          detail: `Strategy: ${a.strategy.label} | Treasury: ${a.treasuryBnb.toFixed(2)} BNB`,
        });
      }
      runtime.logger.info(
        { count: agents.length },
        "ElizaOK: Spawned default Goo agent fleet at startup",
      );
    } else {
      runtime.logger.info(
        { count: agents.length },
        "ElizaOK: Pre-loaded Goo agents from disk",
      );
    }
    setPaperAgents(agents);
    setPaperSummary(buildGooPaperSummary(agents));
  } catch (e) {
    runtime.logger.warn("ElizaOK: Failed to pre-load Goo agents at startup");
  }

  await ensureDiscoveryTask(runtime);

  if (config.enabled && config.runOnStartup) {
    await runElizaOkDiscoveryCycle(runtime, "startup");
  }
}
