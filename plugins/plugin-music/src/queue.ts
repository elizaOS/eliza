import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { v4 } from "uuid";
import type { Broadcast } from "./core/broadcast";
import type { AudioCacheService } from "./services/audioCache";
import { createAudioStream } from "./utils/streamFallback";

interface VoicePlaybackHandle {
  finished?: Promise<void>;
}

/** Minimal voice pipeline from plugin-discord (avoids hard dependency here). */
export interface VoiceManagerLike {
  stopAudio(guildId: string, channel: number): Promise<void>;
  pauseAudio(guildId: string, channel: number): Promise<void>;
  resumeAudio(guildId: string, channel: number): Promise<void>;
  isPlaying(guildId: string, channel: number): Promise<boolean>;
  on(
    event: "audio:finished",
    handler: (data: { guildId: string; channel: number }) => void,
  ): void;
  off(
    event: "audio:finished",
    handler: (data: { guildId: string; channel: number }) => void,
  ): void;
  playAudio(
    stream: Readable,
    options: {
      guildId: string;
      channel: number;
      volume?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<VoicePlaybackHandle>;
}

interface DiscordServiceLike {
  voiceManager?: VoiceManagerLike;
}

/**
 * Represents a track in the music queue
 */
export interface QueuedTrack {
  id: string;
  url: string;
  title: string;
  duration?: number;
  requestedBy?: string;
  dedicatedTo?: string;
  dedicationMessage?: string;
  addedAt: number;
  stream?: Readable;
  audioMetadata?: {
    bitrate?: number;
    format?: string;
    sampleRate?: number;
    channels?: number;
    size?: number;
  };
}

/**
 * Options for cross-fading between tracks
 */
export interface CrossFadeOptions {
  enabled: boolean;
  duration: number; // Duration in milliseconds (default: 3000ms)
}

/**
 * Events emitted by the music queue
 */
export interface MusicQueueEvents {
  "track:starting": (track: QueuedTrack) => void;
  "track:started": (track: QueuedTrack) => void;
  "track:finished": (track: QueuedTrack, duration: number) => void;
  "track:error": (track: QueuedTrack, reason: string) => void;
}

/**
 * Music queue manager with cross-fading support
 */
export class MusicQueue extends EventEmitter {
  private queue: QueuedTrack[] = [];
  private currentTrack: QueuedTrack | null = null;
  private currentPlaybackHandle: VoicePlaybackHandle | null = null;
  private isPlaying = false;
  private isPaused = false;
  private guildId: string;
  private voiceManager: VoiceManagerLike | null;
  private crossFadeOptions: CrossFadeOptions = {
    enabled: true,
    duration: 3000,
  };
  private nextTrackPreBuffered: QueuedTrack | null = null;
  private readonly MUSIC_CHANNEL = 1;

  // Continuous stream for multiplexing
  private continuousStream: PassThrough | null = null;
  private nextTrackStream: Readable | null = null;
  private preBufferTimeout: NodeJS.Timeout | null = null;
  private trackPlayedCallback:
    | ((track: QueuedTrack, duration: number) => Promise<void>)
    | null = null;
  private audioCache: AudioCacheService | null;
  private runtime: IAgentRuntime | null = null;
  private broadcast: Broadcast | null = null; // Reference to broadcast for new architecture

  constructor(
    guildId: string,
    voiceManager: VoiceManagerLike | null,
    runtime?: IAgentRuntime,
    audioCache?: AudioCacheService,
  ) {
    super();
    this.guildId = guildId;
    this.voiceManager = voiceManager;
    this.audioCache = audioCache || null;
    this.runtime = runtime || null;
    this.continuousStream = new PassThrough();
  }

  /**
   * Set the broadcast for this queue (new architecture)
   * @param broadcast Broadcast instance to push audio to
   */
  setBroadcast(broadcast: Broadcast): void {
    this.broadcast = broadcast;
    logger.debug(`[MusicQueue:${this.guildId}] Broadcast reference set`);
  }

  /**
   * Register callback for when a track finishes playing
   */
  onTrackPlayed(
    callback: (track: QueuedTrack, duration: number) => Promise<void>,
  ): void {
    this.trackPlayedCallback = callback;
  }

  /**
   * Set cross-fade options
   */
  setCrossFadeOptions(options: Partial<CrossFadeOptions>): void {
    this.crossFadeOptions = { ...this.crossFadeOptions, ...options };
  }

  /**
   * Add a track to the queue
   */
  async addTrack(
    track: Omit<QueuedTrack, "id" | "addedAt">,
  ): Promise<QueuedTrack> {
    // Note: We skip pre-validation to avoid downloading the track twice
    // Playback validates the canonical stream path once the track reaches the head of queue.
    logger.debug(`Adding track to queue: ${track.title}`);

    const queuedTrack: QueuedTrack = {
      ...track,
      id: v4(),
      addedAt: Date.now(),
    };

    this.queue.push(queuedTrack);
    logger.debug(
      `Added track to queue: ${queuedTrack.title} (${queuedTrack.id})`,
    );

    // If nothing is playing, start playback in the background so the caller
    // (e.g. PLAY_AUDIO action handler) returns immediately and doesn't block
    // the chat while the track streams.
    if (!this.isPlaying && !this.currentTrack) {
      this.playNext().catch((err) => {
        logger.error(`[MusicQueue:${this.guildId}] playNext failed: ${err}`);
      });
    } else if (
      this.isPlaying &&
      !this.nextTrackPreBuffered &&
      this.queue.length === 1
    ) {
      this.preBufferNextTrack().catch((err) => {
        logger.debug(`[MusicQueue:${this.guildId}] preBuffer failed: ${err}`);
      });
    }

    return queuedTrack;
  }

  /**
   * Remove a track from the queue
   */
  removeTrack(trackId: string): boolean {
    const index = this.queue.findIndex((t) => t.id === trackId);
    if (index >= 0) {
      const track = this.queue[index];
      this.queue.splice(index, 1);
      logger.debug(`Removed track from queue: ${track.title}`);

      // If we removed the pre-buffered track, clear it
      if (this.nextTrackPreBuffered?.id === trackId) {
        this.nextTrackPreBuffered = null;
        this.nextTrackStream = null;
      }

      return true;
    }
    return false;
  }

  /**
   * Skip the current track.
   * Works for both legacy voiceManager and broadcast architectures.
   */
  async skip(): Promise<boolean> {
    if (!this.currentTrack) {
      return false;
    }

    logger.debug(`Skipping track: ${this.currentTrack.title}`);

    // Notify about track completion (with 0 duration since skipped)
    if (this.trackPlayedCallback) {
      await this.trackPlayedCallback(this.currentTrack, 0);
    }

    // Stop current playback on legacy path
    if (this.currentPlaybackHandle && this.voiceManager) {
      await this.voiceManager.stopAudio(this.guildId, this.MUSIC_CHANNEL);
      this.currentPlaybackHandle = null;
    }

    // Stop current broadcast track so playNext() can push the next one
    if (this.broadcast) {
      this.broadcast.stop();
    }

    // Play next track
    await this.playNext();

    return true;
  }

  /**
   * Pause playback.
   * For Discord voice: delegates to voiceManager.pauseAudio.
   * For broadcast (web): stops the broadcast StreamCore so HTTP clients
   * stop receiving new audio frames (they stay connected but hear silence).
   */
  async pause(): Promise<void> {
    if (!this.isPlaying || this.isPaused) {
      return;
    }

    this.isPaused = true;
    if (this.voiceManager) {
      await this.voiceManager.pauseAudio(this.guildId, this.MUSIC_CHANNEL);
    }
    if (this.broadcast) {
      this.broadcast.stop();
    }
    logger.debug("Playback paused");
  }

  /**
   * Resume playback.
   * For Discord voice: delegates to voiceManager.resumeAudio.
   * For broadcast (web): re-pushes the current track metadata so clients
   * know playback resumed. The actual audio stream is still wired; calling
   * broadcast.startSilence() unblocks the pipeline and the next pushTrack
   * will pick it back up.
   */
  async resume(): Promise<void> {
    if (!this.isPaused) {
      return;
    }

    this.isPaused = false;
    if (this.voiceManager) {
      await this.voiceManager.resumeAudio(this.guildId, this.MUSIC_CHANNEL);
    }
    if (this.broadcast) {
      this.broadcast.startSilence();
    }
    logger.debug("Playback resumed");
  }

  /**
   * Stop playback and clear queue.
   * Stops both legacy voiceManager and broadcast paths so all consumers
   * (Discord voice + HTTP stream clients) stop receiving audio.
   */
  async stop(): Promise<void> {
    this.isPlaying = false;
    this.isPaused = false;

    if (this.currentPlaybackHandle && this.voiceManager) {
      await this.voiceManager.stopAudio(this.guildId, this.MUSIC_CHANNEL);
      this.currentPlaybackHandle = null;
    }

    if (this.broadcast) {
      this.broadcast.stop();
    }

    if (this.preBufferTimeout) {
      clearTimeout(this.preBufferTimeout);
      this.preBufferTimeout = null;
    }

    this.currentTrack = null;
    this.nextTrackStream = null;
    this.nextTrackPreBuffered = null;

    logger.debug("Playback stopped");
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    this.cleanupPreBufferedStream();
    logger.debug("Queue cleared");
  }

  /**
   * Shuffle the queue
   */
  shuffle(): void {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    logger.debug("Queue shuffled");
  }

  /**
   * Get the queue
   */
  getQueue(): QueuedTrack[] {
    return [...this.queue];
  }

  /**
   * Get the current track
   */
  getCurrentTrack(): QueuedTrack | null {
    return this.currentTrack;
  }

  /**
   * Get whether playback is active
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Get whether playback is paused
   */
  getIsPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Get the continuous stream
   */
  getContinuousStream(): PassThrough | null {
    return this.continuousStream;
  }

  /**
   * Get audio stream for a track (cached or download)
   * Tries cache first (title-based, then URL-based), then downloads if not cached.
   * @param track - Track to get stream for
   * @param shouldCache - Whether to cache downloaded streams (default: true)
   * @returns Audio stream or null if failed
   */
  private async getAudioStreamForTrack(
    track: QueuedTrack,
    shouldCache: boolean = true,
    notifyOnFailure: boolean = true,
  ): Promise<Readable | null> {
    let stream: Readable | null = null;
    let lastErrorMessage: string | null = null;
    // Try cache first if available
    if (this.audioCache) {
      // First try with exact cache key (title-based)
      const cacheKey = {
        song: track.title,
        quality: "high" as const,
        url: track.url,
      };
      stream = await this.audioCache.getCachedAudio(cacheKey);

      // If not found by title, try finding by URL (in case title changed)
      if (!stream) {
        logger.debug(
          `Cache miss with title "${track.title}", trying URL lookup...`,
        );
        stream = await this.audioCache.findCachedAudioByUrl(track.url, "high");
      }

      if (stream) {
        logger.debug(`Using cached audio: ${track.title}`);
      }
    }

    // If still not cached, download using the canonical stream path
    if (!stream) {
      try {
        const streamResult = await createAudioStream(track.url);
        stream = streamResult.stream;

        logger.debug(
          `Stream created using ${streamResult.source} for: ${track.title}`,
        );

        // Cache for next time if cache available and shouldCache is true
        if (shouldCache && this.audioCache && stream) {
          const cacheKey = {
            song: track.title,
            quality: "high" as const,
            url: track.url,
          };
          // Download and cache in background (don't block playback)
          this.audioCache.downloadAndCache(cacheKey, track.url).catch((err) => {
            logger.debug(`Background caching failed: ${err}`);
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        lastErrorMessage = errorMessage;
        if (!stream) {
          logger.error(
            `Error creating stream for ${track.url}: ${errorMessage}`,
          );
        }
      }
    }

    if (!stream && notifyOnFailure) {
      this.emit(
        "track:error",
        track,
        lastErrorMessage || "No playable source found",
      );
    }

    return stream;
  }

  /**
   * Clean up pre-buffered stream
   */
  private cleanupPreBufferedStream(): void {
    if (this.nextTrackStream) {
      try {
        // Remove all listeners to prevent error propagation
        this.nextTrackStream.removeAllListeners();
        this.nextTrackStream = null;
        logger.debug("Cleaned up pre-buffered stream");
      } catch (error) {
        logger.debug(`Error cleaning up pre-buffered stream: ${error}`);
      }
    }
    this.nextTrackPreBuffered = null;
  }

  /**
   * Pre-buffer the next track for cross-fading
   */
  private async preBufferNextTrack(): Promise<void> {
    if (this.queue.length === 0 || this.nextTrackPreBuffered) {
      return;
    }

    const nextTrack = this.queue[0];
    logger.debug(`Pre-buffering next track: ${nextTrack.title}`);

    try {
      // Don't cache pre-buffered streams (they'll be cached when actually played)
      const stream = await this.getAudioStreamForTrack(nextTrack, false, false);

      if (stream) {
        // Add error handler to catch premature close errors
        stream.on("error", (error) => {
          // Only log if this stream is still the current pre-buffered stream
          if (this.nextTrackStream === stream) {
            logger.warn(
              `Pre-buffered stream error for ${nextTrack.title}: ${error.message}`,
            );
          }
        });

        this.nextTrackStream = stream;
        this.nextTrackPreBuffered = nextTrack;
        logger.debug(`Successfully pre-buffered: ${nextTrack.title}`);
      }
    } catch (error) {
      logger.error(`Error pre-buffering track: ${error}`);
      this.cleanupPreBufferedStream();
    }
  }

  /**
   * Play the next track in the queue
   */
  private async playNext(): Promise<void> {
    // ALWAYS emit track:finished for the current track first
    // WHY: Radio service listens to this event to refill the queue.
    // If we check queue.length before emitting, and queue is empty,
    // we return early and radio never gets a chance to refill.
    if (this.currentTrack) {
      const finishedTrack = this.currentTrack;
      logger.debug(`Track finished: ${finishedTrack.title}`);
      this.emit("track:finished", finishedTrack, 0); // Duration calculated elsewhere
      if (this.trackPlayedCallback) {
        await this.trackPlayedCallback(finishedTrack, 0);
      }
    }

    // If queue is empty, wait briefly for external services (like radio) to refill
    // WHY: The track:finished event above is async - radio service needs time to add tracks
    if (this.queue.length === 0) {
      logger.debug("Queue empty, waiting for external refill...");

      // Wait up to 3 seconds for queue to be refilled by external services
      const maxWaitMs = 3000;
      const checkIntervalMs = 200;
      let waitedMs = 0;

      while (waitedMs < maxWaitMs && this.queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
        waitedMs += checkIntervalMs;
      }

      // Check again after waiting
      if (this.queue.length === 0) {
        logger.warn(
          "Queue still empty after waiting for refill, stopping playback",
        );
        this.isPlaying = false;
        this.currentTrack = null;

        // Clean up pre-buffered stream if it exists
        this.cleanupPreBufferedStream();
        return;
      }

      logger.info(
        `Queue refilled while waiting (now has ${this.queue.length} tracks)`,
      );
    }

    let trackToPlay: QueuedTrack;
    let stream: Readable | null = null;

    // Use pre-buffered track if available
    if (
      this.nextTrackPreBuffered &&
      this.nextTrackStream &&
      this.queue[0]?.id === this.nextTrackPreBuffered.id
    ) {
      const nextTrack = this.queue.shift();
      if (!nextTrack) {
        logger.error(
          `[MusicQueue:${this.guildId}] Pre-buffered track missing from queue`,
        );
        this.cleanupPreBufferedStream();
        this.isPlaying = false;
        return;
      }
      trackToPlay = nextTrack;
      stream = this.nextTrackStream;
      this.nextTrackPreBuffered = null;
      this.nextTrackStream = null;
      logger.debug(`Using pre-buffered track: ${trackToPlay.title}`);

      // Trigger background caching for pre-buffered tracks
      // WHY: Pre-buffering disables caching to avoid double-download, but we still
      // want to cache for next time. Trigger caching now that we're actually playing.
      if (this.audioCache) {
        const cacheKey = {
          song: trackToPlay.title,
          quality: "high" as const,
          url: trackToPlay.url,
        };
        this.audioCache
          .downloadAndCache(cacheKey, trackToPlay.url)
          .catch((err) => {
            logger.debug(
              `Background caching of pre-buffered track failed: ${err}`,
            );
          });
      }
    } else {
      // Get next track from queue
      const nextTrack = this.queue.shift();
      if (!nextTrack) {
        logger.warn(
          `[MusicQueue:${this.guildId}] Queue emptied before playback could start`,
        );
        this.isPlaying = false;
        return;
      }
      trackToPlay = nextTrack;

      // Get audio stream (handles cache lookup, download, and caching)
      stream = await this.getAudioStreamForTrack(trackToPlay, true);

      // If still no stream, try next track
      if (!stream) {
        logger.error(`Failed to create stream for track: ${trackToPlay.title}`);
        await this.playNext();
        return;
      }
    }

    if (!stream) {
      logger.error(`Failed to create stream for track: ${trackToPlay.title}`);
      await this.playNext();
      return;
    }

    // NOTE: track:finished is now emitted at the START of playNext() to ensure
    // radio service can refill the queue before we check if it's empty.

    this.currentTrack = trackToPlay;

    // Emit track:starting event BEFORE pushing to broadcast
    // This allows DJ intro to announce BEFORE music starts playing
    this.emit("track:starting", trackToPlay);
    logger.info(`Track starting: ${trackToPlay.title}`);

    // Wait for DJ intro TTS to complete before starting music
    // WHY: DJ intro announces the track, so music should start after the announcement
    if (this.runtime) {
      try {
        const discordService = this.runtime.getService(
          "discord",
        ) as DiscordServiceLike | null;
        if (discordService?.voiceManager) {
          // Poll TTS channel (0) until it's not playing
          const maxWaitMs = 15000; // Max 15 seconds
          const pollIntervalMs = 500; // Check every 500ms
          let waitedMs = 0;

          while (waitedMs < maxWaitMs) {
            const isTTSPlaying = await discordService.voiceManager.isPlaying(
              this.guildId,
              0,
            );
            if (!isTTSPlaying) {
              logger.debug(
                `[MusicQueue:${this.guildId}] TTS finished, starting music`,
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            waitedMs += pollIntervalMs;
          }

          if (waitedMs >= maxWaitMs) {
            logger.warn(
              `[MusicQueue:${this.guildId}] TTS still playing after ${maxWaitMs}ms, starting music anyway`,
            );
          }
        }
      } catch (error) {
        logger.debug(
          `[MusicQueue:${this.guildId}] Could not check TTS status: ${error}`,
        );
        // Fall back to delay
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } else {
      // No runtime, use delay
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    this.isPlaying = true;

    // ARCHITECTURE DECISION: Broadcast vs Legacy
    //
    // WHY ONLY ONE PATH:
    // A Node.js stream can only be consumed once. If we push to broadcast AND
    // call voiceManager.playAudio(), both try to read the same stream, causing
    // race conditions and "stream ended" errors.
    //
    // If broadcast is available, use it exclusively. The auto-wiring in MusicService
    // subscribes Discord to the broadcast, so audio flows:
    //   Stream → Broadcast → StreamCore → StreamMultiplexer → DiscordAudioSink → Discord
    //
    // Legacy path only used when broadcast is NOT available (backward compatibility).

    if (this.broadcast) {
      // NEW ARCHITECTURE: Feed audio into broadcast
      logger.info(
        `[MusicQueue:${this.guildId}] Using broadcast architecture for: ${trackToPlay.title}`,
      );
      try {
        // Push track to broadcast AFTER announcing - DJ intro can pause if needed
        await this.broadcast.pushTrack(stream, {
          title: trackToPlay.title,
          url: trackToPlay.url,
          duration: trackToPlay.duration,
          requestedBy: trackToPlay.requestedBy,
        });

        logger.info(
          `[MusicQueue:${this.guildId}] Track pushed to broadcast, waiting for Discord subscription...`,
        );

        // Emit track:started event after music actually starts
        this.emit("track:started", trackToPlay);
        logger.info(`Now playing: ${trackToPlay.title}`);

        // Pre-buffer next track for smooth transitions
        if (this.queue.length > 0) {
          const timeUntilPreBuffer =
            Math.max(0, (trackToPlay.duration || 180) - 30) * 1000;
          this.preBufferTimeout = setTimeout(() => {
            this.preBufferNextTrack();
          }, timeUntilPreBuffer);
        }

        // Wait for playback to finish.
        // Discord: wait for VoiceManager audio:finished (real-time playback).
        // Non-Discord (HTTP streaming): wait for the broadcast track:ended
        // event which fires when the source stream is consumed, then hold for
        // the track duration so HTTP clients receive the full audio.
        if (this.voiceManager) {
          const voiceManager = this.voiceManager;
          await new Promise<void>((resolve) => {
            const onFinished = (data: { guildId: string; channel: number }) => {
              if (
                data.guildId === this.guildId &&
                data.channel === this.MUSIC_CHANNEL
              ) {
                voiceManager.off("audio:finished", onFinished);
                resolve();
              }
            };
            voiceManager.on("audio:finished", onFinished);
          });
        } else {
          // No voiceManager — wait for broadcast track:ended then hold for
          // the track duration so HTTP streaming clients get the full audio.
          await new Promise<void>((resolve) => {
            const onTrackEnded = () => {
              this.broadcast?.off("track:ended", onTrackEnded);
              const holdMs = (trackToPlay.duration || 180) * 1000;
              setTimeout(resolve, holdMs);
            };
            this.broadcast?.on("track:ended", onTrackEnded);
          });
        }

        // Track finished, play next
        logger.debug(`Track finished: ${trackToPlay.title}`);
        await this.playNext();
      } catch (error) {
        logger.error(
          `[MusicQueue:${this.guildId}] Error in broadcast playback: ${error}`,
        );
        this.isPlaying = false;
        await this.playNext();
      }
    } else if (this.voiceManager) {
      // LEGACY ARCHITECTURE: Direct playback through voice manager
      // Only used when broadcast is not available and voiceManager exists
      try {
        this.currentPlaybackHandle = await this.voiceManager.playAudio(stream, {
          guildId: this.guildId,
          channel: this.MUSIC_CHANNEL,
        });

        // Emit track:started event (after playback begins)
        this.emit("track:started", trackToPlay);
        logger.info(`Now playing: ${trackToPlay.title}`);

        // Pre-buffer next track for smooth transitions
        if (this.queue.length > 0) {
          const timeUntilPreBuffer =
            Math.max(0, (trackToPlay.duration || 180) - 30) * 1000;
          this.preBufferTimeout = setTimeout(() => {
            this.preBufferNextTrack();
          }, timeUntilPreBuffer);
        }

        // Wait for track to finish
        if (this.currentPlaybackHandle?.finished) {
          await this.currentPlaybackHandle.finished;
        }

        // Track finished, play next
        logger.debug(`Track finished: ${trackToPlay.title}`);
        await this.playNext();
      } catch (error) {
        logger.error(`Error during playback: ${error}`);
        this.isPlaying = false;
        await this.playNext();
      }
    } else {
      // No broadcast and no voiceManager — nothing can consume the stream.
      logger.warn(
        `[MusicQueue:${this.guildId}] No broadcast or voiceManager — track "${trackToPlay.title}" cannot be played.`,
      );
      this.emit("track:error", trackToPlay, "No playback target available");
      this.isPlaying = false;
      await this.playNext();
    }
  }
}
