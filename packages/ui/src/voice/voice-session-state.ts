/**
 * Voice-session client state machine (contract §7.4).
 *
 * Canonical lifecycle:
 *   idle → connecting → ready → listening → transcribing → thinking →
 *     speaking → (interrupted | complete) → listening
 *
 * Authority split (binding, from the decision doc §7.4):
 *   - The CLIENT owns `idle`, `connecting`, `listening`, and playback unlock.
 *   - The SERVER is authoritative for `transcribing`, `thinking`, `speaking`,
 *     `interrupted`. Those transitions are driven ONLY by server events, never
 *     synthesized locally.
 *
 * This reducer is pure so the lifecycle is unit-tested without a socket. It maps
 * onto the existing `VoiceContinuousStatus` union (voice-chat-types.ts) rather
 * than forking a second status vocabulary: `toContinuousStatus()` is the single
 * adapter into the unified voice-state surface (#15924).
 */

import type { VoiceContinuousStatus } from "./voice-chat-types";
import type {
  InterruptionReason,
  ServerControlFrame,
} from "./voice-session-protocol";

/**
 * Client-facing session phase. `complete` is a transient terminal-of-turn state
 * the client immediately folds back to `listening` (the machine emits it so a
 * caller can observe turn boundaries); `interrupted` is likewise transient.
 */
export type VoiceSessionPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "complete";

export interface VoiceSessionMachineState {
  phase: VoiceSessionPhase;
  /** Session id from the server `ready` event, once known. */
  sessionId: string | null;
  /** Trace id of the CURRENT turn (from the latest server event carrying one). */
  traceId: string | null;
  /** Latest interim transcript (server `stt_partial`), UI-only. */
  interimTranscript: string;
  /** Latest final transcript (server `stt_final`) for the committed turn. */
  finalTranscript: string;
  /** Reason for the most recent interruption, if the phase is `interrupted`. */
  interruptionReason: InterruptionReason | null;
  /** Last error surfaced by the server, if any (cleared on the next turn). */
  lastError: { code: string; retryable: boolean } | null;
}

export const INITIAL_VOICE_SESSION_STATE: VoiceSessionMachineState = {
  phase: "idle",
  sessionId: null,
  traceId: null,
  interimTranscript: "",
  finalTranscript: "",
  interruptionReason: null,
  lastError: null,
};

/**
 * Client-owned transitions. These NEVER come from the wire — they're driven by
 * the client's own lifecycle (open the socket, sent hello, user stopped).
 */
export type VoiceSessionClientAction =
  | { type: "client/connect" } // idle → connecting
  | { type: "client/reset" } // → idle (e.g. after a fatal error + re-mint)
  | { type: "client/local_barge_in" }; // optimistic: speaking → listening pre-ack

/**
 * Apply a client-owned action. Only the client-authoritative phases move here;
 * a server-authoritative phase is never fabricated.
 */
export function applyClientAction(
  state: VoiceSessionMachineState,
  action: VoiceSessionClientAction,
): VoiceSessionMachineState {
  switch (action.type) {
    case "client/connect":
      // Only advance from idle; a redundant connect is a no-op.
      if (state.phase !== "idle") return state;
      return { ...state, phase: "connecting", lastError: null };
    case "client/reset":
      return { ...INITIAL_VOICE_SESSION_STATE };
    case "client/local_barge_in":
      // Optimistic local flush: if we're audibly speaking, stop showing speaking
      // immediately and return to listening. The authoritative `interrupted`
      // event still arrives and reconciles (see applyServerEvent).
      if (state.phase === "speaking") {
        return { ...state, phase: "listening" };
      }
      return state;
  }
}

