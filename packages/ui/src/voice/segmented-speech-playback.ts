import type { SpeechAudioFrame } from "@elizaos/cloud-sdk/native-speech-stream";
import { splitSpeechSegments } from "./speech-segments.ts";
import {
  createSpeechWordTimeline,
  type SpeechWordRange,
} from "./speech-word-timeline.ts";
export interface SegmentedSpeechState {
  phase: "idle" | "preparing" | "playing" | "waiting";
  caption: string;
  /** Present for progressive playback; null when confirmed timing is unavailable. */
  word?: SpeechWordRange | null;
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
export type SegmentedSpeechOptions = {
  /** Host policy may keep an already prepared utterance intact. */
  segments?: (text: string) => readonly string[];
  changed: (state: SegmentedSpeechState) => void;
  environment?: SpeechAudioEnvironment;
} & (
  | { synthesize: (text: string) => Promise<unknown>; attach?: never }
  | {
      synthesize?: never;
      /** Attach exactly one utterance. loaded resolves only after explicit EOF. */
      attach: (
        player: HTMLAudioElement,
        text: string,
        callbacks: {
          onReady: (renderedSpeed: number | null) => void;
          onFrame: (frame: SpeechAudioFrame) => void;
        },
      ) => { loaded: Promise<unknown>; dispose: () => void };
    }
);
/** Sequential encoded-audio playback, distinct from realtime PCM streaming. */
export class SegmentedSpeechPlayback {
  private options: SegmentedSpeechOptions;
  private environment: SpeechAudioEnvironment;
  private generation = 0;
  private running = false;
  private rate = 1;
  private renderedSpeed = 1;
  private detach: (() => void) | null = null;
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
    if (!Number.isFinite(rate) || rate <= 0)
      throw new RangeError("Invalid speech rate");
    this.rate = rate;
    this.applyRate();
  }
  private applyRate(): void {
    const rate = this.rate / this.renderedSpeed;
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
    const detach = this.detach;
    this.detach = null;
    this.renderedSpeed = 1;
    try {
      player?.pause();
    } finally {
      try {
        detach?.();
      } finally {
        if (url) this.environment.revokeUrl(url);
      }
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
  private playProgressive(
    segment: string,
    ticket: number,
    attach: NonNullable<SegmentedSpeechOptions["attach"]>,
  ): Promise<void> {
    const player = this.environment.audio("");
    this.player = player;
    player.preservesPitch = true;
    this.applyRate();
    const timeline = createSpeechWordTimeline(segment);
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let ready = false;
      let loaded = false;
      let ended = false;
      let playing = false;
      let publishedWord: SpeechWordRange | null | undefined;
      let frame: number | null = null;
      const active = () => !done && ticket === this.generation;
      const cancelFrame = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      };
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        cancelFrame();
        this.finish = null;
        player.onended = null;
        player.onerror = null;
        player.onplaying = null;
        player.onwaiting = null;
        player.onpause = null;
        player.ontimeupdate = null;
        player.onseeking = null;
        player.onseeked = null;
        if (error) reject(error);
        else resolve();
      };
      this.finish = () => finish();
      const publish = () => {
        if (!active() || !playing) return;
        const word = timeline.at(player.currentTime);
        if (
          publishedWord !== undefined &&
          (word === null
            ? publishedWord === null
            : publishedWord?.from === word.from &&
              publishedWord.to === word.to &&
              publishedWord.start === word.start &&
              publishedWord.end === word.end)
        )
          return;
        publishedWord = word;
        this.options.changed({ phase: "playing", caption: segment, word });
      };
      const animate = () => {
        frame = null;
        publish();
        if (active() && playing && typeof requestAnimationFrame === "function")
          frame = requestAnimationFrame(animate);
      };
      const resume = () => {
        if (!active() || ended) return;
        playing = true;
        cancelFrame();
        animate();
      };
      const wait = () => {
        if (!active()) return;
        playing = false;
        publishedWord = undefined;
        cancelFrame();
        this.options.changed({
          phase: "waiting",
          caption: segment,
          word: null,
        });
      };
      player.onplaying = resume;
      player.onwaiting = wait;
      player.onpause = wait;
      player.ontimeupdate = publish;
      player.onseeking = wait;
      player.onseeked = () => {
        if (!player.paused) resume();
      };
      player.onended = () => {
        if (!active()) return;
        ended = true;
        if (loaded) finish();
        else wait();
      };
      player.onerror = () => finish(new SpeechPlaybackError("playback"));
      try {
        const attachment = attach(player, segment, {
          onFrame: (value) => {
            if (!active()) return;
            timeline.append(value.alignment);
            publish();
          },
          onReady: (speed) => {
            if (!active() || ready) return;
            ready = true;
            if (speed !== null && (!Number.isFinite(speed) || speed <= 0)) {
              finish(new SpeechPlaybackError("invalid-audio"));
              return;
            }
            this.renderedSpeed = speed ?? 1;
            try {
              this.applyRate();
              void player.play().then(
                () => {
                  if (!active()) {
                    player.pause();
                    return;
                  }
                  resume();
                },
                (error) => finish(new SpeechPlaybackError("playback", error)),
              );
            } catch (error) {
              finish(new SpeechPlaybackError("playback", error));
            }
          },
        });
        // Observe rejection even if a synchronous callback stopped this operation.
        void attachment.loaded.then(
          () => {
            if (!active()) return;
            loaded = true;
            timeline.finish();
            if (!ready) finish(new SpeechPlaybackError("invalid-audio"));
            else if (ended) finish();
            else publish();
          },
          (error) => finish(new SpeechPlaybackError("playback", error)),
        );
        if (!active()) attachment.dispose();
        else this.detach = () => attachment.dispose();
      } catch (error) {
        finish(new SpeechPlaybackError("playback", error));
      }
    });
  }
  /** Optional observer receives only the current operation's settled result, after cleanup. */
  async speak(
    text: string,
    settled?: (error: unknown | null) => void,
  ): Promise<void> {
    if (this.running || !text) return;
    this.running = true;
    const ticket = ++this.generation;
    let failure: unknown | null = null;
    try {
      for (const segment of (this.options.segments ?? splitSpeechSegments)(
        text,
      )) {
        if (ticket !== this.generation) return;
        this.options.changed({ phase: "preparing", caption: "" });
        if (ticket !== this.generation) return;
        if (this.options.attach) {
          await this.playProgressive(segment, ticket, this.options.attach);
          if (ticket !== this.generation) return;
          this.release();
          continue;
        }
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
      if (ticket === this.generation)
        failure = error ?? new SpeechPlaybackError("playback");
    } finally {
      if (ticket === this.generation) {
        this.running = false;
        try {
          this.release();
        } catch (error) {
          failure ??= error ?? new SpeechPlaybackError("playback");
        }
        this.options.changed({ phase: "idle", caption: "" });
      }
    }
    if (ticket === this.generation) {
      if (settled) settled(failure);
      else if (failure !== null) throw failure;
    }
  }
}
