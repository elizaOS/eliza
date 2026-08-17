/**
 * Single microphone controller shared by batch and realtime chat voice. The
 * realtime client owns the mic only after its feature and consent gates pass;
 * otherwise the established batch controller remains authoritative while both
 * paths expose the same status vocabulary to the composer.
 */

import { useCallback, useMemo } from "react";
import { useVoiceLiveActivity } from "../voice/ios-live-activity";
import type {
  VoiceContinuousStatus,
  VoiceSpeakerMetadata,
} from "../voice/voice-chat-types";
import type {
  ContinuousChatLatency,
  ContinuousChatState,
} from "./useContinuousChat";
import type {
  RealtimeVoiceError,
  RealtimeVoiceStartOutcome,
  UseRealtimeVoiceSessionState,
} from "./useRealtimeVoiceSession";

export interface UseContinuousVoiceSessionOptions {
  /** The batch continuous-chat engine state (always present). */
  batch: ContinuousChatState;
  /** The realtime WS session state (inert when the flag is off / mint 404). */
  realtime: UseRealtimeVoiceSessionState;
}

export interface ContinuousVoiceSessionState {
  /** True when the realtime WS path is genuinely live (socket + ready + mic). */
  realtimeActive: boolean;
  /** True while a started realtime session is still working toward live. */
  realtimeConnecting: boolean;
  /** True when realtime is eligible to try; not proof that mint succeeded. */
  realtimeEligible: boolean;
  /** Unified composer status (realtime wins when active). */
  status: VoiceContinuousStatus;
  /** Visible in-flight transcript: partial while speaking, committed final while thinking. */
  interimTranscript: string;
  /** Committed final transcript from the realtime path ("" on batch). */
  finalTranscript: string;
  /** True while the agent is audibly speaking (realtime phase). */
  agentSpeaking: boolean;
  /** Realtime session paused by a visibility-hide (paused, not broken). */
  paused: boolean;
  /** Why this interaction fell back to standard voice, retained for UI diagnostics. */
  realtimeFallbackReason: UseRealtimeVoiceSessionState["fallbackReason"];
  /** Record an eligibility fallback discovered before realtime start. */
  reportRealtimeFallback: UseRealtimeVoiceSessionState["reportFallback"];
  /** Typed realtime error, actionable or not (null on the batch path). */
  realtimeError: RealtimeVoiceError | null;
  /** Latency snapshot for the badge (batch — realtime latency is server-side). */
  latency: ContinuousChatLatency;
  /** Speaker attribution passthrough. */
  speaker: VoiceSpeakerMetadata | null;
  /** Autoplay-unlock state for the mic path that currently owns playback. */
  needsAudioUnlock: boolean;
  /** Autoplay-unlock action for the active realtime or batch path. */
  unlockAudio: () => void;
  /** Browser SR silent-reconnect pulse (batch). */
  micReconnected: boolean;
  /** Fail-closed TTS error banner (batch). */
  ttsError: ContinuousChatState["ttsError"];
  /**
   * Start capture. Realtime when eligible, else resume the batch passive
   * capture. Pre-live realtime failures return a typed fallback outcome so the
   * caller can start the existing batch path from the same mic tap.
   */
  start: () => Promise<RealtimeVoiceStartOutcome | { kind: "batch" }>;
  /** Stop capture on whichever path is live. */
  stop: () => Promise<void>;
  /** Barge-in (realtime-only; no-op on batch). */
  bargeIn: () => void;
}

export function useContinuousVoiceSession(
  options: UseContinuousVoiceSessionOptions,
): ContinuousVoiceSessionState {
  const { batch, realtime } = options;

  const realtimeActive = realtime.available && realtime.active;

  const start = useCallback(async (): Promise<
    RealtimeVoiceStartOutcome | { kind: "batch" }
  > => {
    if (realtime.available) {
      return realtime.start();
    }
    await batch.resume();
    return { kind: "batch" };
  }, [batch, realtime]);

  const stop = useCallback(async () => {
    // A stop during bring-up (connecting, not yet live) must cancel the pending
    // realtime lifecycle, not pause the (already disabled) batch path.
    if (realtime.active || realtime.connecting) {
      await realtime.stop();
      return;
    }
    await batch.pause();
  }, [batch, realtime]);

  const bargeIn = useCallback(() => {
    if (realtime.active) realtime.bargeIn();
  }, [realtime]);

  // ActivityKit must follow the SAME batch-versus-realtime winner as the
  // composer. The old batch-hook placement could leave a live realtime voice
  // session absent from the Lock Screen and Dynamic Island.
  const status: VoiceContinuousStatus = realtimeActive
    ? realtime.status
    : batch.status;
  const interimTranscript = realtimeActive
    ? realtime.transcriptPartial ||
      (status === "thinking" ? realtime.transcriptFinal : "")
    : batch.interimTranscript;
  const liveActivityActive = realtimeActive || batch.active;
  const liveActivityError = liveActivityActive
    ? Boolean(realtimeActive ? realtime.error : batch.ttsError)
    : Boolean(realtime.error ?? batch.ttsError);
  useVoiceLiveActivity({
    active: liveActivityActive,
    status,
    error: liveActivityError,
  });

  return useMemo<ContinuousVoiceSessionState>(() => {
    return {
      realtimeActive,
      realtimeConnecting: realtime.available && realtime.connecting,
      realtimeEligible: realtime.available,
      status,
      interimTranscript,
      finalTranscript: realtimeActive ? realtime.transcriptFinal : "",
      agentSpeaking: realtimeActive
        ? realtime.agentSpeaking
        : batch.status === "speaking",
      paused: realtimeActive ? realtime.paused : false,
      realtimeFallbackReason: realtime.fallbackReason,
      reportRealtimeFallback: realtime.reportFallback,
      realtimeError: realtime.error,
      latency: batch.latency,
      speaker: realtime.speaker ?? batch.speaker,
      needsAudioUnlock: realtimeActive
        ? realtime.needsUnlock
        : batch.needsAudioUnlock,
      unlockAudio: realtimeActive
        ? () => {
            void realtime.unlock();
          }
        : batch.unlockAudio,
      micReconnected: batch.micReconnected,
      ttsError: batch.ttsError,
      start,
      stop,
      bargeIn,
    };
  }, [
    batch,
    realtime,
    realtimeActive,
    status,
    interimTranscript,
    start,
    stop,
    bargeIn,
  ]);
}
