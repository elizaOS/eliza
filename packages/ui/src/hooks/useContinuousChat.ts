/**
 * Continuous-chat orchestration layered on top of `useVoiceChat`.
 *
 * Kept as a sibling hook rather than folded into `useVoiceChat`: that hook
 * already owns the whole voice engine (STT via Web Speech + native TalkMode;
 * TTS via ElevenLabs + browser + native; interruption, cancellation, audio
 * cache), and the continuous-chat semantics — mode switch, status, latency
 * badge, speaker pill, cancellation-token plumbing — are a thin layer that reads
 * `useVoiceChat`'s state and drives its `startListening("passive")` /
 * `stopListening()` API. Separating them keeps the orchestration testable
 * independently of the engine.
 *
 * The `CancellationToken` shape defined here exposes the UI surface. The
 * cross-layer cancellation contract (abort of the SERVER generation on a
 * barge-in) is wired at the true speech-detected edge in `useVoiceChat`
 * (`onUserSpeechInterrupt`), NOT here: this hook's listening-state transition
 * is also driven by the internal passive-capture rearm during TTS, so firing a
 * server abort off it would cancel ordinary assistant replies the instant the
 * mic reopens. The token cancellation below stays a pure UI-surface signal.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDictationLiveActivity } from "../voice/ios-live-activity";
import type { VoiceChatState } from "../voice/voice-chat-types";
import {
  DEFAULT_VOICE_CONTINUOUS_MODE,
  type VoiceContinuousMode,
  type VoiceContinuousStatus,
  type VoiceSpeakerMetadata,
  type VoiceTtsError,
} from "../voice/voice-chat-types";

export interface ContinuousChatLatency {
  /** Speech end → first assistant token, ms. */
  speechEndToFirstTokenMs: number | null;
  /** Speech end → assistant voice playback start, ms. */
  speechEndToVoiceStartMs: number | null;
  /** Assistant stream start → assistant voice playback start, ms. */
  assistantStreamToVoiceStartMs: number | null;
  /** Whether the first speech segment was served from the first-line cache. */
  firstSegmentCached: boolean | null;
}

export interface ContinuousChatCancellationToken {
  /** Stable id for the optimistic turn the token guards. */
  id: string;
  /** Cancel the turn. Idempotent. */
  cancel: (reason: ContinuousChatCancellationReason) => void;
  /** Whether `cancel` has fired. */
  isCancelled: () => boolean;
}

export type ContinuousChatCancellationReason =
  | "user-speech"
  | "user-stop"
  | "mode-changed"
  | "unmounted";

export interface UseContinuousChatOptions {
  /** Underlying full voice-chat hook (already wired by the caller). */
  voice: VoiceChatState;
  /** Continuous-chat mode the user has chosen. */
  mode: VoiceContinuousMode;
  /** Disable continuous-chat capture even if mode is non-off (e.g. composer locked). */
  disabled?: boolean;
  /**
   * Latency snapshot emitted by `useChatVoiceController` (already tracked).
   * Pass it through so the status bar reads from the same source of truth.
   */
  latency?: ContinuousChatLatency;
  /**
   * Live speaker attribution for the in-progress turn, populated by R2's
   * speaker-id pipeline. Falls back to undefined when speaker-id is offline.
   */
  speaker?: VoiceSpeakerMetadata | null;
  /** True while the runtime is generating an assistant reply. */
  assistantGenerating?: boolean;
  /** Called when continuous capture transitions on→off so callers can flush state. */
  onContinuousStop?: (reason: ContinuousChatCancellationReason) => void;
}

export interface ContinuousChatState {
  /** Resolved aggregate status for the status bar. */
  status: VoiceContinuousStatus;
  /** Continuous capture is currently engaged. */
  active: boolean;
  /** Whether the user enabled continuous mode. */
  mode: VoiceContinuousMode;
  /** Live partial transcript while a turn is in progress. */
  interimTranscript: string;
  /** Pulse flag — set briefly when an interrupt fires. */
  interrupting: boolean;
  /** Latency snapshot mirror, suitable for the latency badge. */
  latency: ContinuousChatLatency;
  /** Speaker attribution mirror. */
  speaker: VoiceSpeakerMetadata | null;
  /**
   * Mirror of `voice.needsAudioUnlock`: assistant audio was blocked by the
   * browser autoplay policy and a user gesture is required to enable sound.
   */
  needsAudioUnlock: boolean;
  /**
   * Mirror of `voice.micReconnected`: a transient pulse set when browser speech
   * recognition silently auto-restarted mid-session.
   */
  micReconnected: boolean;
  /**
   * Mirror of `voice.unlockAudio`: warm/resume the AudioContext in response to a
   * user gesture, clearing `needsAudioUnlock`. Safe to call when already unlocked.
   */
  unlockAudio: () => void;
  /**
   * Mirror of `voice.ttsError`: set when the configured TTS engine failed and
   * the queue was stopped WITHOUT swapping voices (#12253). `null` otherwise.
   */
  ttsError: VoiceTtsError | null;
  /** Start a new optimistic turn (R11 cancellation contract surface). */
  startTurn: () => ContinuousChatCancellationToken;
  /** Manually stop continuous capture without resetting `mode`. */
  pause: () => Promise<void>;
  /** Resume continuous capture after a manual pause. */
  resume: () => Promise<void>;
}

