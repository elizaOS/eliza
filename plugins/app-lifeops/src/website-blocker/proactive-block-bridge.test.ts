import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BlockRule } from "./chat-integration/block-rule-schema.js";
import {
  evaluateProactiveBlockOnBrowserFocus,
  type ProactiveBlockBridgeAlert,
  type ProactiveBlockBridgeDeps,
} from "./proactive-block-bridge.js";

const NIGHT_NOW = new Date("2026-05-03T22:30:00Z"); // 22:30 UTC, inside default night window 21:00-24:00.
const DAY_NOW = new Date("2026-05-03T14:30:00Z"); // 14:30 UTC, outside both default windows.

function makeRuntime(): IAgentRuntime {
  // The bridge never reaches `runtime.adapter.db` when `loadActiveRules` is
  // injected, so the empty stub mirrors the existing
  // `browser-extension-store.test.ts` runtime shape.
  return {
    agentId: "00000000-0000-0000-0000-00000000aaaa",
  } as unknown as IAgentRuntime;
}

function makeRule(overrides: Partial<BlockRule> = {}): BlockRule {
  return {
    id: "rule-x-evening",
    agentId: "00000000-0000-0000-0000-00000000aaaa",
    profile: "focus",
    websites: ["x.com"],
    gateType: "fixed_duration",
    gateTodoId: null,
    gateUntilMs: null,
    fixedDurationMs: 60 * 60_000,
    unlockDurationMs: null,
    active: true,
    createdAt: Date.now(),
    releasedAt: null,
    releasedReason: null,
    ...overrides,
  };
}

interface BridgeStubs {
  startBlock: ReturnType<typeof vi.fn>;
  sendAlert: ReturnType<typeof vi.fn>;
  loadActiveRules: ReturnType<typeof vi.fn>;
  deps: ProactiveBlockBridgeDeps;
}

function makeStubs(options: {
  rules: readonly BlockRule[];
  now: Date;
  timezone?: string;
  startSucceeds?: boolean;
}): BridgeStubs {
  const startBlock = vi.fn(async () => ({
    success: options.startSucceeds ?? true,
  }));
  const sendAlert = vi.fn(async (_alert: ProactiveBlockBridgeAlert) => undefined);
  const loadActiveRules = vi.fn(async () => options.rules);
  return {
    startBlock,
    sendAlert,
    loadActiveRules,
    deps: {
      now: () => options.now,
      timezone: options.timezone ?? "UTC",
      startBlock,
      sendAlert,
      loadActiveRules,
    },
  };
}

describe("evaluateProactiveBlockOnBrowserFocus", () => {
  it("fires startSelfControlBlock and a user-facing alert when a matching active rule exists in the night window", async () => {
    const stubs = makeStubs({ rules: [makeRule()], now: NIGHT_NOW });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toBe("blocked");
    expect(outcome.ruleId).toBe("rule-x-evening");
    expect(outcome.enforcementWindowKind).toBe("night");

    expect(stubs.startBlock).toHaveBeenCalledTimes(1);
    const startArg = stubs.startBlock.mock.calls[0]?.[0];
    expect(startArg).toMatchObject({
      websites: ["x.com"],
      durationMinutes: null,
    });
    expect(startArg?.metadata).toMatchObject({
      managedBy: "lifeops",
      reason: "proactive_browser_focus_match",
      ruleId: "rule-x-evening",
      observedDomain: "x.com",
    });

    expect(stubs.sendAlert).toHaveBeenCalledTimes(1);
    const alert = stubs.sendAlert.mock.calls[0]?.[0] as ProactiveBlockBridgeAlert;
    expect(alert.text).toContain("x.com");
    expect(alert.text).toContain("this evening");
    expect(alert.text).toContain("blocking it now");
    expect(alert.ruleId).toBe("rule-x-evening");
    expect(alert.enforcementWindowKind).toBe("night");
    expect(outcome.alertText).toBe(alert.text);
  });

  it("matches a rule for x.com against an alias domain (twitter.com) via the engine policy expansion", async () => {
    const stubs = makeStubs({ rules: [makeRule()], now: NIGHT_NOW });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "mobile.twitter.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(true);
    expect(stubs.startBlock).toHaveBeenCalledTimes(1);
    expect(stubs.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire when no matching rule exists, even inside an enforcement window", async () => {
    const stubs = makeStubs({
      rules: [makeRule({ id: "rule-reddit", websites: ["reddit.com"] })],
      now: NIGHT_NOW,
    });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("no_matching_rule");
    expect(outcome.enforcementWindowKind).toBe("night");
    expect(stubs.startBlock).not.toHaveBeenCalled();
    expect(stubs.sendAlert).not.toHaveBeenCalled();
  });

  it("does NOT fire when the rule list is empty (no active rules at all)", async () => {
    const stubs = makeStubs({ rules: [], now: NIGHT_NOW });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("no_active_rules");
    expect(stubs.startBlock).not.toHaveBeenCalled();
    expect(stubs.sendAlert).not.toHaveBeenCalled();
  });

  it("does NOT fire when the rule exists but the current time is outside any enforcement window (rule expired for this slot)", async () => {
    const stubs = makeStubs({ rules: [makeRule()], now: DAY_NOW });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("outside_enforcement_window");
    expect(outcome.enforcementWindowKind).toBe("none");
    // Rule lookup is short-circuited — no DB read when the time gate fails.
    expect(stubs.loadActiveRules).not.toHaveBeenCalled();
    expect(stubs.startBlock).not.toHaveBeenCalled();
    expect(stubs.sendAlert).not.toHaveBeenCalled();
  });

  it("returns block_failed and skips the alert when the engine refuses to start (e.g. block already running)", async () => {
    const stubs = makeStubs({
      rules: [makeRule()],
      now: NIGHT_NOW,
      startSucceeds: false,
    });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("block_failed");
    expect(outcome.ruleId).toBe("rule-x-evening");
    expect(stubs.startBlock).toHaveBeenCalledTimes(1);
    expect(stubs.sendAlert).not.toHaveBeenCalled();
  });

  it("rejects an invalid (empty) domain without touching the engine or rule store", async () => {
    const stubs = makeStubs({ rules: [makeRule()], now: NIGHT_NOW });

    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "   " },
      stubs.deps,
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("invalid_domain");
    expect(stubs.loadActiveRules).not.toHaveBeenCalled();
    expect(stubs.startBlock).not.toHaveBeenCalled();
    expect(stubs.sendAlert).not.toHaveBeenCalled();
  });

  it("returns no_active_rules with no DB on the runtime (default loader short-circuits)", async () => {
    // Same shape the existing `browser-extension-store.test.ts` uses: no
    // `adapter.db`, so the default `BlockRuleReader` loader cannot run. The
    // bridge must not throw — that's what makes it safe to wire into
    // `recordBrowserFocusWindow` without breaking that file's tests.
    const startBlock = vi.fn(async () => ({ success: true }));
    const sendAlert = vi.fn(async () => undefined);
    const outcome = await evaluateProactiveBlockOnBrowserFocus(
      makeRuntime(),
      { domain: "x.com" },
      {
        now: () => NIGHT_NOW,
        timezone: "UTC",
        startBlock,
        sendAlert,
      },
    );

    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toBe("no_active_rules");
    expect(startBlock).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });
});
