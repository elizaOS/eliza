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
 * regret-audited commitment-ledger obligations) per
 * the `include` arg. Standalone callers compose the narrative locally; planned
 * turns defer complete narrative grounding to final reply composition.
 * Briefings are kept in-memory.
 *
 * Owner-only — `hasLifeOpsAccess` (which delegates to `hasOwnerAccess`).
 */

import type {
  LifeOpsGoogleConnectorStatus,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsTaskDefinition,
} from "@elizaos/contracts";
import { calendarDateKey, resolveCalendarTimeZone } from "@elizaos/contracts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ActionMode,
  applyGroundedActionReply,
  createUnavailableGroundedActionReply,
  ElizaError,
  extractUserText,
  getActionReplyOwner,
  getTrajectoryContext,
  logger,
  ModelType,
  rejectAtDeadline,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
  unwrapUserMessageText,
} from "@elizaos/core";
import type { MessageRef, TriageOptions } from "@elizaos/plugin-assistant";
import { getDefaultTriageService, rankScored } from "@elizaos/plugin-assistant";
import {
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "@elizaos/plugin-calendar";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { isWholeGenericBriefRequest } from "../lifeops/briefing/direct-routing.js";
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
import { DEFAULT_TIME_WINDOWS } from "../lifeops/defaults.js";
import { resolveOwnerDefinitionSurface } from "../lifeops/definition-owner-surface.js";
import { formatCalendarEventDateTime } from "../lifeops/google/format-helpers.js";
import {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";
import { resolveOwnerFactStore } from "../lifeops/owner/fact-store.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import type {
  LifeOpsBriefing,
  LifeOpsBriefingCalendarItem,
  LifeOpsBriefingCommitmentItem,
  LifeOpsBriefingEditorialContract,
  LifeOpsBriefingInboxCollection,
  LifeOpsBriefingInboxItem,
  LifeOpsBriefingKind,
  LifeOpsBriefingLifeCollection,
  LifeOpsBriefingLifeItem,
  LifeOpsBriefingPeriod,
  LifeOpsBriefingSections,
} from "../types/briefing.js";

export {
  BRIEF_NARRATIVE_INSTRUCTIONS,
  MEETING_PREP_INSTRUCTIONS,
} from "../lifeops/optimized-prompt-instructions.js";

const ACTION_NAME = "BRIEF";
const ENGAGEMENT_RECENCY_DAYS = 30;

/**
 * Longest one briefing source may hold the brief before it is composed from
 * the others.
 */
const BRIEF_SOURCE_TIMEOUT_MS = 10_000;

function withinSourceBound<T>(source: string, work: Promise<T>): Promise<T> {
  return rejectAtDeadline(work, {
    timeoutMs: BRIEF_SOURCE_TIMEOUT_MS,
    onTimeout: () =>
      new ElizaError(
        `The briefing ${source} source did not answer within ${BRIEF_SOURCE_TIMEOUT_MS}ms.`,
        {
          code: "BRIEF_SOURCE_TIMED_OUT",
          context: { source, timeoutMs: BRIEF_SOURCE_TIMEOUT_MS },
        },
      ),
  });
}

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
    request: { timeMin: string; timeMax: string; timeZone: string },
  ): Promise<{ events?: readonly unknown[] }>;
  getOverview(): Promise<
    Pick<LifeOpsOverview, "occurrences" | "reminders" | "goals" | "summary">
  >;
  listOwnerOccurrencesCompletedToday(): Promise<
    readonly LifeOpsOccurrenceView[]
  >;
  definitions: {
    listDefinitionRows(): Promise<readonly LifeOpsTaskDefinition[]>;
  };
  getGoogleConnectorAccounts(
    requestUrl: URL,
    side?: "owner" | "agent",
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
}

async function getBriefLifeOpsService(
  runtime: IAgentRuntime,
): Promise<BriefLifeOpsService> {
  const { LifeOpsService } = await import("../lifeops/service.js");
  return new LifeOpsService(runtime);
}

