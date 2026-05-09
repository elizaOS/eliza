/**
 * W1-F — Contract validation tests.
 *
 * Confirms register / get / list / byCapability behavior on the three
 * registries (connectors, channels, send-policy), plus the dispatch-policy
 * decision matrix from `wave1-interfaces.md` §3.1 and `GAP_ASSESSMENT.md`
 * §3.17, plus the priority-posture map and the default escalation ladders.
 */

import { describe, expect, it } from "vitest";
import {
  createChannelRegistry,
  PRIORITY_TO_POSTURE,
  type ChannelContribution,
  type ScheduledTaskPriority,
} from "../src/lifeops/channels/index.js";
import {
  createConnectorRegistry,
  decideDispatchPolicy,
  type ConnectorContribution,
  type DispatchResult,
} from "../src/lifeops/connectors/index.js";
import { DEFAULT_ESCALATION_LADDERS } from "../src/lifeops/escalation-ladders.js";
import {
  createSendPolicyRegistry,
  type SendPolicyContext,
  type SendPolicyContribution,
} from "../src/lifeops/send-policy/index.js";

function makeConnector(
  partial: Partial<ConnectorContribution> & {
    kind: string;
    capabilities: string[];
  },
): ConnectorContribution {
  return {
    kind: partial.kind,
    capabilities: partial.capabilities,
    modes: partial.modes ?? ["cloud"],
    describe: partial.describe ?? { label: partial.kind },
    start: partial.start ?? (async () => {}),
    disconnect: partial.disconnect ?? (async () => {}),
    verify: partial.verify ?? (async () => true),
    status:
      partial.status ??
      (async () => ({
        state: "ok" as const,
        observedAt: new Date(0).toISOString(),
      })),
    send: partial.send,
    read: partial.read,
    requiresApproval: partial.requiresApproval,
  };
}

function makeChannel(
  partial: Partial<ChannelContribution> & { kind: string },
): ChannelContribution {
  return {
    kind: partial.kind,
    describe: partial.describe ?? { label: partial.kind },
    capabilities: partial.capabilities ?? {
      send: true,
      read: false,
      reminders: false,
      voice: false,
      attachments: false,
      quietHoursAware: false,
    },
    send: partial.send,
  };
}

describe("ConnectorRegistry", () => {
  it("register / get / list / byCapability", () => {
    const registry = createConnectorRegistry();
    const google = makeConnector({
      kind: "google",
      capabilities: ["google.calendar.read", "google.gmail.draft.create"],
      modes: ["cloud"],
    });
    const telegram = makeConnector({
      kind: "telegram",
      capabilities: ["telegram.send", "telegram.read"],
      modes: ["local", "cloud"],
    });

    registry.register(google);
    registry.register(telegram);

    expect(registry.get("google")).toBe(google);
    expect(registry.get("missing")).toBeNull();

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.kind).sort()).toEqual(["google", "telegram"]);

    expect(
      registry.list({ capability: "google.calendar.read" }).map((c) => c.kind),
    ).toEqual(["google"]);
    expect(registry.list({ mode: "local" }).map((c) => c.kind)).toEqual([
      "telegram",
    ]);
    expect(registry.list({ mode: "cloud" }).map((c) => c.kind).sort()).toEqual([
      "google",
      "telegram",
    ]);

    expect(
      registry
        .byCapability("telegram.send")
        .map((c) => c.kind),
    ).toEqual(["telegram"]);
    expect(registry.byCapability("does.not.exist")).toEqual([]);
  });

  it("rejects duplicate kind on second register", () => {
    const registry = createConnectorRegistry();
    registry.register(makeConnector({ kind: "x", capabilities: [] }));
    expect(() =>
      registry.register(makeConnector({ kind: "x", capabilities: [] })),
    ).toThrow(/already registered/);
  });

  it("rejects empty kind", () => {
    const registry = createConnectorRegistry();
    expect(() =>
      registry.register(makeConnector({ kind: "", capabilities: [] })),
    ).toThrow(/kind is required/);
  });
});

