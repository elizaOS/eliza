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
import { HEALTH_PLAN_INSTRUCTIONS } from "../../plugin-health/src/actions/optimized-prompt-instructions.ts";
import { INBOX_TRIAGE_INSTRUCTIONS } from "../../plugin-inbox/src/inbox/triage-classifier.ts";
import { SCHEDULE_PLAN_INSTRUCTIONS } from "../../plugin-personal-assistant/src/lifeops/optimized-prompt-instructions.ts";
import { getTrainingUseModelAdapter } from "../src/core/cerebras-eval-model.ts";
import {
  createPromptScorer,
  createRuntimeAdapter,
  type OptimizationExample,
  type OptimizerResult,
  runGepa,
  scoreLifeOpsTask,
} from "../src/optimizers/index.ts";

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

export const SEED_TASKS: Record<string, SeedTask> = {
  // calendar_extract is the live calendar action planner, not the later
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
  if (provider !== "cerebras") {
    process.stderr.write(
      "[gepa-seed] TRAIN_MODEL_PROVIDER=cerebras (or TRAINING_PROVIDER=cerebras) is required.\n",
    );
    return 1;
  }

  const useModel = getTrainingUseModelAdapter();
  const adapter = createRuntimeAdapter(useModel);
  const scorer = createPromptScorer(adapter, {
    maxTokens: 256,
    compare: (actual, expected) =>
      scoreLifeOpsTask(seed.task, actual, expected),
  });
  const modelLabel = resolveTrainingModelLabel();

  process.stdout.write(
    `[gepa-seed] task=${seed.task} dataset=${seed.dataset.length} ` +
      `model=${modelLabel} (cerebras) generations=${generations} population=${population}\n`,
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
