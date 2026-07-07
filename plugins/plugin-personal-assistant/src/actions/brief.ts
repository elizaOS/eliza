/**
 * `BRIEF` umbrella action — Daily Operations / morning-evening-weekly synthesis.
 *
 * Subactions:
 *   - `compose_morning`  — `period: today` by default
 *   - `compose_evening`  — `period: today` by default
 *   - `compose_weekly`   — `period: this_week` by default
 *
 * Pulls from each domain (calendar feed, inbox triage, life-domain due items,
 * money recurring charges) per the `include` arg, then runs a single LLM
 * compose pass to render a narrative over the structured `LifeOpsBriefing`
 * shape. Briefings are kept in-memory.
 *
 * Owner-only — `hasLifeOpsAccess` (which delegates to `hasOwnerAccess`).
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  MessageRef,
} from "@elizaos/core";
import {
  getDefaultTriageService,
  logger,
  ModelType,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { buildBriefEditorialContract } from "../lifeops/briefing/editorial-judgment.js";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";
import type {
  LifeOpsBriefing,
  LifeOpsBriefingCalendarItem,
  LifeOpsBriefingEditorialContract,
  LifeOpsBriefingInboxItem,
  LifeOpsBriefingKind,
  LifeOpsBriefingLifeItem,
  LifeOpsBriefingMoneyItem,
  LifeOpsBriefingPeriod,
  LifeOpsBriefingSections,
} from "../types/briefing.js";

export {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";

const ACTION_NAME = "BRIEF";

const SUBACTIONS = [
  "compose_morning",
  "compose_evening",
  "compose_weekly",
] as const;

type Subaction = (typeof SUBACTIONS)[number];
type BriefOptimizationTask = "morning_brief" | "meeting_prep";

const SIMILE_NAMES: readonly string[] = [
  "BRIEF",
  "BRIEF_ME",
  "MORNING_BRIEF",
  "EVENING_BRIEF",
  "WEEKLY_BRIEF",
  "COMPOSE_BRIEFING",
  "DAILY_DIGEST",
  "MEETING_PREP",
  "PREBRIEF",
  "MEETING_DOSSIER",
];

const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  MORNING_BRIEF: "compose_morning",
  EVENING_BRIEF: "compose_evening",
  WEEKLY_BRIEF: "compose_weekly",
  DAILY_DIGEST: "compose_evening",
};

const SUBACTION_TO_KIND: Readonly<Record<Subaction, LifeOpsBriefingKind>> = {
  compose_morning: "morning",
  compose_evening: "evening",
  compose_weekly: "weekly",
};

const SUBACTION_TO_DEFAULT_PERIOD: Readonly<
  Record<Subaction, LifeOpsBriefingPeriod>
> = {
  compose_morning: "today",
  compose_evening: "today",
  compose_weekly: "this_week",
};

interface BriefIncludeFlags {
  calendar?: boolean;
  inbox?: boolean;
  life?: boolean;
  money?: boolean;
}

interface BriefActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  period?: LifeOpsBriefingPeriod | string;
  include?: BriefIncludeFlags;
  format?: "narrative" | "json";
  optimizationTask?: BriefOptimizationTask | string;
}

const INTERNAL_URL = new URL("http://127.0.0.1/");

interface BriefLifeOpsService {
  getCalendarFeed(
    requestUrl: URL,
    request: { timeMin: string; timeMax: string },
  ): Promise<{ events?: readonly unknown[] }>;
  getOverview(): Promise<{
    occurrences?: readonly unknown[];
    reminders?: readonly unknown[];
    goals?: readonly unknown[];
  }>;
}

async function getBriefLifeOpsService(
  runtime: IAgentRuntime,
): Promise<BriefLifeOpsService> {
  const { LifeOpsService } = await import("../lifeops/service.js");
  return new LifeOpsService(runtime);
}

function periodWindow(period: LifeOpsBriefingPeriod): {
  readonly start: Date;
  readonly end: Date;
} {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "tomorrow") {
    start.setDate(start.getDate() + 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + (period === "this_week" ? 7 : 1));
  return { start, end };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function mapMessageRefToBriefingItem(
  ref: MessageRef,
): LifeOpsBriefingInboxItem {
  // Triage attaches only structural signals (#14716); urgency is judged by
  // the compose model reading the snippet, so items arrive unclassified.
  return {
    id: ref.id,
    channel: ref.source,
    senderName: ref.from.displayName ?? ref.from.identifier,
    snippet: ref.snippet,
    urgency: "unknown",
    classification: ref.isRead ? "read" : "unread",
  };
}

function normalizeLifeKind(value: unknown): LifeOpsBriefingLifeItem["kind"] {
  return value === "todo" ||
    value === "reminder" ||
    value === "habit" ||
    value === "goal"
    ? value
    : "reminder";
}

function normalizeMoneyCadence(
  value: unknown,
): LifeOpsBriefingMoneyItem["cadence"] {
  switch (value) {
    case "weekly":
    case "monthly":
    case "irregular":
      return value;
    case "annual":
    case "yearly":
      return "yearly";
    case "daily":
      return "daily";
    default:
      return "irregular";
  }
}

async function loadCalendarFromLifeOps(args: {
  runtime: IAgentRuntime;
  period: LifeOpsBriefingPeriod;
}): Promise<readonly LifeOpsBriefingCalendarItem[]> {
  try {
    const service = await getBriefLifeOpsService(args.runtime);
    const { start, end } = periodWindow(args.period);
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    });
    const events = Array.isArray(feed.events) ? feed.events : [];
    return events.map((event) => {
      const record = asRecord(event);
      const location = readString(record, "location");
      return {
        id: readString(record, "id") ?? "calendar-event",
        title: readString(record, "title") ?? "Untitled event",
        startAt:
          readString(record, "startAt") ??
          readString(record, "start") ??
          start.toISOString(),
        endAt:
          readString(record, "endAt") ??
          readString(record, "end") ??
          end.toISOString(),
        ...(location ? { location } : {}),
      };
    });
  } catch (error) {
    logger.warn(
      `[BRIEF] calendar load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function loadInboxFromTriage(args: {
  runtime: IAgentRuntime;
  period: LifeOpsBriefingPeriod;
}): Promise<readonly LifeOpsBriefingInboxItem[]> {
  if (typeof args.runtime.getService !== "function") return [];
  try {
    const { start } = periodWindow(args.period);
    const refs = await getDefaultTriageService().triage(args.runtime, {
      sinceMs: start.getTime(),
      limit: 25,
    });
    return refs.map(mapMessageRefToBriefingItem);
  } catch (error) {
    logger.warn(
      `[BRIEF] inbox load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function loadLifeFromOverview(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefingLifeItem[]> {
  try {
    const service = await getBriefLifeOpsService(args.runtime);
    const overview = await service.getOverview();
    const records = [
      ...(Array.isArray(overview.occurrences) ? overview.occurrences : []),
      ...(Array.isArray(overview.reminders) ? overview.reminders : []),
      ...(Array.isArray(overview.goals) ? overview.goals : []),
    ];
    return records.slice(0, 25).map((item) => {
      const record = asRecord(item);
      const metadata = asRecord(record.metadata);
      return {
        id: readString(record, "id") ?? "life-item",
        kind: normalizeLifeKind(
          readString(record, "kind") ??
            readString(record, "type") ??
            readString(record, "subjectType") ??
            metadata.kind,
        ),
        title: readString(record, "title") ?? "Untitled item",
        dueAt:
          readString(record, "dueAt") ??
          readString(record, "scheduledFor") ??
          null,
      };
    });
  } catch (error) {
    logger.warn(
      `[BRIEF] life load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

async function loadMoneyFromPayments(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefingMoneyItem[]> {
  try {
    // Recurring-charge data moved out of LifeOpsService to FinancesService
    // (@elizaos/plugin-finances); call it there directly.
    const finances = new FinancesService(args.runtime);
    const charges = await finances.getRecurringCharges({});
    return charges.slice(0, 25).map((charge) => ({
      id: `${charge.merchantNormalized}:${charge.cadence}`,
      merchant: charge.merchantDisplay,
      amountUsd: charge.averageAmountUsd,
      cadence: normalizeMoneyCadence(charge.cadence),
      nextChargeAt: charge.nextExpectedAt,
    }));
  } catch (error) {
    logger.warn(
      `[BRIEF] money load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Composer hooks — overridable for tests. Defaults compose from LifeOps'
 * structural services: calendar feed, MESSAGE triage, overview reminders, and
 * recurring payments. Unavailable sources degrade to empty arrays.
 */
