/**
 * Cross-path delivery idempotency guard (Bug A: duplicate message delivery).
 *
 * A single logical assistant reply can fan out through more than one delivery
 * sink — e.g. the `client_chat` send handler (client-chat-sender.deliver) AND
 * the autonomy/coordinator relay (routeAutonomyTextToUser). Each sink
 * independently `createMemory()`s the message and broadcasts a
 * `proactive-message` WS event, so the same text lands in the DB twice (often
 * under two different `source` values) and renders twice in the chat UI. This
 * was visible in production traces.
 *
 * This module provides a small, bounded, time-windowed dedupe keyed on
 * (roomId + normalized text). The FIRST delivery of a given key within the
 * window wins; a second delivery of the same key inside the window is
 * suppressed (the caller skips its createMemory + broadcast). The window is
 * short (a few seconds) so a user legitimately repeating the same short message
 * later is never suppressed.
 *
 * Intentionally NOT a persistence-layer unique constraint: the two sinks mint
 * their own random memory ids, so a PK constraint can't catch them, and we want
 * to suppress the *delivery* (WS broadcast) too, not just the second insert.
 */

/** Default suppression window. A reply re-delivered within this many ms of the
 * first delivery to the same room with the same normalized text is a dupe.
 *
 * Kept short on purpose. The cross-path fan-out this guards (the SAME logical
 * reply reaching both the client_chat send handler AND the autonomy relay)
 * happens within milliseconds, so a tight window reliably catches it while
 * minimizing the chance of collapsing two GENUINELY independent same-text
 * sends to the same room (e.g. two split swarm results both saying "Done").
 * Attachments already discriminate distinct media sends (see
 * {@link deliveryIdentityFromContent}); this window bounds the text-only case. */
const DEFAULT_DEDUPE_WINDOW_MS = 2000;

/** Cap the live key set so a long-running server can't grow this unbounded. */
const MAX_TRACKED_KEYS = 512;

export interface DeliveryDedupeState {
  /** key -> last-delivered epoch ms */
  recentDeliveries: Map<string, number>;
}

export function createDeliveryDedupeState(): DeliveryDedupeState {
  return { recentDeliveries: new Map<string, number>() };
}

/** Normalize text for comparison: collapse whitespace, trim, lowercase. Empty
 * text is never deduped (returns "" → callers treat empty as non-dedupable). */
