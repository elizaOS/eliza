/** Structural ranking helpers for check-in briefing items before they are serialized into the summary prompt. */
import type { CheckinBriefingItem } from "./types.js";

export const MAX_SECTION_ITEMS_FOR_PROMPT = 30;

export type BriefingItemSignals = NonNullable<CheckinBriefingItem["signals"]>;
export type BriefingSortSignals = BriefingItemSignals & {
  occurredAt: string | null;
};
export type BriefingEngagement = NonNullable<BriefingItemSignals["engagement"]>;

function parseMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function toFiniteNonNegativeNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function buildBriefingSignals(args: {
  occurredAt: string | null;
  unread?: boolean;
  inbound?: boolean;
  replyNeeded?: boolean;
  important?: boolean;
  sourcePriority?: number;
  engagement?: BriefingEngagement;
}): { signals: BriefingItemSignals; reason: string | null } {
  const reasons: string[] = [];
  const occurredAtMs = parseMs(args.occurredAt);
  const recent =
    occurredAtMs !== null && Date.now() - occurredAtMs <= 24 * 60 * 60 * 1000;
  if (args.inbound) {
    reasons.push("incoming");
  }
  if (args.unread) {
    reasons.push("unread");
  }
  if (args.replyNeeded) {
    reasons.push("needs reply");
  }
  if (args.important) {
    reasons.push("important");
  }
  if (recent) {
    reasons.push("recent");
  }
  return {
    signals: {
      inbound: args.inbound || undefined,
      unread: args.unread || undefined,
      replyNeeded: args.replyNeeded || undefined,
      important: args.important || undefined,
      recent: recent || undefined,
      sourcePriority: args.sourcePriority,
      engagement: args.engagement,
    },
    reason: reasons.length > 0 ? reasons.join(", ") : null,
  };
}

export function sortBriefingItems(
  entries: Array<CheckinBriefingItem & { sort: BriefingSortSignals }>,
): CheckinBriefingItem[] {
  return entries
    .sort((left, right) => {
      for (const key of [
        "replyNeeded",
        "important",
        "unread",
        "inbound",
        "recent",
      ] as const) {
        const diff =
          Number(Boolean(right.sort[key])) - Number(Boolean(left.sort[key]));
        if (diff !== 0) {
          return diff;
        }
      }
      const priorityDiff =
        (right.sort.sourcePriority ?? 0) - (left.sort.sourcePriority ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const engagementDiff =
        (right.sort.engagement?.totalCount ?? 0) -
        (left.sort.engagement?.totalCount ?? 0);
      if (engagementDiff !== 0) {
        return engagementDiff;
      }
      return (parseMs(right.occurredAt) ?? 0) - (parseMs(left.occurredAt) ?? 0);
    })
    .slice(0, MAX_SECTION_ITEMS_FOR_PROMPT)
    .map(({ sort: _sort, ...item }) => item);
}
