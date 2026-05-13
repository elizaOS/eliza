import { normalizeConnectorSource } from "@elizaos/shared";
import type * as React from "react";
import type { Conversation } from "../../api/client-types-chat";
import { isMainChatConversation } from "../../state/chat-conversation-guards";
import type { TranslateFn } from "../../types";
import { getChatSourceMeta } from "../composites/chat/chat-source";

import {
  formatRelativeTime,
  getLocalizedConversationTitle,
} from "./conversation-utils";

export const ELIZA_SOURCE_SCOPE = "eliza";
export const TERMINAL_SOURCE_SCOPE = "terminal";
export const ALL_CONNECTORS_SOURCE_SCOPE = "__all_connectors__";
export const ALL_WORLDS_SCOPE = "__all_worlds__";

const UNKNOWN_WORLD_KEY = "__unknown_world__";
const DMS_WORLD_PREFIX = "__dms__";

const MS_PER_DAY = 86_400_000;
const MAX_DAY_BUCKET_RANK = 10_000_000;
const MAX_WEEK_BUCKET_RANK = 9_000_000;
const MAX_MONTH_BUCKET_RANK = 8_000_000;
const MAX_YEAR_BUCKET_RANK = 7_000_000;

export interface InboxChatSidebarRow {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  lastMessageAt: number;
  roomType?: string;
  source: string;
  transportSource?: string;
  title: string;
  worldId?: string;
  worldLabel: string;
}

export interface ConversationsSidebarRow {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  kind: "conversation" | "inbox";
  sortKey: number;
  source?: string;
  sourceKey: string;
  transportSource?: string;
  title: string;
  updatedAtLabel: string;
  worldId?: string;
  worldKey: string | null;
  worldLabel?: string;
}

export interface ConversationsSidebarSection {
  count: number;
  key: string;
  label: string;
  rows: ConversationsSidebarRow[];
}

export interface ConversationsSidebarOption {
  count: number;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}

export interface ConversationsSidebarModel {
  rows: ConversationsSidebarRow[];
  sections: ConversationsSidebarSection[];
  showWorldFilter: boolean;
  sourceOptions: ConversationsSidebarOption[];
  sourceScope: string;
  worldOptions: ConversationsSidebarOption[];
  worldScope: string;
}

function sourceLabel(source: string): string {
  return getChatSourceMeta(source).label;
}

const FALLBACK_WORLD_LABEL_RE = /^world for (server|room) /i;

function isDmLike(chat: InboxChatSidebarRow): boolean {
  // Authoritative signal from the backend when the connector tags rooms.
  if (chat.roomType?.trim().toUpperCase() === "DM") return true;
  const trimmedWorldId = chat.worldId?.trim();
  if (!trimmedWorldId) return true;
  const label = chat.worldLabel?.trim() ?? "";
  // Fallback heuristic — backends emit "World for server <id>" / "World for
  // room <id>" when there is no named guild. In practice that's a DM.
  return FALLBACK_WORLD_LABEL_RE.test(label);
}

function normalizeWorldLabel(
  chat: InboxChatSidebarRow,
  t?: TranslateFn,
): string {
  if (isDmLike(chat)) {
    return (
      t?.("conversations.scopeDms", {
        defaultValue: "DMs",
      }) ?? "DMs"
    );
  }
  const trimmed = chat.worldLabel?.trim();
  if (trimmed) {
    return trimmed;
  }
  return (
    t?.("conversations.scopeUnknownWorld", {
      defaultValue: "Unknown world",
    }) ?? "Unknown world"
  );
}

function worldKey(chat: InboxChatSidebarRow, normalizedSource: string): string {
  if (isDmLike(chat)) {
    return `${DMS_WORLD_PREFIX}:${normalizedSource}`;
  }
  const trimmedWorldId = chat.worldId?.trim();
  if (trimmedWorldId) {
    return trimmedWorldId;
  }
  return `${DMS_WORLD_PREFIX}:${normalizedSource}`;
}

function buildConversationRows(
  conversations: Conversation[],
  t: TranslateFn,
): ConversationsSidebarRow[] {
  return conversations
    .filter(isMainChatConversation)
    .map((conversation) => ({
      id: conversation.id,
      kind: "conversation" as const,
      sortKey: new Date(conversation.updatedAt).getTime(),
      sourceKey: ELIZA_SOURCE_SCOPE,
      title: getLocalizedConversationTitle(conversation.title, t),
      updatedAtLabel: formatRelativeTime(conversation.updatedAt, t),
      worldKey: null,
    }))
    .sort((left, right) => right.sortKey - left.sortKey);
}

