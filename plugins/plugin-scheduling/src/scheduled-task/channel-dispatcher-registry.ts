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
 * Registration is keyed on the runtime (WeakMap); duplicate channel keys and
 * reserved/built-in keys throw — the runner host routes contributed keys
 * BEFORE its built-in channels, so a contribution registered under a built-in
 * key would silently hijack that channel's dispatches.
 *
 * Lookup happens at dispatch time, not at runner construction, so a consumer
 * that registers after the (cached, lazily built) runner exists still gets
 * routed. The runner host also folds contributed keys into `channelKeys()` /
 * `channelAvailable` so `runner.schedule()` channel validation accepts them.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { PR_SHEPHERD_DISPATCH_CHANNEL } from "../coding-agent-schedules.js";
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

/**
 * Channel keys a contribution may never claim. Contributed lookup runs before
 * the built-in channels at dispatch time, so registering under one of these
 * would silently reroute the built-in channel's dispatches to the
 * contribution. Covers the coding-agent recipe channel plus the host
 * connector / in-process delivery channel kinds from the LifeOps channel pack
 * (plugin-personal-assistant `channels/default-pack.ts`) — listed literally
 * because the dependency points the other way: consumer plugins import
 * plugin-scheduling, never the reverse.
 */
export const RESERVED_SCHEDULED_TASK_CHANNEL_KEYS: ReadonlySet<string> =
  new Set([
    PR_SHEPHERD_DISPATCH_CHANNEL,
    "in_app",
    "push",
    "browser",
    "email",
    "imessage",
    "telegram",
    "discord",
    "whatsapp",
    "x",
    "x_dm",
    "sms",
    "voice",
    "twilio_voice",
  ]);

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
 * Register a contributed dispatch channel. Throws on a reserved/built-in
 * channel key (a contribution there would hijack the built-in channel's
 * dispatches) and on a duplicate channel key (mirrors
 * `TaskGateRegistry.register`: silent override is a cross-plugin hazard, not
 * a feature).
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
  if (RESERVED_SCHEDULED_TASK_CHANNEL_KEYS.has(channelKey)) {
    throw new ElizaError(
      `registerScheduledTaskChannelDispatcher: channel key "${channelKey}" is reserved for a built-in dispatch channel; contributed dispatchers must use a distinct namespaced key`,
      {
        code: "SCHEDULED_TASK_CHANNEL_KEY_RESERVED",
        context: { channelKey },
        severity: "fatal",
      },
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

/**
 * Remove one contribution during plugin unload.
 *
 * The optional identity guard prevents an older plugin instance from deleting
 * a newer registration that reused the same namespaced channel key.
 */
export function unregisterScheduledTaskChannelDispatcher(
  runtime: IAgentRuntime,
  channelKey: string,
  expected?: ScheduledTaskChannelDispatcherContribution,
): boolean {
  const map = contributionsByRuntime.get(runtime);
  const current = map?.get(channelKey);
  if (!map || !current || (expected && current !== expected)) return false;
  const removed = map.delete(channelKey);
  if (map.size === 0) contributionsByRuntime.delete(runtime);
  return removed;
}
