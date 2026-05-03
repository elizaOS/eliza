import type { IAgentRuntime, Memory, Room } from "@elizaos/core";
import { asNonEmptyString, asRecord } from "@elizaos/shared";

const readString = asNonEmptyString;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function formatExternalSpeakerLabel(
  displayName: string | undefined,
  userName: string | undefined,
  source: string | undefined,
): string {
  if (
    displayName &&
    userName &&
    normalizeName(displayName) !== normalizeName(userName)
  ) {
    if (source === "discord") {
      return `${displayName} (discord username: ${userName})`;
    }
    return `${displayName} (username: ${userName})`;
  }
  return displayName ?? userName ?? "user";
}

export function formatSpeakerLabel(
  runtime: IAgentRuntime,
  memory: Memory,
): string {
  if (memory.entityId === runtime.agentId) {
    return runtime.character?.name ?? "agent";
  }

  const metadata = asRecord(memory.metadata);
  const content = asRecord(memory.content);
  const defaultMetadata = asRecord(metadata?.default);
  const source = readString(content?.source);
  const sourceMetadata = source ? asRecord(metadata?.[source]) : null;

  const displayName =
    readString(metadata?.entityName) ??
    readString(metadata?.displayName) ??
    readString(sourceMetadata?.displayName) ??
    readString(sourceMetadata?.name) ??
    readString(defaultMetadata?.name) ??
    readString(metadata?.name);
  const userName =
    readString(metadata?.entityUserName) ??
    readString(sourceMetadata?.userName) ??
    readString(sourceMetadata?.username) ??
    readString(defaultMetadata?.username) ??
    readString(metadata?.userName) ??
    readString(metadata?.username);

  return formatExternalSpeakerLabel(displayName, userName, source);
}

/**
 * Format a Room into a "[source] name" tag for display in provider output.
 */
export function roomSourceTag(room: Room | null): string {
  if (!room) return "[unknown]";
  const source = room.source || (room.type ?? "chat");
  const name = room.name || room.id?.slice(0, 8);
  return `[${source}] ${name}`;
}

/**
 * Format a createdAt timestamp as a human-readable relative string.
 */
export function formatRelativeTimestamp(createdAt?: number): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
