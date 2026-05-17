export type AmbientMode = "off" | "paused" | "capturing";

export interface ConsentRecord {
  grantedAt: number;
  mode: AmbientMode;
  scope: "household" | "owner-only";
}

export interface AudioFrame {
  startMs: number;
  endMs: number;
  pcm: Int16Array;
  sampleRate: number;
  channel: 0 | 1;
}

export interface TranscribedSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  speakerProfileId?: string;
}

export interface ReplayBufferConfig {
  maxSeconds: number;
  sampleRate: number;
  channels: 1 | 2;
}

export interface ResponseGateSignals {
  vadActive: boolean;
  directAddress: boolean;
  wakeIntent: number;
  contextExpectsReply: boolean;
  ownerConfidence: number;
}

export type ResponseDecision = "respond" | "observe" | "silent";