export interface BriefComposers {
  loadCalendar: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<readonly LifeOpsBriefingCalendarItem[]>;
  loadInbox: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<readonly LifeOpsBriefingInboxItem[]>;
  loadLife: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<readonly LifeOpsBriefingLifeItem[]>;
  loadMoney: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<readonly LifeOpsBriefingMoneyItem[]>;
}

const defaultComposers: BriefComposers = {
  loadCalendar: loadCalendarFromLifeOps,
  loadInbox: loadInboxFromTriage,
  loadLife: loadLifeFromOverview,
  loadMoney: loadMoneyFromPayments,
};

let activeComposers: BriefComposers = defaultComposers;

/**
 * Override the briefing composers. Service-backed loaders can be injected
 * here at plugin init. Test-only callers reset between cases with
 * `__resetBriefComposersForTests`.
 */
export function setBriefComposers(next: Partial<BriefComposers>): void {
  activeComposers = { ...activeComposers, ...next };
}

export function __resetBriefComposersForTests(): void {
  activeComposers = defaultComposers;
}

function getParams(options: HandlerOptions | undefined): BriefActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as BriefActionParameters;
  }
  return {};
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  if (upper in SIMILE_TO_SUBACTION) {
    return SIMILE_TO_SUBACTION[upper] ?? null;
  }
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function resolveSubaction(params: BriefActionParameters): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function resolveIncludeFlags(input: BriefIncludeFlags | undefined): {
  calendar: boolean;
  inbox: boolean;
  life: boolean;
  money: boolean;
} {
  return {
    calendar: input?.calendar !== false,
    inbox: input?.inbox !== false,
    life: input?.life !== false,
    money: input?.money !== false,
  };
}

