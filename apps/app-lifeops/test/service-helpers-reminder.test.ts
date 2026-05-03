import type {
  LifeOpsChannelPolicy,
  LifeOpsReminderAttempt,
  LifeOpsReminderChannel,
  LifeOpsReminderPlan,
  LifeOpsReminderUrgency,
  LifeOpsTaskDefinition,
} from "@elizaos/app-lifeops";
import { describe, expect, it } from "vitest";
import { resolveContactRouteCandidates } from "../src/lifeops/contact-route-policy.js";
import {
  REMINDER_ACTIVITY_GATE_METADATA_KEY,
  REMINDER_ESCALATION_PROFILE_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
} from "../src/lifeops/service-constants.js";
import {
  isWithinQuietHours,
  priorityToUrgency,
} from "../src/lifeops/service-helpers-misc.js";
import {
  applyReminderIntensityToPlan,
  buildReminderEnforcementState,
  buildReminderResponseClaim,
  classifyReminderOwnerResponse,
  classifyReminderOwnerResponseText,
  decideReminderReviewTransition,
  normalizeReminderIntensityInput,
  parseReminderOwnerResponseSemanticClassification,
  parseReminderSnoozeRequestFromText,
  rankReminderEscalationChannelCandidates,
  rankReminderEscalationChannels,
  readReminderEscalationProfile,
  resolveReminderDeliveryUrgency,
  resolveReminderEscalationProfileDecision,
  resolveReminderEscalationRoutingPolicy,
  resolveReminderReviewDelayMinutes,
  shouldDeferReminderUntilComputerActive,
  shouldEscalateImmediately,
} from "../src/lifeops/service-helpers-reminder.js";
import type { ReminderActivityProfileSnapshot } from "../src/lifeops/service-types.js";

function buildDefinition(
  overrides: Partial<
    Pick<
      LifeOpsTaskDefinition,
      "title" | "originalIntent" | "cadence" | "metadata"
    >
  > = {},
): Pick<
  LifeOpsTaskDefinition,
  "title" | "originalIntent" | "cadence" | "metadata"
> {
  return {
    title: "Stretch",
    originalIntent: "stretch every 2 hours while I'm working",
    cadence: {
      kind: "interval",
      everyMinutes: 120,
      windows: ["morning", "afternoon", "evening"],
      maxOccurrencesPerDay: 2,
    },
    metadata: {
      [REMINDER_ACTIVITY_GATE_METADATA_KEY]: "active_on_computer",
    },
    ...overrides,
  };
}

function buildActivityProfile(
  overrides: Partial<ReminderActivityProfileSnapshot> = {},
): ReminderActivityProfileSnapshot {
  return {
    primaryPlatform: "desktop_app",
    secondaryPlatform: null,
    lastSeenPlatform: "desktop_app",
    isCurrentlyActive: true,
    lastSeenAt: Date.now(),
    circadianState: "awake",
    stateConfidence: 0.8,
    lastSleepEndedAt: null,
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    ...overrides,
  };
}

function buildReminderPlan(): LifeOpsReminderPlan {
  return {
    id: "plan-1",
    agentId: "agent-1",
    ownerType: "definition",
    ownerId: "definition-1",
    steps: [
      { channel: "in_app", offsetMinutes: 0, label: "In app" },
      { channel: "discord", offsetMinutes: 10, label: "Discord" },
    ],
    mutePolicy: {},
    quietHours: { timezone: "UTC", startMinute: 0, endMinute: 0 },
    createdAt: "2026-04-29T17:00:00.000Z",
    updatedAt: "2026-04-29T17:00:00.000Z",
  };
}

function buildChannelPolicy(
  channel: LifeOpsReminderChannel,
  overrides: Partial<LifeOpsChannelPolicy> = {},
): LifeOpsChannelPolicy {
  return {
    id: `policy-${channel}`,
    agentId: "agent-1",
    channelType: channel,
    channelRef: `${channel}-owner`,
    privacyClass: "private",
    allowReminders: true,
    allowEscalation: true,
    allowPosts: false,
    requireConfirmationForActions: false,
    metadata: {},
    createdAt: "2026-04-29T17:00:00.000Z",
    updatedAt: "2026-04-29T17:00:00.000Z",
    ...overrides,
  };
}

