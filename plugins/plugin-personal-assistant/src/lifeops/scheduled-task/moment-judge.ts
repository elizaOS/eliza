/**
 * Model-judged admission for scheduled/proactive dispatch (#14677): the
 * production reader for the spine's `model_moment_check` gate kind.
 *
 * Every other gate in the fire path is deterministic (clock, flag, threshold).
 * This one gives the MODEL the "should I speak to the owner right now?"
 * decision, fed with the owner context the runtime already tracks: what is
 * about to be sent (the task's structural fields plus its instruction, passed
 * as opaque payload — nothing here branches on the text), how recently the
 * owner was seen, whether the observed rhythm says they are asleep, how long
 * they have been ignoring pokes (quiet streak), the local time, and the
 * owner's extracted schedule preferences. The verdict maps onto the gate
 * vocabulary: send → allow, defer → defer(offsetMinutes), drop → deny.
 *
 * Placement doctrine: deterministic gates that encode HARD constraints
 * (owner-set quiet hours, weekday config) stay as the outer backstop and are
 * composed BEFORE this gate under `first_deny`, so the model call is only paid
 * when everything structural already allowed. Gates that encoded JUDGMENT
 * ("is the owner busy?", "is it too late in the evening?") become inputs to
 * this prompt instead of hardcoded policy. High-priority tasks bypass the
 * judge entirely — a model must never veto an urgent send (same safety rail
 * as `quiet_hours.highPriorityBypass`).
 */

import {
  type IAgentRuntime,
  logger,
  ModelType,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import type {
  GateDecision,
  GateEvaluationContext,
  ScheduledTask,
  TaskGateContribution,
} from "@elizaos/plugin-scheduling";
import {
  quietStreakDaysFromObservations,
  runQuietUserWatcher,
} from "../../default-packs/quiet-user-watcher.js";
import { createRecentTaskStatesProvider } from "../../providers/recent-task-states.js";
import { readActivityProfile } from "./activity-gates.js";

export const MOMENT_JUDGE_TRAJECTORY_PURPOSE = "scheduled-moment-judge";

/** Defer clamp: a model "defer" reschedules between 5 minutes and 8 hours. */
export const MIN_DEFER_MINUTES = 5;
export const MAX_DEFER_MINUTES = 8 * 60;
const DEFAULT_DEFER_MINUTES = 60;

export type MomentJudgeDecision = "send" | "defer" | "drop";

export interface MomentJudgeVerdict {
  decision: MomentJudgeDecision;
  /** Only meaningful for `defer`; clamped to [MIN, MAX]_DEFER_MINUTES. */
  deferMinutes: number;
  reason: string;
}

/** Owner-context brief the judge prompt is grounded in. */
export interface MomentJudgeContext {
  task: Pick<
    ScheduledTask,
    "kind" | "priority" | "source" | "promptInstructions"
  >;
  nowIso: string;
  /** IANA timezone used for the local-time line. */
  timezone: string;
  /** Minutes since the owner was last observed active, when known. */
  minutesSinceOwnerSeen: number | null;
  /** Observed circadian state from the activity profile, when known. */
  ownerObservedAsleep: boolean | null;
  /** Consecutive ignored check-ins/follow-ups; undefined = not quiet. */
  quietStreakDays: number | undefined;
  quietHours: { start: string; end: string } | null;
  morningWindow: { start?: string; end?: string } | null;
  eveningWindow: { start?: string; end?: string } | null;
  chronotype: string | null;
  scheduleStyle: string | null;
}

function localTimeLine(nowIso: string, timezone: string): string {
  const date = new Date(nowIso);
  if (Number.isNaN(date.getTime())) return "unknown";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an invalid owner timezone
    // string degrades to the UTC reading, explicitly labeled as such.
    return `${new Date(nowIso).toISOString()} (UTC; owner timezone invalid)`;
  }
}

/**
 * Build the moment-judge prompt. Pure and exported for direct prompt-content
 * tests. `promptInstructions` is embedded as opaque payload so the judge sees
 * WHAT is about to be sent; no code here branches on it.
 */