async function periodWindow(
  runtime: IAgentRuntime,
  period: LifeOpsBriefingPeriod,
): Promise<{
  readonly start: Date;
  readonly end: Date;
  readonly timeZone: string;
}> {
  const now = new Date();
  const { timeZone } = await resolveCalendarTimeZone(runtime, now);
  const today = resolveCalendarWindow({ now, timeZone });
  const window =
    period === "tomorrow"
      ? resolveCalendarWindow({ now: new Date(today.timeMax), timeZone })
      : period === "this_week"
        ? resolveNextCalendarEventWindow({ now, timeZone, lookaheadDays: 7 })
        : today;
  return {
    start: new Date(window.timeMin),
    end: new Date(window.timeMax),
    timeZone,
  };
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

function briefingDefinitionKind(
  definition: LifeOpsTaskDefinition | undefined,
): LifeOpsBriefingLifeItem["kind"] {
  if (definition) {
    switch (resolveOwnerDefinitionSurface(definition)) {
      case "OWNER_REMINDERS":
      case "OWNER_ALARMS":
        return "reminder";
      case "OWNER_ROUTINES":
        return "habit";
      case "OWNER_TODOS":
        return "todo";
    }
  }
  throw new ElizaError(
    "The briefing item's definition classification is unavailable.",
    {
      code: "BRIEF_DEFINITION_CLASSIFICATION_UNAVAILABLE",
    },
  );
}

async function loadCalendarFromLifeOps(args: {
  runtime: IAgentRuntime;
  period: LifeOpsBriefingPeriod;
}): Promise<readonly LifeOpsBriefingCalendarItem[]> {
  const service = await getBriefLifeOpsService(args.runtime);
  const { start, end, timeZone } = await periodWindow(
    args.runtime,
    args.period,
  );
  const feed = await service.getCalendarFeed(INTERNAL_URL, {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    timeZone,
  });
  const events = Array.isArray(feed.events) ? feed.events : [];
  return events.map((event) =>
    mapCalendarFeedEventToBriefingItem(event, {
      startAt: start.toISOString(),
      endAt: end.toISOString(),
    }),
  );
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
  explicit?: boolean;
}): Promise<LifeOpsBriefingInboxCollection | undefined> {
  const triage = getDefaultTriageService();
  const reads: TriageOptions[] = [];
  let failed = 0;
  const reportFailure = (
    error: unknown,
    source: string,
    accountId?: string,
  ) => {
    failed++;
    args.runtime.reportError("Brief.loadInbox", error, {
      source: "inbox",
      messageSource: source,
      ...(accountId ? { accountId } : {}),
    });
  };
  for (const adapter of triage.listAdapters()) {
    if (!adapter.capabilities().list) continue;
    if (adapter.source !== "gmail") {
      if (adapter.isAvailable(args.runtime))
        reads.push({ sources: [adapter.source] });
      continue;
    }
    try {
      const service = await getBriefLifeOpsService(args.runtime);
      const accounts = await service.getGoogleConnectorAccounts(
        INTERNAL_URL,
        "owner",
      );
      for (const account of accounts) {
        if (
          !account.configured ||
          !(account.connected || account.reason === "needs_reauth") ||
          !account.grantedCapabilities.includes("google.gmail.triage")
        )
          continue;
        const accountId = account.grant?.connectorAccountId;
        if (!accountId || !adapter.isAvailable(args.runtime)) {
          reportFailure(
            new ElizaError(
              "The configured Gmail inbox reader is unavailable.",
              { code: "BRIEF_CONFIGURED_INBOX_UNAVAILABLE" },
            ),
            "gmail",
            accountId ?? undefined,
          );
          continue;
        }
        reads.push({ sources: ["gmail"], worldIds: [accountId] });
      }
    } catch (error) {
      reportFailure(error, "gmail");
    }
  }
  if (reads.length === 0 && failed === 0) {
    return args.explicit ? { items: [], coverage: "not_connected" } : undefined;
  }
  const { start } = await periodWindow(args.runtime, args.period);
  // Each read is an independent connector or account, so they run together
  // and one slow inbox costs its own time only.
  const batches = await Promise.all(
    reads.map(async (read) => {
      try {
        return await triage.triage(args.runtime, {
          ...read,
          sinceMs: start.getTime(),
        });
      } catch (error) {
        reportFailure(error, read.sources?.[0] ?? "inbox", read.worldIds?.[0]);
        return undefined;
      }
    }),
  );
  const refs: MessageRef[] = [];
  let succeeded = 0;
  for (const batch of batches) {
    if (!batch) continue;
    refs.push(...batch);
    succeeded++;
  }
  return {
    items: rankScored(refs).map(mapMessageRefToBriefingItem),
    coverage:
      failed > 0 ? (succeeded > 0 ? "partial" : "unavailable") : "complete",
  };
}

type BriefDefinitions = ReadonlyMap<string, LifeOpsTaskDefinition>;

