import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { logger } from "@elizaos/core";
import type {
  AudioSubscription,
  BroadcastState,
  BroadcastTrackMetadata,
  IAudioBroadcast,
} from "../contracts";
import { StreamCore, type TrackMetadata } from "./streamCore";
import { StreamMultiplexer } from "./streamMultiplexer";

/**
 * Broadcast - Implements IAudioBroadcast contract
 *
 * WHY THIS FACADE:
 * Consumers (Discord, Web) shouldn't care about internal complexity (StreamCore,
 * StreamMultiplexer, silence generation, backpressure policies). They just want:
 * - subscribe() → get audio stream
 * - unsubscribe() → stop receiving audio
 * - events → know what's playing
 *
 * This class is the ONLY public interface. Everything else (core components) is internal.
 *
 * ARCHITECTURE LAYERS:
 * ```
 * Consumer Layer: Discord, Web, etc. → call subscribe()
 *       ↓
 * Facade Layer: Broadcast (this class) → implements IAudioBroadcast
 *       ↓
 * Generation Layer: StreamCore → produces audio (tracks or silence)
 *       ↓
 * Distribution Layer: StreamMultiplexer → fans out to N consumers
 * ```
 *
 * WHY WIRE THEM IN CONSTRUCTOR:
 * StreamCore → StreamMultiplexer wiring happens once. The output stream is long-lived
 * (never closes). Tracks come and go, but the pipeline stays connected.
 *
 * This is the public interface that consumers (Discord, Web, etc.) interact with.
 * Internally uses StreamCore for audio generation and StreamMultiplexer for fan-out.
 */
export class Broadcast extends EventEmitter implements IAudioBroadcast {
  readonly guildId: string;
  private streamCore: StreamCore;
  private multiplexer: StreamMultiplexer;
  private _state: BroadcastState = "stopped";

  constructor(guildId: string) {
    super();
    this.guildId = guildId;

    // Create internal components
    this.streamCore = new StreamCore();
    this.multiplexer = new StreamMultiplexer({
      policy: "LIVE_DROP", // Radio-style: drop frames for slow consumers
      bufferSize: 128 * 1024, // 128KB per consumer
      logDrops: false, // Enable for debugging
    });

    // Wire up StreamCore output to Multiplexer
    const coreOutput = this.streamCore.getOutputStream();
    this.multiplexer.setSource(coreOutput);

    // Forward state changes from StreamCore
    this.streamCore.on("stateChange", (coreState) => {
      const broadcastState = this.mapCoreStateToBroadcastState(coreState);
      this._state = broadcastState;
      this.emit("stateChange", broadcastState);
    });

    // Forward metadata changes from StreamCore
    this.streamCore.on("metadata", (metadata: TrackMetadata) => {
      const broadcastMetadata: BroadcastTrackMetadata = {
        title: metadata.title,
        url: metadata.url,
        duration: metadata.duration,
        requestedBy: metadata.requestedBy,
      };
      this.emit("metadata", broadcastMetadata);
    });

    // Forward track:ended event from StreamCore
    // WHY: MusicQueue needs to know when a track finishes to play the next one
    this.streamCore.on("track:ended", (metadata: TrackMetadata) => {
      this.emit("track:ended", metadata);
    });

    logger.debug(`[Broadcast] Created broadcast for guild ${guildId}`);
  }

  /**
   * Get current broadcast state
   */
  get state(): BroadcastState {
    return this._state;
  }

  /**
   * Subscribe to this broadcast
   * @param consumerId Unique identifier for the consumer
   * @returns AudioSubscription with stream and unsubscribe method
   */
  subscribe(consumerId: string): AudioSubscription {
    logger.info(
      `[Broadcast:${this.guildId}] Consumer ${consumerId} subscribing`,
    );

    // Get a consumer stream from the multiplexer
    const stream = this.multiplexer.addConsumer(consumerId);
    logger.info(
      `[Broadcast:${this.guildId}] Got stream for ${consumerId}, readable: ${stream?.readable}`,
    );

    // Create subscription object
    const subscription: AudioSubscription = {
      consumerId,
      stream,
      unsubscribe: () => {
        logger.debug(
          `[Broadcast:${this.guildId}] Consumer ${consumerId} unsubscribing`,
        );
        this.multiplexer.removeConsumer(consumerId);
        this.emit("subscriberRemoved", consumerId);
      },
    };

    this.emit("subscriberAdded", consumerId);
    return subscription;
  }

  /**
   * Get current subscriber count
   */
  getSubscriberCount(): number {
    return this.multiplexer.getConsumerCount();
  }

  /**
   * Check if a consumer is subscribed
   */
  isSubscribed(consumerId: string): boolean {
    const hasConsumer = this.multiplexer.hasConsumer(consumerId);
    logger.debug(
      `[Broadcast:${this.guildId}] isSubscribed(${consumerId}) = ${hasConsumer}`,
    );
    return hasConsumer;
  }

  /**
   * Push a track stream into the broadcast (internal API for MusicQueue)
   * @param stream Audio stream
   * @param metadata Track metadata
   */
  async pushTrack(
    stream: Readable,
    metadata: BroadcastTrackMetadata,
  ): Promise<void> {
    const trackMetadata: TrackMetadata = {
      title: metadata.title,
      url: metadata.url,
      duration: metadata.duration,
      requestedBy: metadata.requestedBy,
    };

    await this.streamCore.pushTrackStream(stream, trackMetadata);
  }

  /**
   * Start silence generation (internal API)
   */
  startSilence(): void {
    this.streamCore.startSilence();
  }

  /**
   * Stop the broadcast (internal API)
   */
  stop(): void {
    logger.debug(`[Broadcast:${this.guildId}] Stopping broadcast`);
    this.streamCore.stop();
  }

  /**
   * Destroy the broadcast and clean up resources
   */
  destroy(): void {
    logger.debug(`[Broadcast:${this.guildId}] Destroying broadcast`);

    // Stop core
    this.streamCore.stop();
    this.streamCore.destroy();

    // Destroy multiplexer
    this.multiplexer.destroy();

    // Remove all event listeners
    this.removeAllListeners();
  }

  /**
   * Get statistics about the broadcast
   */
  getStats(): {
    state: BroadcastState;
    subscriberCount: number;
    consumerStats: Map<string, { droppedFrames: number; totalFrames: number }>;
  } {
    return {
      state: this._state,
      subscriberCount: this.getSubscriberCount(),
      consumerStats: this.multiplexer.getAllStats(),
    };
  }

  /**
   * Map StreamCore state to BroadcastState
   */
  private mapCoreStateToBroadcastState(coreState: string): BroadcastState {
    switch (coreState) {
      case "playing":
        return "live";
      case "silence":
        return "silence";
      default:
        return "stopped";
    }
  }
}
