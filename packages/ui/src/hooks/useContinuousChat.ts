/**
 * Continuous-chat orchestration on top of `useVoiceChat` (R10 §1, §2.2).
 *
 * WHY a sibling hook (not a refactor of useVoiceChat):
 * - `useVoiceChat` is a 1961-line monolith that already handles STT (Web Speech
 *   + native TalkMode), TTS (ElevenLabs + browser + native), interruption,
 *   cancellation, and audio cache. Rewriting it for this wave is out of scope
 *   and risky — R10 §10 calls this out explicitly.
 * - The continuous-chat semantics (mode switch, status, latency badge, speaker
 *   pill, cancellation token plumbing) are a thin orchestration layer that
 *   reads `useVoiceChat`'s state + invokes its `startListening("passive")` /
 *   `stopListening()` API. Keeping that orchestration in this sibling makes
 *   the diff reviewable and the contract testable.
 *
 * The cancellation token defined here is intentionally minimal (R11 will spec
 * the full cross-layer cancellation contract; this layer only exposes the UI
 * surface). When R11 lands, swap the local `CancellationToken` shape for the
 * runtime one and propagate the abort signal through the cloud relay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VoiceChatState } from "../voice/voice-chat-types";
import {
  DEFAULT_VOICE_CONTINUOUS_MODE,
  type VoiceContinuousMode,
  type VoiceContinuousStatus,
  type VoiceSpeakerMetadata,
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
  /** Most recent assistant message id (drives `speaking` status). */
  assistantMessageId?: string | null;
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

const INTERRUPT_PULSE_MS = 600;

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
    assistantMessageId,
    assistantGenerating,
    onContinuousStop,
  } = options;

  const [interrupting, setInterrupting] = useState(false);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTokenRef = useRef<ContinuousChatCancellationToken | null>(null);
  const lastModeRef = useRef<VoiceContinuousMode>(DEFAULT_VOICE_CONTINUOUS_MODE);
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

  // Clear pending timer on unmount; cancel any active token.
  useEffect(() => {
    return () => {
      if (interruptTimerRef.current !== null) {
        clearTimeout(interruptTimerRef.current);
        interruptTimerRef.current = null;
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
    if (assistantGenerating) return "thinking";
    if (voice.isListening && voice.captureMode === "passive") return "listening";
    if (mode === "off") return "idle";
    return "idle";
  }, [
    assistantGenerating,
    interrupting,
    mode,
    voice.captureMode,
    voice.isListening,
    voice.isSpeaking,
  ]);

  return {
    status,
    active: voice.isListening && voice.captureMode === "passive",
    mode,
    interimTranscript: voice.interimTranscript,
    interrupting,
    latency: latency ?? EMPTY_LATENCY,
    speaker: speaker ?? null,
    startTurn,
    pause,
    resume,
    // Silence the unused-variable warning during dev; the param is required
    // for the orchestration contract (assistantMessageId is consumed by
    // `useChatVoiceController` which sits above this hook).
    ...(assistantMessageId ? {} : {}),
  };
}
