/**
 * Cold reload strategy — full runtime swap.
 *
 * Delegates to the `restartRuntime` closure injected by the API server.
 * The closure is opaque (it owns shutdown + boot + state swap), so the
 * strategy reports a single terminal `cold-restart` phase rather than
 * synthetic timestamp-only sub-phases.
 */

import type { AgentRuntime } from "@elizaos/core";
import type {
  OperationIntent,
  ReloadContext,
  ReloadStrategy,
} from "./types.ts";

export interface ColdStrategyOptions {
  /**
   * Restart closure injected from the API server boot path. Returns the
   * new runtime on success or null on failure.
   */
  restartRuntime: (reason: string) => Promise<AgentRuntime | null>;
}

export function createColdStrategy(opts: ColdStrategyOptions): ReloadStrategy {
  const { restartRuntime } = opts;

  return {
    tier: "cold",
    async apply(ctx: ReloadContext): Promise<AgentRuntime> {
      const startedAt = Date.now();
      const newRuntime = await restartRuntime(describeIntent(ctx.intent));
      const finishedAt = Date.now();

      if (!newRuntime) {
        await ctx.reportPhase({
          name: "cold-restart",
          status: "failed",
          startedAt,
          finishedAt,
          error: { message: "Cold restart returned null runtime" },
        });
        throw new Error("Cold restart returned null runtime");
      }

      await ctx.reportPhase({
        name: "cold-restart",
        status: "succeeded",
        startedAt,
        finishedAt,
      });

      return newRuntime;
    },
  };
}

function describeIntent(intent: OperationIntent): string {
  switch (intent.kind) {
    case "provider-switch":
      return `provider switch to ${intent.provider}`;
    case "config-reload":
      return "config reload";
    case "plugin-enable":
      return `plugin enable: ${intent.pluginId}`;
    case "plugin-disable":
      return `plugin disable: ${intent.pluginId}`;
    case "restart":
      return intent.reason;
  }
}
