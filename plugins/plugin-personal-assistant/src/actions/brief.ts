/**
 * `BRIEF` umbrella action — Daily Operations / morning-evening-weekly synthesis.
 *
 * Subactions:
 *   - `compose_morning`  — `period: today` by default
 *   - `compose_evening`  — `period: today` by default
 *   - `compose_weekly`   — `period: this_week` by default
 *   - `recalibrate`      — close expired impression windows and demote misses
 *   - `reset_recalibration` — restore one or all currently demoted classes
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
  EffectResourceRef,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  MessageRef,
} from "@elizaos/core";
import {
  ElizaError,
  getDefaultTriageService,
  logger,
  ModelType,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import {
  buildBriefEditorialContract,
  type LifeOpsBriefItemEngagementSummary,
  recalibrateBriefItemClasses,
} from "../lifeops/briefing/editorial-judgment.js";
import { requireBriefActionTimestamp } from "../lifeops/briefing/engagement.js";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
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

const COMPOSE_SUBACTIONS = [
  "compose_morning",
  "compose_evening",
  "compose_weekly",
] as const;
const CONTROL_SUBACTIONS = ["recalibrate", "reset_recalibration"] as const;
const SUBACTIONS = [...COMPOSE_SUBACTIONS, ...CONTROL_SUBACTIONS] as const;

type Subaction = (typeof SUBACTIONS)[number];
type ComposeSubaction = (typeof COMPOSE_SUBACTIONS)[number];
type ControlSubaction = (typeof CONTROL_SUBACTIONS)[number];
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
  "RECALIBRATE_BRIEF",
  "RESET_BRIEF_RECALIBRATION",
];

const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  MORNING_BRIEF: "compose_morning",
  EVENING_BRIEF: "compose_evening",
  WEEKLY_BRIEF: "compose_weekly",
  DAILY_DIGEST: "compose_evening",
  RECALIBRATE_BRIEF: "recalibrate",
  RESET_BRIEF_RECALIBRATION: "reset_recalibration",
};

const SUBACTION_TO_KIND: Readonly<
  Record<ComposeSubaction, LifeOpsBriefingKind>
> = {
  compose_morning: "morning",
  compose_evening: "evening",
  compose_weekly: "weekly",
};

const SUBACTION_TO_DEFAULT_PERIOD: Readonly<
  Record<ComposeSubaction, LifeOpsBriefingPeriod>
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
  itemClass?: string;
  ignoreAfterHours?: number;
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
  listOwnerOccurrencesCompletedToday(): Promise<
    ReadonlyArray<{
      id: string;
      definitionKind: string;
      title: string;
      dueAt: string | null;
    }>
  >;
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

/**
 * Owner items completed today, for the evening/recap narrative. Loaded from
 * the same service read the lifeops provider uses so the brief's "wins" and
 * the chat context can never disagree. A failed load degrades to an empty
 * list like the sibling loaders — the brief still composes — but the failure
 * is surfaced through `runtime.reportError` so the agent sees it in
 * RECENT_ERRORS instead of an evening brief that silently implies a win-less
 * day.
 */