const EMPTY_LATENCY: ContinuousChatLatency = {
  speechEndToFirstTokenMs: null,
  speechEndToVoiceStartMs: null,
  assistantStreamToVoiceStartMs: null,
  firstSegmentCached: null,
};

const NOOP_UNLOCK_AUDIO = () => {};

const INTERRUPT_PULSE_MS = 600;

/**
 * Safety ceiling for the `thinking` status. If the runtime never resolves the
 * generation (relay drop, aborted stream that left `assistantGenerating`
 * stuck), the status bar would otherwise show "thinking" forever. After this
 * window we stop surfacing `thinking` and fall back to listening/idle so the
 * mic UI is usable again. Tuned well above any realistic first-token latency.
 */
const THINKING_TIMEOUT_MS = 30_000;

let cancellationTokenCounter = 0;

function makeCancellationToken(
  onCancel: (reason: ContinuousChatCancellationReason) => void,
): ContinuousChatCancellationToken {
  cancellationTokenCounter += 1;
  const id = `continuous-turn-${Date.now().toString(36)}-${cancellationTokenCounter}`;
  let cancelled = false;
  return {
    id,
    cancel(reason: ContinuousChatCancellationReason) {
      if (cancelled) return;
      cancelled = true;
      onCancel(reason);
    },
    isCancelled: () => cancelled,
  };
}

/**
 * Compose `useVoiceChat` with continuous-chat orchestration. Mode resolution:
 *
 * - `off`         → idle (push-to-talk only; capture is owned by composer).
 * - `vad-gated`   → mic enters `passive` mode on demand, closes on EOT.
 * - `always-on`   → mic enters `passive` mode and stays there as long as the
 *                   component is mounted and not disabled.
 */
