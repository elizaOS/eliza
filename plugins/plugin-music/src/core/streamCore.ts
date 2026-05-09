import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { logger } from "@elizaos/core";
import {
  normalizeOpusBroadcastStream,
  OPUS_NORMALIZE_FFMPEG,
  OPUS_NORMALIZE_INPUT,
} from "../utils/opusBroadcastNormalize";

export type StreamCoreState = "stopped" | "playing" | "silence";

export interface TrackMetadata {
  title: string;
  url: string;
  duration?: number;
  requestedBy?: string;
}

interface StreamCoreHandlers {
  onEnd: () => void;
  onError: (error: Error) => void;
}

type StreamCoreSource = Readable & {
  _streamCoreHandlers?: StreamCoreHandlers;
};

function isWritableStream(value: unknown): value is NodeJS.WritableStream {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { write?: unknown }).write === "function" &&
    typeof (value as { end?: unknown }).end === "function"
  );
}

/**
 * StreamCore - The heart of the audio broadcast system
 *
 * WHY THIS EXISTS:
 * Audio streams have a lifecycle: track plays → track ends → silence → next track.
 * Without explicit silence handling, when the queue empties:
 * - Discord voice connection times out and disconnects
 * - Web listeners get "connection closed" errors
 * - Reconnecting users hear nothing until the next track
 *
 * THE SOLUTION:
 * StreamCore ensures the output stream NEVER ends. It continuously emits frames:
 * - When a track is playing → emit track audio frames
 * - When queue is empty → emit silence frames (20ms intervals)
 *
 * This keeps all connections alive ("dead air" instead of "dead connection").
 *
 * WHY 20MS SILENCE FRAMES:
 * Discord/Opus operates on 20ms frames. Emitting silence at the same rate as
 * real audio makes the transition seamless - consumers don't know the difference
 * between intentional silence and a quiet song.
 *
 * WHY PASSTHROUGH OUTPUT:
 * The output stream never closes - it's piped to the multiplexer which fans it out.
 * We swap the SOURCE (track stream vs silence generator) but keep the output alive.
 *
 * Responsibilities:
 * - Manage the canonical audio stream
 * - Generate silence when no track is playing
 * - Emit consistent PCM/Opus frames
 * - Track broadcast state
 *
 * This is an internal class used by the Broadcast class.
 */
export class StreamCore extends EventEmitter {
  private state: StreamCoreState = "stopped";
  private currentSource: Readable | null = null;
  private outputStream: PassThrough;
  private silenceInterval: NodeJS.Timeout | null = null;
  private currentMetadata: TrackMetadata | null = null;

  // Silence generation
  private readonly SILENCE_FRAME_SIZE = 3840; // 20ms of silence at 48kHz stereo 16-bit PCM
  private readonly SILENCE_INTERVAL_MS = 20; // 20ms frames

  constructor() {
    super();
    this.outputStream = new PassThrough({
      highWaterMark: 128 * 1024, // 128KB buffer
    });
  }

  /**
   * Get the output stream that emits audio data
   */
  getOutputStream(): PassThrough {
    return this.outputStream;
  }

  /**
   * Get current state
   */
  getState(): StreamCoreState {
    return this.state;
  }

  /**
   * Get current track metadata
   */
  getCurrentMetadata(): TrackMetadata | null {
    return this.currentMetadata;
  }

  /**
   * Push a track stream into the core
   * @param stream Audio stream (PCM or Opus)
   * @param metadata Track metadata
   */
  async pushTrackStream(
    stream: Readable,
    metadata: TrackMetadata,
  ): Promise<void> {
    // Stop silence if playing
    this.stopSilence();

    // Clean up old source if exists
    if (this.currentSource) {
      this.detachCurrentSource();
    }

    const media = normalizeOpusBroadcastStream(stream);
    this.currentSource = media;
    this.currentMetadata = metadata;
    this.state = "playing";

    logger.debug(`[StreamCore] Playing track: ${metadata.title}`);
    this.emit("stateChange", this.state);
    this.emit("metadata", metadata);

    // Pipe stream to output (possibly via ffmpeg Ogg Opus remux for web clients)
    media.pipe(this.outputStream, { end: false });

    // Handle stream events
    const onError = (error: Error) => {
      logger.error(`[StreamCore] Track stream error: ${error.message}`);
      this.handleTrackEnd();
    };

    const onEnd = () => {
      logger.debug(`[StreamCore] Track stream ended`);
      this.handleTrackEnd();
    };

    media.on("error", onError);
    media.on("end", onEnd);
    media.on("close", onEnd);

    // Store handlers for cleanup
    (media as StreamCoreSource)._streamCoreHandlers = { onError, onEnd };
  }

