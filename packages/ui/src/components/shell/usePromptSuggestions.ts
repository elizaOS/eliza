import * as React from "react";

import { client } from "../../api/client";
import {
  PAGE_SCOPES,
  type PageScope,
} from "../pages/page-scoped-conversations";
import type { ShellMessage } from "./shell-state";

/**
 * Prompt suggestions for the continuous-chat overlay's resting composer strip.
 *
 * Returns EXACTLY 3 short prompts. The strip is backed by the small text model
 * (`POST /api/suggestions`, TEXT_SMALL) so the offered moves are tailored to the
 * character, the conversation so far, and the active page scope (#8225 — the
 * server tailors per view and pads from a deterministic heuristic tier, so its
 * response is never empty). A deterministic, network-free set is computed
 * synchronously as the cold-start / offline fallback, so the strip is never
 * empty and never flashes while the model set is in flight.
 */

const SUGGESTION_COUNT = 3;
const MAX_CONTEXT_MESSAGES = 6;
const MAX_CONTEXT_CHARS = 240;
const FETCH_TIMEOUT_MS = 6_000;

// Resolved model sets, remembered across strip reveals and keyed by the same
// context dimensions the fetch refreshes on. The overlay component stays
// mounted on close (only the strip's reveal state flips), but the hook's React
// state alone cannot give reveal-to-reveal stability: without this memory each
// cold context would re-roll the model and show different suggestions for an
// unchanged conversation. Bounded LRU, mirrored to sessionStorage so dev HMR
// (which re-executes this module) and same-tab reloads keep the sets stable.
const MODEL_SET_CACHE_MAX = 32;
const MODEL_SET_STORAGE_KEY = "eliza:chat-suggestions:model-sets:v1";

function readPersistedModelSets(): [string, string[]][] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(MODEL_SET_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every((item: unknown) => typeof item === "string"),
    );
  } catch {
    return [];
  }
}

function persistModelSets(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      MODEL_SET_STORAGE_KEY,
      JSON.stringify([...modelSetCache]),
    );
  } catch {
    // Storage blocked/full — memory-only is fine.
  }
}

const modelSetCache = new Map<string, string[]>(readPersistedModelSets());

// One request per context key at a time. The promise lives at module level so
// closing the strip mid-fetch does NOT abort it — the response still lands in
// the cache and the next reveal reads the same set instead of re-rolling.
const inFlightModelSets = new Map<string, Promise<string[] | null>>();

function rememberModelSet(key: string, value: string[]): void {
  modelSetCache.delete(key);
  modelSetCache.set(key, value);
  if (modelSetCache.size > MODEL_SET_CACHE_MAX) {
    const oldest = modelSetCache.keys().next().value;
    if (oldest !== undefined) modelSetCache.delete(oldest);
  }
  persistModelSets();
}

/** Test-only: forget remembered/in-flight model sets so cases stay independent. */
export function resetPromptSuggestionMemory(): void {
  modelSetCache.clear();
  inFlightModelSets.clear();
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(MODEL_SET_STORAGE_KEY);
    } catch {
      // Ignore storage failures in teardown.
    }
  }
}

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
 * Cache-key time bucket. Matches {@link timeOfDayLead}'s boundaries: the
 * time-of-day dimension only exists to keep suggestions in step with the
 * greeting, so the remembered set refreshes at the 3 daypart boundaries —
 * not 24 times a day on every raw hour rollover.
 */
export function daypartForHour(
  hour: number,
): "morning" | "afternoon" | "evening" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
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

/**
 * Derive the active {@link PageScope} from the current location so the server
 * can tailor suggestions per view. The shell navigates by path or hash
 * (`/lifeops`, `#/lifeops?...`), so the first segment of whichever is present
 * is the tab id; `page-<tab>` counts only when it's a registered scope. Pure
 * for unit tests; returns undefined off-DOM or on unscoped views.
 */
export function pageScopeFromLocation(
  pathname: string,
  hash: string,
): PageScope | undefined {
  const fromHash = hash.replace(/^#\/?/, "").split(/[/?#]/)[0] ?? "";
  const fromPath = pathname.replace(/^\//, "").split(/[/?#]/)[0] ?? "";
  const segment = (fromHash || fromPath).trim().toLowerCase();
  if (!segment) return undefined;
  const candidate = `page-${segment}`;
  return (PAGE_SCOPES as readonly string[]).includes(candidate)
    ? (candidate as PageScope)
    : undefined;
}

function currentPageScope(): PageScope | undefined {
  if (typeof window === "undefined") return undefined;
  return pageScopeFromLocation(
    window.location.pathname ?? "",
    window.location.hash ?? "",
  );
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
  scope: PageScope | undefined,
): Promise<{ set: string[]; tier: string | undefined }> {
  const recent = messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content.slice(0, MAX_CONTEXT_CHARS),
    }));
  const data = await client.fetch<{ suggestions?: unknown; tier?: unknown }>(
    "/api/suggestions",
    {
      method: "POST",
      body: JSON.stringify({
        messages: recent,
        hour,
        ...(scope ? { scope } : {}),
      }),
    },
    { allowNonOk: true, timeoutMs: FETCH_TIMEOUT_MS },
  );
  return {
    set: normalizeModelSuggestions(data?.suggestions),
    tier: typeof data?.tier === "string" ? data.tier : undefined,
  };
}

