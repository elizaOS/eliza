/**
 * The one cross-platform transcript-event contract (`eliza.native-transcript/v1`)
 * consumed by the iOS, Android, desktop, and web hosts. A voice/agent turn is
 * expressed as an append-only log of typed events; every host decodes the same
 * bytes (see `fixtures/native-transcript-golden.json`) and folds them into the
 * same ordered render model. The shipped React chat surface visibly renders the
 * validated projection returned by its native host.
 *
 * Design rules that make cross-bridge rendering deterministic:
 *   - Behavior derives from STRUCTURAL fields only — the discriminant `type`, the
 *     `phase`/`status`/`final` flags, the stable ids, and the monotonic `seq`.
 *     Never from transcript text or its length. (Bucketing state by `text.length`
 *     is the banned anti-pattern the earlier draft used.)
 *   - Each event is a self-contained SNAPSHOT of the item it updates, not a delta.
 *     A partial STT hypothesis and a streamed agent message each carry the full
 *     text so far, so a bridge that duplicates, reorders, or drops an event never
 *     has to buffer or re-accumulate — last-write-by-`seq` per item is correct.
 *   - `seq` is a per-stream, source-assigned, strictly increasing integer. It is
 *     the authoritative total order and the dedupe key. The reducer (`reduce.ts`)
 *     is the executable definition of ordering, dedupe, late-event, and
 *     cancellation-boundary semantics.
 *
 * This module is pure type + constant declarations (runtime validation lives in
 * `decode.ts`) so it is safe to import from any layer, native bridge shim
 * included.
 */

/** Versioned schema identifier carried by a transcript-event stream envelope. */
export const NATIVE_TRANSCRIPT_SCHEMA = "eliza.native-transcript/v1" as const;
export type NativeTranscriptSchema = typeof NATIVE_TRANSCRIPT_SCHEMA;

/** Per-word timing for a final STT result (ms from the utterance start). */
export interface TranscriptEventWord {
  text: string;
  startMs: number;
  endMs: number;
}

// ── Events (the append-only wire log) ──────────────────────────────────

/**
 * Interim STT hypothesis for a user turn. `text` is the full current hypothesis
 * (a snapshot, not a delta); a later `stt.final` on the same `turnId` supersedes
 * every partial.
 */
export interface SttPartialEvent {
  type: "stt.partial";
  seq: number;
  turnId: string;
  text: string;
  at?: number;
}

/** Committed STT result for a user turn; terminal for that `turnId`. */
export interface SttFinalEvent {
  type: "stt.final";
  seq: number;
  turnId: string;
  text: string;
  words?: TranscriptEventWord[];
  at?: number;
}

/**
 * Agent response text for one message. `text` is the full text emitted so far;
 * `final` marks the message complete. `turnId` links the message to the user
 * turn it answers so a turn-scoped cancellation can reach it.
 */
export interface AgentTextEvent {
  type: "agent.text";
  seq: number;
  messageId: string;
  text: string;
  final: boolean;
  turnId?: string;
  at?: number;
}

/** Lifecycle phase of a tool/action invocation. */
export type ToolPhase = "started" | "succeeded" | "failed";

/** Tool/action invocation state update, identified by a stable `callId`. */
export interface ToolStateEvent {
  type: "tool.state";
  seq: number;
  callId: string;
  name: string;
  phase: ToolPhase;
  detail?: string;
  turnId?: string;
  at?: number;
}

/** Audio-playback phase for one TTS utterance. */
export type AudioPhase = "started" | "ended";

/**
 * TTS/audio playback state for one spoken utterance. Playback is transient view
 * state (a "speaking now" indicator), not a persisted transcript row.
 */
export interface TtsAudioEvent {
  type: "tts.audio";
  seq: number;
  utteranceId: string;
  phase: AudioPhase;
  messageId?: string;
  at?: number;
}

/** Scope of a cancellation boundary. */
export type CancelScope = "turn" | "all";

