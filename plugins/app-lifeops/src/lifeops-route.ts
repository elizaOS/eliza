/**
 * URL-hash routing for LifeOps detail views and the cross-tab automation
 * selection.
 *
 * Design: we piggyback on `window.location.hash` because the app's top-level
 * tab router already owns the pathname (`/lifeops`, `/automations`, …). The
 * hash is free for deep-linking to sub-entities without touching the main
 * navigation state.
 *
 * Hash format: `#key=value&key=value` (query-string-in-fragment). Two
 * namespaces live here in practice:
 *
 *   - `lifeops.section`    → current LifeOps section id
 *   - `lifeops.event`      → calendar event id (implies section=calendar)
 *   - `lifeops.message`    → inbox message id  (implies section=messages)
 *   - `automations.trigger`→ trigger id selected on the /automations page
 *
 * The helpers here are pure: no DOM access. The hooks in
 * `hooks/useLifeOpsSection.ts` and the widget row handlers call into them.
 */

export type LifeOpsRouteSection =
  | "overview"
  | "sleep"
  | "screen-time"
  | "setup"
  | "reminders"
  | "calendar"
  | "messages"
  | "mail"
  | "money"
  | "documents";

export const LIFEOPS_ROUTE_SECTIONS: readonly LifeOpsRouteSection[] = [
  "overview",
  "sleep",
  "screen-time",
  "setup",
  "reminders",
  "calendar",
  "messages",
  "mail",
  "money",
  "documents",
] as const;

export interface LifeOpsRouteState {
  section: LifeOpsRouteSection | null;
  eventId: string | null;
  messageId: string | null;
}

export interface AutomationsRouteState {
  triggerId: string | null;
}

const LIFEOPS_SECTION_KEY = "lifeops.section";
const LIFEOPS_EVENT_KEY = "lifeops.event";
const LIFEOPS_MESSAGE_KEY = "lifeops.message";
const AUTOMATIONS_TRIGGER_KEY = "automations.trigger";

function isSection(value: string | null): value is LifeOpsRouteSection {
  return (
    value !== null &&
    (LIFEOPS_ROUTE_SECTIONS as readonly string[]).includes(value)
  );
}

/**
 * Parse `#key=value&…` into a plain map. Leading `#` is optional.
 * Tolerates empty / malformed input by returning an empty map.
 */
export function parseHashParams(hash: string): Record<string, string> {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const chunk of raw.split("&")) {
    if (!chunk) continue;
    const eq = chunk.indexOf("=");
    const key = eq >= 0 ? chunk.slice(0, eq) : chunk;
    const value = eq >= 0 ? chunk.slice(eq + 1) : "";
    if (!key) continue;
    try {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      // Skip malformed encodings silently.
    }
  }
  return result;
}

/**
 * Serialize a map back into a `#key=value&…` hash. Empty / null values are
 * stripped so toggling a key off removes it from the URL cleanly.
 */
export function serializeHashParams(
  params: Record<string, string | null | undefined>,
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return pairs.length > 0 ? `#${pairs.join("&")}` : "";
}

export function parseLifeOpsRoute(hash: string): LifeOpsRouteState {
  const params = parseHashParams(hash);
  const rawSection = params[LIFEOPS_SECTION_KEY] ?? null;
  const section = isSection(rawSection) ? rawSection : null;
  const eventId = params[LIFEOPS_EVENT_KEY] || null;
  const messageId = params[LIFEOPS_MESSAGE_KEY] || null;
  // Intentionally permissive: an `lifeops.event=<id>` without a matching
  // section implies `calendar`, and `lifeops.message=<id>` implies `messages`.
  // The hook derives that after parsing; the route itself just reports what
  // the hash literally said.
  return { section, eventId, messageId };
}

export function parseAutomationsRoute(hash: string): AutomationsRouteState {
  const params = parseHashParams(hash);
  const triggerId = params[AUTOMATIONS_TRIGGER_KEY] || null;
  return { triggerId };
}

/**
 * Merge an existing hash string with a LifeOps state update. Keeps unrelated
 * keys (so we don't wipe an `automations.trigger` when navigating inside
 * LifeOps, and vice versa).
 */
