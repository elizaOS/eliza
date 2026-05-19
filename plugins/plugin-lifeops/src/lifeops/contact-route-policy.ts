import type {
  LifeOpsChannelPolicy,
  LifeOpsReminderAttempt,
  LifeOpsReminderChannel,
  LifeOpsReminderUrgency,
} from "../contracts/index.js";
import { isReminderChannelAllowedForUrgency } from "./service-helpers-misc.js";
import {
  isReminderChannel,
  type ReminderEscalationRoutingHint,
  type ReminderRouteCandidate,
  rankReminderEscalationChannelCandidates,
  resolveReminderEscalationRoutingPolicy,
} from "./service-helpers-reminder.js";
import type { ReminderActivityProfileSnapshot } from "./service-types.js";

export const DEFAULT_CONTACT_ROUTE_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;

export type ContactRoutePurpose =
  | "reminder_escalation"
  | "checkin"
  | "workflow"
  | "proactive"
  | "inbox";

export type ContactRoutePolicyCallbacks = {
  resolvePrimaryChannelPolicy: (
    channel: LifeOpsReminderChannel,
  ) => Promise<LifeOpsChannelPolicy | null>;
  hasRuntimeTarget: (
    channel: LifeOpsReminderChannel,
    policy: LifeOpsChannelPolicy | null,
  ) => Promise<boolean>;
  runtimeTargetSendAvailable: boolean;
};

export type ContactRoutePolicyOptions = {
  failureCooldownMs?: number;
  directPolicyRequiredChannels?: readonly LifeOpsReminderChannel[];
};

function normalizeNowMs(value: Date | number | undefined): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Date.now();
}

function hasRecentChannelFailure(args: {
  attempts: readonly LifeOpsReminderAttempt[];
  channel: LifeOpsReminderChannel;
  nowMs: number;
  failureCooldownMs: number;
}): boolean {
  return args.attempts.some((attempt) => {
    if (attempt.channel !== args.channel) {
      return false;
    }
    if (
      attempt.outcome !== "blocked_connector" &&
      attempt.outcome !== "blocked_policy"
    ) {
      return false;
    }
    const attemptedMs = attempt.attemptedAt
      ? Date.parse(attempt.attemptedAt)
      : Number.NaN;
    return (
      Number.isFinite(attemptedMs) &&
      args.nowMs - attemptedMs <= args.failureCooldownMs
    );
  });
}

function buildPolicyWeightAdjustments(
  policies: readonly LifeOpsChannelPolicy[],
): Partial<Record<LifeOpsReminderChannel, number>> {
  const policyWeightAdjustments: Partial<
    Record<LifeOpsReminderChannel, number>
  > = {};
  for (const policy of policies) {
    const channel = isReminderChannel(policy.channelType)
      ? policy.channelType
      : null;
    if (!channel) {
      continue;
    }
    const weight = policy.metadata.routingWeight;
    if (typeof weight === "number" && Number.isFinite(weight)) {
      policyWeightAdjustments[channel] =
        (policyWeightAdjustments[channel] ?? 0) + weight;
    }
  }
  return policyWeightAdjustments;
}

