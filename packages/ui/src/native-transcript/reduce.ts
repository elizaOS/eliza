/**
 * Pure fold from the append-only `eliza.native-transcript/v1` event log to the
 * ordered render model. This reducer IS the contract's behavioral spec — the
 * golden fixture asserts every shell (web here; iOS/Android native next) folds
 * to the exact same {@link TranscriptViewModel}.
 *
 * The four cross-bridge guarantees, all decided from structural fields only:
 *   - Dedupe: `seq` is unique per stream, so a repeated `seq` is a no-op.
 *   - Ordering: an item renders at its first-seen `seq`; later updates to it
 *     never move it. Render order is therefore stable under reordering.
 *   - Late events: an item tracks the highest `seq` applied to it (`revSeq`); an
 *     event with `seq <= revSeq` cannot regress it (a late partial after a final
 *     is dropped). Creation from any event is by first-seen id.
 *   - Cancellation boundary: a `cancel` marks matching in-flight items cancelled
 *     and bumps their `revSeq` to the cancel `seq`, so a pre-boundary straggler
 *     is dropped while a genuinely newer (post-boundary) event still applies.
 *
 * Nothing here inspects transcript text or its length.
 */

import type {
  ConnectionState,
  SpeakingState,
  TranscriptEvent,
  TranscriptItem,
  TranscriptViewModel,
} from "./contract";

interface ItemEntry {
  item: TranscriptItem;
  /** `seq` of the event that created this item; the stable render order. */
  order: number;
  /** Highest `seq` applied to this item; guards against late regressions. */
  revSeq: number;
}

/**
 * Internal accumulator. Kept separate from {@link TranscriptViewModel} so the
 * render model stays free of bookkeeping (dedupe set, per-item order/revSeq) and
 * native reducers can mirror the same split.
 */
export interface TranscriptReducerState {
  entries: Map<string, ItemEntry>;
  appliedSeqs: Set<number>;
  speaking: SpeakingState | null;
  connection: ConnectionState;
  lastSeq: number;
}

export function initialReducerState(): TranscriptReducerState {
  return {
    entries: new Map(),
    appliedSeqs: new Set(),
    speaking: null,
    connection: "live",
    lastSeq: 0,
  };
}

/** Whether an item is still in-flight and therefore cancellable. */
function isInFlight(item: TranscriptItem): boolean {
  return (
    (item.kind === "user" && item.status === "partial") ||
    (item.kind === "agent" && item.status === "streaming") ||
    (item.kind === "tool" && item.status === "running")
  );
}

/** Apply the cancelled status to an in-flight item (terminal for that row). */
function cancelItem(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case "user":
      return { ...item, status: "cancelled" };
    case "agent":
      return { ...item, status: "cancelled" };
    case "tool":
      return { ...item, status: "cancelled" };
    default:
      return item;
  }
}

/** Does this in-flight item belong to `turnId` (for turn-scoped cancel)? */
function belongsToTurn(item: TranscriptItem, turnId: string): boolean {
  if (item.kind === "user") return item.id === turnId;
  if (item.kind === "agent" || item.kind === "tool")
    return item.turnId === turnId;
  return false;
}

/**
 * Fold one already-decoded event into the state. Callers pass only validated
 * events (see `decode.ts`); this function trusts the shapes and decides purely
 * on structural fields.
 */
