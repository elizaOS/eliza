import * as React from "react";

import type { ShellMessage } from "./shell-state";

/**
 * Pure, network-free prompt suggestions for the continuous-chat overlay.
 *
 * Returns EXACTLY 5 short prompts to offer on the resting (collapsed, empty
 * composer) overlay — like a phone keyboard's word strip, but for whole
 * prompts. Phase 1 is deliberately client-only and deterministic: a fixed
 * starter set, lightly adapted to whether a conversation is already underway
 * (slot 0 becomes a "pick up where we left off" follow-up). A later increment
 * can swap the body for a tailored `GET /api/suggestions` call (history +
 * memory + active-view aware) without changing this hook's signature or the
 * overlay that consumes it.
 */

// Cold-start starters — the first things a new user sees on the empty overlay.
const STARTERS: readonly string[] = [
  "What can you do?",
  "Summarize my day",
  "Draft a reply",
  "What's on my plate?",
  "Explain this for me",
];

// Shown in slot 0 once there's an active thread, so the strip nudges forward
// instead of restarting from scratch.
const THREAD_FOLLOW_UP = "Continue where we left off";

/**
 * Pure computation (no React) so it can be unit-tested directly. Always returns
 * exactly 5 unique prompt strings, order-stable.
 */
export function computePromptSuggestions(
  messages: readonly ShellMessage[],
): string[] {
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  const ordered = hasThread ? [THREAD_FOLLOW_UP, ...STARTERS] : [...STARTERS];
  // Dedupe (order-preserving), then take exactly 5 (STARTERS guarantees >= 5).
  return Array.from(new Set(ordered)).slice(0, 5);
}

/** Hook wrapper: memoised on whether a thread is active. */
export function usePromptSuggestions(
  messages: readonly ShellMessage[],
): string[] {
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasThread is the only input that changes the result; recomputing on it (not the messages array identity) keeps the 5 stable across unrelated re-renders.
  return React.useMemo(() => computePromptSuggestions(messages), [hasThread]);
}
