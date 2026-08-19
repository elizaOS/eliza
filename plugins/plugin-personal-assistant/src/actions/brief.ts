/**
 * `BRIEF` umbrella action — Daily Operations / morning-evening-weekly synthesis.
 *
 * Subactions:
 *   - `compose_morning`  — `period: today` by default
 *   - `compose_evening`  — `period: today` by default
 *   - `compose_weekly`   — `period: this_week` by default
 *   - `recalibrate`          — demote repeatedly ignored item classes (reversible)
 *   - `reset_recalibration`  — restore demoted item classes
 *
 * Pulls from each domain (calendar feed, inbox triage, life-domain due items,
 * money recurring charges, regret-audited commitment-ledger obligations) per
 * the `include` arg, then runs a single LLM
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
  getTrajectoryContext,
  logger,
  ModelType,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  buildBriefEditorialContract,
  type LifeOpsBriefItemEngagementSummary,
  recalibrateBriefItemClasses,
  selectRecalibrationCandidates,
} from "../lifeops/briefing/editorial-judgment.js";
import { retryBriefEngagementRewards } from "../lifeops/briefing/engagement-reward.js";
import {
  buildCommitmentRegretAudit,
  type CommitmentRegretAuditItem,
} from "../lifeops/commitments/index.js";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import type {
  LifeOpsBriefing,
  LifeOpsBriefingCalendarItem,
  LifeOpsBriefingCommitmentItem,
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
const ENGAGEMENT_RECENCY_DAYS = 30;

function engagementSinceIso(now = new Date()): string {
  return new Date(
    now.getTime() - ENGAGEMENT_RECENCY_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

const COMPOSE_SUBACTIONS = [
  "compose_morning",
  "compose_evening",
  "compose_weekly",
] as const;

const CONTROL_SUBACTIONS = ["recalibrate", "reset_recalibration"] as const;

const SUBACTIONS = [...COMPOSE_SUBACTIONS, ...CONTROL_SUBACTIONS] as const;

type ComposeSubaction = (typeof COMPOSE_SUBACTIONS)[number];
type ControlSubaction = (typeof CONTROL_SUBACTIONS)[number];
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
  "RECALIBRATE_BRIEF",
];

const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  MORNING_BRIEF: "compose_morning",
  EVENING_BRIEF: "compose_evening",
  WEEKLY_BRIEF: "compose_weekly",
  DAILY_DIGEST: "compose_evening",
  RECALIBRATE_BRIEF: "recalibrate",
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
  commitments?: boolean;
}

interface BriefActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  period?: LifeOpsBriefingPeriod | string;
  include?: BriefIncludeFlags;
  format?: "narrative" | "json";
  optimizationTask?: BriefOptimizationTask | string;
  /** Optional exact item class targeted by recalibrate / reset_recalibration. */
  itemClass?: string;
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
    return events.map((event) =>
      mapCalendarFeedEventToBriefingItem(event, {
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      }),
    );
  } catch (error) {
    logger.warn(
      `[BRIEF] calendar load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Preserve the calendar provider event id used by later mutation receipts. */
export function mapCalendarFeedEventToBriefingItem(
  event: unknown,
  fallback: { startAt: string; endAt: string },
): LifeOpsBriefingCalendarItem {
  const record = asRecord(event);
  const location = readString(record, "location");
  return {
    id: readString(record, "id") ?? "calendar-event",
    title: readString(record, "title") ?? "Untitled event",
    startAt:
      readString(record, "startAt") ??
      readString(record, "start") ??
      fallback.startAt,
    endAt:
      readString(record, "endAt") ??
      readString(record, "end") ??
      fallback.endAt,
    ...(location ? { location } : {}),
  };
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

const MAX_BRIEF_COMMITMENT_ITEMS = 10;

/** Map one regret-audit item onto the briefing's commitment shape. */
export function mapRegretAuditItemToBriefingItem(
  item: CommitmentRegretAuditItem,
): LifeOpsBriefingCommitmentItem {
  return {
    id: item.record.id,
    kind: item.record.kind,
    summary: item.record.summary,
    counterparty: item.record.counterparty,
    dueAt: item.record.dueAt,
    status: item.record.status === "tracked" ? "tracked" : "open",
    regretScore: item.score,
    reasons: item.reasons,
  };
}

/**
 * Regret-audited commitment-ledger obligations (#14864): open and tracked
 * promises ranked by `buildCommitmentRegretAudit`, so the narrative can name
 * what the owner would regret dropping. No-DB hosts have no ledger — that is
 * a designed-empty section, not an error.
 */
async function loadCommitmentsFromLedger(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefingCommitmentItem[]> {
  const adapter = (args.runtime as { adapter?: { db?: unknown } }).adapter;
  if (!adapter?.db) return [];
  try {
    const records = await new LifeOpsRepository(
      args.runtime,
    ).listCommitmentLedgerRecords(String(args.runtime.agentId), {
      statuses: ["open", "tracked"],
    });
    const audit = buildCommitmentRegretAudit(records, {
      nowIso: new Date().toISOString(),
    });
    return audit.items
      .slice(0, MAX_BRIEF_COMMITMENT_ITEMS)
      .map(mapRegretAuditItemToBriefingItem);
  } catch (error) {
    // error-policy:J4 the brief composes from independent optional sources;
    // a broken ledger read must not kill the whole brief. The degrade is
    // designed (section omitted) and stays observable through reportError.
    args.runtime.reportError("Brief.loadCommitments", error, {
      surface: "brief-commitment-regret-audit",
    });
    return [];
  }
}

async function loadEngagementSummariesFromLifeOps(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefItemEngagementSummary[]> {
  try {
    const repository = new LifeOpsRepository(args.runtime);
    await repository.finalizeExpiredBriefItemEngagements(args.runtime.agentId);
    await retryBriefEngagementRewards({
      runtime: args.runtime,
      repository,
    });
    return await repository.summarizeBriefItemEngagements(
      args.runtime.agentId,
      {
        sinceIso: engagementSinceIso(),
      },
    );
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
 * Persist one `rendered` impression per surfaced (non-omitted) editorial item.
 * Called only after the callback delivery of the composed brief resolved, so a
 * failed delivery never fabricates visibility. Returns the number of rows
 * written so callers and tests can assert the ledger reflects the delivery.
 */
async function recordRenderedImpressionsInLifeOps(args: {
  runtime: IAgentRuntime;
  briefing: LifeOpsBriefing;
  deliveredText: string;
  format: "narrative" | "json";
}): Promise<number> {
  const repository = new LifeOpsRepository(args.runtime);
  const normalizedDeliveredText = args.deliveredText
    .normalize("NFKC")
    .toLocaleLowerCase();
  const trajectory =
    args.briefing.optimizationTrace?.task === "morning_brief"
      ? args.briefing.optimizationTrace
      : undefined;
  const itemsById = new Map(
    args.briefing.editorial.items.map((item) => [item.itemId, item]),
  );
  let recorded = 0;
  for (const decision of args.briefing.editorial.decisions) {
    if (decision.action === "omit") continue;
    const item = itemsById.get(decision.itemId);
    if (!item) continue;
    // A JSON-format action callback carries only the generic confirmation;
    // its structured result is machine data, not proof the owner saw every
    // item. Narratives count an impression only when the delivered text names
    // the item's exact title. This intentionally under-counts paraphrases
    // instead of fabricating engagement from the pre-render editorial plan.
    if (
      args.format !== "narrative" ||
      !normalizedDeliveredText.includes(
        item.title.normalize("NFKC").toLocaleLowerCase(),
      )
    ) {
      continue;
    }
    await repository.recordBriefItemEngagement({
      agentId: args.runtime.agentId,
      briefingId: args.briefing.id,
      itemId: item.itemId,
      source: item.source,
      kind: item.kind,
      sourceId: item.sourceId,
      itemClass: item.itemClass,
      eventType: "rendered",
      eventAt: args.briefing.generatedAt,
      weight: 0,
      metadata: {
        briefingKind: args.briefing.kind,
        period: args.briefing.period,
        decision: decision.action,
        deliveryFormat: args.format,
        ...(trajectory?.trajectoryId
          ? { trajectoryId: trajectory.trajectoryId }
          : {}),
        ...(trajectory?.trajectoryStepId
          ? { trajectoryStepId: trajectory.trajectoryStepId }
          : {}),
        ...(trajectory?.traceId ? { traceId: trajectory.traceId } : {}),
      },
    });
    recorded += 1;
  }
  return recorded;
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
  /** Regret-audited commitment-ledger obligations (#14864). */
  loadCommitments: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly LifeOpsBriefingCommitmentItem[]>;
  /** Persisted owner response signals that influence editorial ranking. */
  loadEngagementSummaries: (args: {
    runtime: IAgentRuntime;
  }) => Promise<readonly LifeOpsBriefItemEngagementSummary[]>;
  /** Ledger write for delivered brief items; runs only after callback delivery. */
  recordRenderedImpressions: (args: {
    runtime: IAgentRuntime;
    briefing: LifeOpsBriefing;
    deliveredText: string;
    format: "narrative" | "json";
  }) => Promise<number>;
}

const defaultComposers: BriefComposers = {
  loadCalendar: loadCalendarFromLifeOps,
  loadInbox: loadInboxFromTriage,
  loadLife: loadLifeFromOverview,
  loadMoney: loadMoneyFromPayments,
  loadCompletedToday: loadCompletedTodayFromService,
  loadCommitments: loadCommitmentsFromLedger,
  loadEngagementSummaries: loadEngagementSummariesFromLifeOps,
  recordRenderedImpressions: recordRenderedImpressionsInLifeOps,
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
  commitments: boolean;
} {
  return {
    calendar: input?.calendar !== false,
    inbox: input?.inbox !== false,
    life: input?.life !== false,
    money: input?.money !== false,
    commitments: input?.commitments !== false,
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
}): Promise<
  | {
      text: string;
      optimizationTrace?: NonNullable<LifeOpsBriefing["optimizationTrace"]>;
    }
  | undefined
> {
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
    raw = await runWithTrajectoryPurpose(args.optimizationTask, async () => {
      const active = getTrajectoryContext();
      const response = await args.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });
      return { response, active };
    });
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
  if (!raw || typeof raw !== "object") return undefined;
  const response = (raw as { response?: unknown }).response;
  if (typeof response !== "string") return undefined;
  const active = (raw as { active?: ReturnType<typeof getTrajectoryContext> })
    .active;
  return {
    text: response.trim(),
    ...(active?.trajectoryId
      ? {
          optimizationTrace: {
            task: args.optimizationTask,
            trajectoryId: active.trajectoryId,
            ...(active.trajectoryStepId
              ? { trajectoryStepId: active.trajectoryStepId }
              : {}),
            ...(active.traceId ? { traceId: active.traceId } : {}),
          },
        }
      : {}),
  };
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
    commitmentItems,
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
    args.include.commitments
      ? composers.loadCommitments({ runtime: args.runtime })
      : Promise.resolve([] as readonly LifeOpsBriefingCommitmentItem[]),
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
    ...(args.include.commitments && commitmentItems.length > 0
      ? { commitments: commitmentItems }
      : {}),
  };

  const editorial = buildBriefEditorialContract({
    sections,
    engagementSummaries,
  });
  let narrativeResult: Awaited<ReturnType<typeof composeNarrative>>;
  if (args.format === "narrative") {
    narrativeResult = await composeNarrative({
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
    ...(narrativeResult?.text ? { narrative: narrativeResult.text } : {}),
    ...(narrativeResult?.optimizationTrace
      ? { optimizationTrace: narrativeResult.optimizationTrace }
      : {}),
  };
  return briefing;
}

function normalizeItemClassParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Owner-facing recalibration verbs over the engagement ledger.
 *
 * Both verbs summarize only rows that exist at the command instant
 * (`untilIso = commandAt`), so a delayed or replayed command can never attach
 * owner intent to impressions rendered after it was issued. Candidate
 * filtering happens before any write: a targeted `itemClass` command touches
 * exactly that class, and an untargeted `recalibrate` demotes only classes
 * the owner has repeatedly seen and never acted on. Demotion is expressed as
 * an explicit `demoted` marker row and reversed by a `kept` marker, so every
 * decision is visible in the ledger and reversible from chat.
 */
async function handleRecalibration(args: {
  runtime: IAgentRuntime;
  subaction: ControlSubaction;
  itemClass: string | null;
}): Promise<{
  text: string;
  data: ActionResult["data"];
}> {
  const repository = new LifeOpsRepository(args.runtime);
  const commandAt = new Date().toISOString();
  const summaries = await repository.summarizeBriefItemEngagements(
    args.runtime.agentId,
    { sinceIso: engagementSinceIso(new Date(commandAt)), untilIso: commandAt },
  );

  const writeMarker = async (
    itemClass: string,
    eventType: "demoted" | "restored",
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    const rows = await repository.listBriefItemEngagements(
      args.runtime.agentId,
      { itemClass, untilIso: commandAt },
    );
    const anchor = rows.at(-1);
    if (!anchor) return;
    await repository.recordBriefItemEngagement({
      agentId: args.runtime.agentId,
      briefingId: anchor.briefingId,
      itemId: anchor.itemId,
      source: anchor.source,
      kind: anchor.kind,
      sourceId: anchor.sourceId,
      itemClass,
      eventType,
      eventAt: commandAt,
      weight: eventType === "demoted" ? -1 : 0,
      metadata,
    });
  };

  if (args.subaction === "recalibrate") {
    if (
      args.itemClass &&
      !summaries.some((summary) => summary.itemClass === args.itemClass)
    ) {
      return {
        text: `I have no engagement history for "${args.itemClass}", so there is nothing to recalibrate for it.`,
        data: {
          subaction: args.subaction,
          error: "NO_ENGAGEMENT_HISTORY",
          itemClass: args.itemClass,
        },
      };
    }
    const candidates = selectRecalibrationCandidates(
      summaries,
      args.itemClass ? { itemClass: args.itemClass } : {},
    );
    for (const candidate of candidates) {
      await writeMarker(candidate.itemClass, "demoted", {
        verb: "recalibrate",
        requestedItemClass: args.itemClass,
        renderedCount: candidate.renderedCount,
        ignoredCount: candidate.ignoredCount,
        actedOnCount: candidate.actedOnCount,
      });
    }
    const alreadyDemoted = recalibrateBriefItemClasses(summaries);
    if (candidates.length === 0) {
      const suffix =
        alreadyDemoted.length > 0
          ? ` Currently demoted: ${alreadyDemoted.join(", ")}.`
          : "";
      return {
        text: `Nothing new to recalibrate — no brief item class has enough unacknowledged history yet.${suffix}`,
        data: {
          subaction: args.subaction,
          demotedItemClasses: [],
          alreadyDemotedItemClasses: alreadyDemoted,
        },
      };
    }
    const lines = candidates.map(
      (candidate) =>
        `- ${candidate.itemClass} (surfaced ${candidate.renderedCount + candidate.ignoredCount} times, acted on ${candidate.actedOnCount})`,
    );
    return {
      text: [
        "Recalibrated your brief. Demoting these item classes in upcoming briefs:",
        ...lines,
        'This is reversible: say "reset the brief recalibration" (optionally naming the item class) to restore any of them.',
      ].join("\n"),
      data: {
        subaction: args.subaction,
        demotedItemClasses: candidates.map((c) => c.itemClass),
        alreadyDemotedItemClasses: alreadyDemoted,
      },
    };
  }

  const demotedNow = recalibrateBriefItemClasses(summaries);
  const targets = args.itemClass
    ? demotedNow.filter((itemClass) => itemClass === args.itemClass)
    : demotedNow;
  for (const itemClass of targets) {
    await writeMarker(itemClass, "restored", {
      verb: "reset_recalibration",
      requestedItemClass: args.itemClass,
    });
  }
  if (targets.length === 0) {
    return {
      text: args.itemClass
        ? `"${args.itemClass}" is not currently demoted, so there is nothing to restore.`
        : "No brief item classes are currently demoted, so there is nothing to restore.",
      data: { subaction: args.subaction, restoredItemClasses: [] },
    };
  }
  return {
    text: `Restored ${targets.join(", ")} to normal ranking in upcoming briefs.`,
    data: { subaction: args.subaction, restoredItemClasses: targets },
  };
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
    "surface:internal",
  ],
  description:
    "Compose owner LifeOpsBriefing: morning/evening/weekly; calendar feed, inbox triage, life due, money recurring charges. Subactions: compose_morning, compose_evening, compose_weekly, recalibrate (demote repeatedly ignored brief item classes; reversible), reset_recalibration (restore demoted classes).",
  descriptionCompressed:
    "BRIEF compose_morning|compose_evening|compose_weekly|recalibrate|reset_recalibration; LifeOpsBriefing",
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
        "Brief op: compose_morning | compose_evening | compose_weekly | recalibrate | reset_recalibration.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "itemClass",
      description:
        "recalibrate/reset_recalibration only: exact brief item class to target, e.g. inbox:newsletter-digest. Omit to apply to every qualifying class.",
      schema: { type: "string" as const },
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
        text: "Tell me which briefing operation to run: compose_morning, compose_evening, compose_weekly, recalibrate, or reset_recalibration.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    if (subaction === "recalibrate" || subaction === "reset_recalibration") {
      const outcome = await handleRecalibration({
        runtime,
        subaction,
        itemClass: normalizeItemClassParam(params.itemClass),
      });
      await callback?.({
        text: outcome.text,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        success: true,
        text: outcome.text,
        userFacingText: outcome.text,
        verifiedUserFacing: true,
        turnComplete: true,
        data: outcome.data,
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
      `[BRIEF] ${subaction} id=${briefing.id} period=${briefing.period} calendar=${briefing.sections.calendar?.length ?? 0} inbox=${briefing.sections.inbox?.length ?? 0} life=${briefing.sections.life?.length ?? 0} money=${briefing.sections.money?.length ?? 0} commitments=${briefing.sections.commitments?.length ?? 0}`,
    );

    await callback?.({
      text,
      source: "action",
      action: ACTION_NAME,
    });

    // Rendered impressions are truthful only after the delivery call above
    // resolved: no callback means nothing was shown, and a rejected callback
    // propagates before this point, so a failed delivery never writes rows.
    if (callback) {
      try {
        await activeComposers.recordRenderedImpressions({
          runtime,
          briefing,
          deliveredText: text,
          format,
        });
      } catch (error) {
        // error-policy:J7 the engagement ledger is a learning signal; failing
        // to persist it must not retract an already-delivered brief. The
        // failure stays observable through RECENT_ERRORS instead of a silent
        // gap in the owner-preference history.
        runtime.reportError("Brief.recordRenderedImpressions", error, {
          briefingId: briefing.id,
          briefingKind: briefing.kind,
        });
      }
    }

    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      turnComplete: true,
      data: {
        subaction,
        optimizationTask,
        briefing,
        briefingId: briefing.id,
      },
    };
  },
};
