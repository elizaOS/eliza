/**
 * Shared type definitions for the ambient-audio subsystem: capture modes, the
 * owner consent record, the raw audio frame (fixed 16 kHz mono Int16), a
 * transcribed segment, the response-gate signals/decision, and the
 * `AmbientAudioService` interface that concrete capture backends implement.
 */
export type AmbientAudioMode = "stopped" | "listening" | "paused";

export interface ConsentRecord {
  ownerId: string;
  grantedAt: number;
  source: "first-run" | "settings" | "test";
  expiresAt?: number;
}

export interface AudioFrame {
  samples: Int16Array;
  sampleRate: 16000;
  channels: 1;
  capturedAt: number;
}

export interface TranscribedSegment {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  speakerProfileId?: string;
}

export interface ResponseGateSignals {
  vadActive: boolean;
  wakeIntent: number;
  directAddress: boolean;
  ownerConfidence: number;
  contextExpectsReply: boolean;
}

export interface ResponseDecision {
  shouldRespond: boolean;
  reason:
    | "direct-address"
    | "wake-intent"
    | "expected-reply"
    | "insufficient-signal";
  score: number;
}

export interface AmbientAudioService {
  mode(): AmbientAudioMode;
  start(ownerId: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  pushFrame(frame: AudioFrame): Promise<void>;
  recentAudio(seconds?: number): Int16Array;
}