export function buildMomentJudgePrompt(context: MomentJudgeContext): string {
  const lines: string[] = [
    "You are the timing judge for a personal assistant. A scheduled message for the owner is about to be sent. Decide whether NOW is a good moment.",
    "Verdicts:",
    '- "send": now is fine (or the message is time-sensitive enough to matter more than the interruption).',
    '- "defer": worth sending, but later — pick deferMinutes for a better moment (owner likely asleep, clearly mid-conversation elsewhere, an odd hour for this kind of message).',
    '- "drop": not worth sending at all (stale, redundant, or the owner has been ignoring these and this one is low-value).',
    "Guidance:",
    "- Messages the owner explicitly asked for (source user_chat) should almost never be dropped; prefer send or a short defer.",
    "- A long quiet streak means back off: prefer defer or drop for low-value pokes instead of chasing.",
    "- If the owner was active moments ago they are present — a relevant message can send; an interruption to deep activity can wait a few minutes.",
    "",
    "About to be sent:",
    `- task kind: ${context.task.kind}; priority: ${context.task.priority}; origin: ${context.task.source}`,
    `- instruction the assistant will compose the message from: ${context.task.promptInstructions}`,
    "",
    "Owner context:",
    `- local time: ${localTimeLine(context.nowIso, context.timezone)}`,
    `- last seen active: ${
      context.minutesSinceOwnerSeen === null
        ? "unknown"
        : `${context.minutesSinceOwnerSeen} minute(s) ago`
    }`,
    `- observed circadian state: ${
      context.ownerObservedAsleep === null
        ? "unknown"
        : context.ownerObservedAsleep
          ? "asleep"
          : "awake"
    }`,
    `- quiet streak: ${
      context.quietStreakDays === undefined
        ? "none (owner has been responsive)"
        : `${context.quietStreakDays} consecutive ignored check-ins/follow-ups`
    }`,
    `- owner-set quiet hours: ${
      context.quietHours
        ? `${context.quietHours.start}-${context.quietHours.end} (already enforced upstream; treat as context)`
        : "none"
    }`,
    `- morning window: ${
      context.morningWindow?.start
        ? `${context.morningWindow.start}-${context.morningWindow.end ?? "?"}`
        : "unknown"
    }; evening window: ${
      context.eveningWindow?.start
        ? `${context.eveningWindow.start}-${context.eveningWindow.end ?? "?"}`
        : "unknown"
    }`,
    `- chronotype: ${context.chronotype ?? "unknown"}; schedule style: ${context.scheduleStyle ?? "unknown"}`,
    "",
    'Respond as JSON only: {"decision": "send" | "defer" | "drop", "deferMinutes": <integer, only for defer>, "reason": "<one short sentence>"}',
  ];
  return lines.join("\n");
}

function clampDeferMinutes(raw: unknown): number {
  const parsed =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.round(raw)
      : typeof raw === "string" && Number.isFinite(Number(raw))
        ? Math.round(Number(raw))
        : DEFAULT_DEFER_MINUTES;
  return Math.min(MAX_DEFER_MINUTES, Math.max(MIN_DEFER_MINUTES, parsed));
}

/**
 * Parse the judge model output into a typed verdict, or `null` when the output
 * carries no usable decision (the caller then treats the judgment as
 * unavailable — it never fabricates a verdict from garbage).
 */
export function parseMomentJudgeVerdict(
  raw: unknown,
): MomentJudgeVerdict | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // error-policy:J3 untrusted-input sanitizing — non-JSON model output is
      // an explicit "no verdict", never coerced into a decision.
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;
  const decisionRaw =
    typeof record.decision === "string"
      ? record.decision.trim().toLowerCase()
      : "";
  if (
    decisionRaw !== "send" &&
    decisionRaw !== "defer" &&
    decisionRaw !== "drop"
  ) {
    return null;
  }
  return {
    decision: decisionRaw,
    deferMinutes: clampDeferMinutes(record.deferMinutes),
    reason:
      typeof record.reason === "string" && record.reason.trim().length > 0
        ? record.reason.trim()
        : "no reason given",
  };
}