export function applyTranscriptEvent(
  state: TranscriptReducerState,
  event: TranscriptEvent,
): TranscriptReducerState {
  // Dedupe: a `seq` we have already consumed is a no-op, regardless of type.
  if (state.appliedSeqs.has(event.seq)) return state;

  const entries = new Map(state.entries);
  const appliedSeqs = new Set(state.appliedSeqs);
  appliedSeqs.add(event.seq);
  let { speaking, connection } = state;
  const lastSeq = Math.max(state.lastSeq, event.seq);

  /**
   * Create-or-update the item at `id`. `build(prev)` returns the next item given
   * the previous one (or undefined on first sight). An update to an existing
   * item is dropped when the event is not newer than the last applied (`revSeq`)
   * — this is the late-event guard.
   */
  const upsert = (
    id: string,
    build: (prev: TranscriptItem | undefined) => TranscriptItem,
  ): void => {
    const existing = entries.get(id);
    if (existing && event.seq <= existing.revSeq) return; // late/stale
    entries.set(id, {
      item: build(existing?.item),
      order: existing?.order ?? event.seq,
      revSeq: event.seq,
    });
  };

  switch (event.type) {
    case "stt.partial": {
      // A final/cancelled turn is terminal: a stray later partial is ignored
      // outright (not even its text is applied), so a committed utterance never
      // reverts to an interim hypothesis.
      const prev = entries.get(event.turnId);
      if (prev && prev.item.kind === "user" && prev.item.status !== "partial") {
        break;
      }
      upsert(event.turnId, (existing) => ({
        kind: "user",
        id: event.turnId,
        status: "partial",
        text: event.text,
        words: existing && existing.kind === "user" ? existing.words : [],
      }));
      break;
    }

    case "stt.final":
      upsert(event.turnId, () => ({
        kind: "user",
        id: event.turnId,
        status: "final",
        text: event.text,
        words: event.words ?? [],
      }));
      break;

    case "agent.text":
      upsert(event.messageId, (prev) => ({
        kind: "agent",
        id: event.messageId,
        status: event.final ? "final" : "streaming",
        text: event.text,
        turnId:
          event.turnId ?? (prev && prev.kind === "agent" ? prev.turnId : undefined),
      }));
      break;

    case "tool.state":
      upsert(event.callId, (prev) => ({
        kind: "tool",
        id: event.callId,
        status:
          event.phase === "started"
            ? "running"
            : event.phase === "succeeded"
              ? "succeeded"
              : "failed",
        name: event.name,
        detail:
          event.detail ?? (prev && prev.kind === "tool" ? prev.detail : undefined),
        turnId:
          event.turnId ?? (prev && prev.kind === "tool" ? prev.turnId : undefined),
      }));
      break;

    case "tts.audio":
      // Playback is transient view state, not a row. `started` sets the
      // indicator; `ended` clears it only if it still names this utterance.
      if (event.phase === "started") {
        speaking = {
          utteranceId: event.utteranceId,
          ...(event.messageId ? { messageId: event.messageId } : {}),
        };
      } else if (speaking && speaking.utteranceId === event.utteranceId) {
        speaking = null;
      }
      break;

    case "cancel": {
      const cancelledMessageIds = new Set<string>();
      for (const [id, entry] of entries) {
        if (!isInFlight(entry.item)) continue;
        if (event.scope === "turn") {
          if (!event.turnId || !belongsToTurn(entry.item, event.turnId)) continue;
        }
        if (entry.item.kind === "agent") cancelledMessageIds.add(entry.item.id);
        entries.set(id, {
          item: cancelItem(entry.item),
          order: entry.order,
          // The cancel draws the boundary at its own seq: pre-boundary
          // stragglers are dropped, post-boundary continuations still apply.
          revSeq: Math.max(entry.revSeq, event.seq),
        });
      }
      if (
        speaking &&
        (event.scope === "all" ||
          (speaking.messageId !== undefined &&
            cancelledMessageIds.has(speaking.messageId)))
      ) {
        speaking = null;
      }
      break;
    }

    case "error":
      upsert(`error:${event.seq}`, () => ({
        kind: "error",
        id: `error:${event.seq}`,
        code: event.code,
        retryable: event.retryable,
        ...(event.message !== undefined ? { message: event.message } : {}),
      }));
      break;

    case "reconnect":
      connection = event.phase === "lost" ? "lost" : "live";
      upsert(`reconnect:${event.seq}`, () => ({
        kind: "reconnect",
        id: `reconnect:${event.seq}`,
        phase: event.phase,
        attempt: event.attempt,
      }));
      break;

    default: {
      // Exhaustiveness guard — an unhandled type is impossible after decode.
      const _never: never = event;
      void _never;
      return state;
    }
  }

  return { entries, appliedSeqs, speaking, connection, lastSeq };
}

/** Project the internal accumulator into the render model. */
export function toViewModel(
  state: TranscriptReducerState,
): TranscriptViewModel {
  const ordered = [...state.entries.values()].sort((a, b) =>
    a.order !== b.order ? a.order - b.order : a.item.id < b.item.id ? -1 : 1,
  );
  return {
    items: ordered.map((entry) => entry.item),
    speaking: state.speaking,
    connection: state.connection,
    lastSeq: state.lastSeq,
  };
}

/** Fold a whole (already-decoded) event sequence into a render model. */
export function reduceTranscriptEvents(
  events: readonly TranscriptEvent[],
): TranscriptViewModel {
  let state = initialReducerState();
  for (const event of events) state = applyTranscriptEvent(state, event);
  return toViewModel(state);
}
