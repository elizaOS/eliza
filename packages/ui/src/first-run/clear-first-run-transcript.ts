/**
 * Purge the synthetic onboarding transcript when first-run completes.
 *
 * Onboarding is PART OF THE CHAT (see `use-first-run-conductor.ts`): the
 * conductor seeds synthetic assistant turns — the sign-in greeting, the
 * welcome-back turn, per-step status turns, the cloud-done wrap-up, typed
 * onboarding user/reply turns — DIRECTLY into the live `conversationMessages`
 * store the `ContinuousChatOverlay` renders. While onboarding is active
 * (`firstRunOpen`) the overlay filters the transcript down to the current
 * first-run turn via `selectFirstRunDisplayMessages`, so only one card shows.
 *
 * On completion (`firstRunComplete` flips true / `firstRunOpen` falls to false)
 * that first-run filter is DROPPED and the overlay renders the raw transcript.
 * Nothing cleared the seeded turns, so every leftover `first-run:*` bubble —
 * greeting + welcome-back + cloud-done, plus any typed reply turns — suddenly
 * paints as ordinary chat history. The user, who sent exactly one message, sees
 * multiple stacked "greeting"-looking assistant bubbles and duplicated user
 * turns until the first real send's post-turn history reload full-replaces the
 * store with server truth (#15354).
 *
 * The fix is to drop the synthetic first-run turns the instant onboarding
 * completes, so the real chat opens on a clean thread and the first message is
 * the first thing in it. This is a pure, id/source-scoped filter: it only ever
 * removes turns the conductor itself seeded (`source === "first_run"` or an id
 * under the `first-run:` namespace) and never touches a real server or
 * optimistic (`temp-*`) turn.
 */

import type { ConversationMessage } from "../api";

const FIRST_RUN_TURN_ID_PREFIX = "first-run:";
const FIRST_RUN_TURN_SOURCE = "first_run";

/**
 * Whether a transcript turn is a synthetic onboarding turn seeded by the
 * first-run conductor. Matches by BOTH the `first_run` source marker and the
 * `first-run:` id namespace so a turn that carries either signal is caught (the
 * conductor always sets both via `makeTurn`, but matching either is the robust
 * superset).
 */
export function isFirstRunTranscriptMessage(
  message: ConversationMessage,
): boolean {
  return (
    message.source === FIRST_RUN_TURN_SOURCE ||
    message.id.startsWith(FIRST_RUN_TURN_ID_PREFIX)
  );
}

/**
 * Drop every synthetic first-run turn from a transcript, preserving the order
 * and identity of all real turns. Returns the SAME array reference when there
 * is nothing to remove, so it is safe to run inside a state setter without
 * forcing a spurious re-render (and a no-op when onboarding seeded nothing —
 * the silent-reuse entry, #15133).
 */
export function clearFirstRunTranscriptMessages(
  messages: ConversationMessage[],
): ConversationMessage[] {
  if (!messages.some(isFirstRunTranscriptMessage)) return messages;
  return messages.filter((message) => !isFirstRunTranscriptMessage(message));
}