function buildInboxRows(
  inboxChats: InboxChatSidebarRow[],
  t: TranslateFn,
): ConversationsSidebarRow[] {
  return inboxChats
    .map((chat) => {
      const sortKey = Number.isFinite(chat.lastMessageAt)
        ? chat.lastMessageAt
        : Date.now();
      const isoDate = new Date(sortKey).toISOString();
      const normalizedSource = normalizeConnectorSource(chat.source);
      const normalizedWorldLabel = normalizeWorldLabel(chat, t);
      return {
        avatarUrl: chat.avatarUrl,
        canSend: chat.canSend,
        id: chat.id,
        kind: "inbox" as const,
        sortKey,
        source: normalizedSource,
        sourceKey: normalizedSource,
        transportSource: chat.transportSource ?? chat.source,
        title: chat.title,
        updatedAtLabel: formatRelativeTime(isoDate, t),
        ...(chat.worldId ? { worldId: chat.worldId } : {}),
        worldKey: worldKey(chat, normalizedSource),
        worldLabel: normalizedWorldLabel,
      };
    })
    .sort((left, right) => right.sortKey - left.sortKey);
}

function buildSourceOptions(
  appRows: ConversationsSidebarRow[],
  connectorRows: ConversationsSidebarRow[],
  t: TranslateFn,
): ConversationsSidebarOption[] {
  const sourceCounts = new Map<string, number>();
  for (const row of connectorRows) {
    const current = sourceCounts.get(row.sourceKey) ?? 0;
    sourceCounts.set(row.sourceKey, current + 1);
  }

  const connectorOptions = Array.from(sourceCounts.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([value, count]) => ({
      count,
      icon: getChatSourceMeta(value).Icon,
      label: sourceLabel(value),
      value,
    }));

  const options: ConversationsSidebarOption[] = [
    {
      count: appRows.length,
      icon: getChatSourceMeta("eliza").Icon,
      label: t("conversations.scopeApp", { defaultValue: "Messages" }),
      value: ELIZA_SOURCE_SCOPE,
    },
    {
      count: 0,
      icon: getChatSourceMeta("terminal").Icon,
      label: t("conversations.scopeTerminal", { defaultValue: "Terminal" }),
      value: TERMINAL_SOURCE_SCOPE,
    },
  ];

  if (connectorRows.length > 0) {
    options.push({
      count: connectorRows.length,
      label: t("conversations.scopeAllConnectors", {
        defaultValue: "All connectors",
      }),
      value: ALL_CONNECTORS_SOURCE_SCOPE,
    });
    options.push(...connectorOptions);
  }

  return options;
}

function buildWorldOptions(
  connectorRows: ConversationsSidebarRow[],
  sourceScope: string,
  t: TranslateFn,
): ConversationsSidebarOption[] {
  if (
    sourceScope === ELIZA_SOURCE_SCOPE ||
    sourceScope === TERMINAL_SOURCE_SCOPE ||
    sourceScope === ALL_CONNECTORS_SOURCE_SCOPE
  ) {
    return [];
  }

  const matchingRows = connectorRows.filter(
    (row) => row.sourceKey === sourceScope,
  );
  if (matchingRows.length === 0) {
    return [];
  }

  const worldCounts = new Map<string, ConversationsSidebarOption>();
  for (const row of matchingRows) {
    const key = row.worldKey ?? `${UNKNOWN_WORLD_KEY}:unknown`;
    const existing = worldCounts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    worldCounts.set(key, {
      count: 1,
      label:
        row.worldLabel?.trim() ||
        t("conversations.scopeUnknownWorld", {
          defaultValue: "Unknown world",
        }),
      value: key,
    });
  }

  return [
    {
      count: matchingRows.length,
      label: t("common.all", {
        defaultValue: "All",
      }),
      value: ALL_WORLDS_SCOPE,
    },
    ...Array.from(worldCounts.values()).sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
  ];
}

function filterRowsByScope(
  appRows: ConversationsSidebarRow[],
  connectorRows: ConversationsSidebarRow[],
  sourceScope: string,
  worldScope: string,
): ConversationsSidebarRow[] {
  if (sourceScope === ELIZA_SOURCE_SCOPE) {
    return appRows;
  }

  if (sourceScope === TERMINAL_SOURCE_SCOPE) {
    // Terminal rows are injected by the sidebar component, not the model.
    return [];
  }

  if (sourceScope === ALL_CONNECTORS_SOURCE_SCOPE) {
    return connectorRows;
  }

  return connectorRows.filter((row) => {
    if (row.sourceKey !== sourceScope) {
      return false;
    }
    if (worldScope === ALL_WORLDS_SCOPE) {
      return true;
    }
    return row.worldKey === worldScope;
  });
}

function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

interface TimeBucket {
  key: string;
  label: string;
  rank: number;
}

