import { ConsentStore } from "./consent-store.ts";
import { decideResponse } from "./response-gate.ts";
import type {
  AmbientMode,
  ResponseDecision,
  ResponseGateSignals,
  TranscribedSegment,
} from "./types.ts";

export interface AmbientAudioService {
  start(scope: "household" | "owner-only"): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  mode(): AmbientMode;
  recentTranscript(seconds: number): TranscribedSegment[];
  evaluateGate(signals: ResponseGateSignals): ResponseDecision;
  silentTrace(seconds: number): TranscribedSegment[];
}

export interface MockAmbientAudioServiceOptions {
  now?: () => number;
  syntheticTranscripts?: TranscribedSegment[];
  syntheticSilentTrace?: TranscribedSegment[];
  gate?: (signals: ResponseGateSignals) => ResponseDecision;
}

export class MockAmbientAudioService implements AmbientAudioService {
  private readonly consent: ConsentStore;
  private readonly transcripts: TranscribedSegment[];
  private readonly silent: TranscribedSegment[];
  private readonly gate: (signals: ResponseGateSignals) => ResponseDecision;
  private readonly now: () => number;

  constructor(options: MockAmbientAudioServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.consent = new ConsentStore(this.now);
    this.transcripts = options.syntheticTranscripts ?? [];
    this.silent = options.syntheticSilentTrace ?? [];
    this.gate = options.gate ?? decideResponse;
  }

  async start(scope: "household" | "owner-only"): Promise<void> {
    this.consent.grant(scope);
  }

  async pause(): Promise<void> {
    this.consent.pause();
  }

  async resume(): Promise<void> {
    this.consent.resume();
  }

  async stop(): Promise<void> {
    this.consent.revoke();
  }

  mode(): AmbientMode {
    return this.consent.currentMode();
  }

  recentTranscript(seconds: number): TranscribedSegment[] {
    if (this.transcripts.length === 0) return [];
    const last = this.transcripts[this.transcripts.length - 1];
    if (last === undefined) return [];
    const cutoff = last.endMs - seconds * 1000;
    return this.transcripts.filter((s) => s.endMs > cutoff);
  }

  evaluateGate(signals: ResponseGateSignals): ResponseDecision {
    return this.gate(signals);
  }

  silentTrace(seconds: number): TranscribedSegment[] {
    if (this.silent.length === 0) return [];
    const last = this.silent[this.silent.length - 1];
    if (last === undefined) return [];
    const cutoff = last.endMs - seconds * 1000;
    return this.silent.filter((s) => s.endMs > cutoff);
  }
}