/** Assemble the judge's owner-context brief from the runtime + gate context. */
export async function composeMomentJudgeContext(
  runtime: IAgentRuntime,
  task: ScheduledTask,
  context: GateEvaluationContext,
): Promise<MomentJudgeContext> {
  const nowMs = Date.parse(context.nowIso);
  const profile = await readActivityProfile(runtime);
  const lastSeenAt =
    profile && Number.isFinite(profile.lastSeenAt) && profile.lastSeenAt > 0
      ? profile.lastSeenAt
      : null;
  const observations = await runQuietUserWatcher(
    createRecentTaskStatesProvider(runtime),
    { asOf: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()) },
  );
  return {
    task: {
      kind: task.kind,
      priority: task.priority,
      source: task.source,
      promptInstructions: task.promptInstructions,
    },
    nowIso: context.nowIso,
    timezone: context.ownerFacts.timezone ?? "UTC",
    minutesSinceOwnerSeen:
      lastSeenAt !== null && Number.isFinite(nowMs)
        ? Math.max(0, Math.round((nowMs - lastSeenAt) / 60_000))
        : null,
    ownerObservedAsleep: profile ? profile.isCurrentlySleeping === true : null,
    quietStreakDays: quietStreakDaysFromObservations(observations),
    quietHours: context.ownerFacts.quietHours
      ? {
          start: context.ownerFacts.quietHours.start,
          end: context.ownerFacts.quietHours.end,
        }
      : null,
    morningWindow: context.ownerFacts.morningWindow ?? null,
    eveningWindow: context.ownerFacts.eveningWindow ?? null,
    chronotype: context.ownerFacts.chronotype ?? null,
    scheduleStyle: context.ownerFacts.scheduleStyle ?? null,
  };
}

function verdictToGateDecision(verdict: MomentJudgeVerdict): GateDecision {
  switch (verdict.decision) {
    case "send":
      return { kind: "allow" };
    case "defer":
      return {
        kind: "defer",
        until: { offsetMinutes: verdict.deferMinutes },
        reason: `model_moment_check: ${verdict.reason}`,
      };
    case "drop":
      return {
        kind: "deny",
        reason: `model_moment_check: ${verdict.reason}`,
      };
  }
}

/**
 * The production `model_moment_check` gate. First-wins registration in PA's
 * runner wiring makes this take precedence over the spine's always-allow
 * fallback.
 */
export function makeModelMomentCheckGate(
  runtime: IAgentRuntime,
): TaskGateContribution {
  return {
    kind: "model_moment_check",
    async evaluate(
      task: ScheduledTask,
      context: GateEvaluationContext,
    ): Promise<GateDecision> {
      // Safety rail, not judgment: urgent sends are never model-vetoed.
      if (task.priority === "high") {
        return { kind: "allow" };
      }
      const judgeContext = await composeMomentJudgeContext(
        runtime,
        task,
        context,
      );
      let verdict: MomentJudgeVerdict | null;
      try {
        const raw = await runWithTrajectoryPurpose(
          MOMENT_JUDGE_TRAJECTORY_PURPOSE,
          () =>
            runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: buildMomentJudgePrompt(judgeContext),
            }),
        );
        verdict = parseMomentJudgeVerdict(raw);
      } catch (error) {
        // error-policy:J4 explicit degrade — the moment judgment REFINES the
        // deterministic gates that already allowed this fire; when the judge
        // is unavailable the honest behavior is today's deterministic-only
        // dispatch, not a starved task. The failure is surfaced to the agent
        // and owner escalation via reportError.
        runtime.reportError("lifeops:scheduled-task:moment-judge", error, {
          taskId: task.taskId,
          kind: task.kind,
        });
        return { kind: "allow" };
      }
      if (!verdict) {
        logger.warn(
          {
            src: "lifeops:scheduled-task:moment-judge",
            agentId: runtime.agentId,
            taskId: task.taskId,
          },
          "[MomentJudge] unparseable judge output; proceeding without a moment judgment",
        );
        return { kind: "allow" };
      }
      logger.info(
        {
          src: "lifeops:scheduled-task:moment-judge",
          agentId: runtime.agentId,
          taskId: task.taskId,
          decision: verdict.decision,
          deferMinutes: verdict.deferMinutes,
          reason: verdict.reason,
        },
        `[MomentJudge] ${verdict.decision}: ${verdict.reason}`,
      );
      return verdictToGateDecision(verdict);
    },
  };
}

/**
 * Register the production moment judge into a gate registry. Must run BEFORE
 * `registerBuiltInGates` (first-wins) so this reader shadows the spine's
 * always-allow fallback.
 */
export function registerModelMomentCheckGate(
  runtime: IAgentRuntime,
  registry: { register(c: TaskGateContribution): void },
): void {
  registry.register(makeModelMomentCheckGate(runtime));
}
