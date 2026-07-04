/** Implements Electrobun desktop voice playback adapter ts behavior for app-core shell integration. */
import { VoiceError } from "./errors";
import type { VoicePlayAudioParams, VoicePlaybackEvent } from "./types";

export type VoicePlaybackAdapterStatus = {
  playbackAckSupported: boolean;
  reason?: string;
};

export interface VoicePlaybackAdapter {
  status(): Promise<VoicePlaybackAdapterStatus>;
  playAudio(params: VoicePlayAudioParams): Promise<VoicePlaybackEvent>;
  interrupt(params?: { reason?: string }): Promise<void>;
}

export class UnavailableVoicePlaybackAdapter implements VoicePlaybackAdapter {
  async status(): Promise<VoicePlaybackAdapterStatus> {
    return {
      playbackAckSupported: false,
      reason: "Host playback acknowledgement is not wired.",
    };
  }

  async playAudio(): Promise<VoicePlaybackEvent> {
    throw new VoiceError(
      "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
      "Host playback acknowledgement is not wired.",
    );
  }

  async interrupt(): Promise<void> {}
}