function timeBucket(sortKey: number, now: Date, t: TranslateFn): TimeBucket {
  const nowDay = startOfLocalDay(now);
  const rowDay = startOfLocalDay(new Date(sortKey));
  const dayDelta = Math.max(0, Math.round((nowDay - rowDay) / MS_PER_DAY));

  if (dayDelta <= 0) {
    return {
      key: "t:today",
      label: t("common.today", { defaultValue: "Today" }),
      rank: MAX_DAY_BUCKET_RANK,
    };
  }
  if (dayDelta === 1) {
    return {
      key: "t:yesterday",
      label: t("conversations.bucketYesterday", { defaultValue: "Yesterday" }),
      rank: MAX_DAY_BUCKET_RANK - 1,
    };
  }
  if (dayDelta < 7) {
    return {
      key: `t:days-${dayDelta}`,
      label: t("conversations.bucketDaysAgo", {
        count: dayDelta,
        defaultValue: `${dayDelta} days ago`,
      }),
      rank: MAX_DAY_BUCKET_RANK - dayDelta,
    };
  }

  const weekDelta = Math.floor(dayDelta / 7);
  if (weekDelta === 1) {
    return {
      key: "t:weeks-1",
      label: t("conversations.bucketLastWeek", { defaultValue: "Last week" }),
      rank: MAX_WEEK_BUCKET_RANK - 1,
    };
  }
  if (weekDelta < 5) {
    return {
      key: `t:weeks-${weekDelta}`,
      label: t("conversations.bucketWeeksAgo", {
        count: weekDelta,
        defaultValue: `${weekDelta} weeks ago`,
      }),
      rank: MAX_WEEK_BUCKET_RANK - weekDelta,
    };
  }

  const monthDelta = Math.floor(dayDelta / 30);
  if (monthDelta === 1) {
    return {
      key: "t:months-1",
      label: t("conversations.bucketLastMonth", { defaultValue: "Last month" }),
      rank: MAX_MONTH_BUCKET_RANK - 1,
    };
  }
  if (monthDelta < 12) {
    return {
      key: `t:months-${monthDelta}`,
      label: t("conversations.bucketMonthsAgo", {
        count: monthDelta,
        defaultValue: `${monthDelta} months ago`,
      }),
      rank: MAX_MONTH_BUCKET_RANK - monthDelta,
    };
  }

  const yearDelta = Math.max(1, Math.floor(dayDelta / 365));
  if (yearDelta === 1) {
    return {
      key: "t:years-1",
      label: t("conversations.bucketLastYear", {
        defaultValue: "Over a year ago",
      }),
      rank: MAX_YEAR_BUCKET_RANK - 1,
    };
  }
  return {
    key: `t:years-${yearDelta}`,
    label: t("conversations.bucketYearsAgo", {
      count: yearDelta,
      defaultValue: `${yearDelta} years ago`,
    }),
    rank: MAX_YEAR_BUCKET_RANK - yearDelta,
  };
}

function buildSections(
  rows: ConversationsSidebarRow[],
  t: TranslateFn,
  now: Date = new Date(),
): ConversationsSidebarSection[] {
  if (rows.length === 0) {
    return [];
  }

  const groups = new Map<
    string,
    ConversationsSidebarSection & { rank: number }
  >();
  for (const row of rows) {
    const bucket = timeBucket(row.sortKey, now, t);
    const existing = groups.get(bucket.key);
    if (existing) {
      existing.rows.push(row);
      existing.count += 1;
      continue;
    }

    groups.set(bucket.key, {
      count: 1,
      key: bucket.key,
      label: bucket.label,
      rank: bucket.rank,
      rows: [row],
    });
  }

  return Array.from(groups.values())
    .map((section) => ({
      count: section.count,
      key: section.key,
      label: section.label,
      rank: section.rank,
      rows: [...section.rows].sort(
        (left, right) => right.sortKey - left.sortKey,
      ),
    }))
    .sort((left, right) => right.rank - left.rank)
    .map(({ rank: _rank, ...section }) => section);
}

export function buildConversationsSidebarModel({
  conversations,
  inboxChats,
  searchQuery,
  sourceScope,
  t,
  worldScope,
}: {
  conversations: Conversation[];
  inboxChats: InboxChatSidebarRow[];
  searchQuery: string;
  sourceScope: string;
  t: TranslateFn;
  worldScope: string;
}): ConversationsSidebarModel {
  const appRows = buildConversationRows(conversations, t);
  const connectorRows = buildInboxRows(inboxChats, t);
  const sourceOptions = buildSourceOptions(appRows, connectorRows, t);
  const availableSourceValues = new Set(
    sourceOptions.map((option) => option.value),
  );
  const normalizedSourceScope = availableSourceValues.has(sourceScope)
    ? sourceScope
    : ELIZA_SOURCE_SCOPE;
  const worldOptions = buildWorldOptions(
    connectorRows,
    normalizedSourceScope,
    t,
  );
  const showWorldFilter = worldOptions.length > 0;
  const availableWorldValues = new Set(
    worldOptions.map((option) => option.value),
  );
  const normalizedWorldScope =
    showWorldFilter && availableWorldValues.has(worldScope)
      ? worldScope
      : ALL_WORLDS_SCOPE;

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const scopedRows = filterRowsByScope(
    appRows,
    connectorRows,
    normalizedSourceScope,
    normalizedWorldScope,
  );
  const filteredRows =
    normalizedSearchQuery.length === 0
      ? scopedRows
      : scopedRows.filter((row) =>
          row.title.toLowerCase().includes(normalizedSearchQuery),
        );
  const sections = buildSections(filteredRows, t);

  return {
    rows: sections.flatMap((section) => section.rows),
    sections,
    showWorldFilter,
    sourceOptions,
    sourceScope: normalizedSourceScope,
    worldOptions,
    worldScope: normalizedWorldScope,
  };
}