async function evaluateRouteCandidate(args: {
  candidate: ReminderRouteCandidate;
  candidates: ReminderRouteCandidate[];
  attempts: readonly LifeOpsReminderAttempt[];
  urgency: LifeOpsReminderUrgency;
  nowMs: number;
  failureCooldownMs: number;
  directPolicyRequiredChannels: readonly LifeOpsReminderChannel[];
  interruptionBudget: ReminderRouteCandidate["interruptionBudget"];
  callbacks: ContactRoutePolicyCallbacks;
}): Promise<void> {
  if (
    args.candidates.some(
      (resolvedCandidate) =>
        resolvedCandidate.channel === args.candidate.channel,
    )
  ) {
    return;
  }

  const vetoReasons: string[] = [];
  const channel = args.candidate.channel;
  if (!isReminderChannelAllowedForUrgency(channel, args.urgency)) {
    vetoReasons.push("urgency_policy");
  }
  if (
    args.urgency !== "critical" &&
    hasRecentChannelFailure({
      attempts: args.attempts,
      channel,
      nowMs: args.nowMs,
      failureCooldownMs: args.failureCooldownMs,
    })
  ) {
    vetoReasons.push("recent_channel_failure");
  }
  if (channel !== "in_app" && args.interruptionBudget === "low") {
    vetoReasons.push("attention_budget_low");
  }
  if (vetoReasons.length > 0) {
    args.candidates.push({ ...args.candidate, vetoReasons });
    return;
  }
  if (channel === "in_app") {
    args.candidates.push({ ...args.candidate, vetoReasons });
    return;
  }

  const policy = await args.callbacks.resolvePrimaryChannelPolicy(channel);
  if (policy) {
    if (policy.metadata.disableReminderRouting === true) {
      args.candidates.push({
        ...args.candidate,
        vetoReasons: ["channel_policy_disabled"],
      });
      return;
    }
    if (!policy.allowReminders || !policy.allowEscalation) {
      args.candidates.push({
        ...args.candidate,
        vetoReasons: ["channel_policy_blocks_escalation"],
      });
      return;
    }
  } else if (args.directPolicyRequiredChannels.includes(channel)) {
    args.candidates.push({
      ...args.candidate,
      vetoReasons: ["missing_required_direct_policy"],
    });
    return;
  }

  if (args.directPolicyRequiredChannels.includes(channel)) {
    args.candidates.push({ ...args.candidate, vetoReasons });
    return;
  }
  if (!args.callbacks.runtimeTargetSendAvailable) {
    args.candidates.push({
      ...args.candidate,
      vetoReasons: ["runtime_target_send_unavailable"],
    });
    return;
  }
  if (await args.callbacks.hasRuntimeTarget(channel, policy)) {
    args.candidates.push({ ...args.candidate, vetoReasons });
    return;
  }
  args.candidates.push({
    ...args.candidate,
    vetoReasons: ["runtime_target_missing"],
  });
}

export async function resolveContactRouteCandidates(args: {
  purpose?: ContactRoutePurpose;
  activityProfile: ReminderActivityProfileSnapshot | null;
  ownerContactHints: Record<string, ReminderEscalationRoutingHint>;
  ownerContactSources: readonly string[];
  policies: readonly LifeOpsChannelPolicy[];
  urgency: LifeOpsReminderUrgency;
  attempts?: readonly LifeOpsReminderAttempt[];
  now?: Date | number;
  callbacks: ContactRoutePolicyCallbacks;
  options?: ContactRoutePolicyOptions;
}): Promise<ReminderRouteCandidate[]> {
  const candidates: ReminderRouteCandidate[] = [];
  const nowMs = normalizeNowMs(args.now);
  const purpose = args.purpose ?? "proactive";
  const routingPolicy = resolveReminderEscalationRoutingPolicy({
    activityProfile: args.activityProfile,
    urgency: args.urgency,
  });
  const rankedCandidates = rankReminderEscalationChannelCandidates({
    activityProfile: args.activityProfile,
    ownerContactHints: args.ownerContactHints,
    ownerContactSources: args.ownerContactSources,
    policyChannels: args.policies.map((policy) => policy.channelType),
    policyChannelWeightAdjustments: buildPolicyWeightAdjustments(args.policies),
    urgency: args.urgency,
    routingPolicy,
    now: nowMs,
  });

  for (const candidate of rankedCandidates) {
    await evaluateRouteCandidate({
      candidate: {
        ...candidate,
        evidence: [`purpose:${purpose}`, ...candidate.evidence],
      },
      candidates,
      attempts: args.attempts ?? [],
      urgency: args.urgency,
      nowMs,
      failureCooldownMs:
        args.options?.failureCooldownMs ??
        DEFAULT_CONTACT_ROUTE_FAILURE_COOLDOWN_MS,
      directPolicyRequiredChannels: args.options
        ?.directPolicyRequiredChannels ?? ["sms", "voice"],
      interruptionBudget: routingPolicy.interruptionBudget,
      callbacks: args.callbacks,
    });
  }
  return candidates;
}