/**
 * Fold a server control event into the state. Server events are authoritative
 * for transcribing/thinking/speaking/interrupted; the mapping is:
 *   ready            → ready (client then starts capture → listening)
 *   stt_partial      → transcribing (+ interim text)
 *   stt_eager_eot    → transcribing (no phase change; speculative)
 *   stt_final        → transcribing→thinking is deferred to llm_first_text; we
 *                      commit the final text + set traceId, phase stays
 *                      transcribing until the LLM leg starts (thinking)
 *   llm_first_text   → thinking
 *   speaking_start   → speaking
 *   speaking_end     → complete → (caller loops to listening)
 *   interrupted      → interrupted → (caller loops to listening)
 *   error            → records error; retryable=false is fatal (caller re-mints)
 *   usage            → no phase change (settlement telemetry)
 */
export function applyServerEvent(
  state: VoiceSessionMachineState,
  event: ServerControlFrame,
): VoiceSessionMachineState {
  switch (event.t) {
    case "ready":
      return {
        ...state,
        phase: "ready",
        sessionId: event.sessionId,
        traceId: event.traceId,
        lastError: null,
      };
    case "stt_partial":
      return {
        ...state,
        phase: "transcribing",
        traceId: event.traceId,
        interimTranscript: event.text,
      };
    case "stt_eager_eot":
      // Speculative EOT — the server MAY begin prep. No committed turn yet, no
      // phase jump; keep whatever transcribing/listening phase we're in.
      return { ...state, traceId: event.traceId };
    case "stt_final":
      return {
        ...state,
        phase: "transcribing",
        traceId: event.traceId,
        finalTranscript: event.text,
        interimTranscript: "",
      };
    case "llm_first_text":
      return { ...state, phase: "thinking", traceId: event.traceId };
    case "speaking_start":
      return { ...state, phase: "speaking", traceId: event.traceId };
    case "speaking_end":
      return { ...state, phase: "complete", traceId: event.traceId };
    case "interrupted":
      return {
        ...state,
        phase: "interrupted",
        traceId: event.traceId,
        interruptionReason: event.reason,
      };
    case "error":
      return {
        ...state,
        lastError: { code: event.code, retryable: event.retryable },
      };
    case "usage":
      // Settlement telemetry; no client phase impact.
      return { ...state, traceId: event.traceId };
    default: {
      // Exhaustiveness guard — an unhandled server type is a no-op, never a
      // fabricated transition.
      const _never: never = event;
      void _never;
      return state;
    }
  }
}

/**
 * After a turn terminates (`complete` or `interrupted`), the client loops back
 * to `listening` to await the next utterance. Kept explicit (not folded into
 * applyServerEvent) so the caller controls WHEN the loop happens — e.g. only
 * after the local playback queue has drained on `complete`.
 */
export function loopToListening(
  state: VoiceSessionMachineState,
): VoiceSessionMachineState {
  if (state.phase === "complete" || state.phase === "interrupted") {
    return {
      ...state,
      phase: "listening",
      interruptionReason: null,
    };
  }
  return state;
}

/**
 * The client transitions ready → listening once it has started mic capture and
 * playback is unlocked. Client-authoritative.
 */
export function beginListening(
  state: VoiceSessionMachineState,
): VoiceSessionMachineState {
  if (state.phase === "ready" || state.phase === "complete") {
    return { ...state, phase: "listening" };
  }
  return state;
}

const PHASE_TO_STATUS: Record<VoiceSessionPhase, VoiceContinuousStatus> = {
  idle: "idle",
  connecting: "idle",
  ready: "idle",
  listening: "listening",
  transcribing: "transcribing",
  thinking: "thinking",
  speaking: "speaking",
  interrupted: "interrupting",
  complete: "listening",
};

/**
 * Map a client phase onto the unified `VoiceContinuousStatus` (#15924) so the
 * status bar / live-activity surface reads realtime-WS sessions through the same
 * vocabulary as the batch continuous-chat path — no second status system.
 */
export function toContinuousStatus(
  phase: VoiceSessionPhase,
): VoiceContinuousStatus {
  return PHASE_TO_STATUS[phase];
}