describe("ChannelRegistry", () => {
  it("register / get / list with capability filter", () => {
    const registry = createChannelRegistry();
    const inApp = makeChannel({
      kind: "in_app",
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: true,
        quietHoursAware: true,
      },
    });
    const voice = makeChannel({
      kind: "voice",
      capabilities: {
        send: true,
        read: false,
        reminders: false,
        voice: true,
        attachments: false,
        quietHoursAware: true,
      },
    });

    registry.register(inApp);
    registry.register(voice);

    expect(registry.get("in_app")).toBe(inApp);
    expect(registry.get("missing")).toBeNull();

    expect(registry.list().map((c) => c.kind).sort()).toEqual([
      "in_app",
      "voice",
    ]);
    expect(
      registry.list({ supports: { voice: true } }).map((c) => c.kind),
    ).toEqual(["voice"]);
    expect(
      registry.list({ supports: { reminders: true } }).map((c) => c.kind),
    ).toEqual(["in_app"]);
    expect(
      registry
        .list({ supports: { send: true, quietHoursAware: true } })
        .map((c) => c.kind)
        .sort(),
    ).toEqual(["in_app", "voice"]);
  });

  it("rejects duplicate kind", () => {
    const registry = createChannelRegistry();
    registry.register(makeChannel({ kind: "in_app" }));
    expect(() =>
      registry.register(makeChannel({ kind: "in_app" })),
    ).toThrow(/already registered/);
  });
});

describe("SendPolicyRegistry", () => {
  function makePolicy(
    partial: Partial<SendPolicyContribution> & { kind: string },
  ): SendPolicyContribution {
    return {
      kind: partial.kind,
      describe: partial.describe ?? { label: partial.kind },
      priority: partial.priority,
      appliesTo: partial.appliesTo,
      evaluate: partial.evaluate ?? (async () => ({ kind: "allow" })),
    };
  }

  const baseContext: SendPolicyContext = {
    source: { kind: "connector", key: "google" },
    capability: "google.gmail.draft.create",
    payload: { to: "owner@example.com" },
  };

  it("register / get / list", () => {
    const registry = createSendPolicyRegistry();
    const owner = makePolicy({ kind: "owner_approval", priority: 0 });
    const quiet = makePolicy({ kind: "quiet_hours", priority: 10 });
    registry.register(owner);
    registry.register(quiet);

    expect(registry.get("owner_approval")).toBe(owner);
    expect(registry.get("missing")).toBeNull();

    // list returns priority-sorted policies (lower priority first).
    expect(registry.list().map((p) => p.kind)).toEqual([
      "owner_approval",
      "quiet_hours",
    ]);
  });

  it("rejects duplicate kind", () => {
    const registry = createSendPolicyRegistry();
    registry.register(makePolicy({ kind: "x" }));
    expect(() => registry.register(makePolicy({ kind: "x" }))).toThrow(
      /already registered/,
    );
  });

  it("evaluate returns allow when every policy allows", async () => {
    const registry = createSendPolicyRegistry();
    registry.register(makePolicy({ kind: "p1" }));
    registry.register(makePolicy({ kind: "p2" }));
    await expect(registry.evaluate(baseContext)).resolves.toEqual({
      kind: "allow",
    });
  });

  it("evaluate short-circuits on first non-allow decision in priority order", async () => {
    const registry = createSendPolicyRegistry();
    let later = false;
    registry.register(
      makePolicy({
        kind: "second",
        priority: 100,
        evaluate: async () => {
          later = true;
          return { kind: "allow" };
        },
      }),
    );
    registry.register(
      makePolicy({
        kind: "first",
        priority: 0,
        evaluate: async () => ({
          kind: "deny",
          reason: "stop",
          userActionable: false,
        }),
      }),
    );

    const decision = await registry.evaluate(baseContext);
    expect(decision).toEqual({
      kind: "deny",
      reason: "stop",
      userActionable: false,
    });
    expect(later).toBe(false);
  });

  it("evaluate skips policies whose appliesTo returns false", async () => {
    const registry = createSendPolicyRegistry();
    registry.register(
      makePolicy({
        kind: "channel_only",
        appliesTo: (ctx) => ctx.source.kind === "channel",
        evaluate: async () => ({
          kind: "deny",
          reason: "channel_block",
          userActionable: false,
        }),
      }),
    );
    await expect(registry.evaluate(baseContext)).resolves.toEqual({
      kind: "allow",
    });
  });
});