function buildAttempt(
  overrides: Partial<LifeOpsReminderAttempt> = {},
): LifeOpsReminderAttempt {
  return {
    id: "attempt-1",
    agentId: "agent-1",
    planId: "plan-1",
    ownerType: "occurrence",
    ownerId: "occurrence-1",
    occurrenceId: "occurrence-1",
    channel: "in_app",
    stepIndex: 0,
    scheduledFor: "2026-04-29T17:00:00.000Z",
    attemptedAt: "2026-04-29T17:00:00.000Z",
    outcome: "delivered",
    connectorRef: "system:in_app",
    deliveryMetadata: {},
    reviewAt: null,
    reviewStatus: null,
    ...overrides,
  };
}

function shouldDefer(
  channel: LifeOpsReminderChannel,
  profile: ReminderActivityProfileSnapshot | null,
  definition: Pick<
    LifeOpsTaskDefinition,
    "title" | "originalIntent" | "cadence" | "metadata"
  >,
  urgency?: LifeOpsReminderUrgency,
): boolean {
  return shouldDeferReminderUntilComputerActive({
    channel,
    activityProfile: profile,
    definition,
    urgency,
  });
}

describe("shouldDeferReminderUntilComputerActive", () => {
  it("defers stretch reminders when the owner is inactive", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition(),
      ),
    ).toBe(true);
  });

  it("defers stretch reminders when the owner is active on mobile instead of desktop", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({
          primaryPlatform: "mobile_app",
          lastSeenPlatform: "mobile_app",
        }),
        buildDefinition(),
      ),
    ).toBe(true);
  });

  it("allows stretch reminders when the owner is actively using a computer", () => {
    expect(
      shouldDefer("in_app", buildActivityProfile(), buildDefinition()),
    ).toBe(false);
  });

  it("still respects activity gates for high-priority movement reminders", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition(),
        "high",
      ),
    ).toBe(true);
  });

  it("lets critical reminders bypass activity gates", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition(),
        "critical",
      ),
    ).toBe(false);
  });

  it("does not defer non-stretch reminders", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition({
          title: "Drink water",
          originalIntent: "drink water during the day",
          metadata: {},
        }),
      ),
    ).toBe(false);
  });

  it("uses explicit activity-gate metadata rather than routine text", () => {
    expect(
      shouldDefer(
        "in_app",
        buildActivityProfile({ isCurrentlyActive: false }),
        buildDefinition({ metadata: {} }),
      ),
    ).toBe(false);
  });
});

describe("rankReminderEscalationChannels", () => {
  it("prioritizes observed active channels instead of globally anchoring in-app", () => {
    const channels = rankReminderEscalationChannels({
      activityProfile: buildActivityProfile({
        primaryPlatform: "telegram",
        secondaryPlatform: "discord",
        lastSeenPlatform: "telegram",
      }),
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: ["sms"],
    });

    expect(channels.slice(0, 4)).toEqual([
      "telegram",
      "discord",
      "in_app",
      "sms",
    ]);
  });

  it("does not invent escalation channels when usage is unknown", () => {
    const channels = rankReminderEscalationChannels({
      activityProfile: null,
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: [],
    });

    expect(channels).toEqual(["in_app"]);
  });

  it("uses a routing policy that keeps busy-screen nudges low-cost", () => {
    const routingPolicy = resolveReminderEscalationRoutingPolicy({
      activityProfile: buildActivityProfile({
        screenContextBusy: true,
        screenContextAvailable: true,
        lastSeenPlatform: "desktop_app",
      }),
      urgency: "medium",
    });
    const channels = rankReminderEscalationChannels({
      activityProfile: buildActivityProfile({
        screenContextBusy: true,
        screenContextAvailable: true,
        lastSeenPlatform: "desktop_app",
      }),
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: ["sms"],
      routingPolicy,
    });

    expect(routingPolicy.interruptionBudget).toBe("low");
    expect(channels[0]).toBe("in_app");
  });

  it("ignores stale busy-screen context for interruption budgeting", () => {
    const routingPolicy = resolveReminderEscalationRoutingPolicy({
      activityProfile: buildActivityProfile({
        screenContextBusy: true,
        screenContextAvailable: true,
        screenContextStale: true,
        screenContextConfidence: 0.95,
      }),
      urgency: "medium",
    });

    expect(routingPolicy.interruptionBudget).toBe("normal");
  });

  it("uses shared attention signals beyond screen context", () => {
    expect(
      resolveReminderEscalationRoutingPolicy({
        activityProfile: buildActivityProfile({ calendarBusy: true }),
        urgency: "medium",
      }),
    ).toMatchObject({
      interruptionBudget: "low",
      reason: "calendar_busy",
    });
    expect(
      resolveReminderEscalationRoutingPolicy({
        activityProfile: buildActivityProfile({ dndActive: true }),
        urgency: "medium",
      }),
    ).toMatchObject({
      interruptionBudget: "low",
      reason: "do_not_disturb",
    });
  });

  it("lets channel policy adjust ranking without code changes", () => {
    const channels = rankReminderEscalationChannels({
      activityProfile: null,
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: ["sms", "discord"],
      policyChannelWeightAdjustments: { discord: 1_000 },
    });

    expect(channels.slice(0, 2)).toEqual(["discord", "in_app"]);
  });

  it("returns route candidates with semantic evidence", () => {
    const candidates = rankReminderEscalationChannelCandidates({
      activityProfile: buildActivityProfile({
        primaryPlatform: "telegram",
        lastSeenPlatform: "telegram",
      }),
      ownerContactHints: {},
      ownerContactSources: [],
      policyChannels: ["sms"],
    });

    expect(candidates[0]).toMatchObject({
      channel: "telegram",
      evidence: expect.arrayContaining([
        "currently_active_platform",
        "primary_platform",
      ]),
      vetoReasons: [],
    });
  });
});