export function buildLifeOpsHash(
  existingHash: string,
  next: {
    section?: LifeOpsRouteSection | null;
    eventId?: string | null;
    messageId?: string | null;
  },
): string {
  const params = parseHashParams(existingHash);
  if (next.section !== undefined) {
    if (next.section === null) delete params[LIFEOPS_SECTION_KEY];
    else params[LIFEOPS_SECTION_KEY] = next.section;
  }
  if (next.eventId !== undefined) {
    if (next.eventId === null) delete params[LIFEOPS_EVENT_KEY];
    else params[LIFEOPS_EVENT_KEY] = next.eventId;
  }
  if (next.messageId !== undefined) {
    if (next.messageId === null) delete params[LIFEOPS_MESSAGE_KEY];
    else params[LIFEOPS_MESSAGE_KEY] = next.messageId;
  }
  return serializeHashParams(params);
}

export function buildAutomationsHash(
  existingHash: string,
  next: { triggerId?: string | null },
): string {
  const params = parseHashParams(existingHash);
  if (next.triggerId !== undefined) {
    if (next.triggerId === null) delete params[AUTOMATIONS_TRIGGER_KEY];
    else params[AUTOMATIONS_TRIGGER_KEY] = next.triggerId;
  }
  return serializeHashParams(params);
}

// ── Prime cache ──────────────────────────────────────────────────────────
//
// When a user clicks a row in the chat-sidebar widget, we already have the
// row payload in hand. The detail view that opens via URL hash does not
// share a React context with the widget (it lives inside LifeOpsPageView,
// the widget lives in the app's right rail), so we drop the row into a
// small module-level cache. The detail view pulls it for instant first
// paint and then still refetches the batch endpoint to stay live.
//
// Stored values are light (≤ a few KB), and the cache is pruned both by
// TTL (unused rows expire after 60 s) and by LRU cap. The cache is a
// best-effort hint — detail views MUST render correctly even if the cache
// miss (e.g. the user deep-linked).

const PRIME_TTL_MS = 60_000;
const PRIME_MAX_ENTRIES = 32;

interface PrimedRow<T> {
  value: T;
  storedAt: number;
}

function primeCache<T>(): {
  set: (id: string, value: T) => void;
  get: (id: string) => T | null;
} {
  const store = new Map<string, PrimedRow<T>>();
  function prune(): void {
    const now = Date.now();
    for (const [id, row] of store) {
      if (now - row.storedAt > PRIME_TTL_MS) store.delete(id);
    }
    while (store.size > PRIME_MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
  return {
    set(id, value) {
      if (!id) return;
      store.set(id, { value, storedAt: Date.now() });
      prune();
    },
    get(id) {
      if (!id) return null;
      const entry = store.get(id);
      if (!entry) return null;
      if (Date.now() - entry.storedAt > PRIME_TTL_MS) {
        store.delete(id);
        return null;
      }
      return entry.value;
    },
  };
}

const EVENT_CACHE = primeCache<unknown>();
const MESSAGE_CACHE = primeCache<unknown>();
const TRIGGER_CACHE = primeCache<unknown>();

export function primeLifeOpsEvent<T extends { id: string }>(event: T): void {
  EVENT_CACHE.set(event.id, event);
}
export function getPrimedLifeOpsEvent<T extends { id: string }>(
  id: string,
): T | null {
  return (EVENT_CACHE.get(id) as T | null) ?? null;
}

export function primeLifeOpsMessage<T extends { id: string }>(
  message: T,
): void {
  MESSAGE_CACHE.set(message.id, message);
}
export function getPrimedLifeOpsMessage<T extends { id: string }>(
  id: string,
): T | null {
  return (MESSAGE_CACHE.get(id) as T | null) ?? null;
}

export function primeAutomationsTrigger<T extends { id: string }>(
  trigger: T,
): void {
  TRIGGER_CACHE.set(trigger.id, trigger);
}
export function getPrimedAutomationsTrigger<T extends { id: string }>(
  id: string,
): T | null {
  return (TRIGGER_CACHE.get(id) as T | null) ?? null;
}
