/**
 * Single microphone controller shared by batch and realtime chat voice. The
 * realtime client owns the mic only after its feature and consent gates pass;
 * otherwise the established batch controller remains authoritative while both
 * paths expose the same status vocabulary to the composer.
 */

import { useCallback, useMemo } from "react";
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
  /** True when the realtime path COULD drive the mic (flag on + mint ok). */
  realtimeAvailable: boolean;
  /** Unified status for `ChatVoiceStatusBar` (realtime wins when active). */
  status: VoiceContinuousStatus;
  /** Live partial transcript (realtime `stt_partial`, else batch interim). */
  interimTranscript: string;
  /** Committed final transcript from the realtime path ("" on batch). */
  finalTranscript: string;
  /** True while the agent is audibly speaking (realtime phase). */
  agentSpeaking: boolean;
  /** Realtime session paused by a visibility-hide (paused, not broken). */
  paused: boolean;
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
   * Start capture. Realtime when available (mint + WS + mic), else resume the
   * batch passive capture. On a realtime start that resolves to feature-disabled
   * (404), the realtime path flips unavailable and the caller can fall through
   * to batch on the next tap.
   */
  start: () => Promise<void>;
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

  const start = useCallback(async () => {
    if (realtime.available) {
      await realtime.start();
      // If the start resolved to feature-disabled, `realtime.available` is now
      // false; the caller's NEXT gesture takes the batch branch. We do not
      // silently start batch here — the user's single gesture starts one path.
      return;
    }
    await batch.resume();
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

  return useMemo<ContinuousVoiceSessionState>(() => {
    // Realtime wins the status surface while it is the active path; otherwise
    // the batch status is shown verbatim (zero change to the existing flow).
    const status: VoiceContinuousStatus = realtimeActive
      ? realtime.status
      : batch.status;
    const interimTranscript = realtimeActive
      ? realtime.transcriptPartial
      : batch.interimTranscript;

    return {
      realtimeActive,
      realtimeConnecting: realtime.available && realtime.connecting,
      realtimeAvailable: realtime.available,
      status,
      interimTranscript,
      finalTranscript: realtimeActive ? realtime.transcriptFinal : "",
      agentSpeaking: realtimeActive
        ? realtime.agentSpeaking
        : batch.status === "speaking",
      paused: realtimeActive ? realtime.paused : false,
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
  }, [batch, realtime, realtimeActive, start, stop, bargeIn]);
}
