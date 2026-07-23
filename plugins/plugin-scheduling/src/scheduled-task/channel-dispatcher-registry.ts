/**
 * Per-runtime registry of contributed dispatch channels for the scheduled-task
 * spine. A consumer plugin (or the agent host) that owns a recipe-style
 * scheduled behavior — deterministic domain work executed at fire time, like
 * the built-in coding-agent pr-shepherd channel — registers a channel key plus
 * the dispatcher that handles it. The runner host routes any dispatch whose
 * `channelKey` matches a contributed channel to that dispatcher and leaves
 * every other dispatch on the host's connector dispatcher, so contributions
 * never replace or reorder the host's escalation channels.
 *
 * This mirrors the `registerDefaultTaskPack` seam: plugin-scheduling stays
 * free of consumer imports (the dependency points inward — consumers import
 * this module), while consumers get structural, non-prompt-driven fire
 * behavior through the one scheduler instead of standing up a second timer.
 * Registration is keyed on the runtime (WeakMap) and duplicate channel keys
 * throw — silent override would let one plugin steal another's channel.
 *
 * Lookup happens at dispatch time, not at runner construction, so a consumer
 * that registers after the (cached, lazily built) runner exists still gets
 * routed. The runner host also folds contributed keys into `channelKeys()` /
 * `channelAvailable` so `runner.schedule()` channel validation accepts them.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { DispatchResult } from "../dispatch-types.js";
import type { ScheduledTaskDispatchRecord } from "./runner.js";

export interface ScheduledTaskChannelDispatcherContribution {
  /**
   * The escalation-step channel key this dispatcher owns. Must be globally
   * unique per runtime; pick a namespaced key (e.g. `wallet_balance_delta`).
   */
  channelKey: string;
  /** Handle one fired dispatch on this channel. Same contract as
   * {@link ScheduledTaskDispatcher.dispatch}: a typed `DispatchResult` drives
   * the runner's retry/escalation policy; `undefined` reports fire-and-forget
   * success. */
  dispatch(
    record: ScheduledTaskDispatchRecord,
  ): Promise<DispatchResult | undefined>;
}

const contributionsByRuntime = new WeakMap<
  IAgentRuntime,
  Map<string, ScheduledTaskChannelDispatcherContribution>
>();

function contributionMap(
  runtime: IAgentRuntime,
): Map<string, ScheduledTaskChannelDispatcherContribution> {
  let map = contributionsByRuntime.get(runtime);
  if (!map) {
    map = new Map();
    contributionsByRuntime.set(runtime, map);
  }
  return map;
}

/**
 * Register a contributed dispatch channel. Throws on a duplicate channel key
 * (mirrors `TaskGateRegistry.register`: silent override is a cross-plugin
 * hazard, not a feature).
 */
export function registerScheduledTaskChannelDispatcher(
  runtime: IAgentRuntime,
  contribution: ScheduledTaskChannelDispatcherContribution,
): void {
  const channelKey = contribution.channelKey;
  if (!channelKey || typeof channelKey !== "string") {
    throw new Error(
      "registerScheduledTaskChannelDispatcher: channelKey required",
    );
  }
  if (typeof contribution.dispatch !== "function") {
    throw new Error(
      `registerScheduledTaskChannelDispatcher: dispatch function required for channel "${channelKey}"`,
    );
  }
  const map = contributionMap(runtime);
  if (map.has(channelKey)) {
    throw new Error(
      `registerScheduledTaskChannelDispatcher: duplicate channel "${channelKey}"`,
    );
  }
  map.set(channelKey, contribution);
}

/** Resolve the contributed dispatcher for a channel key, if one exists. */
export function getScheduledTaskChannelDispatcher(
  runtime: IAgentRuntime,
  channelKey: string,
): ScheduledTaskChannelDispatcherContribution | null {
  return contributionsByRuntime.get(runtime)?.get(channelKey) ?? null;
}

/** All contributed channel keys registered on this runtime. */
export function listScheduledTaskChannelDispatcherKeys(
  runtime: IAgentRuntime,
): string[] {
  const map = contributionsByRuntime.get(runtime);
  return map ? Array.from(map.keys()) : [];
}