function normalizeForDedupe(text: string | undefined): string {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeKey(
  roomId: string,
  normalizedText: string,
  identity: string,
): string {
  // `identity` distinguishes sends that share `text` but differ in payload
  // (e.g. different attachments/metadata) so two genuinely distinct messages
  // are not collapsed. Empty identity = text-only key (the common reply case).
  return `${roomId}\u0000${identity}\u0000${normalizedText}`;
}

/** Build a stable identity discriminator from delivery payload extras.
 *
 * Keys ONLY on ATTACHMENTS — deliberately NOT on `action`/`actions`. The whole
 * point of the guard is to dedupe the SAME logical reply arriving via two
 * sinks: the `client_chat` send handler (which carries normal reply content,
 * often `actions: ["REPLY"]`) and `routeAutonomyTextToUser` (which delivers
 * bare `{ text }` with no action). Including the action would put the same
 * room/text under two different keys (`x:REPLY` vs none) and the cross-path
 * duplicate would slip through. Attachments, by contrast, genuinely make two
 * sends DISTINCT (e.g. two "Done" messages carrying different images), so two
 * deliveries with the same text but different attachments are NOT collapsed.
 * A plain-text reply yields identity "" on BOTH paths, so they match + dedupe. */
export function deliveryIdentityFromContent(
  content: Record<string, unknown> | undefined,
): string {
  if (!content) return "";
  const att = content.attachments;
  if (!Array.isArray(att) || att.length === 0) return "";
  // Key on attachment URLs/ids/titles when present; fall back to a marker.
  const sig = att
    .map((a) => {
      if (a && typeof a === "object") {
        const r = a as Record<string, unknown>;
        return (
          (typeof r.url === "string" && r.url) ||
          (typeof r.id === "string" && r.id) ||
          (typeof r.title === "string" && r.title) ||
          "att"
        );
      }
      return String(a);
    })
    .join(",");
  return `a:${sig}`;
}

function pruneExpired(
  state: DeliveryDedupeState,
  now: number,
  windowMs: number,
): void {
  // Drop expired entries; if still over the cap, drop oldest first. A negative
  // value is an in-flight reservation sentinel (negated timestamp) — compare on
  // its magnitude so a long-running in-flight delivery still ages out.
  for (const [key, ts] of state.recentDeliveries) {
    if (now - Math.abs(ts) > windowMs) state.recentDeliveries.delete(key);
  }
  if (state.recentDeliveries.size <= MAX_TRACKED_KEYS) return;
  const overflow = state.recentDeliveries.size - MAX_TRACKED_KEYS;
  let removed = 0;
  // Map iteration is insertion-ordered, so the first keys are the oldest.
  for (const key of state.recentDeliveries.keys()) {
    if (removed >= overflow) break;
    state.recentDeliveries.delete(key);
    removed += 1;
  }
}

/**
 * Handle returned by {@link beginDelivery} for the FIRST (winning) delivery of a
 * (roomId + text) key. The caller MUST call exactly one of:
 *   - `commit()`  after the delivery (createMemory + broadcast) SUCCEEDS, or
 *   - `release()` if the delivery FAILS,
 * so a failed delivery does not leave a phantom reservation that suppresses a
 * legitimate fallback/retry of the same reply (codex P2).
 */
export interface DeliveryReservation {
  /** Persist the delivery timestamp so later cross-path copies are deduped. */
  commit(): void;
  /** Undo the reservation so a retry of this same reply is NOT suppressed. */
  release(): void;
}

export type BeginDeliveryResult =
  | { kind: "duplicate" }
  | { kind: "deliver"; reservation: DeliveryReservation };

/**
 * Begin a delivery of `text` to `roomId`. Returns:
 *   - `{ kind: "duplicate" }` when an identical (roomId + text) was committed
 *     within the window — the caller should SKIP delivery; or
 *   - `{ kind: "deliver", reservation }` when this is the first/fresh delivery.
 *     The caller delivers, then calls `reservation.commit()` on success or
 *     `reservation.release()` on failure.
 *
 * The reservation is held but NOT yet windowed: it only blocks an OVERLAPPING
 * in-flight duplicate. It becomes a real window anchor on `commit()`. This
 * ordering means a delivery that throws never suppresses a subsequent retry.
 *
 * Empty/whitespace-only text is never deduped (always `deliver` with a no-op
 * reservation), and when there is no state/roomId the guard is a transparent
 * pass-through. Pass `options.identity` (see {@link deliveryIdentityFromContent})
 * to distinguish sends that share text but differ in payload (attachments/
 * action) so distinct messages are not collapsed. NOTE: this guard is intended
 * ONLY for the small set of known fan-out sinks (client_chat send handler +
 * autonomy relay) where the same logical reply is re-delivered; do not wire it
 * into paths that emit genuinely independent same-text+same-payload messages
 * within the window.
 */
export function beginDelivery(
  state: DeliveryDedupeState | undefined,
  roomId: string | undefined,
  text: string | undefined,
  options?: { windowMs?: number; now?: number; identity?: string },
): BeginDeliveryResult {
  const noop: DeliveryReservation = {
    commit() {},
    release() {},
  };
  if (!state || !roomId) return { kind: "deliver", reservation: noop };
  const normalized = normalizeForDedupe(text);
  if (!normalized) return { kind: "deliver", reservation: noop };

  const windowMs = options?.windowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = options?.now ?? Date.now();
  const identity =
    typeof options?.identity === "string" ? options.identity : "";
  const key = dedupeKey(roomId, normalized, identity);

  const last = state.recentDeliveries.get(key);
  // A committed (or in-flight) delivery within the window → duplicate. A
  // negative sentinel marks an in-flight reservation (see below); both block.
  if (last !== undefined && Math.abs(now - Math.abs(last)) <= windowMs) {
    return { kind: "duplicate" };
  }

  // Reserve in-flight with a sentinel (store the negated timestamp) so a truly
  // concurrent duplicate is blocked, but a FAILED delivery (release) clears it
  // and a later retry is allowed. commit() rewrites it to the positive anchor.
  state.recentDeliveries.set(key, -now);
  pruneExpired(state, now, windowMs);

  let settled = false;
  return {
    kind: "deliver",
    reservation: {
      commit() {
        if (settled) return;
        settled = true;
        // Anchor on the original delivery time (positive) so a burst of copies
        // collapses to the first and the window can't be held open forever.
        state.recentDeliveries.set(key, now);
      },
      release() {
        if (settled) return;
        settled = true;
        // Only clear if WE still own the in-flight sentinel; never stomp a
        // newer reservation/commit for the same key.
        if (state.recentDeliveries.get(key) === -now) {
          state.recentDeliveries.delete(key);
        }
      },
    },
  };
}
