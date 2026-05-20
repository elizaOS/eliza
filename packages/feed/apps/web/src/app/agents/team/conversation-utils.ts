/**
 * Minimal conversation shape used for sidebar display logic.
 */
export interface ConversationDisplayInfo {
  name: string | null;
  createdAt: string;
}

/**
 * Returns the sidebar label for a conversation.
 * Uses an explicit title when present, otherwise a localized timestamp fallback.
 */
export function getConversationDisplayName(
  conversation: ConversationDisplayInfo,
  locale?: string
): string {
  if (conversation.name) return conversation.name;

  const date = new Date(conversation.createdAt);
  if (Number.isNaN(date.getTime())) {
    return 'New Chat';
  }

  const effectiveLocale =
    locale ??
    (typeof navigator !== 'undefined' ? navigator.language : undefined);
  const dateStr = date.toLocaleDateString(effectiveLocale, {
    month: 'short',
    day: 'numeric',
  });
  const timeStr = date.toLocaleTimeString(effectiveLocale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `New Chat - ${dateStr}, ${timeStr}`;
}

/**
 * Deletion is only allowed when more than one conversation exists.
 */
export function canDeleteConversation(totalConversations: number): boolean {
  return totalConversations > 1;
}
