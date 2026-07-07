/**
 * Editorial judgment helpers for LifeOps briefings.
 *
 * The brief composer gives every surfaced item a stable structural identity,
 * then this module turns owner engagement history into a small editorial
 * contract: what leads, what is demoted, and what pushback the model should
 * justify. The contract is deterministic so tests and optimization rewards can
 * inspect the same artifact the model sees.
 */

import type {
  LifeOpsBriefingCalendarItem,
  LifeOpsBriefingInboxItem,
  LifeOpsBriefingLifeItem,
  LifeOpsBriefingMoneyItem,
  LifeOpsBriefingSections,
} from "../../types/briefing.js";

export type LifeOpsBriefItemSource = "calendar" | "inbox" | "life" | "money";

export type LifeOpsBriefItemKind =
  | "meeting"
  | "message"
  | "todo"
  | "reminder"
  | "habit"
  | "goal"
  | "recurring_charge";

export type LifeOpsBriefEngagementEventType =
  | "rendered"
  | "opened"
  | "replied"
  | "completed"
  | "rescheduled"
  | "kept"
  | "dismissed"
  | "ignored"
  | "demoted";

export interface LifeOpsBriefStructuredItem {
  readonly itemId: string;
  readonly source: LifeOpsBriefItemSource;
  readonly kind: LifeOpsBriefItemKind;
  readonly sourceId: string;
  readonly itemClass: string;
  readonly title: string;
  readonly summary: string;
  readonly consequenceScore: number;
}

export interface LifeOpsBriefItemEngagementSummary {
  readonly itemClass: string;
  readonly renderedCount: number;
  readonly ignoredCount: number;
  readonly actedOnCount: number;
  readonly lastEventAt: string | null;
}

export interface LifeOpsBriefEditorialDecision {
  readonly itemId: string;
  readonly action: "lead" | "include" | "demote" | "omit";
  readonly reason: string;
}

export interface LifeOpsBriefEditorialContract {
  readonly maxItems: number;
  readonly items: readonly LifeOpsBriefStructuredItem[];
  readonly decisions: readonly LifeOpsBriefEditorialDecision[];
  readonly demotedItemClasses: readonly string[];
  readonly pushback: string | null;
}

const ACTED_ON_EVENTS = new Set<LifeOpsBriefEngagementEventType>([
  "opened",
  "replied",
  "completed",
  "rescheduled",
  "kept",
]);

