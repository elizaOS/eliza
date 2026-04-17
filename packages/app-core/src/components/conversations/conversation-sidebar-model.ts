import { normalizeConnectorSource } from "@elizaos/shared/connectors";
import { getChatSourceMeta } from "@elizaos/ui";
import type * as React from "react";
import type { Conversation } from "../../api/client-types-chat";
import {
  formatRelativeTime,
  getLocalizedConversationTitle,
} from "./conversation-utils";

export const ELIZA_SOURCE_SCOPE = "eliza";
export const ALL_CONNECTORS_SOURCE_SCOPE = "__all_connectors__";
export const ALL_WORLDS_SCOPE = "__all_worlds__";

const UNKNOWN_WORLD_KEY = "__unknown_world__";

type TranslateFn = (
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
) => string;

export interface InboxChatSidebarRow {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  lastMessageAt: number;
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

function normalizeWorldLabel(chat: InboxChatSidebarRow): string {
  const trimmed = chat.worldLabel?.trim();
  if (trimmed) {
    return trimmed;
  }
  return "Unknown world";
}

function worldKey(chat: InboxChatSidebarRow): string {
  const trimmedWorldId = chat.worldId?.trim();
  if (trimmedWorldId) {
    return trimmedWorldId;
  }
  return `${UNKNOWN_WORLD_KEY}:${normalizeWorldLabel(chat).toLowerCase()}`;
}

function buildConversationRows(
  conversations: Conversation[],
  t: TranslateFn,
): ConversationsSidebarRow[] {
  return conversations
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
      const isoDate = new Date(chat.lastMessageAt).toISOString();
      const normalizedWorldLabel = normalizeWorldLabel(chat);
      const normalizedSource = normalizeConnectorSource(chat.source);
      return {
        avatarUrl: chat.avatarUrl,
        canSend: chat.canSend,
        id: chat.id,
        kind: "inbox" as const,
        sortKey: chat.lastMessageAt,
        source: normalizedSource,
        sourceKey: normalizedSource,
        transportSource: chat.transportSource ?? chat.source,
        title: chat.title,
        updatedAtLabel: formatRelativeTime(isoDate, t),
        ...(chat.worldId ? { worldId: chat.worldId } : {}),
        worldKey: worldKey(chat),
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
      label: t("conversations.scopeApp", { defaultValue: "Terminal" }),
      value: ELIZA_SOURCE_SCOPE,
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
      label: t("conversations.scopeAllWorlds", {
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

function buildSections(
  rows: ConversationsSidebarRow[],
  sourceScope: string,
  t: TranslateFn,
): ConversationsSidebarSection[] {
  if (rows.length === 0) {
    return [];
  }

  const groups = new Map<string, ConversationsSidebarSection>();
  for (const row of rows) {
    let key = sourceScope;
    let label = t("conversations.scopeApp", { defaultValue: "Terminal" });

    if (row.kind === "inbox") {
      if (sourceScope === ALL_CONNECTORS_SOURCE_SCOPE) {
        key = `${row.sourceKey}:${row.worldKey ?? "unknown"}`;
        label = `${sourceLabel(row.sourceKey)} • ${row.worldLabel ?? "Unknown world"}`;
      } else {
        key = row.worldKey ?? `${UNKNOWN_WORLD_KEY}:unknown`;
        label = row.worldLabel ?? "Unknown world";
      }
    }

    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.count += 1;
      continue;
    }

    groups.set(key, {
      count: 1,
      key,
      label,
      rows: [row],
    });
  }

  return Array.from(groups.values())
    .map((section) => ({
      ...section,
      rows: [...section.rows].sort(
        (left, right) => right.sortKey - left.sortKey,
      ),
    }))
    .sort((left, right) => {
      const leftNewest = left.rows[0]?.sortKey ?? 0;
      const rightNewest = right.rows[0]?.sortKey ?? 0;
      return rightNewest - leftNewest;
    });
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
  const sections = buildSections(filteredRows, normalizedSourceScope, t);

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
