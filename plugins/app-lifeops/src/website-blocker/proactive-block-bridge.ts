/**
 * Proactive browser-focus → block bridge.
 *
 * Closes the gap called out in `/tmp/lifeops-assessment/07-on-demand-block.md`:
 * the browser extension already records per-domain focus windows
 * (`plugins/app-lifeops/src/lifeops/browser-extension-store.ts`) and the
 * website-blocker engine can sinkhole hosts on demand
 * (`startSelfControlBlock`), but nothing previously consumed the focus
 * stream to enforce a standing "don't let me use X" rule.
 *
 * This bridge runs from `recordBrowserFocusWindow`. On every focus
 * report it asks two questions:
 *   1. Is the agent currently inside an `enforcement-windows.ts`
 *      window (morning / night by default)? If not, do nothing —
 *      "don't let me use X this evening" should not fire at noon.
 *   2. Does any active `life_block_rules` row match the focused
 *      domain (using the same policy expansion the engine itself uses,
 *      so a rule for `x.com` matches a focused `twitter.com` tab)?
 *
 * On match it calls `startSelfControlBlock` and emits a user-facing
 * chat alert that names the domain. The bridge is the first runtime
 * consumer of `enforcement-windows.ts` outside the reminder pipeline,
 * which until now was the only call site.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import {
  type EnforcementWindow,
  getCurrentEnforcementWindow,
} from "../lifeops/enforcement-windows.js";
import type { BlockRule } from "./chat-integration/block-rule-schema.js";
import { BlockRuleReader } from "./chat-integration/block-rule-service.js";
import {
  buildSelfControlBlockPolicy,
  isWebsiteBlockedByPolicy,
  startSelfControlBlock,
} from "./engine.js";

export type ProactiveBlockBridgeReason =
  | "blocked"
  | "no_active_rules"
  | "outside_enforcement_window"
  | "no_matching_rule"
  | "block_failed"
  | "rule_lookup_failed"
  | "invalid_domain";

export interface ProactiveBlockBridgeOutcome {
  blocked: boolean;
  reason: ProactiveBlockBridgeReason;
  ruleId: string | null;
  domain: string;
  alertText: string | null;
  enforcementWindowKind: EnforcementWindow["kind"];
}

export interface ProactiveBlockBridgeDeps {
  /** Override the engine call. Defaults to `startSelfControlBlock`. */
  startBlock?: (request: {
    websites: string[];
    durationMinutes: number | null;
    metadata: Record<string, unknown>;
  }) => Promise<{ success: boolean }>;
  /** Override the alert dispatcher. Defaults to `runtime.sendMessageToTarget` to the rule's profile room. */
  sendAlert?: (alert: ProactiveBlockBridgeAlert) => Promise<void>;
  /** Read active rules. Defaults to `BlockRuleReader.listActiveBlocks`. */
  loadActiveRules?: (runtime: IAgentRuntime) => Promise<readonly BlockRule[]>;
  /** Override "now" — used by the enforcement-window check. */
  now?: () => Date;
  /** Override the IANA timezone. Defaults to `resolveDefaultTimeZone()`. */
  timezone?: string;
  /** Override the enforcement windows. Defaults to morning + night. */
  enforcementWindows?: readonly EnforcementWindow[];
}

export interface ProactiveBlockBridgeAlert {
  text: string;
  domain: string;
  ruleId: string;
  enforcementWindowKind: EnforcementWindow["kind"];
}

function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().toLowerCase().replace(/\.+$/, "");
  return trimmed.length === 0 ? null : trimmed;
}

function ruleMatchesDomain(rule: BlockRule, focusedDomain: string): boolean {
  if (rule.websites.length === 0) return false;
  const policy = buildSelfControlBlockPolicy(rule.websites);
  return isWebsiteBlockedByPolicy(policy, focusedDomain);
}

function buildAlertText(
  domain: string,
  windowKind: EnforcementWindow["kind"],
): string {
  const phrase =
    windowKind === "night"
      ? "this evening"
      : windowKind === "morning"
        ? "this morning"
        : "right now";
  return `You said you didn't want to use ${domain} ${phrase} — blocking it now.`;
}

function runtimeDbAvailable(runtime: IAgentRuntime): boolean {
  const db = (runtime as { adapter?: { db?: unknown } }).adapter?.db;
  return (
    typeof db === "object" &&
    db !== null &&
    typeof (db as { execute?: unknown }).execute === "function"
  );
}

