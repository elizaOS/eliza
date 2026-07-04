/**
 * Predicates that classify conversations for the main chat surface — hiding
 * automation-scoped rooms and the legacy page-chat titles so only real user
 * threads appear in the transcript list.
 */
import type { Conversation } from "../api";

const MAIN_CHAT_HIDDEN_SCOPES = new Set([
  "automation-coordinator",
  "automation-workflow",
  "automation-workflow-draft",
  "automation-draft",
]);

const LEGACY_PAGE_CHAT_TITLES = new Set([
  "browser",
  "character",
  "automations",
  "apps",
  "phone",
  "settings",
  "wallet",
]);

/**
 * True when a title collides with the legacy page-chat title heuristic in
 * {@link isMainChatConversation}. A scope-less conversation with one of these
 * exact titles is treated as a legacy page chat and hidden from every list —
 * so user renames must reject them (QA: renaming a chat to "wallet" made it
 * vanish with no recovery path). New conversations are stamped
 * `scope: "general"` at creation, but the pre-stamp backlog stays vulnerable
 * to this collision.
 */
export function isReservedLegacyChatTitle(title: string): boolean {
  return LEGACY_PAGE_CHAT_TITLES.has(title.trim().toLowerCase());
}

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

export function isMainChatConversation(
  conversation: Pick<Conversation, "metadata" | "title"> | null | undefined,
): boolean {
  const scope = conversation?.metadata?.scope;
  if (typeof scope !== "string" || scope.length === 0) {
    const title = conversation?.title?.trim().toLowerCase();
    return !title || !LEGACY_PAGE_CHAT_TITLES.has(title);
  }
  if (scope.startsWith("page-")) {
    return false;
  }
  return !MAIN_CHAT_HIDDEN_SCOPES.has(scope);
}

export function filterMainChatConversations(
  conversations: Conversation[],
): Conversation[] {
  return conversations.filter(isMainChatConversation);
}

export function normalizeConversationList(value: unknown): Conversation[] {
  return Array.isArray(value)
    ? filterMainChatConversations(value.filter(isConversationRecord))
    : [];
}
