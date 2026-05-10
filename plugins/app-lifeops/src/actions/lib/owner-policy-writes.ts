/**
 * Shared owner-policy writers for the LifeOps action surface.
 *
 * `LIFE.policy_set_reminder` / `LIFE.policy_configure_escalation` use these
 * helpers so the OwnerFactStore is the single source of truth for reminder
 * intensity + escalation rules.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import type {
  LifeOpsDefinitionRecord,
  LifeOpsDomain,
  LifeOpsReminderStep,
  SetLifeOpsReminderPreferenceRequest,
} from "../../contracts/index.js";
import {
  type OwnerFactProvenance,
  type ReminderIntensity,
  resolveOwnerFactStore,
} from "../../lifeops/owner/fact-store.js";
import { LifeOpsService } from "../../lifeops/service.js";
import { extractReminderIntensityWithLlm } from "./extract-task-plan.js";

/**
 * Caller-supplied resolver. Accepted as a parameter so this module stays
 * free of inbound imports from `actions/life.ts` (which owns the one
 * canonical impl) and avoids a circular dep between `actions/life.ts` and
 * `actions/lib/`.
 */
export type DefinitionResolver = (
  service: LifeOpsService,
  target: string | undefined,
  intent: string,
  domain?: LifeOpsDomain,
) => Promise<LifeOpsDefinitionRecord | null>;

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
    provenance.note = intent.slice(0, 200);
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
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const details = detailRecord(args.details);
  const intent =
    args.intent.trim() ||
    (typeof args.message.content?.text === "string"
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
  const target = await args.resolveDefinition(
    service,
    args.target,
    intent,
    domain,
  );
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

export async function applyOwnerPolicyConfigureEscalation(
  args: OwnerPolicyConfigureEscalationInput,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const details = detailRecord(args.details);
  const service = new LifeOpsService(args.runtime);
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
  const intent =
    typeof args.message.content?.text === "string"
      ? args.message.content.text
      : "";

  if (!args.target) {
    const timeoutMinutes =
      typeof args.timeoutMinutes === "number" ? args.timeoutMinutes : null;
    const callAfterMinutes =
      typeof args.callAfterMinutes === "number" ? args.callAfterMinutes : null;
    if (timeoutMinutes === null && callAfterMinutes === null) {
      return {
        success: true,
        text: "No target supplied and no escalation timing provided; global escalation defaults are unchanged.",
        data: {
          timeoutMinutes: null,
          callAfterMinutes: null,
        },
      };
    }
    const factStore = resolveOwnerFactStore(args.runtime);
    const facts = await factStore.upsertEscalationRule(
      {
        rule: {
          definitionId: null,
          timeoutMinutes,
          callAfterMinutes,
        },
        note: intent,
      },
      policyProvenance(intent),
    );
    return {
      success: true,
      text: `Global escalation policy updated (timeout=${timeoutMinutes ?? "unset"}m, voice-after=${callAfterMinutes ?? "unset"}m).`,
      data: {
        facts,
        timeoutMinutes,
        callAfterMinutes,
      },
    };
  }
  const target = await args.resolveDefinition(
    service,
    args.target,
    args.target,
    domain,
  );
  if (!target) {
    return {
      success: false,
      text: "I could not find that item to configure its escalation.",
    };
  }
  const ownership =
    target.definition.domain === "agent_ops"
      ? { domain: "agent_ops" as const, subjectType: "agent" as const }
      : { domain: "user_lifeops" as const, subjectType: "owner" as const };
  const rawSteps =
    detailArray(details, "steps") ?? detailArray(details, "escalationSteps");
  const steps: LifeOpsReminderStep[] = rawSteps
    ? rawSteps
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null,
        )
        .map((s) => ({
          channel: String(
            s.channel ?? "in_app",
          ) as LifeOpsReminderStep["channel"],
          offsetMinutes:
            typeof s.offsetMinutes === "number" ? s.offsetMinutes : 0,
          label:
            typeof s.label === "string"
              ? s.label
              : String(s.channel ?? "reminder"),
        }))
    : [{ channel: "in_app", offsetMinutes: 0, label: "In-app reminder" }];
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