async function loadCompletedTodayFromService(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefingLifeItem[]> {
  try {
    const service = await getBriefLifeOpsService(args.runtime);
    const completed = await service.listOwnerOccurrencesCompletedToday();
    return completed.slice(0, 25).map((occurrence) => ({
      id: occurrence.id,
      kind: normalizeLifeKind(occurrence.definitionKind),
      title: occurrence.title,
      dueAt: occurrence.dueAt ?? null,
    }));
  } catch (error) {
    // error-policy:J4 the brief composes from independent optional sources;
    // one broken source must not kill the whole evening brief. The degrade is
    // designed (section omitted, narrative simply cannot claim wins) and the
    // failure stays observable: reportError feeds RECENT_ERRORS + owner
    // escalation rather than a log-only warn masquerading as an empty day.
    args.runtime.reportError("Brief.loadCompletedToday", error, {
      surface: "evening-brief-wins",
    });
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

async function loadEngagementSummariesFromLifeOps(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefItemEngagementSummary[]> {
  try {
    return await new LifeOpsRepository(
      args.runtime,
    ).summarizeBriefItemEngagements(args.runtime.agentId);
  } catch (error) {
    // error-policy:J4 engagement history improves editorial ranking but is not
    // required to render a brief. Keep the degradation observable instead of
    // presenting the missing history as a successful database read.
    args.runtime.reportError("Brief.loadEngagementSummaries", error, {
      surface: "brief-editorial-engagement",
    });
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
  /** Evening/recap wins: owner items completed within the current local day. */
  loadCompletedToday: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly LifeOpsBriefingLifeItem[]>;
  /** Persisted owner response signals that influence editorial ranking. */
  loadEngagementSummaries: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly LifeOpsBriefItemEngagementSummary[]>;
}

const defaultComposers: BriefComposers = {
  loadCalendar: loadCalendarFromLifeOps,
  loadInbox: loadInboxFromTriage,
  loadLife: loadLifeFromOverview,
  loadMoney: loadMoneyFromPayments,
  loadCompletedToday: loadCompletedTodayFromService,
  loadEngagementSummaries: loadEngagementSummariesFromLifeOps,
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
  subaction: ComposeSubaction,
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

function isComposeSubaction(value: Subaction): value is ComposeSubaction {
  return (COMPOSE_SUBACTIONS as readonly string[]).includes(value);
}

function requireItemClass(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new ElizaError("[BRIEF] itemClass must be a string", {
      code: "BRIEF_ITEM_CLASS_INVALID",
      context: {},
      severity: "ephemeral",
    });
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    !/^[a-z0-9][a-z0-9:_-]*$/u.test(normalized)
  ) {
    throw new ElizaError("[BRIEF] itemClass is malformed", {
      code: "BRIEF_ITEM_CLASS_INVALID",
      context: {},
      severity: "ephemeral",
    });
  }
  return normalized;
}

function resolveIgnoreAfterHours(value: unknown): number {
  if (value === undefined) return 24;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 168
  ) {
    throw new ElizaError("[BRIEF] ignoreAfterHours is invalid", {
      code: "BRIEF_RECALIBRATION_WINDOW_INVALID",
      context: { value },
      severity: "ephemeral",
    });
  }
  return value;
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

async function runBriefCalibration(args: {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback | undefined;
  subaction: ControlSubaction;
  params: BriefActionParameters;
}): Promise<ActionResult> {
  const repository = new LifeOpsRepository(args.runtime);
  const eventAt = requireBriefActionTimestamp(args.message.createdAt);
  const itemClass = requireItemClass(args.params.itemClass);
  const ignoreAfterHours = resolveIgnoreAfterHours(
    args.params.ignoreAfterHours,
  );
  const reconciled =
    args.subaction === "recalibrate"
      ? await repository.reconcileExpiredBriefItemEngagements({
          agentId: args.runtime.agentId,
          asOfIso: eventAt,
          ignoreAfterHours,
        })
      : [];
  const summaries = await repository.summarizeBriefItemEngagements(
    args.runtime.agentId,
  );
  const demotedClasses = recalibrateBriefItemClasses(summaries);
  const targetClasses =
    args.subaction === "recalibrate"
      ? demotedClasses.filter(
          (candidate) => itemClass === null || candidate === itemClass,
        )
      : itemClass
        ? demotedClasses.filter((candidate) => candidate === itemClass)
        : demotedClasses;
  const controls = await repository.recordBriefItemClassControls({
    agentId: args.runtime.agentId,
    itemClasses: targetClasses,
    eventType: args.subaction === "recalibrate" ? "demoted" : "restored",
    eventAt,
    metadata: {
      operation: args.subaction,
      ignoreAfterHours,
      ...(args.message.id ? { messageId: args.message.id } : {}),
    },
  });
  const records = [...reconciled, ...controls];
  const affectedItemClasses = [
    ...new Set(controls.map((record) => record.itemClass)),
  ].sort();
  const artifacts: EffectResourceRef[] = records.slice(1).map((record) => ({
    kind: "lifeops.brief_item_engagement",
    id: record.id,
    version: record.createdAt,
  }));
  const classSummary =
    affectedItemClasses.length > 0 ? affectedItemClasses.join(", ") : "none";
  const text =
    args.subaction === "recalibrate"
      ? `Recalibrated your brief from ${reconciled.length} expired item${reconciled.length === 1 ? "" : "s"}. Demoted classes: ${classSummary}. Items you completed or rescheduled remain promoted.`
      : `Reset brief recalibration for: ${classSummary}. Future brief ranking will learn from new engagement.`;
  const result: ActionResult = {
    success: true,
    text,
    data: {
      actionName: ACTION_NAME,
      subaction: args.subaction,
      ignoreAfterHours,
      itemClass,
      reconciledCount: reconciled.length,
      affectedItemClasses,
      summaries: await repository.summarizeBriefItemEngagements(
        args.runtime.agentId,
      ),
    },
  };
  if (records.length === 0) {
    return completeLifeOpsEffect(
      args.callback,
      result,
      lifeOpsNoopEffect({
        receiptId: `lifeops.brief_recalibration:${args.runtime.agentId}:${eventAt}`,
        operation: `lifeops.brief_recalibration.${args.subaction}`,
        resource: {
          kind: "lifeops.brief_recalibration",
          id: args.runtime.agentId,
        },
        artifacts: [],
        idempotency: { key: args.message.id ?? null, replayed: false },
        observedAt: eventAt,
        reason: "No expired or demoted briefing item classes required a write.",
      }),
    );
  }
  const primary = records[0];
  return completeLifeOpsEffect(
    args.callback,
    result,
    lifeOpsAppliedEffect({
      receiptId: `lifeops.brief_recalibration:${args.subaction}:${primary.id}`,
      operation: `lifeops.brief_recalibration.${args.subaction}`,
      resource: {
        kind: "lifeops.brief_item_engagement",
        id: primary.id,
        version: primary.createdAt,
      },
      artifacts,
      idempotency: { key: args.message.id ?? null, replayed: false },
      observedAt: primary.createdAt,
      commit: {
        kind: "durable",
        id: primary.id,
        committedAt: primary.createdAt,
      },
    }),
  );
}

async function assembleBriefing(args: {
  runtime: IAgentRuntime;
  subaction: ComposeSubaction;
  period: LifeOpsBriefingPeriod;
  include: ReturnType<typeof resolveIncludeFlags>;
  format: "narrative" | "json";
  optimizationTask: BriefOptimizationTask;
}): Promise<LifeOpsBriefing> {
  const composers = activeComposers;
  const [
    calendarItems,
    inboxItems,
    lifeItems,
    moneyItems,
    engagementSummaries,
  ] = await Promise.all([
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
    composers.loadEngagementSummaries({ runtime: args.runtime }),
  ]);

  const kind = SUBACTION_TO_KIND[args.subaction];
  // The evening brief is the recap surface: it must know what got DONE today
  // so the narrative can lead with wins instead of opening on open items
  // (#16935). Morning/weekly briefs keep their forward-looking shape.
  const completedToday =
    kind === "evening" && args.include.life
      ? await composers.loadCompletedToday({ runtime: args.runtime })
      : [];

  const sections: LifeOpsBriefingSections = {
    ...(args.include.calendar ? { calendar: calendarItems } : {}),
    ...(args.include.inbox ? { inbox: inboxItems } : {}),
    ...(args.include.life ? { life: lifeItems } : {}),
    ...(completedToday.length > 0 ? { completedToday } : {}),
    ...(args.include.money ? { money: moneyItems } : {}),
  };

  const editorial = buildBriefEditorialContract({
    sections,
    engagementSummaries,
  });
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
    "resource:tracked-work",
    "capability:read",
    "capability:compose",
    "capability:write",
    "effect:receipt-required",
    "surface:internal",
  ],
  description:
    "Compose or recalibrate the owner's LifeOpsBriefing. Subactions: compose_morning, compose_evening, compose_weekly, recalibrate, reset_recalibration.",
  descriptionCompressed:
    "BRIEF compose_morning|compose_evening|compose_weekly|recalibrate|reset_recalibration",
  routingHint:
    'briefing/digest or ranking calibration ("morning brief", "daily digest", "stop showing these", "reset brief learning") -> BRIEF.',
  contexts: ["briefing", "calendar", "inbox", "tasks", "finance"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description:
        "Brief op: compose_morning | compose_evening | compose_weekly | recalibrate | reset_recalibration.",
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
    {
      name: "itemClass",
      description:
        "Optional structural item class to recalibrate or reset, for example life:reminder.",
      schema: { type: "string" as const },
    },
    {
      name: "ignoreAfterHours",
      description:
        "Close rendered items with no observed response after this many hours (1-168, default 24).",
      schema: { type: "number" as const, minimum: 1, maximum: 168 },
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
        text: "Tell me which briefing operation to run: compose_morning, compose_evening, compose_weekly, recalibrate, or reset_recalibration.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    if (!isComposeSubaction(subaction)) {
      return runBriefCalibration({
        runtime,
        message,
        callback,
        subaction,
        params,
      });
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

    return completeLifeOpsEffect(
      callback,
      {
        success: true,
        text,
        data: {
          actionName: ACTION_NAME,
          subaction,
          optimizationTask,
          briefing,
          briefingId: briefing.id,
        },
      },
      lifeOpsNoopEffect({
        receiptId: `lifeops.briefing.compose:${briefing.id}`,
        operation: `lifeops.briefing.${subaction}`,
        resource: {
          kind: "lifeops.briefing",
          id: briefing.id,
        },
        artifacts: [],
        idempotency: { key: null, replayed: false },
        observedAt: briefing.generatedAt,
        reason:
          "The briefing was composed from current data without mutating owner records.",
      }),
    );
  },
};
