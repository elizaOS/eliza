/**
 * Shared owner-policy writers for the LifeOps action surface.
 *
 * Owner reminder policy flows use these helpers so the OwnerFactStore is the
 * single source of truth for reminder intensity + escalation rules.
 */

import {
  LIFEOPS_REMINDER_CHANNELS,
  type LifeOpsDefinitionRecord,
  type LifeOpsDomain,
  type LifeOpsReminderChannel,
  type LifeOpsReminderStep,
  type SetLifeOpsReminderPreferenceRequest,
} from "@elizaos/contracts";
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { toWellFormedUnicode } from "@elizaos/core";
import {
  type OwnerFactProvenance,
  type ReminderIntensity,
  resolveOwnerFactStore,
} from "../../lifeops/owner/fact-store.js";
import { LifeOpsService } from "../../lifeops/service.js";
import { extractReminderIntensityWithLlm } from "./extract-task-plan.js";

/**
 * Caller-supplied write resolver. Accepted as a parameter so this module stays
 * free of inbound imports from `actions/life.ts` (which owns the one
 * canonical impl) and avoids a circular dep between `actions/life.ts` and
 * `actions/lib/`. `match` is set only for an id, exact-title or whole-title
 * match; looser matches come back as `candidates` to ask about.
 */
export type DefinitionResolver = (
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
) => Promise<{ match: LifeOpsDefinitionRecord | null; candidates: string[] }>;

export type OwnerPolicyDetails = Record<string, unknown> | undefined;

export interface OwnerPolicySetReminderInput {
  runtime: IAgentRuntime;
  message: Memory;
  intent: string;
  /** Resolver — see `DefinitionResolver` for the contract. */
  resolveDefinition: DefinitionResolver;
  /**
   * Caller-supplied. Strict canonical intensity only — the legacy compat
   * tokens (`"low"`, `"high"`, `"paused"`) accepted by
   * `SetLifeOpsReminderPreferenceRequest` must be normalized upstream
   * before they land here.
   */
  intensity?: ReminderIntensity;
  /** Optional definition target name/id (per-definition override). */
  target?: string;
  /** Optional structured details (e.g. domain). */
  details?: OwnerPolicyDetails;
}

export interface OwnerPolicyConfigureEscalationInput {
  runtime: IAgentRuntime;
  message: Memory;
  intent: string;
  resolveDefinition: DefinitionResolver;
  target?: string;
  timeoutMinutes?: number;
  callAfterMinutes?: number;
  details?: OwnerPolicyDetails;
}

function policyProvenance(intent: string): OwnerFactProvenance {
  const provenance: OwnerFactProvenance = {
    source: "policy_action",
    recordedAt: new Date().toISOString(),
  };
  if (intent.length > 0) {
    provenance.note = toWellFormedUnicode(intent);
  }
  return provenance;
}

function detailRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function detailString(
  source: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function detailArray(
  source: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = source?.[key];
  return Array.isArray(value) ? value : undefined;
}

export async function applyOwnerPolicySetReminder(
  args: OwnerPolicySetReminderInput,
): Promise<ActionResult> {
  const details = detailRecord(args.details);
  const intent =
    args.intent.trim() ||
    (typeof args.message.content.text === "string"
      ? args.message.content.text.trim()
      : "");

  let intensity: ReminderIntensity | "unknown" = args.intensity ?? "unknown";
  if (intensity === "unknown") {
    const plan = await extractReminderIntensityWithLlm({
      runtime: args.runtime,
      intent,
    });
    intensity = plan.intensity;
  }
  if (intensity === "unknown") {
    return {
      success: false,
      text: "I need to know whether you want reminders minimal, normal, persistent, or high priority only.",
    };
  }

  const service = new LifeOpsService(args.runtime);
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
  const resolved = await args.resolveDefinition(service, args.target, domain);
  if (args.target?.trim() && !resolved.match) {
    return unresolvedTargetReply(args.target, resolved.candidates);
  }
  const target = resolved.match;
  const request: SetLifeOpsReminderPreferenceRequest = {
    intensity,
    definitionId: target?.definition.id ?? null,
    note: intent,
  };
  const preference = await service.setReminderPreference(request);
  if (!target) {
    const factStore = resolveOwnerFactStore(args.runtime);
    await factStore.setReminderIntensity(
      { intensity, note: intent },
      policyProvenance(intent),
    );
  }
  const intensityLabel =
    intensity === "high_priority_only"
      ? "high priority only"
      : preference.effective.intensity;
  if (target) {
    return {
      success: true,
      text: `Reminder intensity for "${target.definition.title}" is now ${intensityLabel}.`,
      data: { preference },
    };
  }
  return {
    success: true,
    text: `Global LifeOps reminders are now ${intensityLabel}.`,
    data: { preference },
  };
}

function unresolvedTargetReply(
  target: string,
  candidates: string[],
): ActionResult {
  const text =
    candidates.length > 0
      ? `Which item do you mean by "${target.trim()}"?\n${candidates.map((label) => `  - ${label}`).join("\n")}`
      : `I couldn't find an item called "${target.trim()}".`;
  return {
    success: false,
    text,
    data: { target, candidates },
  };
}

function isReminderChannel(value: unknown): value is LifeOpsReminderChannel {
  return (
    typeof value === "string" &&
    (LIFEOPS_REMINDER_CHANNELS as readonly string[]).includes(value)
  );
}

function nonNegativeMinutes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Steps the owner asked for: explicit `details.steps`, or an in-app nudge at
 * +0 then a call at +callAfterMinutes (timeoutMinutes when only that is
 * given). `null` means nothing usable was supplied.
 */
function requestedEscalationSteps(
  details: Record<string, unknown> | undefined,
  timeoutMinutes: number | null,
  callAfterMinutes: number | null,
): { steps: LifeOpsReminderStep[] } | { invalidChannels: string[] } | null {
  const rawSteps =
    detailArray(details, "steps") ?? detailArray(details, "escalationSteps");
  if (rawSteps && rawSteps.length > 0) {
    const steps: LifeOpsReminderStep[] = [];
    const invalidChannels: string[] = [];
    for (const raw of rawSteps) {
      const step = detailRecord(raw);
      if (!step) continue;
      if (!isReminderChannel(step.channel)) {
        invalidChannels.push(String(step.channel ?? "missing"));
        continue;
      }
      steps.push({
        channel: step.channel,
        offsetMinutes:
          typeof step.offsetMinutes === "number" &&
          Number.isFinite(step.offsetMinutes) &&
          step.offsetMinutes >= 0
            ? step.offsetMinutes
            : 0,
        label: typeof step.label === "string" ? step.label : step.channel,
      });
    }
    if (invalidChannels.length > 0) return { invalidChannels };
    return steps.length > 0 ? { steps } : null;
  }
  const voiceAfter = callAfterMinutes ?? timeoutMinutes;
  if (voiceAfter === null) return null;
  return {
    steps: [
      { channel: "in_app", offsetMinutes: 0, label: "In-app reminder" },
      { channel: "voice", offsetMinutes: voiceAfter, label: "Phone call" },
    ],
  };
}

/** Requested steps replace existing steps on the same channel; the rest of
 * the existing plan (an sms step, say) stays. */
function mergeReminderSteps(
  existing: LifeOpsReminderStep[],
  requested: LifeOpsReminderStep[],
): LifeOpsReminderStep[] {
  const requestedChannels = new Set(requested.map((step) => step.channel));
  return [
    ...existing.filter((step) => !requestedChannels.has(step.channel)),
    ...requested,
  ].sort((a, b) => a.offsetMinutes - b.offsetMinutes);
}

export async function applyOwnerPolicyConfigureEscalation(
  args: OwnerPolicyConfigureEscalationInput,
): Promise<ActionResult> {
  const details = detailRecord(args.details);
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;

  // No reminder path reads OwnerFacts.escalationRules yet, so a global rule
  // would be stored and reported as applied while nothing escalates on it.
  if (!args.target?.trim()) {
    return {
      success: false,
      text: "Global escalation rules are not supported yet. Name a reminder and I'll set its escalation.",
      data: { reason: "global_escalation_unsupported" },
    };
  }
  const service = new LifeOpsService(args.runtime);
  const resolved = await args.resolveDefinition(service, args.target, domain);
  const target = resolved.match;
  if (!target) {
    return unresolvedTargetReply(args.target, resolved.candidates);
  }
  const requested = requestedEscalationSteps(
    details,
    nonNegativeMinutes(args.timeoutMinutes),
    nonNegativeMinutes(args.callAfterMinutes),
  );
  if (requested === null) {
    return {
      success: false,
      text: `How should "${target.definition.title}" escalate? For example: call me if I don't respond in 30 minutes.`,
      data: { reason: "escalation_timing_missing" },
    };
  }
  if ("invalidChannels" in requested) {
    return {
      success: false,
      text: `I can't send reminders by ${requested.invalidChannels.join(", ")}. Use one of: ${LIFEOPS_REMINDER_CHANNELS.join(", ")}.`,
      data: { invalidChannels: requested.invalidChannels },
    };
  }
  const steps =
    details?.replace === true
      ? requested.steps
      : mergeReminderSteps(target.reminderPlan?.steps ?? [], requested.steps);
  const ownership =
    target.definition.domain === "agent_ops"
      ? { domain: "agent_ops" as const, subjectType: "agent" as const }
      : { domain: "user_lifeops" as const, subjectType: "owner" as const };
  const updated = await service.updateDefinition(target.definition.id, {
    ownership,
    reminderPlan: { steps },
  });
  const summary = steps
    .map((s) => `${s.channel} at +${s.offsetMinutes}m`)
    .join(", ");
  return {
    success: true,
    text: `Updated reminder plan for "${updated.definition.title}": ${summary}.`,
    data: { updated },
  };
}
