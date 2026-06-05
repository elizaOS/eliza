import * as React from "react";

import { client } from "../../api/client";
import type { ShellMessage } from "./shell-state";

/**
 * Prompt suggestions for the continuous-chat overlay's resting composer strip.
 *
 * Returns EXACTLY 3 short prompts. The strip is backed by the small text model
 * (`POST /api/suggestions`, TEXT_SMALL) so the offered moves are tailored to the
 * character and the conversation so far. A deterministic, network-free set is
 * computed synchronously as the cold-start / offline fallback, so the strip is
 * never empty and never flashes while the model set is in flight.
 */

const SUGGESTION_COUNT = 3;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_CHARS = 240;
const FETCH_TIMEOUT_MS = 6_000;

// Cold-start starters — the stable pool the fallback always draws from.
const STARTERS: readonly string[] = [
  "What can you do?",
  "Summarize my day",
  "Draft a reply",
  "What's on my plate?",
  "Explain this for me",
];

// Shown in slot 0 once there's an active thread, so the fallback nudges forward
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
 * Pure computation (no React/network) so it can be unit-tested directly. Always
 * returns exactly 3 unique prompt strings, order-stable. Used as the offline
 * fallback and as the immediate value before the model set resolves.
 */
export function computePromptSuggestions(
  messages: readonly ShellMessage[],
  hour?: number,
): string[] {
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  const lead = hasThread ? THREAD_FOLLOW_UP : timeOfDayLead(hour);
  // Lead first, then the stable pool; dedupe (order-preserving) and take 3.
  return Array.from(new Set([lead, ...STARTERS])).slice(0, SUGGESTION_COUNT);
}

function normalizeModelSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= SUGGESTION_COUNT) break;
  }
  return out;
}

async function fetchModelSuggestions(
  messages: readonly ShellMessage[],
  hour: number,
  signal: AbortSignal,
): Promise<string[]> {
  const recent = messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content.slice(0, MAX_CONTEXT_CHARS),
    }));
  const data = await client.fetch<{ suggestions?: unknown }>(
    "/api/suggestions",
    {
      method: "POST",
      body: JSON.stringify({ messages: recent, hour }),
      signal,
    },
    { allowNonOk: true, timeoutMs: FETCH_TIMEOUT_MS },
  );
  return normalizeModelSuggestions(data?.suggestions);
}

/**
 * Hook: returns exactly 3 suggestions. Yields the static fallback immediately,
 * then upgrades to the model-generated set once `POST /api/suggestions`
 * resolves. The fetch runs only while `enabled` (the strip is actually
 * visible), so the small model isn't invoked for a hidden strip; it refreshes
 * when the thread gains its first line, after each new turn, or across the
 * time-of-day boundary.
 */
export function usePromptSuggestions(
  messages: readonly ShellMessage[],
  options?: { enabled?: boolean },
): string[] {
  const enabled = options?.enabled ?? false;
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  // Bucket the clock to the hour so the strip is stable within an hour.
  const hour = new Date().getHours();
  const lastId =
    messages.filter((m) => m.content.trim().length > 0).at(-1)?.id ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: hasThread + hour are the only inputs that change the fallback; depending on the messages array identity would needlessly churn it on every unrelated re-render.
  const fallback = React.useMemo(
    () => computePromptSuggestions(messages, hour),
    [hasThread, hour],
  );

  const [model, setModel] = React.useState<string[] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is read inside, but the fetch is intentionally keyed on enabled/hasThread/hour/lastId (the dimensions worth a refresh); keying on the array identity would refetch on every render.
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    void fetchModelSuggestions(messages, hour, controller.signal)
      .then((next) => {
        if (!cancelled && next.length >= SUGGESTION_COUNT) setModel(next);
      })
      .catch(() => {
        // Keep the static fallback on any failure (offline, timeout, no API).
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, hasThread, hour, lastId]);

  const source = model && model.length >= SUGGESTION_COUNT ? model : fallback;
  return source.slice(0, SUGGESTION_COUNT);
}