describe("resolveContactRouteCandidates", () => {
  it("keeps busy-context routes low-cost by vetoing external channels", async () => {
    const discordPolicy = buildChannelPolicy("discord");
    const candidates = await resolveContactRouteCandidates({
      activityProfile: buildActivityProfile({
        screenContextBusy: true,
        screenContextAvailable: true,
      }),
      ownerContactHints: {
        discord: {
          source: "discord",
          preferredCommunicationChannel: "discord",
          lastResponseAt: null,
          lastResponseChannel: null,
        },
      },
      ownerContactSources: ["discord"],
      policies: [discordPolicy],
      urgency: "medium",
      callbacks: {
        runtimeTargetSendAvailable: true,
        resolvePrimaryChannelPolicy: async () => discordPolicy,
        hasRuntimeTarget: async () => true,
      },
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          vetoReasons: ["attention_budget_low"],
        }),
        expect.objectContaining({
          channel: "in_app",
          vetoReasons: [],
        }),
      ]),
    );
  });

  it("requires an explicit direct-channel policy for SMS and voice", async () => {
    const candidates = await resolveContactRouteCandidates({
      activityProfile: null,
      ownerContactHints: {
        sms: {
          source: "sms",
          preferredCommunicationChannel: "sms",
          lastResponseAt: null,
          lastResponseChannel: null,
        },
      },
      ownerContactSources: ["sms"],
      policies: [],
      urgency: "high",
      callbacks: {
        runtimeTargetSendAvailable: true,
        resolvePrimaryChannelPolicy: async () => null,
        hasRuntimeTarget: async () => true,
      },
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "sms",
          vetoReasons: ["missing_required_direct_policy"],
        }),
      ]),
    );
  });

  it("uses scheduler time for recent route failure cooldowns", async () => {
    const discordPolicy = buildChannelPolicy("discord");
    const candidates = await resolveContactRouteCandidates({
      activityProfile: null,
      ownerContactHints: {
        discord: {
          source: "discord",
          preferredCommunicationChannel: "discord",
          lastResponseAt: null,
          lastResponseChannel: null,
        },
      },
      ownerContactSources: ["discord"],
      policies: [discordPolicy],
      urgency: "high",
      attempts: [
        buildAttempt({
          id: "attempt-discord-failure",
          channel: "discord",
          outcome: "blocked_connector",
          attemptedAt: "2026-04-29T16:30:00.000Z",
        }),
      ],
      now: new Date("2026-04-29T17:00:00.000Z"),
      callbacks: {
        runtimeTargetSendAvailable: true,
        resolvePrimaryChannelPolicy: async () => discordPolicy,
        hasRuntimeTarget: async () => true,
      },
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          vetoReasons: ["recent_channel_failure"],
        }),
      ]),
    );
  });
});

