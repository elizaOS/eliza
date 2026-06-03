import type { AmbientAudioConsentState } from "./consent.ts";
import { ReplayBuffer } from "./replay-buffer.ts";
import type {
  AmbientAudioMode,
  AmbientAudioService,
  AudioFrame,
} from "./types.ts";

export interface InMemoryAmbientAudioServiceOptions {
  consent: AmbientAudioConsentState;
  replayBuffer?: ReplayBuffer;
}

export class InMemoryAmbientAudioService implements AmbientAudioService {
  private currentMode: AmbientAudioMode = "stopped";
  private ownerId: string | null = null;
  private readonly consent: AmbientAudioConsentState;
  private readonly buffer: ReplayBuffer;

  constructor(options: InMemoryAmbientAudioServiceOptions) {
    this.consent = options.consent;
    this.buffer = options.replayBuffer ?? new ReplayBuffer();
  }

  mode(): AmbientAudioMode {
    return this.currentMode;
  }

  async start(ownerId: string): Promise<void> {
    this.consent.require(ownerId);
    this.ownerId = ownerId;
    this.currentMode = "listening";
  }

  async pause(): Promise<void> {
    if (this.currentMode === "listening") {
      this.currentMode = "paused";
    }
  }

  async resume(): Promise<void> {
    if (!this.ownerId) {
      throw new Error("ambient audio service has not been started");
    }
    this.consent.require(this.ownerId);
    if (this.currentMode === "paused") {
      this.currentMode = "listening";
    }
  }

  async stop(): Promise<void> {
    this.currentMode = "stopped";
    this.ownerId = null;
    this.buffer.clear();
  }

  async pushFrame(frame: AudioFrame): Promise<void> {
    if (this.currentMode !== "listening") {
      throw new Error("ambient audio service is not listening");
    }
    this.buffer.push(frame);
  }

  recentAudio(seconds?: number): Int16Array {
    return this.buffer.readTail(seconds);
  }
}