function resolvePeriod(
  params: BriefActionParameters,
  subaction: Subaction,
): LifeOpsBriefingPeriod {
  const candidate =
    typeof params.period === "string"
      ? params.period.trim().toLowerCase()
      : null;
  if (
    candidate === "today" ||
    candidate === "tomorrow" ||
    candidate === "this_week"
  ) {
    return candidate;
  }
  return SUBACTION_TO_DEFAULT_PERIOD[subaction];
}

function newBriefingId(): string {
  return `brief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function messageText(message: Memory): string {
  const value = message.content.text;
  return typeof value === "string" ? value : "";
}

function resolveBriefOptimizationTask(args: {
  params: BriefActionParameters;
  message: Memory;
}): BriefOptimizationTask {
  if (args.params.optimizationTask === "meeting_prep") {
    return "meeting_prep";
  }
  if (args.params.optimizationTask === "morning_brief") {
    return "morning_brief";
  }

  const text = messageText(args.message).toLowerCase();
  const asksForMeetingPrep =
    /\b(prep|prebrief|brief me|dossier|agenda|risk register)\b/u.test(text) &&
    /\b(meeting|board|client|call|agenda|presentation|interview)\b/u.test(text);
  return asksForMeetingPrep ? "meeting_prep" : "morning_brief";
}

// Static instruction block for the briefing narrative. This is the optimization
// target for the `morning_brief` LifeOps task (#8795): an OptimizedPromptService
// artifact, when present, replaces it; otherwise this inline baseline is used,
// so the absence of an artifact is a no-op. The dynamic header line and the data
// payload are composed around the resolved instructions, never optimized away.
export function buildNarrativePrompt(args: {
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
  editorial?: LifeOpsBriefingEditorialContract;
  runtime?: IAgentRuntime;
  optimizationTask?: BriefOptimizationTask;
}): string {
  const payload = JSON.stringify(
    {
      kind: args.kind,
      period: args.period,
      sections: args.sections,
      editorial: args.editorial,
    },
    null,
    2,
  );
  const optimizationTask = args.optimizationTask ?? "morning_brief";
  const instructions =
    optimizationTask === "meeting_prep"
      ? args.runtime
        ? resolveOptimizedPromptForRuntime(
            args.runtime,
            "meeting_prep",
            MEETING_PREP_INSTRUCTIONS,
          )
        : MEETING_PREP_INSTRUCTIONS
      : args.runtime
        ? resolveOptimizedPromptForRuntime(
            args.runtime,
            "morning_brief",
            BRIEF_NARRATIVE_INSTRUCTIONS,
          )
        : BRIEF_NARRATIVE_INSTRUCTIONS;
  return `You are composing the owner's ${args.kind} briefing for ${args.period}.

${instructions}

Data:
${payload}`;
}

async function composeNarrative(args: {
  runtime: IAgentRuntime;
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
  editorial: LifeOpsBriefingEditorialContract;
  optimizationTask: BriefOptimizationTask;
}): Promise<string | undefined> {
  if (typeof args.runtime.useModel !== "function") {
    return undefined;
  }
  const prompt = buildNarrativePrompt({
    kind: args.kind,
    period: args.period,
    sections: args.sections,
    editorial: args.editorial,
    runtime: args.runtime,
    optimizationTask: args.optimizationTask,
  });
  // Tag the trajectory with the exact LifeOps prompt task resolved above so the
  // call buckets into its per-capability dataset for the GEPA loop (#8795).
  // A failed compose pass degrades to a narrative-less structured briefing —
  // symmetric with the other LifeOps LLM consumers (scheduling, reminders),
  // which all fall back to a safe default rather than propagating the error.
  let raw: unknown;
  try {
    raw = await runWithTrajectoryPurpose(args.optimizationTask, () =>
      args.runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
  } catch (error) {
    logger.warn(
      {
        src: "action:brief",
        task: args.optimizationTask,
        error: error instanceof Error ? error.message : String(error),
      },
      "[BRIEF] narrative compose model call failed; returning structured briefing without a narrative",
    );
    return undefined;
  }
  return typeof raw === "string" ? raw.trim() : undefined;
}

async function assembleBriefing(args: {
  runtime: IAgentRuntime;
  subaction: Subaction;
  period: LifeOpsBriefingPeriod;
  include: ReturnType<typeof resolveIncludeFlags>;
  format: "narrative" | "json";
  optimizationTask: BriefOptimizationTask;
}): Promise<LifeOpsBriefing> {
  const composers = activeComposers;
  const [calendarItems, inboxItems, lifeItems, moneyItems] = await Promise.all([
    args.include.calendar
      ? composers.loadCalendar({ runtime: args.runtime, period: args.period })
      : Promise.resolve([] as readonly LifeOpsBriefingCalendarItem[]),
    args.include.inbox
      ? composers.loadInbox({ runtime: args.runtime, period: args.period })
      : Promise.resolve([] as readonly LifeOpsBriefingInboxItem[]),
    args.include.life
      ? composers.loadLife({ runtime: args.runtime, period: args.period })
      : Promise.resolve([] as readonly LifeOpsBriefingLifeItem[]),
    args.include.money
      ? composers.loadMoney({ runtime: args.runtime, period: args.period })
      : Promise.resolve([] as readonly LifeOpsBriefingMoneyItem[]),
  ]);

  const sections: LifeOpsBriefingSections = {
    ...(args.include.calendar ? { calendar: calendarItems } : {}),
    ...(args.include.inbox ? { inbox: inboxItems } : {}),
    ...(args.include.life ? { life: lifeItems } : {}),
    ...(args.include.money ? { money: moneyItems } : {}),
  };

  const kind = SUBACTION_TO_KIND[args.subaction];
  const editorial = buildBriefEditorialContract({ sections });
  let narrative: string | undefined;
  if (args.format === "narrative") {
    narrative = await composeNarrative({
      runtime: args.runtime,
      kind,
      period: args.period,
      sections,
      editorial,
      optimizationTask: args.optimizationTask,
    });
  }

  const briefing: LifeOpsBriefing = {
    id: newBriefingId(),
    kind,
    period: args.period,
    generatedAt: new Date().toISOString(),
    sections,
    editorial,
    ...(narrative ? { narrative } : {}),
  };
  return briefing;
}

const examples: ActionExample[][] = [
  [
    { name: "{{name1}}", content: { text: "Give me my morning brief." } },
    {
      name: "{{agentName}}",
      content: {
        text: "Composed your morning briefing.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    { name: "{{name1}}", content: { text: "What's the weekly digest?" } },
    {
      name: "{{agentName}}",
      content: {
        text: "Composed this week's briefing.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const briefAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:briefing",
    "capability:read",
    "capability:compose",
    "surface:internal",
  ],
  description:
    "Compose owner LifeOpsBriefing: morning/evening/weekly; calendar feed, inbox triage, life due, money recurring charges. Subactions: compose_morning, compose_evening, compose_weekly.",
  descriptionCompressed:
    "BRIEF compose_morning|compose_evening|compose_weekly; LifeOpsBriefing",
  routingHint:
    'briefing/digest ("morning brief", "evening summary", "this week", "daily digest") -> BRIEF; one-domain read -> CALENDAR.feed, MESSAGE.triage, etc.',
  contexts: ["briefing", "calendar", "inbox", "tasks", "finance"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description:
        "Brief op: compose_morning | compose_evening | compose_weekly.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "period",
      description:
        "Brief window: today | tomorrow | this_week. Default subaction period.",
      schema: {
        type: "string" as const,
        enum: ["today", "tomorrow", "this_week"],
      },
    },
    {
      name: "include",
      description:
        "Include flags, default true: { calendar?, inbox?, life?, money? }.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "format",
      description:
        "Format: narrative = LLM compose; json = LifeOpsBriefing only. Default narrative.",
      schema: { type: "string" as const, enum: ["narrative", "json"] },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Briefings are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which briefing to compose: compose_morning, compose_evening, or compose_weekly.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const include = resolveIncludeFlags(params.include);
    const period = resolvePeriod(params, subaction);
    const format: "narrative" | "json" =
      params.format === "json" ? "json" : "narrative";
    const optimizationTask = resolveBriefOptimizationTask({ params, message });

    const briefing = await assembleBriefing({
      runtime,
      subaction,
      period,
      include,
      format,
      optimizationTask,
    });

    const text =
      briefing.narrative ??
      `Composed your ${briefing.kind} briefing for ${briefing.period}.`;

    logger.info(
      `[BRIEF] ${subaction} id=${briefing.id} period=${briefing.period} calendar=${briefing.sections.calendar?.length ?? 0} inbox=${briefing.sections.inbox?.length ?? 0} life=${briefing.sections.life?.length ?? 0} money=${briefing.sections.money?.length ?? 0}`,
    );

    await callback?.({
      text,
      source: "action",
      action: ACTION_NAME,
    });

    return {
      success: true,
      text,
      data: {
        subaction,
        optimizationTask,
        briefing,
        briefingId: briefing.id,
      },
    };
  },
};