async function defaultLoadActiveRules(
  runtime: IAgentRuntime,
): Promise<readonly BlockRule[]> {
  if (!runtimeDbAvailable(runtime)) {
    return [];
  }
  const reader = new BlockRuleReader(runtime);
  return reader.listActiveBlocks();
}

async function defaultSendAlert(
  runtime: IAgentRuntime,
  alert: ProactiveBlockBridgeAlert,
): Promise<void> {
  const send = (
    runtime as { sendMessageToTarget?: IAgentRuntime["sendMessageToTarget"] }
  ).sendMessageToTarget;
  if (typeof send !== "function") {
    return;
  }
  await send.call(
    runtime,
    {
      source: "agent",
      entityId: runtime.agentId,
    } as Parameters<IAgentRuntime["sendMessageToTarget"]>[0],
    {
      text: alert.text,
      source: "agent",
      metadata: {
        lifeopsProactiveBlock: true,
        domain: alert.domain,
        ruleId: alert.ruleId,
        enforcementWindowKind: alert.enforcementWindowKind,
      },
    },
  );
}

/**
 * The single entry point. Idempotent: if the engine already has an
 * active block covering `args.domain`, `startSelfControlBlock` will
 * report "already running" (`success: false`) and the bridge returns
 * `block_failed` without raising. The reconciler is the long-lived
 * lifecycle owner; this bridge only ever asks the engine to start a
 * new short manual block when the user is observed on a banned site.
 */
export async function evaluateProactiveBlockOnBrowserFocus(
  runtime: IAgentRuntime,
  args: { domain: string; deviceId?: string | null },
  deps: ProactiveBlockBridgeDeps = {},
): Promise<ProactiveBlockBridgeOutcome> {
  const focusedDomain = normalizeDomain(args.domain);
  if (!focusedDomain) {
    return {
      blocked: false,
      reason: "invalid_domain",
      ruleId: null,
      domain: args.domain,
      alertText: null,
      enforcementWindowKind: "none",
    };
  }

  const now = deps.now ? deps.now() : new Date();
  const timezone = deps.timezone ?? resolveDefaultTimeZone();
  const windows = deps.enforcementWindows
    ? [...deps.enforcementWindows]
    : undefined;
  const activeWindow = getCurrentEnforcementWindow(now, timezone, windows);
  if (activeWindow.kind === "none") {
    return {
      blocked: false,
      reason: "outside_enforcement_window",
      ruleId: null,
      domain: focusedDomain,
      alertText: null,
      enforcementWindowKind: "none",
    };
  }

  const loadRules = deps.loadActiveRules ?? defaultLoadActiveRules;
  const rules = await loadRules(runtime);
  if (rules.length === 0) {
    return {
      blocked: false,
      reason: "no_active_rules",
      ruleId: null,
      domain: focusedDomain,
      alertText: null,
      enforcementWindowKind: activeWindow.kind,
    };
  }

  const matchingRule = rules.find((rule) =>
    ruleMatchesDomain(rule, focusedDomain),
  );
  if (!matchingRule) {
    return {
      blocked: false,
      reason: "no_matching_rule",
      ruleId: null,
      domain: focusedDomain,
      alertText: null,
      enforcementWindowKind: activeWindow.kind,
    };
  }

  const alertText = buildAlertText(focusedDomain, activeWindow.kind);
  const startBlock = deps.startBlock ?? startSelfControlBlock;
  const startResult = await startBlock({
    websites: matchingRule.websites,
    durationMinutes: null,
    metadata: {
      managedBy: "lifeops",
      reason: "proactive_browser_focus_match",
      ruleId: matchingRule.id,
      observedDomain: focusedDomain,
    },
  });

  if (!startResult.success) {
    logger.warn(
      `[ProactiveBlockBridge] startBlock declined for rule ${matchingRule.id} on ${focusedDomain}; reconciler will retry on its next tick.`,
    );
    return {
      blocked: false,
      reason: "block_failed",
      ruleId: matchingRule.id,
      domain: focusedDomain,
      alertText: null,
      enforcementWindowKind: activeWindow.kind,
    };
  }

  const sendAlert =
    deps.sendAlert ?? ((alert) => defaultSendAlert(runtime, alert));
  await sendAlert({
    text: alertText,
    domain: focusedDomain,
    ruleId: matchingRule.id,
    enforcementWindowKind: activeWindow.kind,
  });

  return {
    blocked: true,
    reason: "blocked",
    ruleId: matchingRule.id,
    domain: focusedDomain,
    alertText,
    enforcementWindowKind: activeWindow.kind,
  };
}
