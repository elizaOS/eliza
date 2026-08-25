import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CONTACT_ROUTE_FAILURE_COOLDOWN_MS,
  resolveContactRouteCandidates,
} from "./contact-route-policy";
import * as miscHelpers from "./service-helpers-misc";
import * as reminderHelpers from "./service-helpers-reminder";

const HOUR_MS = 60 * 60 * 1000;

type Attempt = {
  channel: string;
  outcome: string;
  attemptedAt: string;
};

type Policy = {
  channelType: string;
  metadata: { routingWeight?: unknown; disableReminderRouting?: boolean };
  allowReminders?: boolean;
  allowEscalation?: boolean;
};

function baseCallbacks(overrides: Record<string, unknown> = {}) {
  return {
    resolvePrimaryChannelPolicy: vi.fn(async () => null),
    hasRuntimeTarget: vi.fn(async () => true),
    runtimeTargetSendAvailable: true,
    ...overrides,
  };
}

function buildArgs(overrides: Record<string, unknown> = {}) {
  return {
    activityProfile: null,
    ownerContactHints: {},
    ownerContactSources: [],
    policies: [] as Policy[],
    urgency: "high",
    attempts: [] as Attempt[],
    now: new Date("2026-08-25T12:00:00Z"),
    callbacks: baseCallbacks(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(miscHelpers, "isReminderChannelAllowedForUrgency").mockReturnValue(
    true,
  );
  vi.spyOn(reminderHelpers, "isReminderChannel").mockImplementation(
    (channelType: string) =>
      ["in_app", "push", "sms", "voice", "email"].includes(channelType),
  );
});

describe("resolveContactRouteCandidates — urgency policy veto", () => {
  it("vetoes a channel that the urgency policy disallows", async () => {
    vi.mocked(
      miscHelpers.isReminderChannelAllowedForUrgency,
    ).mockImplementation((_channel: string, urgency: string) => {
      return urgency !== "low";
    });
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "low" }),
    );
    // stub ranking: no policies -> fallback order starts with in_app
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].vetoReasons).toContain("urgency_policy");
  });
});

describe("resolveContactRouteCandidates — recent channel failure cooldown", () => {
  it("vetoes a channel with a blocked outcome inside the cooldown window", async () => {
    const nowMs = new Date("2026-08-25T12:00:00Z").getTime();
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "high",
        attempts: [
          {
            channel: "push",
            outcome: "blocked_connector",
            attemptedAt: new Date(nowMs - 10 * 60 * 1000).toISOString(),
          },
        ],
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push).toBeDefined();
    expect(push?.vetoReasons).toContain("recent_channel_failure");
  });

  it("does not veto when the failure is outside the cooldown window", async () => {
    const nowMs = new Date("2026-08-25T12:00:00Z").getTime();
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "high",
        attempts: [
          {
            channel: "push",
            outcome: "blocked_connector",
            attemptedAt: new Date(
              nowMs - DEFAULT_CONTACT_ROUTE_FAILURE_COOLDOWN_MS - 1000,
            ).toISOString(),
          },
        ],
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).not.toContain("recent_channel_failure");
  });

  it("treats an unparseable attemptedAt as no recent failure", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "high",
        attempts: [
          {
            channel: "push",
            outcome: "blocked_policy",
            attemptedAt: "not-a-date",
          },
        ],
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).not.toContain("recent_channel_failure");
  });

  it("ignores non-blocked outcomes in the cooldown check", async () => {
    const nowMs = new Date("2026-08-25T12:00:00Z").getTime();
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "high",
        attempts: [
          {
            channel: "push",
            outcome: "sent",
            attemptedAt: new Date(nowMs - 60 * 1000).toISOString(),
          },
        ],
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).not.toContain("recent_channel_failure");
  });

  it("bypasses the cooldown veto for critical urgency", async () => {
    const nowMs = new Date("2026-08-25T12:00:00Z").getTime();
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        attempts: [
          {
            channel: "push",
            outcome: "blocked_connector",
            attemptedAt: new Date(nowMs - 60 * 1000).toISOString(),
          },
        ],
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push).toBeDefined();
    expect(push?.vetoReasons).not.toContain("recent_channel_failure");
  });
});

