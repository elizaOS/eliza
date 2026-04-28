/**
 * Cold reload strategy — full runtime swap.
 *
 * Phase 1: delegates to the existing `restartRuntime` closure injected by
 * the API server. Reports phase boundaries (`shutdown-old`, `start-new`,
 * `swap`) from the manager's perspective; `restartRuntime` itself is
 * opaque, so the inner phases are recorded as a single bracketed step.
 */

import type { AgentRuntime } from "@elizaos/core";
import type { ReloadContext, ReloadStrategy } from "./types.js";

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
      const reason = describeIntent(ctx.intent);

      const shutdownStart = Date.now();
      await ctx.reportPhase({
        name: "shutdown-old",
        status: "running",
        startedAt: shutdownStart,
      });

      const startNewStart = Date.now();
      await ctx.reportPhase({
        name: "shutdown-old",
        status: "succeeded",
        startedAt: shutdownStart,
        finishedAt: startNewStart,
      });

      await ctx.reportPhase({
        name: "start-new",
        status: "running",
        startedAt: startNewStart,
      });

      const newRuntime = await restartRuntime(reason);
      const startNewEnd = Date.now();

      if (!newRuntime) {
        await ctx.reportPhase({
          name: "start-new",
          status: "failed",
          startedAt: startNewStart,
          finishedAt: startNewEnd,
          error: { message: "Cold restart returned null runtime" },
        });
        throw new Error("Cold restart returned null runtime");
      }

      await ctx.reportPhase({
        name: "start-new",
        status: "succeeded",
        startedAt: startNewStart,
        finishedAt: startNewEnd,
      });

      const swapStart = startNewEnd;
      await ctx.reportPhase({
        name: "swap",
        status: "running",
        startedAt: swapStart,
      });
      // The actual swap into server.ts state is owned by `restartRuntime`'s
      // closure; from the strategy's perspective, the moment we've received
      // a non-null runtime back the swap has happened.
      await ctx.reportPhase({
        name: "swap",
        status: "succeeded",
        startedAt: swapStart,
        finishedAt: Date.now(),
      });

      return newRuntime;
    },
  };
}

function describeIntent(intent: ReloadContext["intent"]): string {
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
