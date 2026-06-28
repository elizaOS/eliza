/**
 * Unified wake-word controller — the "two-stage name-aware wake" decision from
 * issue #9880 (§ Backend decision / Work breakdown D), made concrete and pure.
 *
 * One controller picks the cheapest CORRECT detection path for the current
 * platform capabilities + character name, and runs the confirmation handshake
 * when the always-on detector is not itself name-specific:
 *
 *   head-fast-path  — a trained openWakeWord head exists for the current name
 *                     (shipped `hey-eliza`, or an auto-trained head). The fused
 *                     detector fires the name directly: lowest latency, no ASR,
 *                     no confirmation window.
 *   two-stage-asr   — only a GENERIC always-on detector is available
 *                     (openWakeWord generic / native VAD). It raises a cheap
 *                     CANDIDATE; we open a short ASR window and fuzzy-match the
 *                     transcript against the character name. Zero-shot, follows
 *                     renames, and idle power stays at Stage-A levels because the
 *                     expensive ASR only runs on a candidate.
 *   swabble-fallback — where the fused FFI is unavailable (e.g. some browsers),
 *                     the Swabble native OS-ASR plugin already emits a name-aware
 *                     wake event; pass it straight through.
 *
 * The reducer is pure and clock-injected, mirroring `wake-listen-window.ts`, so
 * every transition is unit- and fuzz-testable. The React adapter is
 * `useWakeController`; the only thing that ever burns battery at idle is the
 * platform's Stage-A detector, never this module.
 */

import {
  matchWakeName,
  normalizeForWake,
  type WakeNameMatchOptions,
} from "./wake-name-match";

export type WakeDetectionPath =
  | "head-fast-path"
  | "two-stage-asr"
  | "swabble-fallback";

export interface WakeCapabilities {
  /**
   * The fused `libelizainference` openWakeWord runtime is present — the
   * battery-efficient always-on Stage-A detector and any trained heads.
   */
  openWakeWord: boolean;
  /**
   * A short-window ASR is available to confirm a Stage-A candidate by name
   * (native OS ASR, fused transcription, or a desktop Whisper bridge).
   */
  asrConfirm: boolean;
  /**
   * The Swabble native continuous-ASR plugin is present — name-aware zero-shot,
   * but not battery-efficient for always-on, so only a fallback detector.
   */
  swabble: boolean;
}

export interface WakeControllerConfig {
  /** Live character name; the wake phrase is "hey <name>" / "<name>". */
  characterName: string;
  /**
   * Normalized names (see {@link normalizeForWake}) that already have a trained
   * openWakeWord head, enabling the head fast-path. The shipped catalog head is
   * `hey-eliza`; auto-trained heads are added here as they land.
   */
  trainedHeads: ReadonlySet<string>;
  capabilities: WakeCapabilities;
  /**
   * How long (ms) a Stage-A candidate stays armed waiting for a Stage-B
   * transcript before it is abandoned. Default {@link DEFAULT_CONFIRM_WINDOW_MS}.
   */
  confirmWindowMs?: number;
  /** Name-match tuning forwarded to {@link matchWakeName}. */
  nameMatch?: WakeNameMatchOptions;
}

export const DEFAULT_CONFIRM_WINDOW_MS = 2500;

/** Phase of the two-stage confirmation handshake. */
export type WakeControllerPhase = "idle" | "confirming";

export interface WakeControllerState {
  phase: WakeControllerPhase;
  /** When the Stage-A candidate was raised. 0 when idle. */
  candidateAt: number;
}

export type WakeControllerEvent =
  /** Head fast-path: the trained head fired the character name directly. */
  | { type: "head-fired"; confidence?: number; now: number }
  /** Two-stage: the generic Stage-A detector raised a candidate. */
  | { type: "stage-a-candidate"; now: number }
  /** Two-stage: Stage-B ASR produced a transcript within the confirm window. */
  | { type: "stage-b-transcript"; transcript: string; now: number }
  /** Fallback: the Swabble native plugin emitted a (name-aware) wake. */
  | {
      type: "swabble-wake";
      wakeWord: string;
      command: string;
      transcript: string;
      confidence?: number;
    }
  /** Clock advanced — drives the Stage-B confirm-window timeout. */
  | { type: "tick"; now: number }
  /** External force-close (wake disabled, always-on engaged, unmount). */
  | { type: "reset" };

