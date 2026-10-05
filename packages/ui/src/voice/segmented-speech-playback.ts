import { splitSpeechSegments } from "./speech-segments.ts";
export interface SegmentedSpeechState {
  phase: "idle" | "preparing" | "playing" | "waiting";
  caption: string;
}
export interface SpeechAudioEnvironment {
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  audio: (url: string) => HTMLAudioElement;
}
export class SpeechPlaybackError extends Error {
  readonly code: "invalid-audio" | "playback";
  constructor(code: "invalid-audio" | "playback", cause?: unknown) {
    super(code, { cause });
    this.code = code;
  }
}
export interface SegmentedSpeechOptions {
  synthesize: (text: string) => Promise<unknown>;
  changed: (state: SegmentedSpeechState) => void;
  environment?: SpeechAudioEnvironment;
}
/** Sequential encoded-audio playback, distinct from realtime PCM streaming. */
export class SegmentedSpeechPlayback {
  private options: SegmentedSpeechOptions;
  private environment: SpeechAudioEnvironment;
  private generation = 0;
  private running = false;
  private rate = 1;
  private player: HTMLAudioElement | null = null;
  private url: string | null = null;
  private finish: (() => void) | null = null;
  constructor(options: SegmentedSpeechOptions) {
    this.options = { ...options };
    this.environment = options.environment ?? {
      createUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => URL.revokeObjectURL(url),
      audio: (url) => new Audio(url),
    };
  }
  get pending(): boolean {
    return this.running;
  }
  setRate(rate: number): void {
    this.rate = rate;
    if (this.player) {
      this.player.defaultPlaybackRate = rate;
      this.player.playbackRate = rate;
    }
  }
  private release(): void {
    this.finish?.();
    this.finish = null;
    const player = this.player;
    this.player = null;
    const url = this.url;
    this.url = null;
    try {
      player?.pause();
    } finally {
      if (url) this.environment.revokeUrl(url);
    }
  }
  stop(): void {
    ++this.generation;
    this.running = false;
    try {
      this.release();
    } finally {
      this.options.changed({ phase: "idle", caption: "" });
    }
  }
  async speak(text: string): Promise<void> {
    if (this.running || !text) return;
    this.running = true;
    const ticket = ++this.generation;
    try {
      for (const segment of splitSpeechSegments(text)) {
        if (ticket !== this.generation) return;
        this.options.changed({ phase: "preparing", caption: "" });
        if (ticket !== this.generation) return;
        const value = await this.options.synthesize(segment);
        if (ticket !== this.generation) return;
        const result = value as {
          audioBase64: string;
          mimeType: string;
        } | null;
        if (
          !result ||
          typeof result.audioBase64 !== "string" ||
          !result.audioBase64 ||
          typeof result.mimeType !== "string" ||
          !result.mimeType.startsWith("audio/")
        )
          throw new SpeechPlaybackError("invalid-audio");
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = Uint8Array.from(atob(result.audioBase64), (char) =>
            char.charCodeAt(0),
          );
        } catch (error) {
          throw new SpeechPlaybackError("invalid-audio", error);
        }
        this.url = this.environment.createUrl(
          new Blob([bytes], { type: result.mimeType }),
        );
        const player = this.environment.audio(this.url);
        this.player = player;
        player.defaultPlaybackRate = this.rate;
        player.playbackRate = this.rate;
        player.preservesPitch = true;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            this.finish = null;
            player.onended = null;
            player.onerror = null;
            player.onplaying = null;
            player.onwaiting = null;
            if (error) reject(error);
            else resolve();
          };
          this.finish = () => finish();
          const playing = () => {
            if (!settled && ticket === this.generation)
              this.options.changed({ phase: "playing", caption: segment });
          };
          player.onended = () => finish();
          player.onerror = () => finish(new SpeechPlaybackError("playback"));
          player.onplaying = playing;
          player.onwaiting = () => {
            if (!settled && ticket === this.generation)
              this.options.changed({ phase: "waiting", caption: "" });
          };
          try {
            void player.play().then(
              () => {
                if (ticket !== this.generation || settled) {
                  player.pause();
                  return;
                }
                playing();
              },
              (error) => finish(new SpeechPlaybackError("playback", error)),
            );
          } catch (error) {
            finish(new SpeechPlaybackError("playback", error));
          }
        });
        if (ticket !== this.generation) return;
        this.release();
      }
    } catch (error) {
      if (ticket === this.generation) throw error;
    } finally {
      if (ticket === this.generation) {
        this.running = false;
        try {
          this.release();
        } finally {
          this.options.changed({ phase: "idle", caption: "" });
        }
      }
    }
  }
}