describe("resolveContactRouteCandidates — attention budget veto", () => {
  it("vetoes non-in_app channels when the interruption budget is low", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "high" }),
    );
    // stub routing policy: high urgency -> interruptionBudget "low"
    const push = result.find((c) => c.channel === "push");
    expect(push).toBeDefined();
    expect(push?.vetoReasons).toContain("attention_budget_low");
  });

  it("never vetoes in_app for a low budget", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "high" }),
    );
    const inApp = result.find((c) => c.channel === "in_app");
    expect(inApp?.vetoReasons).not.toContain("attention_budget_low");
  });
});

describe("resolveContactRouteCandidates — channel policy gates", () => {
  it("vetoes a channel whose policy disables reminder routing", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        callbacks: baseCallbacks({
          resolvePrimaryChannelPolicy: vi.fn(async (channel: string) => ({
            channelType: channel,
            metadata: { disableReminderRouting: true },
          })),
        }),
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).toContain("channel_policy_disabled");
  });

  it("vetoes a channel whose policy blocks escalation", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        callbacks: baseCallbacks({
          resolvePrimaryChannelPolicy: vi.fn(async (channel: string) => ({
            channelType: channel,
            metadata: {},
            allowReminders: true,
            allowEscalation: false,
          })),
        }),
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).toContain("channel_policy_blocks_escalation");
  });

  it("vetoes a direct-policy-required channel with no policy at all", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "critical" }),
    );
    const sms = result.find((c) => c.channel === "sms");
    expect(sms).toBeDefined();
    expect(sms?.vetoReasons).toContain("missing_required_direct_policy");
  });

  it("accepts a direct-policy-required channel when a policy exists", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        callbacks: baseCallbacks({
          resolvePrimaryChannelPolicy: vi.fn(async (channel: string) => ({
            channelType: channel,
            metadata: {},
            allowReminders: true,
            allowEscalation: true,
          })),
        }),
      }),
    );
    const sms = result.find((c) => c.channel === "sms");
    expect(sms).toBeDefined();
    expect(sms?.vetoReasons).toHaveLength(0);
  });
});

describe("resolveContactRouteCandidates — runtime target gates", () => {
  it("vetoes when no runtime target can send", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        callbacks: baseCallbacks({ runtimeTargetSendAvailable: false }),
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).toContain("runtime_target_send_unavailable");
  });

  it("vetoes when the runtime target is missing", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        callbacks: baseCallbacks({
          hasRuntimeTarget: vi.fn(async () => false),
        }),
      }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push?.vetoReasons).toContain("runtime_target_missing");
  });

  it("accepts a channel with a resolvable runtime target", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "critical" }),
    );
    const push = result.find((c) => c.channel === "push");
    expect(push).toBeDefined();
    expect(push?.vetoReasons).toHaveLength(0);
  });
});

describe("resolveContactRouteCandidates — candidate shaping", () => {
  it("prefixes evidence with the routing purpose", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({ urgency: "critical", purpose: "reminder_escalation" }),
    );
    const inApp = result.find((c) => c.channel === "in_app");
    expect(inApp?.evidence[0]).toBe("purpose:reminder_escalation");
  });

  it("does not add the same channel twice", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        policies: [
          { channelType: "push", metadata: { routingWeight: 10 } },
          { channelType: "push", metadata: { routingWeight: 5 } },
        ],
      }),
    );
    const pushes = result.filter((c) => c.channel === "push");
    expect(pushes).toHaveLength(1);
  });

  it("orders candidates by accumulated policy routing weight", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        policies: [
          { channelType: "sms", metadata: { routingWeight: 2 } },
          { channelType: "push", metadata: { routingWeight: 10 } },
        ],
      }),
    );
    expect(result[0].channel).toBe("push");
    expect(result[1].channel).toBe("sms");
  });

  it("ignores non-finite routing weights", async () => {
    const result = await resolveContactRouteCandidates(
      buildArgs({
        urgency: "critical",
        policies: [
          { channelType: "push", metadata: { routingWeight: Number.NaN } },
          { channelType: "sms", metadata: { routingWeight: 3 } },
        ],
      }),
    );
    expect(result[0].channel).toBe("sms");
  });

  it("accepts a number or Date for the now anchor", async () => {
    const nowMs = new Date("2026-08-25T12:00:00Z").getTime();
    const byNumber = await resolveContactRouteCandidates(
      buildArgs({ now: nowMs }),
    );
    const byDate = await resolveContactRouteCandidates(
      buildArgs({ now: new Date(nowMs) }),
    );
    expect(byNumber.map((c) => c.channel)).toEqual(
      byDate.map((c) => c.channel),
    );
  });
});
