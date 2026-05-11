/**
 * `BRIEF` umbrella action — Daily Operations / morning-evening-weekly synthesis.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Daily Operations and Wave-2
 * scenario matrix `plan-lifeops-executive-assistant-scenario-matrix.md`. Today
 * the agent composes morning/evening/weekly briefs ad-hoc inside chat;
 * `BRIEF` makes it a first-class callable surface so the planner has a clean
 * target and the Wave-2 scenarios have a stable verb to dispatch.
 *
 * Subactions:
 *   - `compose_morning`  — `period: today` by default
 *   - `compose_evening`  — `period: today` by default
 *   - `compose_weekly`   — `period: this_week` by default
 *
 * Composition rule: pull from each domain (calendar feed, inbox triage,
 * life-domain due items, money recurring charges) per the `include` arg, then
 * run a single LLM compose pass to render a narrative on top of the
 * structured `LifeOpsBriefing` shape. Wave-2 persists briefings; Wave-1 leaves
 * them in-memory.
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
} from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import type {
  LifeOpsBriefing,
  LifeOpsBriefingCalendarItem,
  LifeOpsBriefingInboxItem,
  LifeOpsBriefingKind,
  LifeOpsBriefingLifeItem,
  LifeOpsBriefingMoneyItem,
  LifeOpsBriefingPeriod,
  LifeOpsBriefingSections,
} from "../types/briefing.js";

const ACTION_NAME = "BRIEF";

const SUBACTIONS = [
  "compose_morning",
  "compose_evening",
  "compose_weekly",
] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "BRIEF",
  "BRIEF_ME",
  "MORNING_BRIEF",
  "EVENING_BRIEF",
  "WEEKLY_BRIEF",
  "COMPOSE_BRIEFING",
  "DAILY_DIGEST",
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
}

/**
 * Composer hooks — overridable for tests and Wave-2 wiring. Each loader
 * returns the structured items the briefing renders; an unavailable source
 * returns an empty array (the narrative compose pass mentions missing
 * sources explicitly).
 *
 * TODO Wave-2: replace these with real composition of CALENDAR.feed,
 * MESSAGE.triage, LIFE.due_today, MONEY.recurring_charges via the umbrella
 * dispatchers rather than direct loaders. Wave-1 leaves the seams open so the
 * unit tests can mock per-domain inputs without standing up the full
 * connector graph.
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
  loadCalendar: async () => [],
  loadInbox: async () => [],
  loadLife: async () => [],
  loadMoney: async () => [],
};

let activeComposers: BriefComposers = defaultComposers;

/**
 * Override the briefing composers. Wave-2 will inject service-backed loaders
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

function buildNarrativePrompt(args: {
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
}): string {
  const payload = JSON.stringify(
    {
      kind: args.kind,
      period: args.period,
      sections: args.sections,
    },
    null,
    2,
  );
  return `You are composing the owner's ${args.kind} briefing for ${args.period}.

Render a concise narrative paragraph (2-5 sentences). Lead with the
schedule-changing or reply-needed items first. Mention each non-empty domain
once. If a domain is empty, omit it rather than saying "nothing to report".
No invented facts; only describe items in the data below.

Data:
${payload}`;
}

async function composeNarrative(args: {
  runtime: IAgentRuntime;
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
}): Promise<string | undefined> {
  if (typeof args.runtime.useModel !== "function") {
    return undefined;
  }
  const prompt = buildNarrativePrompt({
    kind: args.kind,
    period: args.period,
    sections: args.sections,
  });
  const raw = await runWithTrajectoryContext(
    { purpose: "lifeops-brief-compose" },
    () => args.runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
  );
  return typeof raw === "string" ? raw.trim() : undefined;
}

async function assembleBriefing(args: {
  runtime: IAgentRuntime;
  subaction: Subaction;
  period: LifeOpsBriefingPeriod;
  include: ReturnType<typeof resolveIncludeFlags>;
  format: "narrative" | "json";
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
  let narrative: string | undefined;
  if (args.format === "narrative") {
    narrative = await composeNarrative({
      runtime: args.runtime,
      kind,
      period: args.period,
      sections,
    });
  }

  const briefing: LifeOpsBriefing = {
    id: newBriefingId(),
    kind,
    period: args.period,
    generatedAt: new Date().toISOString(),
    sections,
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

export const briefAction: Action & { suppressPostActionContinuation?: boolean } =
  {
    name: ACTION_NAME,
    similes: SIMILE_NAMES.slice(),
    tags: [
      "domain:briefing",
      "capability:read",
      "capability:compose",
      "surface:internal",
    ],
    description:
      "Compose the owner's morning, evening, or weekly briefing by pulling calendar feed, inbox triage, life-domain due items, and money recurring charges into a single LifeOpsBriefing. Subactions: compose_morning, compose_evening, compose_weekly.",
    descriptionCompressed:
      "briefing: compose_morning|compose_evening|compose_weekly; LifeOpsBriefing shape; LLM narrative pass",
    routingHint:
      'briefing/digest intent ("give me my morning brief", "evening summary", "what\'s on this week", "compose daily digest") -> BRIEF; for one-domain reads use the underlying umbrella (CALENDAR.feed, MESSAGE.triage, etc.)',
    contexts: ["briefing", "calendar", "inbox", "tasks", "finance"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
    parameters: [
      {
        name: "subaction",
        description:
          "Which brief to compose: compose_morning | compose_evening | compose_weekly.",
        schema: { type: "string" as const, enum: [...SUBACTIONS] },
      },
      {
        name: "period",
        description:
          "Time window the brief covers: today | tomorrow | this_week. Defaults to the subaction's natural period.",
        schema: {
          type: "string" as const,
          enum: ["today", "tomorrow", "this_week"],
        },
      },
      {
        name: "include",
        description:
          "Per-domain include flags; each defaults to true. Shape: { calendar?, inbox?, life?, money? }.",
        schema: { type: "object" as const, additionalProperties: true },
      },
      {
        name: "format",
        description:
          "narrative renders the LLM compose pass; json returns only the structured LifeOpsBriefing. Defaults to narrative.",
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

      const briefing = await assembleBriefing({
        runtime,
        subaction,
        period,
        include,
        format,
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
          briefing,
          briefingId: briefing.id,
        },
      };
    },
  };
