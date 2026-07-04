/**
 * Chooses when blocked or failed coding-agent sessions should pull focus into
 * the Terminal channel without repeatedly stealing attention.
 */
import type { CodingAgentSession } from "../../api/client";

/**
 * Session states that should pull the user's attention into the Terminal
 * channel. "blocked" is routine ("Waiting for input" — set on every
 * blocked/escalation event) and a session can sit in it for a long time, so
 * attention-routing must fire once per transition, never continuously.
 */
export function isProblemSessionStatus(
  status: CodingAgentSession["status"],
): boolean {
  return status === "error" || status === "blocked";
}

/**
 * Decide which problem (error/blocked) session, if any, should be auto-focused
 * into the Terminal channel — at most ONCE per transition into a problem state.
 *
 * `handledSessionIds` is caller-owned bookkeeping (a ref in ChatView) that this
 * function mutates:
 * - A session picked for focus is marked handled, so a user-initiated dismissal
 *   (closing the panel or selecting a conversation, both of which clear
 *   `activeTerminalSessionId`) sticks instead of bouncing the user straight
 *   back to the terminal while the session still waits for input.
 * - A problem session the user is already viewing is marked handled for the
 *   same reason.
 * - Sessions that left the problem state (or left the list) are evicted, so a
 *   fresh error/blocked transition can auto-focus again.
 *
 * Returns the sessionId to focus, or null when nothing new needs attention.
 */
export function pickProblemSessionToAutoFocus(
  sessions: readonly CodingAgentSession[],
  activeTerminalSessionId: string | null,
  handledSessionIds: Set<string>,
): string | null {
  const problemIds = new Set<string>();
  for (const session of sessions) {
    if (isProblemSessionStatus(session.status)) {
      problemIds.add(session.sessionId);
    }
  }

  // Evict sessions that recovered/finished: their next problem transition is a
  // The next problem state is a fresh event and may auto-focus again.
  for (const id of handledSessionIds) {
    if (!problemIds.has(id)) {
      handledSessionIds.delete(id);
    }
  }

  if (activeTerminalSessionId) {
    // The terminal panel is already open. If it shows a problem session, count
    // it as seen so closing the panel does not immediately re-open it.
    if (problemIds.has(activeTerminalSessionId)) {
      handledSessionIds.add(activeTerminalSessionId);
    }
    return null;
  }

  for (const session of sessions) {
    if (
      isProblemSessionStatus(session.status) &&
      !handledSessionIds.has(session.sessionId)
    ) {
      handledSessionIds.add(session.sessionId);
      return session.sessionId;
    }
  }
  return null;
}