/**
 * A cancellation boundary. `scope: "all"` cancels every in-flight item; `scope:
 * "turn"` cancels only items linked to `turnId`. The boundary also draws a `seq`
 * line: a late pre-boundary event for a cancelled item is dropped, while a
 * post-boundary event (higher `seq`) is a fresh continuation and still applies.
 */
export interface CancelEvent {
  type: "cancel";
  seq: number;
  scope: CancelScope;
  turnId?: string;
  reason?: string;
  at?: number;
}

/** A surfaced error. `retryable` drives whether the shell offers a retry. */
export interface TranscriptErrorEvent {
  type: "error";
  seq: number;
  code: string;
  retryable: boolean;
  message?: string;
  at?: number;
}

/** Connection lifecycle phase for a reconnect marker. */
export type ReconnectPhase = "lost" | "restored";

/** Transport reconnect marker; `lost`/`restored` toggle the connection state. */
export interface ReconnectEvent {
  type: "reconnect";
  seq: number;
  phase: ReconnectPhase;
  attempt: number;
  at?: number;
}

export type TranscriptEvent =
  | SttPartialEvent
  | SttFinalEvent
  | AgentTextEvent
  | ToolStateEvent
  | TtsAudioEvent
  | CancelEvent
  | TranscriptErrorEvent
  | ReconnectEvent;

export type TranscriptEventType = TranscriptEvent["type"];

/** Every recognized event discriminant, for the decoder's known-type gate. */
export const TRANSCRIPT_EVENT_TYPES: readonly TranscriptEventType[] = [
  "stt.partial",
  "stt.final",
  "agent.text",
  "tool.state",
  "tts.audio",
  "cancel",
  "error",
  "reconnect",
] as const;

/** Stream envelope: the versioned schema tag plus the ordered event log. */
export interface TranscriptEventStream {
  schema: NativeTranscriptSchema;
  events: TranscriptEvent[];
}

// ── Reduced render model (what every shell draws) ──────────────────────

export type UserTurnStatus = "partial" | "final" | "cancelled";
export type AgentTurnStatus = "streaming" | "final" | "cancelled";
export type ToolItemStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A user utterance row, keyed by its `turnId`. */
export interface UserTranscriptItem {
  kind: "user";
  id: string;
  status: UserTurnStatus;
  text: string;
  words: TranscriptEventWord[];
}

/** An agent message row, keyed by its `messageId`. */
export interface AgentTranscriptItem {
  kind: "agent";
  id: string;
  status: AgentTurnStatus;
  text: string;
  turnId?: string;
}

/** A tool/action row, keyed by its `callId`. */
export interface ToolTranscriptItem {
  kind: "tool";
  id: string;
  status: ToolItemStatus;
  name: string;
  detail?: string;
  turnId?: string;
}

/** An error row; `id` is synthesized from the event `seq` (`error:<seq>`). */
export interface ErrorTranscriptItem {
  kind: "error";
  id: string;
  code: string;
  retryable: boolean;
  message?: string;
}

/** A reconnect marker row; `id` is synthesized (`reconnect:<seq>`). */
export interface ReconnectTranscriptItem {
  kind: "reconnect";
  id: string;
  phase: ReconnectPhase;
  attempt: number;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AgentTranscriptItem
  | ToolTranscriptItem
  | ErrorTranscriptItem
  | ReconnectTranscriptItem;

export type TranscriptItemKind = TranscriptItem["kind"];

/** Transient "audio is playing now" indicator, cleared when playback ends. */
export interface SpeakingState {
  utteranceId: string;
  messageId?: string;
}

export type ConnectionState = "live" | "lost";

/**
 * The render model a shell draws. `items` is ordered by each item's first-seen
 * `seq` (stable across later updates); `speaking` and `connection` are transient
 * transport state. This is the single shape the golden fixture asserts against.
 */
export interface TranscriptViewModel {
  items: TranscriptItem[];
  speaking: SpeakingState | null;
  connection: ConnectionState;
  lastSeq: number;
}
