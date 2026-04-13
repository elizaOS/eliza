import type { Conversation } from "../api";

export function isConversationRecord(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.title === "string" &&
    typeof candidate.roomId === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function normalizeConversationList(value: unknown): Conversation[] {
  return Array.isArray(value) ? value.filter(isConversationRecord) : [];
}
