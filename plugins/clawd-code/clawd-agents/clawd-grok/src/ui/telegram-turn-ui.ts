import type { ChatEntry, ToolCall, ToolResult } from "../types/index";

export interface EntryDecoration {
  modeColor?: string;
  remoteKey?: string;
  sourceLabel?: string;
}

export function getTelegramSourceLabel(kind: "user" | "assistant", userId: number): string {
  return kind === "user" ? `Telegram user ${userId}` : `Telegram Grok • user ${userId}`;
}

export function buildUserEntry(content: string, decoration: EntryDecoration = {}): ChatEntry {
  return {
    type: "user",
    content,
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
  };
}

export function buildAssistantEntry(content: string, decoration: EntryDecoration = {}): ChatEntry {
  return {
    type: "assistant",
    content,
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
  };
}

export function buildToolResultEntry(
  toolCall: ToolCall,
  toolResult: ToolResult,
  decoration: EntryDecoration = {},
): ChatEntry {
  return {
    type: "tool_result",
    content: toolResult.success ? toolResult.output || "Success" : toolResult.error || "Error",
    timestamp: new Date(),
    modeColor: decoration.modeColor,
    remoteKey: decoration.remoteKey,
    sourceLabel: decoration.sourceLabel,
    toolCall,
    toolResult,
  };
}

export function getUnflushedTelegramAssistantContent(fullContent: string, flushedChars: number): string {
  const safeStart = Math.max(0, Math.min(flushedChars, fullContent.length));
  return fullContent.slice(safeStart);
}

export function replaceTurnEntries(entries: ChatEntry[], turnKey: string, replacements: ChatEntry[]): ChatEntry[] {
  return [...entries.filter((entry) => entry.remoteKey !== turnKey), ...replacements];
}

export function decorateTelegramEntries(entries: ChatEntry[], userId: number, turnKey: string): ChatEntry[] {
  return entries.map((entry) => {
    if (entry.type === "user") {
      return {
        ...entry,
        remoteKey: turnKey,
        sourceLabel: getTelegramSourceLabel("user", userId),
      };
    }

    if (entry.type === "assistant") {
      return {
        ...entry,
        remoteKey: turnKey,
        sourceLabel: getTelegramSourceLabel("assistant", userId),
      };
    }

    return {
      ...entry,
      remoteKey: turnKey,
    };
  });
}