async function loadLifeFromOverview(args: {
  runtime: IAgentRuntime;
  loadDefinitions: () => Promise<BriefDefinitions>;
}): Promise<LifeOpsBriefingLifeCollection> {
  const service = await getBriefLifeOpsService(args.runtime);
  const overview = await service.getOverview();
  const occurrences = Array.isArray(overview.occurrences)
    ? overview.occurrences
    : [];
  const occurrenceIds = new Set(
    occurrences.map((item) => readString(asRecord(item), "id")).filter(Boolean),
  );
  // Reminder-plan steps project the same occurrence, not additional owner items.
  const reminders = Array.isArray(overview.reminders)
    ? overview.reminders.filter((item) => {
        const occurrenceId = readString(asRecord(item), "occurrenceId");
        return !occurrenceId || !occurrenceIds.has(occurrenceId);
      })
    : [];
  const goals = Array.isArray(overview.goals) ? overview.goals : [];
  // This public batch read uses the caller's definition scopes and includes
  // archived rows; never infer human item kinds from storage's raw kind.
  const definitionsById =
    occurrences.length > 0 ? await args.loadDefinitions() : new Map();
  const records = [...occurrences, ...reminders, ...goals];
  const items = records.map((item, index) => {
    const record = asRecord(item);
    const ownerId = readString(record, "ownerId");
    const ownerType = readString(record, "ownerType");
    return {
      id:
        readString(record, "id") ??
        readString(record, "occurrenceId") ??
        (ownerId && ownerType
          ? `${ownerType}:${ownerId}:${record.stepIndex ?? index}`
          : `life-item:${index}`),
      kind:
        index < occurrences.length
          ? briefingDefinitionKind(
              definitionsById.get(readString(record, "definitionId") ?? ""),
            )
          : index < occurrences.length + reminders.length
            ? ("reminder" as const)
            : ("goal" as const),
      title: readString(record, "title") ?? "Untitled item",
      ...(index < occurrences.length
        ? { state: occurrences[index].state }
        : {}),
      dueAt:
        readString(record, "dueAt") ??
        readString(record, "scheduledFor") ??
        null,
    };
  });
  return { items, summary: overview.summary };
}

/**
 * Owner items completed today, for the evening/recap narrative. Loaded from
 * the same service read the lifeops provider uses so the brief's "wins" and
 * the chat context can never disagree. A failed load reaches the composition
 * boundary, which records its unavailable marker and reports the failure.
 */
async function loadCompletedTodayFromService(args: {
  runtime: IAgentRuntime;
  loadDefinitions: () => Promise<BriefDefinitions>;
}): Promise<readonly LifeOpsBriefingLifeItem[]> {
  const service = await getBriefLifeOpsService(args.runtime);
  const completed = await service.listOwnerOccurrencesCompletedToday();
  if (completed.length === 0) return [];
  const definitionsById = await args.loadDefinitions();
  return completed.map((occurrence) => ({
    id: occurrence.id,
    kind: briefingDefinitionKind(definitionsById.get(occurrence.definitionId)),
    title: occurrence.title,
    dueAt: occurrence.dueAt ?? null,
    completedAt:
      typeof occurrence.completionPayload?.completedAt === "string"
        ? occurrence.completionPayload.completedAt
        : null,
    state: occurrence.state,
  }));
}

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
  const records = await new LifeOpsRepository(
    args.runtime,
  ).listCommitmentLedgerRecords(String(args.runtime.agentId), {
    statuses: ["open", "tracked"],
  });
  const audit = buildCommitmentRegretAudit(records, {
    nowIso: new Date().toISOString(),
  });
  return audit.items.map(mapRegretAuditItemToBriefingItem);
}

async function loadEngagementSummariesFromLifeOps(args: {
  runtime: IAgentRuntime;
}): Promise<readonly LifeOpsBriefItemEngagementSummary[]> {
  const repository = new LifeOpsRepository(args.runtime);
  await repository.finalizeExpiredBriefItemEngagements(args.runtime.agentId);
  await retryBriefEngagementRewards({
    runtime: args.runtime,
    repository,
  });
  return repository.summarizeBriefItemEngagements(args.runtime.agentId, {
    sinceIso: engagementSinceIso(),
  });
}

/**
 * Persist one `rendered` impression per surfaced (non-omitted) editorial item.
 * Called only after standalone callback delivery or the planner turn
 * delivery boundary resolved, so a failed delivery never fabricates visibility. Returns the number of rows
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
 * recurring payments. The composition boundary records unavailable sources.
 */
export interface BriefComposers {
  loadCalendar: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<readonly LifeOpsBriefingCalendarItem[]>;
  loadInbox: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
    explicit?: boolean;
  }) => Promise<
    | readonly LifeOpsBriefingInboxItem[]
    | LifeOpsBriefingInboxCollection
    | undefined
  >;
  loadLife: (args: {
    runtime: IAgentRuntime;
    period: LifeOpsBriefingPeriod;
  }) => Promise<
    readonly LifeOpsBriefingLifeItem[] | LifeOpsBriefingLifeCollection
  >;
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
  /** Ledger write for brief items after their owning delivery boundary. */
  recordRenderedImpressions: (args: {
    runtime: IAgentRuntime;
    briefing: LifeOpsBriefing;
    deliveredText: string;
    format: "narrative" | "json";
  }) => Promise<number>;
}

const defaultComposers: Omit<
  BriefComposers,
  "loadLife" | "loadCompletedToday"
