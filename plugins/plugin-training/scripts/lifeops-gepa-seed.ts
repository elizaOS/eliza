#!/usr/bin/env bun
/**
 * Seed-dataset GEPA optimizer for a LifeOps per-capability task, run against
 * gpt-oss-120b on Cerebras (#9299, Scope 5).
 *
 * Unlike `lifeops:gepa` (which buckets recorded trajectories), this entrypoint
 * carries a small, hand-curated seed dataset so the GEPA loop can run before
 * any trajectories have been captured. It reuses the real building blocks:
 *   - the GEPA optimizer (`runGepa`) + LifeOps scorer (`scoreLifeOpsTask`),
 *   - plugin-training's Cerebras client (`getTrainingUseModelAdapter`),
 *   - the standard optimized-prompt store (`OptimizedPromptService.setPrompt`),
 *     so the artifact auto-loads at boot.
 *
 * It prints the measured before/after score and persists the optimized prompt
 * only when `--apply` is passed and the optimized prompt beats the baseline.
 *
 *   TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=... \
 *     bun run --cwd plugins/plugin-training scripts/lifeops-gepa-seed.ts \
 *       --task calendar_extract [--apply] [--generations 2] [--population 4]
 *
 * Providers (#11384): `cerebras` and `anthropic` use API keys via
 * `cerebras-eval-model`; `cli` runs on a subscription-only host through
 * plugin-cli-inference's `claude --print` lane (#10757, no API key):
 *
 *   TRAIN_MODEL_PROVIDER=cli EVAL_MODEL_PROVIDER=cli \
 *     bun run --cwd plugins/plugin-training scripts/lifeops-gepa-seed.ts \
 *       --task reminder_dispatch --apply
 *
 * Scoring: the structured planner tasks (calendar_extract, schedule_plan,
 * inbox_triage, health_checkin) use the deterministic field-match scorer; the
 * prose/NL tasks (reminder_dispatch, meeting_prep, morning_brief,
 * screentime_recap) are graded by a live judge against per-example rubrics
 * (`createLifeOpsJudgeCompare`).
 *
 * Without `--apply` it runs the optimization and reports metrics but does not
 * persist (dry run).
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  type OptimizedPromptArtifact,
  OptimizedPromptService,
  type OptimizedPromptTask,
} from "@elizaos/core";
import { CALENDAR_PLAN_INSTRUCTIONS } from "../../plugin-calendar/src/actions/optimized-prompt-instructions.ts";
import {
  HEALTH_PLAN_INSTRUCTIONS,
  SCREENTIME_RECAP_INSTRUCTIONS,
} from "../../plugin-health/src/actions/optimized-prompt-instructions.ts";
import { INBOX_TRIAGE_INSTRUCTIONS } from "../../plugin-inbox/src/inbox/triage-classifier.ts";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
  REMINDER_DISPATCH_INSTRUCTIONS,
  SCHEDULE_PLAN_INSTRUCTIONS,
} from "../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts";
import {
  type EvalModelClient,
  getEvalModelClient,
  getTrainingUseModelAdapter,
} from "../src/core/cerebras-eval-model.ts";
import {
  createLifeOpsJudgeCompare,
  encodeJudgeExpectation,
  LIFEOPS_JUDGE_TASKS,
} from "../src/core/lifeops-judge-scorer.ts";
import {
  createPromptScorer,
  createRuntimeAdapter,
  type OptimizationExample,
  type OptimizerResult,
  runGepa,
  scoreLifeOpsTask,
} from "../src/optimizers/index.ts";
import { getCliModelClient, resolveCliModel } from "./lib/cli-model.ts";

const DEFAULT_GENERATIONS = 2;
const DEFAULT_POPULATION = 4;
const MAX_GENERATIONS = 20;
const MAX_POPULATION = 50;
const MIN_PERSIST_DELTA = 0.0001;

export interface SeedTask {
  task: OptimizedPromptTask;
  baseline: string;
  dataset: OptimizationExample[];
}

interface CalendarPlannerInputArgs {
  currentMessage: string;
  intent?: string;
  recentConversation?: string;
}

function calendarPlannerInput(args: CalendarPlannerInputArgs): string {
  const intent = args.intent ?? args.currentMessage;
  return [
    "Current timezone: America/Los_Angeles",
    "LOCAL DATE ANCHORS (authoritative - IGNORE UTC day for date arithmetic): yesterday = 2026-06-23, today = 2026-06-24, tomorrow = 2026-06-25.",
    "Current local datetime: Wednesday, June 24, 2026 at 9:00:00 AM PDT",
    "Current ISO datetime (informational only - do NOT use for 'today/tomorrow/yesterday'): 2026-06-24T16:00:00.000Z",
    "When the user says 'today', 'tomorrow', 'yesterday', or similar, resolve the calendar day from the LOCAL DATE ANCHORS above (not from the UTC datetime) and build timeMin/timeMax as a full local-day window in the current timezone.",
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Recent conversation:\n${args.recentConversation ?? "(none)"}`,
  ].join("\n");
}

function expectedCalendarPlan(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

interface SchedulingPlannerInputArgs {
  currentMessage: string;
  intent?: string;
  params?: Record<string, unknown>;
  recentConversation?: string;
}

function schedulingPlannerInput(args: SchedulingPlannerInputArgs): string {
  const intent = args.intent ?? args.currentMessage;
  const params = args.params ?? {};
  const paramLines = Object.entries(params)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  return [
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${intent}`,
    `Structured parameters:\n${paramLines || "(none)"}`,
    `Recent conversation:\n${args.recentConversation ?? "(none)"}`,
  ].join("\n");
}

function expectedSchedulePlan(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function inboxClassificationInput(args: {
  senderName: string;
  channel?: string;
  text: string;
  ownerContext?: string;
}): string {
  return [
    "Owner context:",
    args.ownerContext ??
      "The owner prioritizes legal, finance, and calendar-critical messages.",
    "",
    "Messages:",
    JSON.stringify(
      [
        {
          id: "msg-1",
          senderName: args.senderName,
          channel: args.channel ?? "email",
          text: args.text,
        },
      ],
      null,
      2,
    ),
  ].join("\n");
}

function expectedInboxClassification(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

interface HealthPlannerInputArgs {
  currentMessage: string;
  intent?: string;
  params?: Record<string, unknown>;
  recentConversation?: string;
}

// Mirrors resolveHealthPlanWithLlm's composed prompt body
// (plugin-health/src/actions/health.ts) so GEPA optimizes the production
// health_checkin planner, not a divergent shape.
function healthPlannerInput(args: HealthPlannerInputArgs): string {
  const intent = args.intent ?? args.currentMessage;
  const params = args.params ?? {};
  const paramLines = Object.entries(params)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  return [
    "Current request:",
    args.currentMessage,
    "Resolved intent:",
    intent,
    "Structured parameters:",
    paramLines || "(none)",
    "Recent conversation:",
    args.recentConversation ?? "(none)",
  ].join("\n");
}

function expectedHealthPlan(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

// ---------------------------------------------------------------------------
// Prose/NL task input builders (#11384). These mirror the production prompt
// composition that FOLLOWS the resolved instructions at each call site, since
// the GEPA scorer composes `${candidatePrompt}\n\n${input.user}`. Expected
// outputs are judge rubrics (encodeJudgeExpectation), graded live by
// `createLifeOpsJudgeCompare`, not exact-matched.
// ---------------------------------------------------------------------------

// Mirrors buildReminderDispatchPrompt (plugin-personal-assistant
// lifeops/domains/reminders-service.ts): everything after the resolved
// instructions, ending with the "Reminder text:" cue.
function reminderDispatchInput(args: {
  title: string;
  due: string;
  channel: string;
  urgency: "low" | "medium" | "high" | "critical";
  lifecycle: "plan" | "escalation";
  voice?: string;
  recentConversation?: string[];
  nearbyReminderTitles?: string[];
}): string {
  return [
    "Character voice:",
    args.voice ?? "No extra character context.",
    "",
    "Current reminder:",
    `- title: ${args.title}`,
    `- due: ${args.due}`,
    `- channel: ${args.channel}`,
    `- urgency: ${args.urgency}`,
    `- lifecycle: ${args.lifecycle}`,
    "",
    "Recent conversation:",
    args.recentConversation && args.recentConversation.length > 0
      ? args.recentConversation.join("\n")
      : "No recent conversation available.",
    "",
    "Other reminders around this time:",
    args.nearbyReminderTitles && args.nearbyReminderTitles.length > 0
      ? args.nearbyReminderTitles.map((title) => `- ${title}`).join("\n")
      : "None.",
    "",
    "Reminder text:",
  ].join("\n");
}

// Mirrors buildNarrativePrompt (plugin-personal-assistant actions/brief.ts)
// for both morning_brief and meeting_prep. Production interleaves the header
// BEFORE the resolved instructions ("header\n\ninstructions\n\nData:"); the
// GEPA composition puts the candidate instructions first, so the header leads
// input.user instead — the data payload and header text are identical.
function briefNarrativeInput(args: {
  kind: "morning" | "evening" | "weekly";
  period: "today" | "tomorrow" | "this_week";
  sections: Record<string, unknown>;
}): string {
  const payload = JSON.stringify(
    { kind: args.kind, period: args.period, sections: args.sections },
    null,
    2,
  );
  return [
    `You are composing the owner's ${args.kind} briefing for ${args.period}.`,
    "",
    "Data:",
    payload,
  ].join("\n");
}

// Mirrors the screen-time recap render context (plugin-health
// actions/screen-time.ts respond → renderReply with
// buildScreenTimeRecapRules): the optimizable policy is the candidate prompt;
// the reply is rendered from the owner request + screen-time context below.
function screentimeRecapInput(args: {
  request: string;
  thisPeriodLabel: string;
  thisPeriod: Array<{ app: string; minutes: number }>;
  priorPeriodLabel?: string;
  priorPeriod?: Array<{ app: string; minutes: number }>;
  usageNotes?: string[];
}): string {
  const lines = [
    "Owner request:",
    args.request,
    "",
    "Screen-time context:",
    `This period (${args.thisPeriodLabel}):`,
    ...args.thisPeriod.map((row) => `- ${row.app}: ${row.minutes}m`),
  ];
  if (args.priorPeriod && args.priorPeriodLabel) {
    lines.push(
      `Prior period (${args.priorPeriodLabel}):`,
      ...args.priorPeriod.map((row) => `- ${row.app}: ${row.minutes}m`),
    );
  } else {
    lines.push("Prior period: no data recorded (first tracked period).");
  }
  if (args.usageNotes && args.usageNotes.length > 0) {
    lines.push("Usage notes:", ...args.usageNotes.map((note) => `- ${note}`));
  }
  return lines.join("\n");
}

function judgeExpectation(reference: string, rubric: string[]): string {
  return encodeJudgeExpectation({ reference, rubric });
}

export const SEED_TASKS: Record<string, SeedTask> = {
  // calendar_extract is the live calendar action planner, not the downstream
  // create-event field extractor. Keep the baseline and rows aligned with
  // CALENDAR_PLAN_INSTRUCTIONS and CalendarLlmPlan.
  calendar_extract: {
    task: "calendar_extract",
    baseline: CALENDAR_PLAN_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "What's on my calendar today?",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "feed",
          shouldAct: true,
          queries: [],
          timeMin: "2026-06-24T00:00:00-07:00",
          timeMax: "2026-06-25T00:00:00-07:00",
          windowLabel: "today",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "What's my next meeting?",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "next_event",
          shouldAct: true,
          queries: [],
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "Find my return flight to Denver.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "search_events",
          shouldAct: true,
          queries: ["return flight to denver", "denver"],
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage:
              "Set up a dentist appointment on March 3rd at 9am for 30 minutes at Downtown Dental.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "create_event",
          shouldAct: true,
          title: "dentist appointment",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage:
              "Block 2-3pm tomorrow for a 1:1 with Priya in the small conference room.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "create_event",
          shouldAct: true,
          title: "1:1 with Priya",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "Move the dentist appointment to Friday afternoon.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "update_event",
          shouldAct: true,
          queries: ["dentist appointment"],
          windowLabel: "Friday afternoon",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "Cancel the team meeting tomorrow.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "delete_event",
          shouldAct: true,
          queries: ["team meeting"],
          timeMin: "2026-06-25T00:00:00-07:00",
          timeMax: "2026-06-26T00:00:00-07:00",
          windowLabel: "tomorrow",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "What do I have while I'm in Tokyo?",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "trip_window",
          shouldAct: true,
          queries: ["tokyo"],
          tripLocation: "Tokyo",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage:
              "Réserve un rendez-vous chez le médecin mardi à 10h pour une heure à la clinique du centre.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "create_event",
          shouldAct: true,
          title: "rendez-vous médecin",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage:
              "Termin beim Friseur am Samstag um 14 Uhr, eine halbe Stunde, im Salon Schmidt.",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: "create_event",
          shouldAct: true,
          title: "Friseurtermin",
        }),
      },
      {
        input: {
          user: calendarPlannerInput({
            currentMessage: "Can you help me with my calendar?",
          }),
        },
        expectedOutput: expectedCalendarPlan({
          subaction: null,
          shouldAct: false,
        }),
      },
    ],
  },
  // schedule_plan is the live scheduling-negotiation planner
  // (buildSchedulingPlanPrompt → SCHEDULE_PLAN_INSTRUCTIONS). It returns a JSON
  // object with subaction / shouldAct / response. Rows cover every subaction,
  // the wrong-tool and vague guards (shouldAct=false), and multilingual,
  // formal+informal phrasing per the GEPA-real-conversation requirement (#9299).
  schedule_plan: {
    task: "schedule_plan",
    baseline: SCHEDULE_PLAN_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Set up a time to meet with Jordan next week for a 30-minute sync.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "start",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Propose Thursday at 2pm for the budget review negotiation.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "propose",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage: "Accept the 3pm slot Dana proposed.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "respond",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Lock in the Tuesday 10am option for the design sync.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "finalize",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Cancel the scheduling negotiation for the offsite planning call.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "cancel",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage: "Which scheduling negotiations are still open?",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "list_active",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Show me the proposed times for the Q3 roadmap meeting.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "list_proposals",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Trouve un créneau avec Camille la semaine prochaine pour caler une réunion d'une heure.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "start",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage:
              "Acepto la propuesta de las 4 de la tarde de Marco.",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: "respond",
          shouldAct: true,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage: "What's on my calendar today?",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: null,
          shouldAct: false,
        }),
      },
      {
        input: {
          user: schedulingPlannerInput({
            currentMessage: "Can you help me with scheduling stuff?",
          }),
        },
        expectedOutput: expectedSchedulePlan({
          subaction: null,
          shouldAct: false,
        }),
      },
    ],
  },
  // inbox_triage is the live cross-channel classifier in plugin-inbox. Keep
  // the seed rows aligned with INBOX_TRIAGE_INSTRUCTIONS so GEPA optimizes the
  // production classifier, not the old PA Gmail planner.
  inbox_triage: {
    task: "inbox_triage",
    baseline: INBOX_TRIAGE_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: inboxClassificationInput({
            senderName: "CFO",
            text: "Wire cutoff is in 20 minutes and we need your approval on the settlement transfer.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "urgent",
          urgency: "high",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Mia",
            text: "Can you confirm whether 2pm works and send the deck before the client call?",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "needs_reply",
          urgency: "medium",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Northstar Vendor",
            text: "Your renewal invoice is attached for records. No action is needed unless details changed.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "info",
          urgency: "low",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Airline",
            text: "Boarding pass for Denver is ready. Gate B12. Boarding starts at 4:35pm.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "notify",
          urgency: "medium",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Marketing Newsletter",
            text: "This week's roundup: five productivity tips and our latest product launch.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "ignore",
          urgency: "low",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Ana",
            text: "¿Puedes revisar la factura de renovación hoy y decirme si la aprobamos?",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "needs_reply",
          urgency: "medium",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Security",
            text: "Unusual login detected from a new device. Confirm whether this was you.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "urgent",
          urgency: "high",
        }),
      },
      {
        input: {
          user: inboxClassificationInput({
            senderName: "Calendar Bot",
            text: "Room booking accepted for tomorrow's staff meeting.",
          }),
        },
        expectedOutput: expectedInboxClassification({
          category: "info",
          urgency: "low",
        }),
      },
    ],
  },
  // health_checkin is the live HEALTH action planner
  // (resolveHealthPlanWithLlm → HEALTH_PLAN_INSTRUCTIONS). It returns a JSON
  // object with subaction / metric / days / shouldAct. Rows cover every
  // subaction, the by_metric enum, day-window inference, the vague guard
  // (shouldAct=false), and multilingual phrasing — the same discipline as
  // schedule_plan so the structured-field scorer is discriminative.
  health_checkin: {
    task: "health_checkin",
    baseline: HEALTH_PLAN_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "How am I doing health-wise today?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "today",
          metric: null,
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "Show me my activity trend over the last week.",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "trend",
          metric: null,
          days: 7,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "How many steps did I take today?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "by_metric",
          metric: "steps",
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "What's my resting heart rate lately?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "by_metric",
          metric: "heart_rate",
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "How much did I sleep last night?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "by_metric",
          metric: "sleep_hours",
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "Is my health tracker actually connected?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "status",
          metric: null,
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "Give me my calorie burn for the past 30 days.",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "trend",
          metric: "calories",
          days: 30,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "¿Cuántos pasos di hoy?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "by_metric",
          metric: "steps",
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "Comment va ma santé aujourd'hui ?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: "today",
          metric: null,
          days: null,
          shouldAct: true,
        }),
      },
      {
        input: {
          user: healthPlannerInput({
            currentMessage: "Can you help me with health stuff?",
          }),
        },
        expectedOutput: expectedHealthPlan({
          subaction: null,
          metric: null,
          days: null,
          shouldAct: false,
        }),
      },
    ],
  },
  // reminder_dispatch is the live reminder-nudge writer
  // (buildReminderDispatchPrompt → REMINDER_DISPATCH_INSTRUCTIONS). Output is
  // one or two sentences of natural prose, so rows are judge-graded rubrics:
  // constraint compliance (no "Reminder" prefix, no ISO timestamps, no
  // markdown/emoji, length) plus content grounding (mentions the reminder,
  // tone matches lifecycle/urgency, language matches the conversation).
  reminder_dispatch: {
    task: "reminder_dispatch",
    baseline: REMINDER_DISPATCH_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: reminderDispatchInput({
            title: "Take out the trash",
            due: "6/24/2026, 7:00:00 PM",
            channel: "in_app",
            urgency: "medium",
            lifecycle: "plan",
          }),
        },
        expectedOutput: judgeExpectation(
          "Trash pickup is tomorrow morning — tonight's the night to get the bins out.",
          [
            "Mentions taking out the trash (or the bins).",
            "Does not begin with the word 'Reminder' or 'Follow-up'.",
            "Contains no ISO-8601 timestamp (like 2026-06-24T19:00:00).",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Submit quarterly tax payment",
            due: "6/24/2026, 5:00:00 PM",
            channel: "email",
            urgency: "critical",
            lifecycle: "escalation",
          }),
        },
        expectedOutput: judgeExpectation(
          "The quarterly tax payment is due by 5 PM today and it still isn't in — this one really can't slip.",
          [
            "Mentions the quarterly tax payment.",
            "Sounds firmer than a first gentle nudge while still reading as a human message, not a system log.",
            "Does not begin with the word 'Reminder' or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Take your medication",
            due: "6/24/2026, 9:00:00 AM",
            channel: "push",
            urgency: "high",
            lifecycle: "plan",
            nearbyReminderTitles: ["Water the plants", "Call the pharmacy"],
          }),
        },
        expectedOutput: judgeExpectation(
          "Time for your morning medication — and while you're up, the plants and the pharmacy call are queued too.",
          [
            "Mentions taking the medication.",
            "If it references the other reminders (plants, pharmacy), it does so briefly in the same flowing sentence rather than as a list.",
            "Does not begin with the word 'Reminder' or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Daily standup",
            due: "6/24/2026, 9:15:00 AM",
            channel: "in_app",
            urgency: "medium",
            lifecycle: "plan",
            voice: [
              "Name: Milady",
              "Bio: playful, warm, concise personal assistant who keeps the owner on track without nagging.",
            ].join("\n"),
            recentConversation: [
              "Owner: morning! coffee first, then work",
              "Milady: deal — coffee is a load-bearing beverage.",
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          "Coffee's earned — standup is at 9:15, so bring the mug along.",
          [
            "Mentions the standup.",
            "Reads warm or lightly playful, consistent with the character voice, not corporate or robotic.",
            "Does not begin with the word 'Reminder' or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Sacar la basura",
            due: "6/24/2026, 8:00:00 PM",
            channel: "in_app",
            urgency: "medium",
            lifecycle: "plan",
            recentConversation: [
              "Owner: recuérdame sacar la basura esta noche",
              "Assistant: claro, te aviso a las ocho.",
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          "Ya son las ocho — toca sacar la basura antes de que se te pase.",
          [
            "Is written in Spanish, matching the conversation.",
            "Mentions taking out the trash (la basura).",
            "Does not begin with the word 'Reminder', 'Recordatorio', or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Appeler maman",
            due: "6/24/2026, 6:30:00 PM",
            channel: "sms",
            urgency: "low",
            lifecycle: "plan",
            recentConversation: [
              "Owner: rappelle-moi d'appeler maman ce soir",
              "Assistant: c'est noté, je te fais signe vers 18h30.",
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          "Il est 18h30 — c'est le bon moment pour appeler ta maman.",
          [
            "Is written in French, matching the conversation.",
            "Mentions calling mom (appeler maman).",
            "Does not begin with the word 'Reminder', 'Rappel', or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Gym session",
            due: "6/24/2026, 6:00:00 PM",
            channel: "push",
            urgency: "medium",
            lifecycle: "plan",
            recentConversation: [
              "Owner: slammed with the release deadline today",
              "Assistant: understood — I'll keep interruptions light.",
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          "Deadline or not, your gym slot is here — even a short session counts.",
          [
            "Mentions the gym or workout.",
            "Fits the busy-day context naturally without guilt-tripping or lecturing.",
            "Does not begin with the word 'Reminder' or 'Follow-up'.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
      {
        input: {
          user: reminderDispatchInput({
            title: "Submit expense report",
            due: "6/23/2026, 5:00:00 PM",
            channel: "in_app",
            urgency: "high",
            lifecycle: "escalation",
            recentConversation: [
              "Assistant: your expense report is due by end of day.",
              "Assistant: nudging again — the expense report is still open.",
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          "That expense report is now overdue and finance is waiting on it — please get it in today.",
          [
            "Mentions the expense report.",
            "Sounds firmer than the earlier nudges shown in the conversation while staying human.",
            "Does not use all-caps words or exclamation-heavy shouting.",
            "Is one or two sentences long.",
            "Contains no markdown formatting, bullets, quotes, labels, or emoji.",
          ],
        ),
      },
    ],
  },
  // morning_brief is the live briefing-narrative composer
  // (buildNarrativePrompt → BRIEF_NARRATIVE_INSTRUCTIONS). Rows are
  // judge-graded: prioritization (schedule-changing / reply-needed first),
  // per-domain coverage without empty-domain filler, 2-5 sentence length, and
  // strict grounding in the JSON data payload.
  morning_brief: {
    task: "morning_brief",
    baseline: BRIEF_NARRATIVE_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Dentist appointment (moved to 3:00 PM)",
                  startAt: "2026-06-24T15:00:00-07:00",
                  endAt: "2026-06-24T15:30:00-07:00",
                },
                {
                  id: "cal-2",
                  title: "Team standup",
                  startAt: "2026-06-24T09:15:00-07:00",
                  endAt: "2026-06-24T09:30:00-07:00",
                },
              ],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Marta (landlord)",
                  snippet: "Need your decision on the lease renewal by Friday.",
                  urgency: "high",
                  classification: "needs_reply",
                },
              ],
              life: [
                {
                  id: "life-1",
                  kind: "todo",
                  title: "Submit insurance forms",
                  dueAt: "2026-06-24T17:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Your landlord needs a lease-renewal decision by Friday, and today's dentist appointment has moved to 3 PM. Standup runs at 9:15 as usual. The insurance forms are also due by end of day.",
          [
            "Opens with a reply-needed or schedule-changing item (the lease-renewal reply or the moved dentist appointment), not the routine standup.",
            "Mentions the calendar, inbox, and life items — each domain at least once.",
            "Does not mention money, finances, or subscriptions (that domain is absent from the data).",
            "Is a narrative paragraph of 2 to 5 sentences, not a bullet list.",
            "States only facts present in the data (no invented times, senders, or tasks).",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Design review",
                  startAt: "2026-06-24T11:00:00-07:00",
                  endAt: "2026-06-24T12:00:00-07:00",
                },
                {
                  id: "cal-2",
                  title: "Lunch with Sam",
                  startAt: "2026-06-24T12:30:00-07:00",
                  endAt: "2026-06-24T13:30:00-07:00",
                },
              ],
              inbox: [],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "A light day: the design review runs 11 to noon, then you're at lunch with Sam at 12:30.",
          [
            "Mentions both calendar items (design review and lunch with Sam).",
            "Does not say 'nothing to report' about the empty inbox or life domains, and does not dwell on them.",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "evening",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Dinner with Alex",
                  startAt: "2026-06-24T19:00:00-07:00",
                  endAt: "2026-06-24T21:00:00-07:00",
                  location: "Nopa",
                },
              ],
              inbox: [],
              life: [
                {
                  id: "life-1",
                  kind: "reminder",
                  title: "Take evening medication",
                  dueAt: "2026-06-24T22:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Tonight you have dinner with Alex at Nopa from 7 to 9, and your evening medication is set for 10 PM.",
          [
            "Mentions the dinner with Alex and the evening medication.",
            "Does not mention the inbox (it is empty) or invent messages.",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "weekly",
            period: "this_week",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Quarterly planning offsite",
                  startAt: "2026-06-25T09:00:00-07:00",
                  endAt: "2026-06-25T17:00:00-07:00",
                },
              ],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Ravi (accountant)",
                  snippet: "Please confirm the Q2 estimated payment figure.",
                  urgency: "high",
                  classification: "needs_reply",
                },
              ],
              life: [],
              money: [
                {
                  id: "money-1",
                  merchant: "Netflix",
                  amountUsd: 15.49,
                  cadence: "monthly",
                  nextChargeAt: "2026-06-26T00:00:00-07:00",
                },
                {
                  id: "money-2",
                  merchant: "City Gym",
                  amountUsd: 45,
                  cadence: "monthly",
                  nextChargeAt: "2026-06-28T00:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Ravi needs the Q2 estimated payment figure confirmed, so that reply comes first. Thursday is fully blocked by the quarterly planning offsite. On the money side, Netflix ($15.49) renews Friday and City Gym ($45) on Sunday.",
          [
            "Opens with the reply-needed accountant item rather than the offsite or the subscriptions.",
            "Mentions the offsite and at least one of the upcoming charges (Netflix or City Gym).",
            "Mentions the money domain since it is non-empty.",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data (no invented amounts or dates).",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: { calendar: [], inbox: [], life: [] },
          }),
        },
        expectedOutput: judgeExpectation(
          "Nothing is scheduled today and the inbox is quiet — a clear day to spend however you like.",
          [
            "States that the day is clear or light.",
            "Invents no specific events, messages, tasks, or amounts.",
            "Is at most two sentences.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Sprint review",
                  startAt: "2026-06-24T10:00:00-07:00",
                  endAt: "2026-06-24T11:00:00-07:00",
                },
                {
                  id: "cal-2",
                  title: "Vendor demo",
                  startAt: "2026-06-24T14:00:00-07:00",
                  endAt: "2026-06-24T15:00:00-07:00",
                },
                {
                  id: "cal-3",
                  title: "Architecture sync",
                  startAt: "2026-06-24T14:00:00-07:00",
                  endAt: "2026-06-24T14:45:00-07:00",
                },
                {
                  id: "cal-4",
                  title: "Coffee with Jordan",
                  startAt: "2026-06-24T16:00:00-07:00",
                  endAt: "2026-06-24T16:30:00-07:00",
                },
                {
                  id: "cal-5",
                  title: "Evening yoga",
                  startAt: "2026-06-24T18:00:00-07:00",
                  endAt: "2026-06-24T19:00:00-07:00",
                },
              ],
              inbox: [],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Heads-up: the vendor demo and the architecture sync are both at 2 PM, so one needs to move. Otherwise the day runs from sprint review at 10 through coffee with Jordan at 4 and yoga at 6.",
          [
            "Flags the 2 PM overlap between the vendor demo and the architecture sync before the routine items.",
            "Summarizes the day in flowing prose rather than enumerating all five events as a list.",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Chen (counsel)",
                  snippet:
                    "Contract signature deadline is 5 PM today — please review clause 7 first.",
                  urgency: "high",
                  classification: "needs_reply",
                },
                {
                  id: "msg-2",
                  channel: "slack",
                  senderName: "Design team",
                  snippet: "New mockups posted for the settings page.",
                  urgency: "low",
                  classification: "info",
                },
                {
                  id: "msg-3",
                  channel: "email",
                  senderName: "Newsletter",
                  snippet: "This week in tech...",
                  urgency: "low",
                  classification: "ignore",
                },
              ],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Chen needs the contract signed by 5 PM today, with clause 7 reviewed first — that's the priority. The rest of the inbox is light: new settings mockups from the design team and a newsletter you can skip.",
          [
            "Leads with the contract-signature deadline from counsel.",
            "Does not give the low-urgency newsletter or mockups more weight than the legal deadline.",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Product sync",
                  startAt: "2026-06-24T13:00:00-07:00",
                  endAt: "2026-06-24T13:30:00-07:00",
                },
              ],
              inbox: [],
              life: [
                {
                  id: "life-1",
                  kind: "todo",
                  title: "Renew passport",
                  dueAt: "2026-06-23T17:00:00-07:00",
                },
                {
                  id: "life-2",
                  kind: "goal",
                  title: "Read 12 books this year",
                  dueAt: null,
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "The passport renewal slipped past yesterday's deadline, so that's the first thing to clear. Your only meeting is the product sync at 1 PM, and the reading goal keeps ticking in the background.",
          [
            "Mentions the overdue passport renewal with priority over the routine items.",
            "Mentions the product sync.",
            "Does not mention money or finances (that domain is absent).",
            "Is a narrative paragraph of 2 to 5 sentences.",
            "States only facts present in the data.",
          ],
        ),
      },
    ],
  },
  // meeting_prep is the same live composer (buildNarrativePrompt) resolved
  // with MEETING_PREP_INSTRUCTIONS when the owner asks for meeting prep. Rows
  // are judge-graded: surfacing missing agenda/location/dial-in/prep-doc,
  // decision owners, blockers, and likely follow-ups — while staying compact
  // and grounded in the data payload.
  meeting_prep: {
    task: "meeting_prep",
    baseline: MEETING_PREP_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "tomorrow",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Board meeting",
                  startAt: "2026-06-25T10:00:00-07:00",
                  endAt: "2026-06-25T12:00:00-07:00",
                },
              ],
              inbox: [],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Tomorrow's board meeting (10-12) has no agenda circulated and no location or dial-in on the invite — both need chasing today. No prep document is linked either, so ask the chief of staff what pre-read the board expects.",
          [
            "Flags that no agenda exists for the board meeting.",
            "Flags the missing location or dial-in.",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no attendees, documents, or facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Client call — Acme renewal",
                  startAt: "2026-06-24T14:00:00-07:00",
                  endAt: "2026-06-24T15:00:00-07:00",
                  location: "Zoom (link on invite)",
                },
              ],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Dana (Acme)",
                  snippet:
                    "Agenda attached: pricing tier change and the renewal timeline.",
                  urgency: "medium",
                  classification: "needs_reply",
                },
              ],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "The 2 PM Acme renewal call has an agenda from Dana — pricing tier change and renewal timeline — and the Zoom link is on the invite. What's missing is your own prep document: pull the current contract terms and a pricing comparison before the call, and Dana's email still needs a reply.",
          [
            "Acknowledges the agenda from Dana (pricing and renewal timeline).",
            "Flags that no prep document or pre-read of the owner's own exists.",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "1:1 with Priya",
                  startAt: "2026-06-24T15:00:00-07:00",
                  endAt: "2026-06-24T15:30:00-07:00",
                  location: "Small conference room",
                },
              ],
              inbox: [],
              life: [
                {
                  id: "life-1",
                  kind: "todo",
                  title: "Decide on Priya's promotion case",
                  dueAt: "2026-06-24T15:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Your 3 PM 1:1 with Priya has one real decision attached: her promotion case, which is due by the meeting and sits with you. Come in with a yes/no and the reasoning — there's no agenda beyond that on file.",
          [
            "Surfaces the promotion decision as the key decision point for the 1:1.",
            "Makes clear the decision owner is the owner (it is their todo, due at meeting time).",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Interview — backend candidate (panel 1)",
                  startAt: "2026-06-24T11:00:00-07:00",
                  endAt: "2026-06-24T11:45:00-07:00",
                  location: "Meet link on invite",
                },
                {
                  id: "cal-2",
                  title: "Interview — backend candidate (panel 2)",
                  startAt: "2026-06-24T11:45:00-07:00",
                  endAt: "2026-06-24T12:30:00-07:00",
                },
              ],
              inbox: [],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Two back-to-back backend interviews from 11:00 to 12:30 with zero buffer between panels. Panel 1 has its Meet link, but panel 2 has no location or dial-in on the invite — chase that now so the candidate isn't left waiting.",
          [
            "Flags the missing dial-in or location for the second panel specifically.",
            "Notes the back-to-back timing (no buffer between the two panels).",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Roadmap review",
                  startAt: "2026-06-24T10:00:00-07:00",
                  endAt: "2026-06-24T11:00:00-07:00",
                  location: "Room 4B",
                },
              ],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Lee (PM)",
                  snippet:
                    "Agenda and prep doc attached for the roadmap review; decisions needed on Q3 scope.",
                  urgency: "medium",
                  classification: "info",
                },
              ],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "The 10 AM roadmap review in Room 4B is well covered: Lee sent the agenda and prep doc, and the decision on the table is Q3 scope. Read the prep doc before 10 — otherwise nothing is missing.",
          [
            "States that prep is largely complete (agenda, prep doc, and location all exist).",
            "Does not invent missing items or manufacture gaps.",
            "Mentions the Q3 scope decision.",
            "Is compact: at most 5 sentences or an equally short structure.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Vendor negotiation — DataCo",
                  startAt: "2026-06-24T13:00:00-07:00",
                  endAt: "2026-06-24T14:00:00-07:00",
                  location: "Zoom (link on invite)",
                },
              ],
              inbox: [
                {
                  id: "msg-1",
                  channel: "email",
                  senderName: "Sam (legal)",
                  snippet:
                    "DataCo contract is blocked on legal review of the data-processing addendum.",
                  urgency: "high",
                  classification: "needs_reply",
                },
              ],
              life: [],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "Before the 1 PM DataCo negotiation, know that the contract is blocked on legal's review of the data-processing addendum — Sam's email is waiting on you. Don't commit to signature timing until legal clears it; that's the likely follow-up out of this call.",
          [
            "Surfaces the legal-review blocker on the DataCo contract.",
            "Connects the blocker to the negotiation (e.g. don't commit until legal clears, or reply to Sam first).",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Exec presentation — Q3 plan",
                  startAt: "2026-06-24T16:00:00-07:00",
                  endAt: "2026-06-24T17:00:00-07:00",
                  location: "Boardroom",
                },
              ],
              inbox: [],
              life: [
                {
                  id: "life-1",
                  kind: "todo",
                  title: "Finish Q3 slides",
                  dueAt: "2026-06-24T15:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "The Q3 exec presentation is at 4 in the boardroom and the slides aren't finished — that todo is due at 3, which leaves you one hour of buffer. Block time this morning to close them out; the deck is the only open prep item.",
          [
            "Flags the unfinished Q3 slides as the prep gap before the presentation.",
            "Notes the timing relationship (slides due before the 4 PM meeting).",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
      {
        input: {
          user: briefNarrativeInput({
            kind: "morning",
            period: "today",
            sections: {
              calendar: [
                {
                  id: "cal-1",
                  title: "Offsite planning call",
                  startAt: "2026-06-24T09:30:00-07:00",
                  endAt: "2026-06-24T10:00:00-07:00",
                  location: "Phone",
                },
              ],
              inbox: [],
              life: [],
              money: [
                {
                  id: "money-1",
                  merchant: "Sunset Lodge (venue deposit)",
                  amountUsd: 500,
                  cadence: "irregular",
                  nextChargeAt: "2026-06-26T00:00:00-07:00",
                },
              ],
            },
          }),
        },
        expectedOutput: judgeExpectation(
          "The 9:30 offsite planning call has one money item attached: the $500 Sunset Lodge venue deposit charges Friday, so confirm the venue decision on this call or pause the charge. No agenda is on file beyond that.",
          [
            "Surfaces the $500 venue deposit charging Friday as a decision or follow-up tied to the call.",
            "Is compact: at most 5 sentences or an equally short structure.",
            "Invents no facts not present in the data.",
          ],
        ),
      },
    ],
  },
  // screentime_recap is the live screen-time recap policy
  // (buildScreenTimeRecapRules → SCREENTIME_RECAP_INSTRUCTIONS). The reply is
  // a JSON envelope { recap, topApps, suggestion } whose prose fields carry
  // the value, so rows are judge-graded: envelope validity, topApps
  // correctness against the data, change-vs-prior emphasis, and the
  // at-most-one-grounded-suggestion rule.
  screentime_recap: {
    task: "screentime_recap",
    baseline: SCREENTIME_RECAP_INSTRUCTIONS,
    dataset: [
      {
        input: {
          user: screentimeRecapInput({
            request: "Give me my screen-time recap for today.",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "VS Code", minutes: 180 },
              { app: "Instagram", minutes: 95 },
              { app: "Safari", minutes: 62 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "VS Code", minutes: 175 },
              { app: "Instagram", minutes: 55 },
              { app: "Safari", minutes: 60 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"Coding time held steady at 3 hours, but Instagram jumped from 55 to 95 minutes — the biggest shift today. Safari stayed flat around an hour.","topApps":[{"app":"VS Code","minutes":180},{"app":"Instagram","minutes":95}],"suggestion":"Instagram grew 40 minutes day-over-day; a 60-minute daily cap would return that time without touching your focus apps."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "topApps lists VS Code (180 minutes) and Instagram (95 minutes) with the correct minute values.",
            "The recap highlights the Instagram increase (+40 minutes vs yesterday) as the largest change, not just raw totals.",
            "Proposes exactly one suggestion, and it is tied to the Instagram usage pattern.",
            "The tone is factual and non-clinical (no moralizing about screen addiction).",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "How was my screen time today?",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "YouTube", minutes: 45 },
              { app: "Messages", minutes: 30 },
              { app: "TikTok", minutes: 20 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "TikTok", minutes: 140 },
              { app: "YouTube", minutes: 44 },
              { app: "Messages", minutes: 28 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"TikTok collapsed from 140 minutes to 20 — by far the day\'s biggest change. YouTube and Messages held steady around 45 and 30 minutes.","topApps":[{"app":"YouTube","minutes":45},{"app":"Messages","minutes":30}],"suggestion":"Whatever replaced the two hours of TikTok worked; keeping its notifications off would help the drop stick."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The recap highlights the TikTok drop (140 to 20 minutes) as the largest change.",
            "topApps reflects today's actual top apps by minutes (YouTube 45, Messages 30).",
            "Proposes at most one suggestion, tied to a pattern actually in the data.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "Recap my browsing time today.",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "youtube.com", minutes: 110 },
              { app: "github.com", minutes: 95 },
              { app: "docs.google.com", minutes: 40 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "github.com", minutes: 100 },
              { app: "youtube.com", minutes: 30 },
              { app: "docs.google.com", minutes: 35 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"youtube.com nearly quadrupled, from 30 minutes yesterday to 110 today, overtaking github.com (95m) as your top site. Docs held steady around 40 minutes.","topApps":[{"app":"youtube.com","minutes":110},{"app":"github.com","minutes":95}],"suggestion":"The YouTube jump is the one pattern worth a nudge — a site limit during work hours would cap the drift without touching GitHub or Docs."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The recap highlights the youtube.com increase (30 to 110 minutes) as the largest change.",
            "topApps lists youtube.com (110) and github.com (95) with correct minutes.",
            "Proposes exactly one suggestion, tied to the youtube.com pattern.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "Screen-time recap, please.",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "Slack", minutes: 60 },
              { app: "Chrome", minutes: 55 },
              { app: "Terminal", minutes: 50 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "Slack", minutes: 58 },
              { app: "Chrome", minutes: 57 },
              { app: "Terminal", minutes: 49 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"Usage was essentially flat versus yesterday: Slack, Chrome, and Terminal all moved by two minutes or less, holding a balanced 50-60 minutes each.","topApps":[{"app":"Slack","minutes":60},{"app":"Chrome","minutes":55}],"suggestion":"Nothing needs changing today — the split is stable and balanced."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The recap says usage was roughly stable and does not fabricate a large change.",
            "topApps lists Slack (60) and Chrome (55) with correct minutes.",
            "Does not propose more than one change, and any suggestion is modest and grounded in the stable data.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "How did I do on screen time today?",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "Kindle", minutes: 80 },
              { app: "Instagram", minutes: 70 },
              { app: "Mail", minutes: 25 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "Kindle", minutes: 75 },
              { app: "Instagram", minutes: 65 },
              { app: "Mail", minutes: 30 },
            ],
            usageNotes: ["Instagram usage clustered between 23:00 and 01:00."],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"Totals were close to yesterday — Kindle led at 80 minutes, Instagram at 70 — but nearly all of the Instagram time landed between 11 PM and 1 AM.","topApps":[{"app":"Kindle","minutes":80},{"app":"Instagram","minutes":70}],"suggestion":"The late-night Instagram window is the one pattern to adjust: a wind-down block after 11 PM would move that hour toward sleep or reading."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The suggestion addresses the late-night (23:00-01:00) Instagram window from the usage notes.",
            "topApps lists Kindle (80) and Instagram (70) with correct minutes.",
            "Proposes exactly one suggestion.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "Weekend screen-time recap?",
            thisPeriodLabel: "Saturday",
            thisPeriod: [
              { app: "Steam", minutes: 240 },
              { app: "Discord", minutes: 85 },
              { app: "Safari", minutes: 40 },
            ],
            priorPeriodLabel: "last Saturday",
            priorPeriod: [
              { app: "Steam", minutes: 30 },
              { app: "Discord", minutes: 80 },
              { app: "Safari", minutes: 45 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"Steam exploded from 30 minutes last Saturday to 4 hours today — the week\'s standout change. Discord and Safari stayed where they usually are.","topApps":[{"app":"Steam","minutes":240},{"app":"Discord","minutes":85}],"suggestion":"If the marathon session wasn\'t planned, a two-hour gaming block next weekend keeps Saturdays fun without eating the whole afternoon."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The recap highlights the Steam spike (30 to 240 minutes) versus last Saturday.",
            "topApps lists Steam (240) and Discord (85) with correct minutes.",
            "Proposes exactly one suggestion, tied to the Steam pattern.",
            "The tone is factual and non-clinical (weekend leisure is not treated as a failing).",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "Give me a screen-time recap.",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "Notes", minutes: 50 },
              { app: "Maps", minutes: 35 },
              { app: "Camera", minutes: 20 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"First tracked day: Notes led with 50 minutes, followed by Maps at 35 and Camera at 20 — about 1 hour 45 total.","topApps":[{"app":"Notes","minutes":50},{"app":"Maps","minutes":35}],"suggestion":"No baseline exists yet, so keep tracking for a few days before changing anything."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "Does not invent a prior-period comparison (the data says no prior period was recorded).",
            "topApps lists Notes (50) and Maps (35) with correct minutes.",
            "Any suggestion acknowledges the missing baseline rather than prescribing a change from invented trends.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
      {
        input: {
          user: screentimeRecapInput({
            request: "Recap today's screen time for me.",
            thisPeriodLabel: "today",
            thisPeriod: [
              { app: "VS Code", minutes: 300 },
              { app: "Slack", minutes: 45 },
              { app: "Spotify", minutes: 40 },
            ],
            priorPeriodLabel: "yesterday",
            priorPeriod: [
              { app: "VS Code", minutes: 120 },
              { app: "Slack", minutes: 90 },
              { app: "Spotify", minutes: 38 },
            ],
          }),
        },
        expectedOutput: judgeExpectation(
          '{"recap":"A deep-focus day: VS Code went from 2 hours yesterday to 5 today, while Slack fell by half to 45 minutes. Spotify hummed along unchanged.","topApps":[{"app":"VS Code","minutes":300},{"app":"Slack","minutes":45}],"suggestion":"Five straight coding hours with Slack halved suggests the focus setup worked — worth repeating, with a couple of stretch breaks folded in."}',
          [
            "Is a valid JSON object with exactly the keys recap, topApps, and suggestion.",
            "The recap highlights both the VS Code increase (120 to 300) and the Slack halving (90 to 45).",
            "topApps lists VS Code (300) and Slack (45) with correct minutes.",
            "Proposes at most one suggestion, grounded in the focus pattern actually present.",
            "The tone is factual and non-clinical.",
          ],
        ),
      },
    ],
  },
};

export function parseBoundedIntegerArg(
  name: string,
  value: string | undefined,
  defaults: { defaultValue: number; min: number; max: number },
): number {
  const raw = value?.trim();
  if (!raw) {
    return defaults.defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--${name} must be an integer between ${defaults.min} and ${defaults.max}`,
    );
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < defaults.min ||
    parsed > defaults.max
  ) {
    throw new Error(
      `--${name} must be an integer between ${defaults.min} and ${defaults.max}`,
    );
  }
  return parsed;
}

function resolveTrainingProvider(): string | undefined {
  return (
    process.env.TRAIN_MODEL_PROVIDER?.trim() ??
    process.env.TRAINING_PROVIDER?.trim()
  )?.toLowerCase();
}

// Adapts the CLI EvalModelClient to the useModel-shaped adapter the
// optimizer consumes (same contract as getTrainingUseModelAdapter).
function cliUseModelAdapter(
  client: EvalModelClient,
): (input: {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string> {
  return async (input) => {
    const result = await client({
      prompt: input.prompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
    return result.text;
  };
}

function resolveTrainingModelLabel(): string {
  return (
    process.env.TRAIN_MODEL?.trim() ??
    process.env.TRAINING_MODEL?.trim() ??
    process.env.TRAIN_MODEL_NAME?.trim() ??
    process.env.CEREBRAS_MODEL?.trim() ??
    "gemma-4-31b"
  );
}

function resolveStateDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(process.cwd(), trimmed) : undefined;
}

function validateOptimizedPromptForTask(
  task: OptimizedPromptTask,
  prompt: string,
): string[] {
  const requiredFragmentsByTask: Partial<
    Record<OptimizedPromptTask, string[]>
  > = {
    calendar_extract: [
      "subaction",
      "shouldAct",
      "queries",
      "title",
      "timeMin",
      "timeMax",
      "feed",
      "next_event",
      "search_events",
      "create_event",
      "update_event",
      "delete_event",
      "trip_window",
    ],
    inbox_triage: [
      "ignore",
      "info",
      "notify",
      "needs_reply",
      "urgent",
      "urgency",
      "confidence",
      "reasoning",
      "suggestedResponse",
    ],
    schedule_plan: [
      "subaction",
      "shouldAct",
      "response",
      "start",
      "propose",
      "respond",
      "finalize",
      "cancel",
      "list_active",
      "list_proposals",
    ],
    health_checkin: [
      "subaction",
      "metric",
      "days",
      "shouldAct",
      "today",
      "trend",
      "by_metric",
      "status",
      "steps",
      "heart_rate",
      "sleep_hours",
    ],
    // Prose/NL tasks: fragments are the load-bearing domain nouns (and, for
    // screentime_recap, the JSON envelope keys) that any valid rewrite of the
    // instructions must still carry.
    reminder_dispatch: ["reminder"],
    meeting_prep: ["agenda"],
    morning_brief: ["schedule"],
    screentime_recap: ["recap", "topApps", "suggestion"],
  };
  const requiredFragments = requiredFragmentsByTask[task] ?? [];
  const normalized = prompt.toLowerCase();
  return requiredFragments
    .filter((fragment) => !normalized.includes(fragment.toLowerCase()))
    .map((fragment) => `optimized prompt is missing "${fragment}"`);
}

export function validatePersistableResult(
  seed: SeedTask,
  result: OptimizerResult,
): string[] {
  const reasons: string[] = [];
  if (!Number.isFinite(result.baseline) || !Number.isFinite(result.score)) {
    reasons.push("optimizer returned a non-finite score");
  }
  if (result.score - result.baseline < MIN_PERSIST_DELTA) {
    reasons.push(
      `optimized score must beat baseline by at least ${MIN_PERSIST_DELTA.toFixed(4)} (baseline=${result.baseline.toFixed(3)}, optimized=${result.score.toFixed(3)})`,
    );
  }
  const prompt = result.optimizedPrompt.trim();
  if (prompt.length === 0) {
    reasons.push("optimized prompt is empty");
  }
  reasons.push(...validateOptimizedPromptForTask(seed.task, prompt));
  return reasons;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      apply: { type: "boolean" },
      generations: { type: "string" },
      population: { type: "string" },
      "state-dir": { type: "string" },
    },
    allowPositionals: false,
  });

  const taskName = (values.task ?? "calendar_extract").trim();
  const seed = SEED_TASKS[taskName];
  if (!seed) {
    process.stderr.write(
      `[gepa-seed] unknown --task "${taskName}". Available: ${Object.keys(SEED_TASKS).join(", ")}\n`,
    );
    return 1;
  }

  const resolvedStateDir = resolveStateDir(values["state-dir"]);
  if (resolvedStateDir) {
    process.env.TRAINING_STATE_DIR = resolvedStateDir;
    process.env.ELIZA_STATE_DIR = resolvedStateDir;
  }

  const generations = parseBoundedIntegerArg(
    "generations",
    values.generations,
    {
      defaultValue: DEFAULT_GENERATIONS,
      min: 1,
      max: MAX_GENERATIONS,
    },
  );
  const population = parseBoundedIntegerArg("population", values.population, {
    defaultValue: DEFAULT_POPULATION,
    min: 2,
    max: MAX_POPULATION,
  });

  const provider = resolveTrainingProvider();
  if (
    provider !== "cerebras" &&
    provider !== "anthropic" &&
    provider !== "cli"
  ) {
    process.stderr.write(
      "[gepa-seed] TRAIN_MODEL_PROVIDER=cerebras|anthropic|cli (or TRAINING_PROVIDER=...) is required.\n",
    );
    return 1;
  }

  const useModel =
    provider === "cli"
      ? cliUseModelAdapter(getCliModelClient())
      : getTrainingUseModelAdapter();
  const adapter = createRuntimeAdapter(useModel);
  const isJudgeTask = LIFEOPS_JUDGE_TASKS.has(seed.task);
  // Prose/NL tasks are graded by a live judge against per-example rubrics;
  // the structured planners keep the deterministic field-match scorer.
  const compare = isJudgeTask
    ? createLifeOpsJudgeCompare(
        seed.task,
        provider === "cli" ? getCliModelClient() : getEvalModelClient(),
      )
    : (actual: string, expected: string) =>
        scoreLifeOpsTask(seed.task, actual, expected);
  const scorer = createPromptScorer(adapter, {
    maxTokens: isJudgeTask ? 512 : 256,
    compare,
  });
  const modelLabel =
    provider === "cli" ? resolveCliModel() : resolveTrainingModelLabel();

  process.stdout.write(
    `[gepa-seed] task=${seed.task} dataset=${seed.dataset.length} ` +
      `model=${modelLabel} (${provider}) scorer=${isJudgeTask ? "judge-rubric" : "field-match"} ` +
      `generations=${generations} population=${population}\n`,
  );

  const result = await runGepa({
    baselinePrompt: seed.baseline,
    dataset: seed.dataset,
    scorer,
    llm: adapter,
    options: {
      generations,
      population,
      reflectionBatchSize: 2,
      maxTokens: 768,
      reflectionMaxTokens: 384,
    },
  });

  process.stdout.write(
    `\n[gepa-seed] RESULT task=${seed.task} ` +
      `baseline=${result.baseline.toFixed(3)} optimized=${result.score.toFixed(3)} ` +
      `delta=${(result.score - result.baseline).toFixed(3)}\n`,
  );
  process.stdout.write(`\n[gepa-seed] baseline prompt:\n${seed.baseline}\n`);
  process.stdout.write(
    `\n[gepa-seed] optimized prompt:\n${result.optimizedPrompt}\n`,
  );

  if (!values.apply) {
    process.stdout.write(
      "\n[gepa-seed] dry run - pass --apply to persist to the optimized-prompt store.\n",
    );
    return 0;
  }

  const persistBlockers = validatePersistableResult(seed, result);
  if (persistBlockers.length > 0) {
    process.stderr.write(
      `\n[gepa-seed] refusing to persist ${seed.task} artifact:\n` +
        persistBlockers.map((reason) => `- ${reason}`).join("\n") +
        "\n",
    );
    return 1;
  }

  const artifact: OptimizedPromptArtifact = {
    task: seed.task,
    optimizer: "gepa",
    baseline: seed.baseline,
    prompt: result.optimizedPrompt,
    score: result.score,
    baselineScore: result.baseline,
    datasetId: `seed:${seed.task}`,
    datasetSize: seed.dataset.length,
    generatedAt: new Date().toISOString(),
    lineage: result.lineage.map((entry) => ({
      round: entry.round,
      variant: entry.variant,
      score: entry.score,
      notes: entry.notes,
    })),
  };

  const service = new OptimizedPromptService();
  if (resolvedStateDir) {
    service.setStoreRoot(join(resolvedStateDir, "optimized-prompts"));
  }
  const path = await service.setPrompt(seed.task, artifact);
  process.stdout.write(
    `\n[gepa-seed] persisted optimized artifact -> ${path}\n`,
  );
  return 0;
}

const entrypointUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";

if (import.meta.url === entrypointUrl) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(
        `[gepa-seed] failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