/** A confirmed wake, normalized across every detection path. */
export interface WakeDetection {
  /** The wake word that fired (the character name, or Swabble's trigger). */
  wakeWord: string;
  /** Trailing command spoken in the same breath ("" when none). */
  command: string;
  /** Full transcript at detection. */
  transcript: string;
  /** Detector confidence in [0,1] when the path provides one. */
  confidence?: number;
  /** Which path produced this detection. */
  path: WakeDetectionPath;
}

export interface WakeControllerStep {
  state: WakeControllerState;
  /** A confirmed wake to surface to the listening window, or null. */
  emit: WakeDetection | null;
}

const IDLE: WakeControllerState = { phase: "idle", candidateAt: 0 };

export function initialWakeControllerState(): WakeControllerState {
  return { phase: "idle", candidateAt: 0 };
}

/** Does a trained openWakeWord head exist for the current character name? */
export function hasTrainedHead(config: WakeControllerConfig): boolean {
  return config.trainedHeads.has(normalizeForWake(config.characterName));
}

/**
 * Select the detection path for the current capabilities + name, or null when
 * no name-aware path is available. The preference order IS the issue's backend
 * decision: head fast-path (cheapest, lowest latency) → two-stage ASR
 * (battery-cheap, zero-shot, rename-following) → Swabble fallback.
 */
export function selectWakePath(
  config: WakeControllerConfig,
): WakeDetectionPath | null {
  const caps = config.capabilities;
  if (caps.openWakeWord && hasTrainedHead(config)) return "head-fast-path";
  if (caps.openWakeWord && caps.asrConfirm) return "two-stage-asr";
  if (caps.swabble) return "swabble-fallback";
  // openWakeWord may be present but with no head and no way to confirm the name:
  // it cannot be a name-aware path on its own, so there is no usable detector.
  return null;
}

/**
 * Pure reducer. Given the current confirmation state and an event, returns the
 * next state and any confirmed wake to emit. Each event is gated on the selected
 * path so only the chosen detector can ever fire — a stray event from an
 * unselected backend is ignored.
 */
export function wakeControllerReducer(
  state: WakeControllerState,
  event: WakeControllerEvent,
  config: WakeControllerConfig,
): WakeControllerStep {
  if (event.type === "reset") return { state: IDLE, emit: null };

  const path = selectWakePath(config);

  switch (event.type) {
    case "head-fired": {
      if (path !== "head-fast-path") return { state, emit: null };
      // A head fire is terminal — the name is the wake word, no ASR needed.
      return {
        state: IDLE,
        emit: {
          wakeWord: config.characterName,
          command: "",
          transcript: config.characterName,
          confidence: event.confidence,
          path,
        },
      };
    }

    case "stage-a-candidate": {
      if (path !== "two-stage-asr") return { state, emit: null };
      // Open the confirmation window; the ASR transcript decides in Stage B.
      return {
        state: { phase: "confirming", candidateAt: event.now },
        emit: null,
      };
    }

    case "stage-b-transcript": {
      if (path !== "two-stage-asr" || state.phase !== "confirming") {
        return { state, emit: null };
      }
      const m = matchWakeName(
        event.transcript,
        config.characterName,
        config.nameMatch,
      );
      // Confirmed or rejected, the candidate is resolved either way.
      if (!m.matched) return { state: IDLE, emit: null };
      return {
        state: IDLE,
        emit: {
          wakeWord: config.characterName,
          command: m.command,
          transcript: event.transcript,
          path,
        },
      };
    }

    case "swabble-wake": {
      if (path !== "swabble-fallback") return { state, emit: null };
      // Swabble already matched a configured trigger against full OS ASR; the
      // event is name-aware, so pass it straight through.
      return {
        state,
        emit: {
          wakeWord: event.wakeWord,
          command: event.command,
          transcript: event.transcript,
          confidence: event.confidence,
          path,
        },
      };
    }

    case "tick": {
      if (state.phase !== "confirming") return { state, emit: null };
      const window = config.confirmWindowMs ?? DEFAULT_CONFIRM_WINDOW_MS;
      // No confirming transcript arrived in time — abandon the candidate so the
      // confirm window can never get stuck open.
      if (event.now - state.candidateAt >= window) {
        return { state: IDLE, emit: null };
      }
      return { state, emit: null };
    }

    default: {
      const _exhaustive: never = event;
      return { state, emit: null };
    }
  }
}