describe("reminder escalation profiles", () => {
  it("keeps the former routine voice behavior as typed default policy", () => {
    const state = buildReminderEnforcementState(
      new Date("2026-04-29T06:21:00.000Z"),
      "UTC",
      { kind: "morning_routine", metadata: {} },
      { voice: true },
    );

    expect(
      resolveReminderEscalationProfileDecision({
        normalDelayMinutes: 10,
        state,
        urgency: "critical",
      }),
    ).toEqual({
      delayMinutes: 5,
      forceChannel: "voice",
    });
  });

  it("lets arbitrary urgent tasks tune force-channel policy through metadata", () => {
    const profile = readReminderEscalationProfile({
      metadata: {
        [REMINDER_ESCALATION_PROFILE_METADATA_KEY]: {
          requireRoutineDefinition: false,
          forceChannel: {
            channel: "sms",
            afterMinutes: 15,
            urgencies: ["high"],
            requireAvailable: false,
          },
        },
      },
    });
    const state = buildReminderEnforcementState(
      new Date("2026-04-29T06:16:00.000Z"),
      "UTC",
      { kind: "habit", metadata: {} },
    );

    expect(
      resolveReminderEscalationProfileDecision({
        normalDelayMinutes: 10,
        state,
        urgency: "high",
        profile,
      }),
    ).toMatchObject({
      forceChannel: "sms",
    });
  });
});

describe("classifyReminderOwnerResponseText", () => {
  it("treats explicit completion as a reminder resolution", () => {
    expect(classifyReminderOwnerResponseText("done")).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
    });
  });

  it("does not treat unrelated chat as acknowledgement", () => {
    expect(classifyReminderOwnerResponseText("what time is it?")).toMatchObject(
      {
        decision: "unrelated",
        resolution: null,
      },
    );
  });

  it("does not bind generic acknowledgement to unrelated conversation", () => {
    expect(
      classifyReminderOwnerResponseText("yes, book the calendar thing", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:03:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "unrelated",
      resolution: null,
    });
  });

  it("accepts prompt-adjacent standalone completion", () => {
    expect(
      classifyReminderOwnerResponseText("done", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:03:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
    });
  });

  it("does not accept stale standalone completion as task-bound", () => {
    expect(
      classifyReminderOwnerResponseText("done", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:11:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "unrelated",
      resolution: null,
    });
  });

  it("keeps explicit reminder references task-bound after the prompt window", () => {
    expect(
      classifyReminderOwnerResponseText("finished the stretch reminder", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:11:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
    });
  });

  it("requires enough title evidence before binding short reminder titles", () => {
    expect(
      classifyReminderOwnerResponseText("done with the call", {
        title: "Call dentist",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:11:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "unrelated",
      resolution: null,
    });
    expect(
      classifyReminderOwnerResponseText("call dentist done", {
        title: "Call dentist",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:11:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
    });
  });

  it("can disallow standalone replies outside the delivery thread", () => {
    expect(
      classifyReminderOwnerResponseText("done", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:03:00.000Z",
        channel: "discord",
        allowStandaloneResolution: false,
      }),
    ).toMatchObject({
      decision: "unrelated",
      resolution: null,
    });
  });

  it("asks for clarification on vague snooze language", () => {
    for (const response of [
      "snooze",
      "remind me later",
      "remind me after lunch",
      "remind me at 3",
      "remind me tomorrow",
    ]) {
      expect(
        classifyReminderOwnerResponseText(response, {
          title: "Stretch",
          attemptedAt: "2026-04-29T17:00:00.000Z",
          respondedAt: "2026-04-29T17:03:00.000Z",
          channel: "in_app",
        }),
      ).toMatchObject({
        decision: "needs_clarification",
        resolution: null,
      });
    }
  });

  it("accepts concrete snooze replies after a clarification prompt", () => {
    expect(
      classifyReminderOwnerResponseText("30 minutes", {
        title: "Stretch",
        attemptedAt: "2026-04-29T17:00:00.000Z",
        respondedAt: "2026-04-29T17:03:00.000Z",
        channel: "in_app",
      }),
    ).toMatchObject({
      decision: "explicit_resolution",
      resolution: "snoozed",
      snoozeRequest: { preset: "30m" },
    });
  });
});