/**
 * Resolve the model set for a context key: cache hit, then in-flight dedupe,
 * then a fresh request. The request is deliberately NOT tied to the strip's
 * lifecycle — the server has already started the model call, so the result is
 * banked even when the user closes the strip before it lands (the next reveal
 * then reads the identical set instead of re-rolling). The 6s client timeout
 * bounds the request's lifetime. Heuristic-tier responses (the server's
 * deterministic filler while the model is cold or failing) are NOT cached or
 * surfaced: the client fallback is equally deterministic, and skipping them
 * lets a later reveal retry for the real model set instead of pinning generic
 * suggestions for the whole bucket.
 */
function requestModelSet(
  messages: readonly ShellMessage[],
  hour: number,
  scope: PageScope | undefined,
  key: string,
): Promise<string[] | null> {
  const cached = modelSetCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inFlightModelSets.get(key);
  if (pending) return pending;
  const request = fetchModelSuggestions(messages, hour, scope)
    .then(({ set, tier }) => {
      if (tier === "heuristic" || set.length < SUGGESTION_COUNT) return null;
      rememberModelSet(key, set);
      return set;
    })
    .catch(() => null)
    .finally(() => {
      inFlightModelSets.delete(key);
    });
  inFlightModelSets.set(key, request);
  return request;
}

/**
 * Hook: returns exactly 3 suggestions. Yields the static fallback immediately,
 * then upgrades to the model-generated set once `POST /api/suggestions`
 * resolves. The fetch starts only while `enabled` (the strip is actually
 * visible), so the small model isn't invoked for a hidden strip. The set is
 * stable for a given context — reopening the overlay reuses the remembered
 * model set; only a new turn, a view change, the thread's first line, or a
 * daypart boundary (morning/afternoon/evening) produces a fresh one.
 */
export function usePromptSuggestions(
  messages: readonly ShellMessage[],
  options?: { enabled?: boolean; scope?: PageScope },
): string[] {
  const enabled = options?.enabled ?? false;
  const hasThread = messages.some((m) => m.content.trim().length > 0);
  // Bucket the clock to the hour so the strip is stable within an hour.
  const hour = new Date().getHours();
  const lastId =
    messages.filter((m) => m.content.trim().length > 0).at(-1)?.id ?? null;
  // Active view scope: explicit override wins; otherwise derived from the
  // location at fetch time (the overlay floats over every view, so the URL is
  // the source of truth for "where the user is").
  const scope = options?.scope ?? currentPageScope();

  // biome-ignore lint/correctness/useExhaustiveDependencies: hasThread + hour are the only inputs that change the fallback; depending on the messages array identity would needlessly churn it on every unrelated re-render.
  const fallback = React.useMemo(
    () => computePromptSuggestions(messages, hour),
    [hasThread, hour],
  );

  const contextKey = `${scope ?? ""}|${lastId ?? ""}|${daypartForHour(hour)}|${hasThread ? 1 : 0}`;
  const remembered = modelSetCache.get(contextKey);

  // Tagged with the key it was fetched for: the overlay stays mounted across
  // reveals, so untagged state would bleed the previous context's set into a
  // cold key (stale suggestions shown, then a visible mid-reveal swap).
  const [model, setModel] = React.useState<{
    key: string;
    set: string[];
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is read inside, but the fetch is intentionally keyed on enabled + contextKey (scope/lastId/daypart/hasThread — the dimensions worth a refresh); keying on the array identity would refetch on every render.
  React.useEffect(() => {
    if (!enabled || modelSetCache.has(contextKey)) return;
    let disposed = false;
    void requestModelSet(messages, hour, scope, contextKey).then((set) => {
      if (!disposed && set) setModel({ key: contextKey, set });
    });
    return () => {
      // Only stop the state update — the request itself keeps going so its
      // result is cached for the next reveal (see requestModelSet).
      disposed = true;
    };
  }, [enabled, contextKey]);

  // Remembered set first (stable across reveals for an unchanged context),
  // then the freshly-fetched one (current key only), then the static fallback.
  const modelSet = model && model.key === contextKey ? model.set : null;
  const source = remembered ?? modelSet ?? fallback;
  return source.slice(0, SUGGESTION_COUNT);
}