> = {
  loadCalendar: loadCalendarFromLifeOps,
  loadInbox: loadInboxFromTriage,
  loadCommitments: loadCommitmentsFromLedger,
  loadEngagementSummaries: loadEngagementSummariesFromLifeOps,
  recordRenderedImpressions: recordRenderedImpressionsInLifeOps,
};

let activeComposers: typeof defaultComposers &
  Partial<Pick<BriefComposers, "loadLife" | "loadCompletedToday">> =
  defaultComposers;

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
  inboxExplicit: boolean;
  life: boolean;
  commitments: boolean;
} {
  return {
    calendar: input?.calendar !== false,
    inbox: input?.inbox !== false,
    inboxExplicit: input?.inbox === true,
    life: input?.life !== false,
    commitments: input?.commitments !== false,
  };
}

/** Generic daily dossiers use morning before the owner's evening start and
 * evening from that start, in the authoritative owner zone. Explicitly named
 * kinds and standalone calls never use this default policy. */
async function resolveGenericDailySubaction(
  runtime: IAgentRuntime,
  now: Date,
): Promise<ComposeSubaction> {
  const [{ timeZone }, facts] = await Promise.all([
    resolveCalendarTimeZone(runtime, now),
    resolveOwnerFactStore(runtime).read(),
  ]);
  const evening = DEFAULT_TIME_WINDOWS.find(
    (window) => window.name === "evening",
  );
  if (!evening)
    throw new ElizaError("Default evening window is unavailable", {
      code: "BRIEF_EVENING_WINDOW_UNAVAILABLE",
    });
  const configured = facts.eveningWindow?.value.startLocal;
  const eveningStart = configured
    ? Number(configured.slice(0, 2)) * 60 + Number(configured.slice(3, 5))
    : evening.startMinute;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const localMinute =
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value);
  return localMinute >= eveningStart ? "compose_evening" : "compose_morning";
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

// Preserve source scope through both initial composition and final reply synthesis.
const BRIEF_SOURCE_SCOPE_INSTRUCTIONS =
  "This briefing covers selected sources for the requested period, not the owner's entire stored inventory. activeGoalCount counts active goals only; zero does not mean no goals are stored or tracked. Empty collections describe only this period and source selection. For a general brief, focus on the supplied items and omit empty categories unless the owner explicitly asked about them. Do not broaden scoped counts into claims that nothing exists or nothing is tracked. Return finished owner-facing prose; never describe your composing process or editorial rules.";