  /**
   * Start generating silence frames
   * Used when queue is empty to keep connections alive
   *
   * WHY SILENCE GENERATION:
   * When the queue empties, if we stop emitting audio frames:
   * - Discord voice timeout (30-60s) → disconnects
   * - Web listeners get EOF → connection closes
   * - Users have to manually reconnect
   *
   * Instead, we emit silence frames (zeros) at the same rate as real audio.
   * To Discord and browsers, it's just a quiet moment, not a closed stream.
   *
   * WHY 20MS INTERVALS:
   * Discord/Opus operates on 20ms frames (960 samples at 48kHz).
   * Matching this interval makes transitions seamless:
   *   Track ends → 20ms silence → 20ms silence → new track starts
   *
   * No gap, no pop, no reconnection needed.
   *
   * WHY BUFFER SIZE 3840:
   * 48kHz sample rate × 2 channels (stereo) × 2 bytes (16-bit) × 0.02s = 3840 bytes
   * This is one frame of PCM audio. We allocate zeros to create silence.
   */
  startSilence(): void {
    if (this.silenceInterval) {
      return; // Already generating silence
    }

    this.state = "silence";
    logger.debug("[StreamCore] Starting silence generation");
    this.emit("stateChange", this.state);

    // Generate silence frames at regular intervals
    this.silenceInterval = setInterval(() => {
      const silenceFrame = Buffer.alloc(this.SILENCE_FRAME_SIZE);

      // Try to write silence frame
      // WHY CHECK destroyed/writableEnded:
      // If output stream is destroyed (service stopping), don't write.
      // Prevents errors during shutdown.
      if (!this.outputStream.destroyed && !this.outputStream.writableEnded) {
        this.outputStream.write(silenceFrame);
      }
    }, this.SILENCE_INTERVAL_MS);

    // Emit metadata indicating silence
    this.currentMetadata = {
      title: "(Silence - Queue Empty)",
      url: "",
    };
    this.emit("metadata", this.currentMetadata);
  }

  /**
   * Stop generating silence frames
   */
  stopSilence(): void {
    if (this.silenceInterval) {
      clearInterval(this.silenceInterval);
      this.silenceInterval = null;
      logger.debug("[StreamCore] Stopped silence generation");
    }
  }

  /**
   * Stop the stream core completely
   */
  stop(): void {
    logger.debug("[StreamCore] Stopping stream core");

    this.stopSilence();
    this.detachCurrentSource();

    this.state = "stopped";
    this.currentMetadata = null;
    this.emit("stateChange", this.state);

    // Don't end the output stream - keep it open for reconnections
    // Just stop feeding it data
  }

  /**
   * Handle track end (switch to silence or wait for next track)
   */
  private handleTrackEnd(): void {
    // Emit track:ended event before cleanup
    // WHY: MusicQueue listens for this to know when to play the next track
    this.emit("track:ended", this.currentMetadata);

    this.detachCurrentSource();

    // DO NOT auto-start silence generation
    // WHY: Track audio is opus-encoded, but silence frames are raw PCM.
    // Writing PCM to an opus stream corrupts it, causing Discord to fail/stop early.
    // The MusicQueue is waiting for VoiceManager's audio:finished event, which fires
    // when Discord actually finishes playing (based on the buffered opus data).
    // Silence generation is only useful for web streaming where we control the format.
    //
    // For web streaming, call startSilence() explicitly from the orchestrator layer
    // AFTER ensuring format consistency (e.g., transcoding all audio to PCM first).
    this.state = "stopped";
    this.emit("stateChange", this.state);
  }

  /**
   * Detach and clean up current source stream
   */
  private detachCurrentSource(): void {
    if (!this.currentSource) {
      return;
    }

    const src = this.currentSource;
    const ff = (
      src as { [OPUS_NORMALIZE_FFMPEG]?: ChildProcessWithoutNullStreams }
    )[OPUS_NORMALIZE_FFMPEG];
    const upstream = (src as { [OPUS_NORMALIZE_INPUT]?: Readable })[
      OPUS_NORMALIZE_INPUT
    ];

    src.unpipe(this.outputStream);

    const handlers = (
      src as {
        _streamCoreHandlers?: {
          onError: (e: Error) => void;
          onEnd: () => void;
        };
      }
    )._streamCoreHandlers;
    if (handlers) {
      src.removeListener("error", handlers.onError);
      src.removeListener("end", handlers.onEnd);
      src.removeListener("close", handlers.onEnd);
      delete (src as { _streamCoreHandlers?: unknown })._streamCoreHandlers;
    }

    if (ff) {
      try {
        if (upstream) {
          upstream.unpipe(ff.stdin);
        }
      } catch {
        /* ignore */
      }
      if (!ff.killed) {
        ff.kill("SIGKILL");
      }
      try {
        if (upstream && !upstream.destroyed) {
          upstream.destroy();
        }
      } catch {
        /* ignore */
      }
    } else if (upstream) {
      try {
        if (isWritableStream(src)) {
          upstream.unpipe(src);
        }
      } catch {
        /* ignore */
      }
      try {
        if (!upstream.destroyed) {
          upstream.destroy();
        }
      } catch {
        /* ignore */
      }
    }

    if (!src.destroyed) {
      src.destroy();
    }

    this.currentSource = null;
  }

  /**
   * Destroy the stream core and clean up all resources
   */
  destroy(): void {
    logger.debug("[StreamCore] Destroying stream core");

    this.stopSilence();
    this.detachCurrentSource();

    if (!this.outputStream.destroyed) {
      this.outputStream.end();
      this.outputStream.destroy();
    }

    this.removeAllListeners();
  }
}