describe("decideDispatchPolicy (W1-F dispatch policy)", () => {
  it("ok=true → complete with messageId", () => {
    const result: DispatchResult = { ok: true, messageId: "abc" };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 0, totalSteps: 3 }),
    ).toEqual({ kind: "complete", messageId: "abc" });
  });

  it("retryAfterMinutes set → retry on the same step (does not advance)", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "transport_error",
      retryAfterMinutes: 15,
      userActionable: false,
    };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 0, totalSteps: 3 }),
    ).toEqual({
      kind: "retry",
      retryAfterMinutes: 15,
      reason: "transport_error",
    });
  });

  it("rate_limited without retryAfterMinutes → retry with default backoff", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "rate_limited",
      userActionable: false,
    };
    expect(
      decideDispatchPolicy(result, {
        currentStepIndex: 1,
        totalSteps: 3,
        defaultRetryAfterMinutes: 7,
      }),
    ).toEqual({
      kind: "retry",
      retryAfterMinutes: 7,
      reason: "rate_limited",
    });
  });

  it("user-actionable failure (auth_expired) on a non-final step → surface_degraded", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "auth_expired",
      userActionable: true,
      message: "re-auth Gmail",
    };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 0, totalSteps: 3 }),
    ).toEqual({
      kind: "surface_degraded",
      reason: "auth_expired",
      message: "re-auth Gmail",
    });
  });

  it("permanent failure on a non-final step → advance", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "unknown_recipient",
      userActionable: false,
      message: "no such handle",
    };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 0, totalSteps: 3 }),
    ).toEqual({
      kind: "advance",
      reason: "unknown_recipient",
      message: "no such handle",
    });
  });

  it("permanent failure on the last step → fail (terminal)", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: "boom",
    };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 2, totalSteps: 3 }),
    ).toEqual({
      kind: "fail",
      reason: "transport_error",
      message: "boom",
    });
  });

  it("user-actionable failure on the last step → fail (terminal beats degraded)", () => {
    const result: DispatchResult = {
      ok: false,
      reason: "auth_expired",
      userActionable: true,
    };
    expect(
      decideDispatchPolicy(result, { currentStepIndex: 0, totalSteps: 1 }),
    ).toEqual({
      kind: "fail",
      reason: "auth_expired",
      message: undefined,
    });
  });
});

describe("PRIORITY_TO_POSTURE", () => {
  it("matches the frozen wave1-interfaces.md §3.3 shape", () => {
    expect(PRIORITY_TO_POSTURE.low).toEqual({
      defaultChannelKeys: ["in_app"],
      banner: false,
      sound: false,
      badge: true,
      mandatoryEscalation: false,
    });
    expect(PRIORITY_TO_POSTURE.medium).toEqual({
      defaultChannelKeys: ["in_app", "push"],
      banner: true,
      sound: false,
      badge: true,
      mandatoryEscalation: false,
    });
    expect(PRIORITY_TO_POSTURE.high).toEqual({
      defaultChannelKeys: ["in_app", "push"],
      banner: true,
      sound: true,
      badge: true,
      mandatoryEscalation: true,
    });
  });

  it("covers exactly the three priority levels", () => {
    const keys = Object.keys(PRIORITY_TO_POSTURE).sort();
    expect(keys).toEqual<ScheduledTaskPriority[]>(["high", "low", "medium"]);
  });
});

describe("DEFAULT_ESCALATION_LADDERS", () => {
  it("matches the frozen wave1-interfaces.md §3.4 shape", () => {
    expect(DEFAULT_ESCALATION_LADDERS.priority_low_default).toEqual({
      steps: [],
    });
    expect(DEFAULT_ESCALATION_LADDERS.priority_medium_default).toEqual({
      steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }],
    });
    expect(DEFAULT_ESCALATION_LADDERS.priority_high_default).toEqual({
      steps: [
        { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
        { delayMinutes: 15, channelKey: "push", intensity: "normal" },
        { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
      ],
    });
  });
});