export function useContinuousChat(
  options: UseContinuousChatOptions,
): ContinuousChatState {
  const {
    voice,
    mode,
    disabled = false,
    latency,
    speaker,
    assistantGenerating,
    onContinuousStop,
  } = options;

  const [interrupting, setInterrupting] = useState(false);
  const [thinkingTimedOut, setThinkingTimedOut] = useState(false);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTokenRef = useRef<ContinuousChatCancellationToken | null>(null);
  const lastModeRef = useRef<VoiceContinuousMode>(
    DEFAULT_VOICE_CONTINUOUS_MODE,
  );
  const onContinuousStopRef = useRef(onContinuousStop);
  onContinuousStopRef.current = onContinuousStop;

  // Bring up / tear down passive capture based on mode + disabled.
  useEffect(() => {
    if (!voice.supported) return;
    const wantActive = mode !== "off" && !disabled;
    const isCurrentlyActive =
      voice.isListening && voice.captureMode === "passive";

    if (wantActive && !isCurrentlyActive) {
      void voice.startListening("passive");
      return;
    }
    if (!wantActive && isCurrentlyActive) {
      void voice.stopListening({ submit: false });
    }
  }, [
    mode,
    disabled,
    voice.captureMode,
    voice.isListening,
    voice.startListening,
    voice.stopListening,
    voice.supported,
  ]);

  // Mode-change cancellation: any in-flight token gets cancelled.
  useEffect(() => {
    if (lastModeRef.current === mode) return;
    const previous = lastModeRef.current;
    lastModeRef.current = mode;
    const token = activeTokenRef.current;
    if (token) {
      token.cancel("mode-changed");
      activeTokenRef.current = null;
    }
    if (previous !== "off" && mode === "off") {
      onContinuousStopRef.current?.("mode-changed");
    }
  }, [mode]);

  // Interrupt indicator: when speech starts while assistant is speaking,
  // pulse the interrupting flag for INTERRUPT_PULSE_MS.
  const wasSpeakingRef = useRef(false);
  const wasListeningRef = useRef(false);
  useEffect(() => {
    const wasSpeaking = wasSpeakingRef.current;
    const wasListening = wasListeningRef.current;
    wasSpeakingRef.current = voice.isSpeaking;
    wasListeningRef.current = voice.isListening;

    const speechJustStartedDuringTts =
      voice.isListening && !wasListening && wasSpeaking;
    if (!speechJustStartedDuringTts) return;

    if (interruptTimerRef.current !== null) {
      clearTimeout(interruptTimerRef.current);
    }
    setInterrupting(true);
    interruptTimerRef.current = setTimeout(() => {
      setInterrupting(false);
      interruptTimerRef.current = null;
    }, INTERRUPT_PULSE_MS);

    // Any in-flight optimistic generation should be aborted by the caller's
    // chat send pipeline; we cancel the token to surface the signal.
    const token = activeTokenRef.current;
    if (token) {
      token.cancel("user-speech");
      activeTokenRef.current = null;
    }
  }, [voice.isListening, voice.isSpeaking]);

  // Thinking-timeout guard: a generation that never resolves must not pin the
  // status bar to "thinking". While `assistantGenerating` is true (and the
  // assistant is not yet speaking), arm a timer; if it fires, latch
  // `thinkingTimedOut` so the status derivation drops back to listening/idle.
  // Any state change that ends the thinking window (generation finished,
  // playback started) clears the timer and the latch.
  const isThinking = Boolean(assistantGenerating) && !voice.isSpeaking;
  useEffect(() => {
    if (!isThinking) {
      if (thinkingTimerRef.current !== null) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      setThinkingTimedOut(false);
      return;
    }
    // Already thinking and timer running — keep the existing deadline.
    if (thinkingTimerRef.current !== null) return;
    thinkingTimerRef.current = setTimeout(() => {
      thinkingTimerRef.current = null;
      setThinkingTimedOut(true);
    }, THINKING_TIMEOUT_MS);
  }, [isThinking]);

  // Clear pending timer on unmount; cancel any active token.
  useEffect(() => {
    return () => {
      if (interruptTimerRef.current !== null) {
        clearTimeout(interruptTimerRef.current);
        interruptTimerRef.current = null;
      }
      if (thinkingTimerRef.current !== null) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      const token = activeTokenRef.current;
      if (token) {
        token.cancel("unmounted");
        activeTokenRef.current = null;
      }
    };
  }, []);

  const startTurn = useCallback((): ContinuousChatCancellationToken => {
    const prev = activeTokenRef.current;
    if (prev) {
      prev.cancel("user-speech");
    }
    const token = makeCancellationToken(() => {
      if (activeTokenRef.current?.id === token.id) {
        activeTokenRef.current = null;
      }
    });
    activeTokenRef.current = token;
    return token;
  }, []);

  const pause = useCallback(async () => {
    if (!voice.isListening) return;
    await voice.stopListening({ submit: false });
    onContinuousStopRef.current?.("user-stop");
  }, [voice.isListening, voice.stopListening]);

  const resume = useCallback(async () => {
    if (voice.isListening || mode === "off" || disabled) return;
    await voice.startListening("passive");
  }, [disabled, mode, voice.isListening, voice.startListening]);

  const status: VoiceContinuousStatus = useMemo(() => {
    if (interrupting) return "interrupting";
    if (voice.isSpeaking) return "speaking";
    // Suppress a stuck "thinking" once the safety timeout has fired so the bar
    // falls through to listening/idle instead of pulsing forever.
    if (assistantGenerating && !thinkingTimedOut) return "thinking";
    if (voice.isListening && voice.captureMode === "passive")
      return "listening";
    if (mode === "off") return "idle";
    return "idle";
  }, [
    assistantGenerating,
    interrupting,
    mode,
    thinkingTimedOut,
    voice.captureMode,
    voice.isListening,
    voice.isSpeaking,
  ]);

  const active = voice.isListening && voice.captureMode === "passive";

  // Mirror the live session onto the iOS Lock Screen + Dynamic Island Live
  // Activity (#12185). Inert off iOS.
  useDictationLiveActivity({
    active,
    status,
    transcript: voice.interimTranscript ?? "",
  });

  return {
    status,
    active,
    mode,
    interimTranscript: voice.interimTranscript,
    interrupting,
    latency: latency ?? EMPTY_LATENCY,
    speaker: speaker ?? null,
    needsAudioUnlock: voice.needsAudioUnlock ?? false,
    micReconnected: voice.micReconnected ?? false,
    unlockAudio: voice.unlockAudio ?? NOOP_UNLOCK_AUDIO,
    ttsError: voice.ttsError ?? null,
    startTurn,
    pause,
    resume,
  };
}