describe("classifyReminderOwnerResponse", () => {
  it("accepts a semantic classifier for non-lexical task-bound replies", async () => {
    await expect(
      classifyReminderOwnerResponse({
        text: "listo",
        context: {
          title: "Stretch",
          attemptedAt: "2026-04-29T17:00:00.000Z",
          respondedAt: "2026-04-29T17:03:00.000Z",
          channel: "in_app",
        },
        semanticClassifier: async () => ({
          decision: "explicit_resolution",
          resolution: "completed",
          snoozeRequest: null,
          confidence: 0.9,
          reason: "semantic_completion",
        }),
      }),
    ).resolves.toMatchObject({
      decision: "explicit_resolution",
      resolution: "completed",
      reason: "semantic_completion",
      classifierSource: "semantic",
      semanticReason: "semantic_completion",
    });
  });

  it("falls back to deterministic classification when semantic review abstains", async () => {
    await expect(
      classifyReminderOwnerResponse({
        text: "listo",
        context: {
          title: "Stretch",
          attemptedAt: "2026-04-29T17:00:00.000Z",
          respondedAt: "2026-04-29T17:03:00.000Z",
          channel: "in_app",
        },
        semanticClassifier: async () => ({
          decision: "abstain",
          resolution: null,
          snoozeRequest: null,
          confidence: 0.2,
          reason: "ambiguous",
        }),
      }),
    ).resolves.toMatchObject({
      decision: "unrelated",
      resolution: null,
      classifierSource: "semantic_abstain",
      semanticReason: "ambiguous",
    });
  });

  it("parses model JSON into a bounded semantic decision", () => {
    expect(
      parseReminderOwnerResponseSemanticClassification({
        decision: "explicit_resolution",
        resolution: "snoozed",
        snoozeRequest: { minutes: 45 },
        confidence: 2,
        reason: "reply means later",
      }),
    ).toEqual({
      decision: "explicit_resolution",
      resolution: "snoozed",
      snoozeRequest: { minutes: 45 },
      confidence: 1,
      reason: "reply means later",
    });
  });
});

describe("buildReminderResponseClaim", () => {
  it("binds standalone replies only to the latest prompt in the delivery thread", () => {
    const older = {
      id: "attempt-older",
      agentId: "agent-1",
      planId: "plan-1",
      ownerType: "occurrence" as const,
      ownerId: "occurrence-1",
      occurrenceId: "occurrence-1",
      channel: "in_app" as const,
      stepIndex: 0,
      scheduledFor: "2026-04-29T17:00:00.000Z",
      attemptedAt: "2026-04-29T17:00:00.000Z",
      outcome: "delivered" as const,
      connectorRef: "system:in_app",
      deliveryMetadata: { deliveryRoomId: "room-1" },
      reviewAt: "2026-04-29T17:07:00.000Z",
      reviewStatus: null,
    };
    const newer = {
      ...older,
      id: "attempt-newer",
      ownerId: "occurrence-2",
      attemptedAt: "2026-04-29T17:01:00.000Z",
      scheduledFor: "2026-04-29T17:01:00.000Z",
    };

    expect(
      buildReminderResponseClaim({
        attempt: older,
        competingAttempts: [older, newer],
        response: {
          text: "done",
          createdAt: Date.parse("2026-04-29T17:02:00.000Z"),
          roomId: "room-1",
        },
        roomIds: ["room-1"],
      }),
    ).toMatchObject({
      binding: "stale_or_competing_prompt",
      allowStandaloneResolution: false,
    });
    expect(
      buildReminderResponseClaim({
        attempt: newer,
        competingAttempts: [older, newer],
        response: {
          text: "done",
          createdAt: Date.parse("2026-04-29T17:02:00.000Z"),
          roomId: "room-1",
        },
        roomIds: ["room-1"],
      }),
    ).toMatchObject({
      binding: "latest_prompt_in_thread",
      allowStandaloneResolution: true,
    });
  });
});

describe("decideReminderReviewTransition", () => {
  it("turns explicit completion into one resolve transition", () => {
    expect(
      decideReminderReviewTransition({
        reviewDue: true,
        ownerType: "occurrence",
        responseReview: {
          decision: "explicit_resolution",
          resolution: "completed",
          snoozeRequest: null,
          respondedAt: "2026-04-29T17:03:00.000Z",
          responseText: "done",
          confidence: 0.86,
          reason: "completion_language",
        },
      }),
    ).toMatchObject({
      kind: "resolve",
      resolution: "completed",
    });
  });

  it("turns vague snooze into one clarification transition", () => {
    expect(
      decideReminderReviewTransition({
        reviewDue: true,
        ownerType: "occurrence",
        responseReview: {
          decision: "needs_clarification",
          resolution: null,
          snoozeRequest: null,
          respondedAt: "2026-04-29T17:03:00.000Z",
          responseText: "later",
          confidence: 0.68,
          reason: "snooze_needs_duration",
        },
      }),
    ).toMatchObject({
      kind: "clarify",
      observation: {
        decision: "needs_clarification",
        reason: "snooze_needs_duration",
      },
    });
  });
});