// Static instruction block for the briefing narrative. This is the optimization
// target for the `morning_brief` LifeOps task (#8795): an OptimizedPromptService
// artifact, when present, replaces it; otherwise this inline baseline is used,
// so the absence of an artifact is a no-op. The dynamic header line and the data
// payload are composed around the resolved instructions, never optimized away.
export function buildNarrativePrompt(args: {
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
  sourceErrors?: LifeOpsBriefing["sourceErrors"];
  lifeSummary?: LifeOpsBriefing["lifeSummary"];
  timeZone?: string;
  asOf?: string;
  editorial?: LifeOpsBriefingEditorialContract;
  runtime?: IAgentRuntime;
  optimizationTask?: BriefOptimizationTask;
}): string {
  const asOf = args.asOf ?? new Date().toISOString();
  const asOfMs = Date.parse(asOf);
  const localAsOfDate =
    args.timeZone && Number.isFinite(asOfMs)
      ? calendarDateKey(new Date(asOfMs), args.timeZone)
      : undefined;
  const describeTime = (value: string | null | undefined) => {
    if (!value || !args.timeZone || !Number.isFinite(Date.parse(value)))
      return undefined;
    const instant = new Date(value);
    const localDate = calendarDateKey(instant, args.timeZone);
    return {
      localTime: formatCalendarEventDateTime(
        { startAt: value, timezone: args.timeZone },
        { includeYear: true, includeTimeZoneName: true },
      ),
      localDate,
      ...(localAsOfDate
        ? {
            dateRelationToAsOf:
              localDate === localAsOfDate
                ? "same_local_date"
                : localDate < localAsOfDate
                  ? "earlier_local_date"
                  : "later_local_date",
          }
        : {}),
      relationToAsOf:
        instant.getTime() < asOfMs
          ? "before_as_of"
          : instant.getTime() > asOfMs
            ? "after_as_of"
            : "at_as_of",
    };
  };
  const calendar = args.sections.calendar?.map((item) => {
    const startAt = describeTime(item.startAt);
    const endAt = describeTime(item.endAt);
    return {
      ...item,
      ...(startAt || endAt
        ? {
            timeContext: {
              ...(startAt ? { startAt } : {}),
              ...(endAt ? { endAt } : {}),
            },
          }
        : {}),
    };
  });
  const withItemTimes = <
    T extends { dueAt: string | null; completedAt?: string | null },
  >(
    item: T,
  ) => {
    const dueAt = describeTime(item.dueAt);
    const completedAt = describeTime(item.completedAt);
    return {
      ...item,
      ...(dueAt || completedAt
        ? {
            timeContext: {
              ...(dueAt ? { dueAt } : {}),
              ...(completedAt ? { completedAt } : {}),
            },
          }
        : {}),
    };
  };
  const life = args.sections.life?.map(withItemTimes);
  const sections = {
    ...args.sections,
    ...(calendar ? { calendar } : {}),
    ...(life ? { life } : {}),
    ...(args.sections.completedToday
      ? { completedToday: args.sections.completedToday.map(withItemTimes) }
      : {}),
    ...(args.sections.commitments
      ? { commitments: args.sections.commitments.map(withItemTimes) }
      : {}),
  };
  const editorial = args.editorial
    ? {
        // Ranking and engagement diagnostics explain how this contract was
        // chosen; they are not facts to narrate about the owner. Keep them in
        // the canonical briefing while rendering only the resulting decisions.
        maxItems: args.editorial.maxItems,
        items: args.editorial.items.map((item) => {
          const localTime =
            item.source === "life"
              ? life?.find((source) => source.id === item.sourceId)?.timeContext
                  ?.dueAt
              : item.source === "calendar"
                ? calendar?.find((source) => source.id === item.sourceId)
                    ?.timeContext?.startAt
                : undefined;
          return {
            itemId: item.itemId,
            source: item.source,
            kind: item.kind,
            sourceId: item.sourceId,
            title: item.title,
            summary: localTime
              ? `${item.source === "life" ? "due" : "starts"} ${localTime.localTime} (${localTime.relationToAsOf})`
              : item.summary,
          };
        }),
        decisions: args.editorial.decisions.map(({ itemId, action }) => ({
          itemId,
          action,
        })),
        pushback: args.editorial.pushback,
      }
    : undefined;
  const payload = JSON.stringify({
    kind: args.kind,
    period: args.period,
    sections,
    sourceErrors: args.sourceErrors,
    lifeSummary: args.lifeSummary,
    timeZone: args.timeZone,
    asOf,
    localAsOf: describeTime(asOf)?.localTime,
    localAsOfDate,
    editorial,
  });
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
${BRIEF_SOURCE_SCOPE_INSTRUCTIONS}
Write directly to the owner in ordinary conversational language, not a tracking or status report. For an evening brief with completedToday items, start with what was marked done today; the editorial lead then guides the still-open items. Keep item names and categories faithful. Do not narrate which records went active or contrast open carryovers with finished tasks. An uncompleted reminder record does not prove that its real-world activity is unfinished; its dueAt is a scheduled time, not activation or delivery time. When timing matters, use the supplied owner-local clock times rather than guessing dayparts or elapsed time.
Use asOf/localAsOfDate as the briefing clock and timeContext.localTime/localDate as the authoritative owner-local display. The requested briefing kind does not change the current date, daypart or selected period. When a named morning/evening brief is requested outside that daypart, identify it as a preview as of localAsOf and describe only the supplied period. An empty today-only calendar does not establish tomorrow's or the next morning's availability. When describing an empty calendar, name its supplied local date or say today. End after the verified facts; omit vague forecasts and motivational closing lines. Use relationToAsOf for before/after the clock and dateRelationToAsOf for the local day: same_local_date with before_as_of means earlier today, not yesterday or last evening; earlier_local_date requires its supplied date, not a guessed daypart. Prefer exact local dates/times when relative wording is ambiguous. Describe completion timing only from completedAt and its local timeContext, never dueAt or updatedAt. Completion and delivery cannot be inferred from a timestamp; before_as_of alone does not mean an item remains outstanding. Item state and lifeSummary counts are canonical source facts. Express them in ordinary language: visible means still open, snoozed means postponed but still open, completed means done, and skipped remains distinct. A notification does not make an item completed. Describe source coverage and item status conversationally; do not use source/status labels. An omitted section was not selected: do not discuss omitted domains or claim they were checked, empty, or unavailable.${args.sourceErrors ? "\nRequested sources marked unavailable are unavailable, not empty; partial means some inboxes could not be checked while supplied items remain valid. not_connected means no readable inbox connection: say the inbox is not connected and suggest connecting an email/message account to include its messages. Do not say a not_connected inbox check failed. Say what could not be checked in one compact, ordinary-language clause. Name the unavailable domain as supplied; do not rename an inbox error as an email/social-provider failure. Never claim it has no items or nothing due." : ""}

Data:
${payload}`;
}

async function composeNarrative(args: {
  runtime: IAgentRuntime;
  kind: LifeOpsBriefingKind;
  period: LifeOpsBriefingPeriod;
  sections: LifeOpsBriefingSections;
  sourceErrors?: LifeOpsBriefing["sourceErrors"];
  lifeSummary?: LifeOpsBriefing["lifeSummary"];
  editorial: LifeOpsBriefingEditorialContract;
  optimizationTask: BriefOptimizationTask;
  asOf: string;
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
  // Tag the trajectory with the exact LifeOps prompt task resolved above so the
  // call buckets into its per-capability dataset for the GEPA loop (#8795).
  // A failed compose pass degrades to a narrative-less structured briefing —
  // symmetric with the other LifeOps LLM consumers (scheduling, reminders),
  // which all fall back to a safe default rather than propagating the error.
  let raw: unknown;
  try {
    const prompt = buildNarrativePrompt({
      kind: args.kind,
      period: args.period,
      sections: args.sections,
      sourceErrors: args.sourceErrors,
      lifeSummary: args.lifeSummary,
      asOf: args.asOf,
      timeZone: (
        await resolveCalendarTimeZone(args.runtime, new Date(args.asOf))
      ).timeZone,
      editorial: args.editorial,
      runtime: args.runtime,
      optimizationTask: args.optimizationTask,
    });
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
      "[BRIEF] narrative compose failed; returning structured briefing without a narrative",
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
  asOf: string;
}): Promise<LifeOpsBriefing> {
  const { asOf } = args;
  const composers = activeComposers;
  // Both built-in collectors classify the same owner's definitions. Share only
  // this assembly's lazy read, including failures; later briefs read afresh.
  let definitions: Promise<BriefDefinitions> | undefined;
  const loadDefinitions = () =>
    (definitions ??= getBriefLifeOpsService(args.runtime)
      .then((service) => service.definitions.listDefinitionRows())
      .then(
        (records) =>
          new Map(records.map((definition) => [definition.id, definition])),
      ));
  const sourceErrors: NonNullable<LifeOpsBriefing["sourceErrors"]> = {};
  const collectSource = async <T>(
    source: keyof LifeOpsBriefingSections,
    collect: () => Promise<T>,
  ): Promise<T | readonly never[]> => {
    try {
      return await withinSourceBound(source, collect());
    } catch (error) {
      // error-policy:J4 compose the remaining requested sources, while retaining
      // an explicit unavailable marker and the diagnostic cause.
      args.runtime.reportError(
        `Brief.load${source.charAt(0).toUpperCase()}${source.slice(1)}`,
        error,
        { source },
      );
      sourceErrors[source] = "unavailable";
      return [];
    }
  };
  const kind = SUBACTION_TO_KIND[args.subaction];
  const [
    calendarItems,
    inboxCollection,
    lifeCollection,
    commitmentItems,
    // The evening brief is the recap surface: it must know what got DONE today
    // so the narrative can lead with wins instead of opening on open items
    // (#16935). Morning/weekly briefs keep their forward-looking shape.
    completedToday,
    engagementSummaries,
  ] = await Promise.all([
    args.include.calendar
      ? collectSource("calendar", () =>
          composers.loadCalendar({
            runtime: args.runtime,
            period: args.period,
          }),
        )
      : Promise.resolve([] as readonly LifeOpsBriefingCalendarItem[]),
    args.include.inbox
      ? collectSource("inbox", () =>
          composers.loadInbox({
            runtime: args.runtime,
            period: args.period,
            explicit: args.include.inboxExplicit,
          }),
        )
      : Promise.resolve([] as readonly LifeOpsBriefingInboxItem[]),
    args.include.life
      ? collectSource("life", () =>
          composers.loadLife
            ? composers.loadLife({ runtime: args.runtime, period: args.period })
            : loadLifeFromOverview({ runtime: args.runtime, loadDefinitions }),
        )
      : Promise.resolve([] as readonly LifeOpsBriefingLifeItem[]),
    args.include.commitments
      ? collectSource("commitments", () =>
          composers.loadCommitments({ runtime: args.runtime }),
        )
      : Promise.resolve([] as readonly LifeOpsBriefingCommitmentItem[]),
    kind === "evening" && args.include.life
      ? collectSource("completedToday", () =>
          composers.loadCompletedToday
            ? composers.loadCompletedToday({ runtime: args.runtime })
            : loadCompletedTodayFromService({
                runtime: args.runtime,
                loadDefinitions,
              }),
        )
      : Promise.resolve([] as readonly LifeOpsBriefingLifeItem[]),
    withinSourceBound(
      "engagement",
      composers.loadEngagementSummaries({ runtime: args.runtime }),
    ).catch((error) => {
      // error-policy:J4 engagement history only ranks the items; a brief
      // without it is still complete, so it must not wait on or fail with it.
      args.runtime.reportError("Brief.loadEngagementSummaries", error, {
        surface: "brief-editorial-engagement",
      });
      return [] as readonly LifeOpsBriefItemEngagementSummary[];
    }),
  ]);

  const inboxItems =
    inboxCollection === undefined
      ? undefined
      : "items" in inboxCollection
        ? inboxCollection.items
        : inboxCollection;
  if (
    inboxCollection &&
    "items" in inboxCollection &&
    inboxCollection.coverage !== "complete"
  )
    sourceErrors.inbox = inboxCollection.coverage;

  const lifeItems =
    "items" in lifeCollection ? lifeCollection.items : lifeCollection;
  const lifeSummary =
    "items" in lifeCollection ? lifeCollection.summary : undefined;

  const sections: LifeOpsBriefingSections = {
    ...(args.include.calendar ? { calendar: calendarItems } : {}),
    ...(args.include.inbox && inboxItems !== undefined
      ? { inbox: inboxItems }
      : {}),
    ...(args.include.life ? { life: lifeItems } : {}),
    ...(kind === "evening" && args.include.life ? { completedToday } : {}),
    ...(args.include.commitments ? { commitments: commitmentItems } : {}),
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
      ...(lifeSummary ? { lifeSummary } : {}),
      ...(Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
      editorial,
      optimizationTask: args.optimizationTask,
      asOf,
    });
  }

  const briefing: LifeOpsBriefing = {
    id: newBriefingId(),
    kind,
    period: args.period,
    generatedAt: asOf,
    sections,
    ...(lifeSummary ? { lifeSummary } : {}),
    ...(Object.keys(sourceErrors).length > 0 ? { sourceErrors } : {}),
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
        `- ${candidate.itemClass} (surfaced ${candidate.renderedCount} times, acted on ${candidate.actedOnCount})`,
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
    "Compose owner LifeOpsBriefing: morning/evening/weekly; calendar feed, inbox triage, life due. Subactions: compose_morning, compose_evening, compose_weekly, recalibrate (demote repeatedly ignored brief item classes; reversible), reset_recalibration (restore demoted classes).",
  descriptionCompressed:
    "BRIEF compose_morning|compose_evening|compose_weekly|recalibrate|reset_recalibration; LifeOpsBriefing",
  routingHint:
    'briefing/digest ("morning brief", "evening summary", "this week", "daily digest") -> BRIEF; one-domain read -> CALENDAR.feed, MESSAGE.triage, etc.',
  contexts: ["productivity", "calendar", "inbox", "tasks", "finance"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      required: true,
      description:
        "Brief op: compose_morning | compose_evening | compose_weekly | recalibrate | reset_recalibration. Unnamed daily dossiers use morning before the owner-local evening-window start, then evening; explicitly named kinds are retained.",
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
        "Include flags: { calendar?, inbox?, life? }. Ordinary briefs use configured inboxes by default. Leave include.inbox unset for ordinary briefs; set true only when the owner explicitly requests inbox/email coverage, or false to exclude it.",
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
    const requestText = extractUserText(unwrapUserMessageText(message));
    const plannerOwned = getActionReplyOwner(message.id) === "planner";
    const genericRequest =
      plannerOwned && isWholeGenericBriefRequest(requestText);
    const asOf = new Date().toISOString();
    let subaction = resolveSubaction(params);
    // Resolve the actual whole request before any control operation can run.
    // A planner-selected recalibration is not authority to mutate preferences.
    if (genericRequest) {
      subaction = /\bmorning\b/iu.test(requestText)
        ? "compose_morning"
        : /\bevening\b/iu.test(requestText)
          ? "compose_evening"
          : await resolveGenericDailySubaction(runtime, new Date(asOf));
    }
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

    // Whole ordinary briefs use existing connected-source defaults. Model flags
    // cannot invent required sources or exclude them; explicit user selections
    // stay outside this contract. The loader retains genuine source failures.
    const include = resolveIncludeFlags(
      genericRequest ? undefined : params.include,
    );
    const period = genericRequest ? "today" : resolvePeriod(params, subaction);
    const format: "narrative" | "json" =
      params.format === "json" ? "json" : "narrative";
    const optimizationTask = resolveBriefOptimizationTask({ params, message });

    const briefing = await assembleBriefing({
      runtime,
      subaction,
      period,
      include,
      // The planner writes its turn's reply from the grounding below whatever
      // format it passed, so only a direct caller composes a narrative here.
      format: plannerOwned ? "json" : format,
      optimizationTask,
      asOf,
    });

    const result: ActionResult = {
      success: true,
      data: {
        subaction,
        optimizationTask,
        briefing,
        briefingId: briefing.id,
        replyContext: {
          domain: "briefing",
          sourceScope: BRIEF_SOURCE_SCOPE_INSTRUCTIONS,
        },
      },
    };
    if (plannerOwned) {
      try {
        const prompt = buildNarrativePrompt({
          kind: briefing.kind,
          period: briefing.period,
          sections: briefing.sections,
          sourceErrors: briefing.sourceErrors,
          lifeSummary: briefing.lifeSummary,
          editorial: briefing.editorial,
          asOf: briefing.generatedAt,
          timeZone: (
            await resolveCalendarTimeZone(
              runtime,
              new Date(briefing.generatedAt),
            )
          ).timeZone,
          runtime,
          optimizationTask,
        });
        // The complete briefing prompt is the sole model-facing representation.
        // Keep the original snapshot in data for post-delivery impressions.
        return applyGroundedActionReply(
          {
            ...result,
            promptData: {
              subaction,
              optimizationTask,
              briefingId: briefing.id,
            },
            promptDataMode: "replace-data",
          },
          {
            kind: "deferred",
            grounding: JSON.stringify({ domain: "briefing", prompt }),
          },
        );
      } catch (error) {
        // error-policy:J1 preserve collected sources when presentation context fails.
        // Never retry collection or substitute an ungrounded owner-local clock.
        runtime.reportError("Brief.replyGrounding", error, {
          briefingId: briefing.id,
        });
        return applyGroundedActionReply(
          result,
          createUnavailableGroundedActionReply({
            kind: "reply_generation_error",
            code: "BRIEF_REPLY_GROUNDING_FAILED",
          }),
        );
      }
    }

    const text =
      briefing.narrative ??
      `Composed your ${briefing.kind} briefing for ${briefing.period}.${briefing.sourceErrors?.inbox === "not_connected" ? " Your inbox isn't connected. Connect an email or message account to include its messages." : ""}${Object.values(briefing.sourceErrors ?? {}).some((coverage) => coverage !== "not_connected") ? " Some requested information could not be checked." : ""}`;

    logger.info(
      `[BRIEF] ${subaction} id=${briefing.id} period=${briefing.period} calendar=${briefing.sections.calendar?.length ?? 0} inbox=${briefing.sections.inbox?.length ?? 0} life=${briefing.sections.life?.length ?? 0} commitments=${briefing.sections.commitments?.length ?? 0}`,
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
      ...result,
      text,
      userFacingText: text,
      // Generated narrative is licensed reply material, not mandatory verbatim
      // output. Preserve exact structured JSON while the evaluator owns prose.
      ...(format === "json" ? { verifiedUserFacing: true } : {}),
      turnComplete: true,
    };
  },
};

/** Current-turn results come from the executor, never message-supplied metadata. */
function deferredBriefings(state: State | undefined): LifeOpsBriefing[] {
  const results = state?.data?.actionResults;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result: ActionResult) => {
    const data = result?.data;
    const subaction = data?.subaction;
    const briefing = data?.briefing as LifeOpsBriefing | undefined;
    return result?.success === true &&
      result.transcriptVisibility === "internal" &&
      result.turnComplete === false &&
      !result.replyFailure &&
      typeof data?.replyGrounding === "string" &&
      typeof subaction === "string" &&
      COMPOSE_SUBACTIONS.some((value) => value === subaction) &&
      (data.actionName === ACTION_NAME ||
        // Whole-request reconciliation may convert a wrongly selected control
        // child into compose; only the successful deferred compose above qualifies.
        SUBACTIONS.some(
          (value) =>
            data.actionName === `${ACTION_NAME}_${value.toUpperCase()}`,
        )) &&
      briefing &&
      briefing.id === data.briefingId
      ? [briefing]
      : [];
  });
}

/** The existing post-delivery lifecycle supplies final text and exact source results. */
export const briefDeliveredImpressionsAction: Action = {
  name: "BRIEF_RECORD_DELIVERED_IMPRESSIONS",
  description:
    "Record surfaced briefing items after the owner's reply is delivered.",
  mode: ActionMode.ALWAYS_AFTER,
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message, state) =>
    deferredBriefings(state).length > 0 && hasLifeOpsAccess(runtime, message),
  handler: async (runtime, message, state, _options, _callback, responses) => {
    // Final planner replies carry simple=true; early response-handler acks do not.
    // Never fall back to an earlier ack when the final response is withheld.
    const response = responses?.at(-1);
    const content = response?.content;
    if (
      !response ||
      response.entityId !== runtime.agentId ||
      response.roomId !== message.roomId ||
      content?.simple !== true ||
      content.transcriptVisibility === "internal" ||
      content?.elizaSyntheticFailure === true ||
      typeof content?.text !== "string" ||
      !content.text.trim()
    )
      return { success: true };
    for (const briefing of deferredBriefings(state)) {
      await activeComposers.recordRenderedImpressions({
        runtime,
        briefing,
        deliveredText: content.text,
        format: "narrative",
      });
    }
    return { success: true };
  },
};
