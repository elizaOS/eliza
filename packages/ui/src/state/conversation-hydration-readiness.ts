/** Exposes whether the active conversation history has been applied without revealing its identity. */

const HISTORY_APPLIED_ATTRIBUTE = "data-conversation-history-applied";

export function markConversationHistoryApplied(applied: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(
    HISTORY_APPLIED_ATTRIBUTE,
    applied ? "true" : "false",
  );
}
