import type { Plugin, IAgentRuntime } from "@elizaos/core";

import { ScoutClient } from "./client/scout-client.js";
import { ScoutCache } from "./client/cache.js";
import { loadConfig } from "./config.js";
import { setScoutClient, setScoutConfig } from "./runtime-store.js";

import { checkServiceAction } from "./actions/check-service.js";
import { checkFidelityAction } from "./actions/check-fidelity.js";
import { scanSkillAction } from "./actions/scan-skill.js";
import { browseLeaderboardAction } from "./actions/browse-leaderboard.js";
import { batchScoreAction } from "./actions/batch-score.js";

import { trustContextProvider } from "./providers/trust-context.js";
import { trustPolicyProvider } from "./providers/trust-policy.js";

import { transactionGuardEvaluator } from "./evaluators/transaction-guard.js";

import { TrustMonitorService } from "./services/trust-monitor.js";

export const scoutPlugin: Plugin = {
  name: "@scoutscore/plugin-eliza",
  description:
    "Scout trust intelligence - x402 service verification, skill scanning, and transaction safety for ELIZA OS agents",

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const pluginConfig = loadConfig((key) => runtime.getSetting(key));
    const cache = new ScoutCache({
      ttlMinutes: pluginConfig.cacheTtl,
      maxEntries: 500,
    });
    const client = new ScoutClient(
      {
        baseUrl: pluginConfig.apiUrl,
        apiKey: pluginConfig.apiKey || undefined,
        agentId: runtime.agentId,
        agentName: runtime.character?.name,
      },
      cache
    );

    // Store in WeakMap for cross-component access
    setScoutClient(runtime, client);
    setScoutConfig(runtime, pluginConfig);

    // Start background monitoring if domains are configured
    if (pluginConfig.watchedDomains.length > 0) {
      try {
        await TrustMonitorService.start(runtime);
      } catch {
        // Monitor failure should not prevent plugin initialization
      }
    }
  },

  actions: [
    checkServiceAction,
    checkFidelityAction,
    scanSkillAction,
    browseLeaderboardAction,
    batchScoreAction,
  ],

  providers: [
    trustContextProvider,
    trustPolicyProvider,
  ],

  evaluators: [
    transactionGuardEvaluator,
  ],
};

// Re-export components for advanced usage
export { ScoutClient } from "./client/scout-client.js";
export { ScoutCache } from "./client/cache.js";
export { loadConfig } from "./config.js";
export type { ScoutPluginConfig } from "./config.js";
export * from "./client/types.js";
export * from "./utils/trust-levels.js";
export * from "./utils/flag-interpreter.js";
export * from "./utils/recommendations.js";

export default scoutPlugin;