describe("parseReminderSnoozeRequestFromText", () => {
  it("extracts concrete snooze durations", () => {
    expect(parseReminderSnoozeRequestFromText("snooze for 30 minutes")).toEqual(
      {
        request: { preset: "30m" },
        needsClarification: false,
        reason: "snooze_30m",
      },
    );
    expect(parseReminderSnoozeRequestFromText("remind me in 2 hours")).toEqual({
      request: { minutes: 120 },
      needsClarification: false,
      reason: "snooze_duration",
    });
    expect(parseReminderSnoozeRequestFromText("tonight")).toEqual({
      request: { preset: "tonight" },
      needsClarification: false,
      reason: "snooze_tonight",
    });
    expect(parseReminderSnoozeRequestFromText("tomorrow morning")).toEqual({
      request: { preset: "tomorrow_morning" },
      needsClarification: false,
      reason: "snooze_tomorrow_morning",
    });
  });

  it("flags ambiguous snooze requests for clarification", () => {
    for (const response of [
      "snooze",
      "remind me after lunch",
      "remind me at 3",
      "remind me tomorrow",
    ]) {
      expect(parseReminderSnoozeRequestFromText(response)).toMatchObject({
        request: null,
        needsClarification: true,
      });
    }
  });
});

describe("applyReminderIntensityToPlan", () => {
  it("normalizes reminder intensity from shared policy aliases", () => {
    expect(normalizeReminderIntensityInput("HIGH", "intensity")).toBe(
      "persistent",
    );
    expect(normalizeReminderIntensityInput("paused", "intensity")).toBe(
      "high_priority_only",
    );
  });

  it("keeps minimal reminders to the first step", () => {
    const plan = buildReminderPlan();
    const adjusted = applyReminderIntensityToPlan(plan, "minimal");

    expect(adjusted?.steps).toEqual([plan.steps[0]]);
  });

  it("adds a gentle follow-up step for persistent reminders", () => {
    const adjusted = applyReminderIntensityToPlan(
      buildReminderPlan(),
      "persistent",
    );

    expect(adjusted?.steps.at(-1)).toMatchObject({
      channel: "in_app",
      offsetMinutes: 70,
      label: "Discord follow-up",
    });
  });
});

describe("reminder escalation policy", () => {
  it("keeps quiet-hours blocks from becoming immediate cross-channel escalation", () => {
    expect(shouldEscalateImmediately("blocked_quiet_hours")).toBe(false);
    expect(shouldEscalateImmediately("blocked_connector")).toBe(true);
  });

  it("uses the shared delay policy for review callbacks", () => {
    expect(resolveReminderReviewDelayMinutes("high", "plan")).toBe(7);
    expect(resolveReminderReviewDelayMinutes("high", "escalation")).toBe(10);
    expect(resolveReminderReviewDelayMinutes("low", "plan")).toBeNull();
  });
});

describe("resolveReminderDeliveryUrgency", () => {
  it("keeps task priority separate from delivery urgency metadata", () => {
    expect(
      resolveReminderDeliveryUrgency({
        priority: 4,
        metadata: { [REMINDER_URGENCY_METADATA_KEY]: "high" },
      }),
    ).toBe("high");
    expect(
      resolveReminderDeliveryUrgency({
        priority: 4,
        metadata: {},
      }),
    ).toBe("low");
  });
});

describe("priorityToUrgency", () => {
  it("uses the stored LifeOps 1-5 priority scale", () => {
    expect(priorityToUrgency(1)).toBe("critical");
    expect(priorityToUrgency(2)).toBe("high");
    expect(priorityToUrgency(3)).toBe("medium");
    expect(priorityToUrgency(4)).toBe("low");
    expect(priorityToUrgency(5)).toBe("low");
  });
});

describe("isWithinQuietHours", () => {
  it("uses the normalized minute-based quiet-hours contract", () => {
    const quietHours = {
      timezone: "America/Los_Angeles",
      startMinute: 6 * 60,
      endMinute: 8 * 60,
      channels: ["push"],
    };

    expect(
      isWithinQuietHours({
        now: new Date("2026-04-28T13:30:00.000Z"),
        quietHours,
        channel: "push",
      }),
    ).toBe(true);
    expect(
      isWithinQuietHours({
        now: new Date("2026-04-28T13:30:00.000Z"),
        quietHours,
        channel: "sms",
      }),
    ).toBe(false);
  });
});
