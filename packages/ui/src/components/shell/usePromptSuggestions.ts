import * as React from "react";

import type { ShellMessage } from "./shell-state";

/**
 * Pure, network-free prompt suggestions for the continuous-chat overlay.
 *
 * Returns EXACTLY 5 short prompts to offer on the resting (collapsed, empty
 * composer) overlay — like a phone keyboard's word strip, but for whole
 * prompts. Client-only and deterministic, lightly tailored to context:
 *  - HISTORY: once a conversation is underway, slot 0 becomes a "pick up where
 *    we left off" follow-up so the strip nudges forward, not from scratch.
 *  - TIME OF DAY: with no thread yet, slot 0 matches the overlay's own
 *    morning/afternoon/evening greeting ("Plan my day" / "What's left today?" /
 *    "Recap my day"), so the first move feels of-the-moment.
 *
 * A later increment can back this with a tailored `GET /api/suggestions` call
 * (memory + active-view aware) without changing this hook's signature or the
 * overlay that consumes it — the static set here stays as the offline fallback.
 */

// Cold-start starters — the stable pool the strip always draws from.
const STARTERS: readonly string[] = [
  "What can you do?",
  "Summarize my day",
  "Draft a reply",
  "What's on my plate?",
  "Explain this for me",
];

// Shown in slot 0 once there's an active thread, so the strip nudges forward
// instead of restarting from scratch (history-aware).
const THREAD_FOLLOW_UP = "Continue where we left off";

/**
 * The time-of-day lead prompt for an empty overlay, matching the greeting the
 * overlay shows. `hour` is a local 0–23 hour; when omitted, falls back to the
 * neutral first starter (e.g. server render / unknown clock).
 */
function timeOfDayLead(hour: number | undefined): string {
  if (hour === undefined) return STARTERS[0];
  if (hour >= 5 && hour < 12) return "Plan my day";
  if (hour >= 12 && hour < 18) return "What's left today?";
  return "Recap my day";
}

/**
 * Pure computation (no React) so it can be unit-tested directly. Always returns
 * exactly 5 unique prompt strings, order-stable. `hour` (local 0–23) tailors the
 * cold-start lead; an active thread takes precedence with a continue follow-up.
 */
export function computePromptSuggestions(
  messages: readonly ShellMessage[],
  hour?: number,
): string[] {
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  const lead = hasThread ? THREAD_FOLLOW_UP : timeOfDayLead(hour);
  // Lead first, then the stable pool; dedupe (order-preserving) and take 5.
  // STARTERS alone is >= 5, so a deduped lead never drops the count below 5.
  return Array.from(new Set([lead, ...STARTERS])).slice(0, 5);
}

/** Hook wrapper: memoised on the inputs that change the result. */
export function usePromptSuggestions(
  messages: readonly ShellMessage[],
): string[] {
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  // Bucket the clock to the hour so the strip is stable within an hour and only
  // recomputes when the time-of-day lead would actually change.
  const hour = new Date().getHours();
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasThread + hour are the only inputs that change the result; depending on the messages array identity would needlessly churn the 5 on every unrelated re-render.
  return React.useMemo(
    () => computePromptSuggestions(messages, hour),
    [hasThread, hour],
  );
}