function clean(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sourceItemId(
  source: LifeOpsBriefItemSource,
  sourceId: string,
): string {
  return `${source}:${sourceId}`;
}

function calendarConsequence(item: LifeOpsBriefingCalendarItem): number {
  const title = item.title.toLowerCase();
  if (
    /\b(board|investor|legal|deadline|interview|client|customer)\b/u.test(title)
  ) {
    return 95;
  }
  if (/\b(sync|standup|check[- ]?in|1:1)\b/u.test(title)) {
    return 55;
  }
  return 70;
}

function inboxConsequence(item: LifeOpsBriefingInboxItem): number {
  switch (item.urgency) {
    case "high":
      return 90;
    case "medium":
      return 65;
    case "low":
      return 30;
    default:
      return /\b(approve|deadline|sign|urgent|pay|renew|decision)\b/iu.test(
        item.snippet,
      )
        ? 75
        : 45;
  }
}

function lifeConsequence(item: LifeOpsBriefingLifeItem): number {
  if (item.kind === "goal") return 75;
  if (item.kind === "todo") return item.dueAt ? 80 : 55;
  if (item.kind === "reminder") return item.dueAt ? 65 : 45;
  return 30;
}

function moneyConsequence(item: LifeOpsBriefingMoneyItem): number {
  if (item.amountUsd >= 500) return 85;
  if (item.amountUsd >= 100) return 60;
  return 35;
}

function calendarItemClass(item: LifeOpsBriefingCalendarItem): string {
  const title = item.title.toLowerCase();
  if (/\bnewsletter|digest|fyis?\b/u.test(title)) return "calendar:low-signal";
  if (/\b(board|investor|legal|deadline|client|customer)\b/u.test(title)) {
    return "calendar:high-consequence";
  }
  return "calendar:meeting";
}

function inboxItemClass(item: LifeOpsBriefingInboxItem): string {
  const snippet = item.snippet.toLowerCase();
  if (/\bnewsletter|digest|roundup|promo|promotion\b/u.test(snippet)) {
    return "inbox:newsletter-digest";
  }
  if (/\b(approve|deadline|sign|urgent|pay|renew|decision)\b/u.test(snippet)) {
    return "inbox:decision-required";
  }
  return `inbox:${item.channel}`;
}

export function structureBriefingItems(
  sections: LifeOpsBriefingSections,
): readonly LifeOpsBriefStructuredItem[] {
  const items: LifeOpsBriefStructuredItem[] = [];
  for (const item of sections.calendar ?? []) {
    items.push({
      itemId: sourceItemId("calendar", item.id),
      source: "calendar",
      kind: "meeting",
      sourceId: item.id,
      itemClass: calendarItemClass(item),
      title: clean(item.title),
      summary: clean(`${item.startAt} ${item.location ?? ""}`),
      consequenceScore: calendarConsequence(item),
    });
  }
  for (const item of sections.inbox ?? []) {
    items.push({
      itemId: sourceItemId("inbox", item.id),
      source: "inbox",
      kind: "message",
      sourceId: item.id,
      itemClass: inboxItemClass(item),
      title: clean(`${item.senderName} via ${item.channel}`),
      summary: clean(item.snippet),
      consequenceScore: inboxConsequence(item),
    });
  }
  for (const item of sections.life ?? []) {
    items.push({
      itemId: sourceItemId("life", item.id),
      source: "life",
      kind: item.kind,
      sourceId: item.id,
      itemClass: `life:${item.kind}`,
      title: clean(item.title),
      summary: clean(item.dueAt ? `due ${item.dueAt}` : "no due date"),
      consequenceScore: lifeConsequence(item),
    });
  }
  for (const item of sections.money ?? []) {
    items.push({
      itemId: sourceItemId("money", item.id),
      source: "money",
      kind: "recurring_charge",
      sourceId: item.id,
      itemClass:
        item.amountUsd >= 100
          ? "money:material-recurring"
          : "money:small-recurring",
      title: clean(item.merchant),
      summary: clean(`$${item.amountUsd.toFixed(2)} ${item.cadence}`),
      consequenceScore: moneyConsequence(item),
    });
  }
  return items;
}

export function summarizeBriefEngagementRows(
  rows: readonly {
    readonly itemClass: string;
    readonly eventType: LifeOpsBriefEngagementEventType;
    readonly eventAt: string;
  }[],
): readonly LifeOpsBriefItemEngagementSummary[] {
  const summaries = new Map<string, LifeOpsBriefItemEngagementSummary>();
  for (const row of rows) {
    const current =
      summaries.get(row.itemClass) ??
      ({
        itemClass: row.itemClass,
        renderedCount: 0,
        ignoredCount: 0,
        actedOnCount: 0,
        lastEventAt: null,
      } satisfies LifeOpsBriefItemEngagementSummary);
    summaries.set(row.itemClass, {
      itemClass: row.itemClass,
      renderedCount:
        current.renderedCount + (row.eventType === "rendered" ? 1 : 0),
      ignoredCount:
        current.ignoredCount + (row.eventType === "ignored" ? 1 : 0),
      actedOnCount:
        current.actedOnCount + (ACTED_ON_EVENTS.has(row.eventType) ? 1 : 0),
      lastEventAt:
        current.lastEventAt && current.lastEventAt > row.eventAt
          ? current.lastEventAt
          : row.eventAt,
    });
  }
  return [...summaries.values()].sort((a, b) =>
    a.itemClass.localeCompare(b.itemClass),
  );
}

export function recalibrateBriefItemClasses(
  summaries: readonly LifeOpsBriefItemEngagementSummary[],
  options: { ignoredThreshold?: number } = {},
): readonly string[] {
  const ignoredThreshold = options.ignoredThreshold ?? 5;
  return summaries
    .filter(
      (summary) =>
        summary.ignoredCount >= ignoredThreshold &&
        summary.actedOnCount === 0 &&
        summary.ignoredCount >= summary.renderedCount - summary.actedOnCount,
    )
    .map((summary) => summary.itemClass)
    .sort();
}

export function buildBriefEditorialContract(args: {
  sections: LifeOpsBriefingSections;
  engagementSummaries?: readonly LifeOpsBriefItemEngagementSummary[];
  maxItems?: number;
  overloadedCalendarThreshold?: number;
}): LifeOpsBriefEditorialContract {
  const maxItems = args.maxItems ?? 7;
  const items = structureBriefingItems(args.sections);
  const demotedItemClasses = recalibrateBriefItemClasses(
    args.engagementSummaries ?? [],
  );
  const demoted = new Set(demotedItemClasses);
  const ranked = [...items].sort((a, b) => {
    const demotionDelta =
      Number(demoted.has(a.itemClass)) - Number(demoted.has(b.itemClass));
    if (demotionDelta !== 0) return demotionDelta;
    return (
      b.consequenceScore - a.consequenceScore ||
      a.itemId.localeCompare(b.itemId)
    );
  });
  const decisions: LifeOpsBriefEditorialDecision[] = ranked.map(
    (item, index) => {
      if (index === 0 && !demoted.has(item.itemClass)) {
        return {
          itemId: item.itemId,
          action: "lead",
          reason: "highest consequence item in the current briefing set",
        };
      }
      if (demoted.has(item.itemClass)) {
        return {
          itemId: item.itemId,
          action: index < maxItems ? "demote" : "omit",
          reason: `${item.itemClass} has repeated ignore history with no acted-on signal`,
        };
      }
      return {
        itemId: item.itemId,
        action: index < maxItems ? "include" : "omit",
        reason:
          index < maxItems
            ? "within the consequence-ranked brief cap"
            : "below the consequence-ranked brief cap",
      };
    },
  );
  const calendarCount = args.sections.calendar?.length ?? 0;
  const pushback =
    calendarCount >= (args.overloadedCalendarThreshold ?? 6)
      ? "Calendar is overloaded; justify one meeting to cancel, decline, or shorten."
      : null;
  return {
    maxItems,
    items: ranked.map((item) => ({
      ...item,
      consequenceScore: clampScore(item.consequenceScore),
    })),
    decisions,
    demotedItemClasses,
    pushback,
  };
}
