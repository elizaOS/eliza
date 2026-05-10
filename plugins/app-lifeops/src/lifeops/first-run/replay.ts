/**
 * First-run replay semantics.
 *
 * Replay = re-run the first-run flow without destroying anything:
 *   - Existing `ScheduledTask` records are NOT touched. The runner sees the
 *     same `idempotencyKey` and upserts in place.
 *   - `OwnerFactStore` facts that the questions touch ARE updated. New
 *     answers append; previously-answered fields show their current value as
 *     the "default" for the user to confirm or change.
 *   - `partialAnswers` for the in-progress lifecycle is reset on entry —
 *     replay always starts a fresh answer slate (the user can still skip
 *     unchanged questions).
 *
 * Wipe = the destructive sibling (`LIFEOPS.wipe`). Wipe deletes every
 * lifeops-owned `ScheduledTask`, clears `OwnerFactStore`, and resets the
 * first-run state machine. Implemented in `actions/lifeops-pause.ts`.
 *
 * This module exposes the read-only helpers replay uses to surface current
 * facts as defaults.
 */

import type { CustomizeAnswers, RelationshipAnswerEntry } from "./questions.js";
import type { OwnerFactStore, OwnerFacts } from "./state.js";

export interface ReplayContext {
  currentFacts: OwnerFacts;
}

/**
 * Build the planner-visible "defaults to confirm" payload for the customize
 * path. The action serializes this into the prompt so the user sees their
 * current values as pre-filled options.
 */
export async function buildReplayContext(
  store: OwnerFactStore,
): Promise<ReplayContext> {
  const currentFacts = await store.read();
  return { currentFacts };
}

/**
 * Project the current facts into a partial `CustomizeAnswers` so the planner
 * can pre-fill the questionnaire. Missing values stay missing — the user has
 * to provide them this round.
 */
export function partialAnswersFromFacts(
  facts: OwnerFacts,
): Partial<CustomizeAnswers> {
  const partial: Partial<CustomizeAnswers> = {};
  if (facts.preferredName) partial.preferredName = facts.preferredName.value;
  if (facts.timezone) partial.timezone = facts.timezone.value;
  if (facts.morningWindow) {
    partial.morningWindow = {
      startLocal: facts.morningWindow.value.startLocal,
      endLocal: facts.morningWindow.value.endLocal,
    };
  }
  if (facts.eveningWindow) {
    partial.eveningWindow = {
      startLocal: facts.eveningWindow.value.startLocal,
      endLocal: facts.eveningWindow.value.endLocal,
    };
  }
  if (facts.preferredNotificationChannel) {
    partial.channel = facts.preferredNotificationChannel.value;
  }
  return partial;
}

/**
 * Replay never wipes existing relationship answers but it also has no way of
 * reading back into the question slate which relationships the user
 * previously named. Replay treats the relationships question as a fresh
 * round (the user lists them again or skips).
 */
export function relationshipsFallbackForReplay(): RelationshipAnswerEntry[] {
  return [];
}
