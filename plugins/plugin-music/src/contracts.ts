import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/**
 * Audio Broadcast Contracts
 *
 * WHY THIS EXISTS:
 * These contracts define how audio flows from music-player to consumers (Discord, Web, etc.)
 * without creating dependencies between plugins. This allows:
 *
 * 1. Plugin Independence: music-player doesn't know about Discord, Discord doesn't know
 *    about music-player internals. They communicate through contracts.
 *
 * 2. Multiple Consumers: Multiple outputs (Discord + 5 web listeners) can all receive
 *    the same broadcast independently without affecting each other.
 *
 * 3. Resilience: If Discord disconnects, the broadcast continues. Web listeners are
 *    unaffected. Discord can reconnect and resume from live position.
 *
 * 4. No Radio Dependency: music-player + discord work together without needing the
 *    radio plugin. Radio can add orchestration features, but isn't required.
 */

/**
 * Subscription to an audio broadcast stream
 *
 * WHY: Each consumer needs independent control over their subscription.
 * One consumer unsubscribing shouldn't affect others.
 */
export interface AudioSubscription {
  /** Unique identifier for this subscription */
  readonly consumerId: string;

  /** The audio stream (PCM or Opus frames) */
  readonly stream: Readable;

  /** Unsubscribe from the broadcast */
  unsubscribe(): void;
}

/**
 * Audio broadcast state
 */
export type BroadcastState = "live" | "silence" | "stopped";

/**
 * Track metadata for broadcast events
 */
export interface BroadcastTrackMetadata {
  title: string;
  url: string;
  duration?: number;
  requestedBy?: string;
}

/**
 * Audio broadcast interface - represents a continuous audio stream
 * that multiple consumers can subscribe to independently.
 *
 * WHY NON-BLOCKING:
 * A slow web listener with a bad connection should NOT cause Discord audio to stutter.
 * Each consumer is isolated - if they can't keep up, we drop their frames, not the source.
 *
 * WHY RESILIENT:
 * Radio stations don't stop broadcasting when everyone changes the channel. Similarly,
 * the broadcast continues even with zero subscribers, so reconnecting is seamless.
 *
 * WHY LIVE:
 * When Discord reconnects after a hiccup, it should hear what's playing NOW, not
 * buffered audio from 10 seconds ago. This is radio-style, not recording-style.
 *
 * Implementations must ensure:
 * - Non-blocking: slow consumers don't affect the broadcast or other consumers
 * - Resilient: broadcast continues even if all consumers disconnect
 * - Live: new subscribers get current audio, not buffered past audio
 */
export interface IAudioBroadcast extends EventEmitter {
  /** Guild/server this broadcast is for */
  readonly guildId: string;

  /** Current broadcast state */
  readonly state: BroadcastState;

  /**
   * Subscribe to this broadcast stream
   * @param consumerId Unique identifier for the consumer
   * @returns Subscription object with stream and unsubscribe method
   */
  subscribe(consumerId: string): AudioSubscription;

  /**
   * Get current subscriber count
   */
  getSubscriberCount(): number;

  /**
   * Check if a consumer is currently subscribed
   */
  isSubscribed(consumerId: string): boolean;

  // Event emitters (typed via EventEmitter)
  on(event: "stateChange", listener: (state: BroadcastState) => void): this;
  on(
    event: "metadata",
    listener: (metadata: BroadcastTrackMetadata) => void,
  ): this;
  on(event: "subscriberAdded", listener: (consumerId: string) => void): this;
  on(event: "subscriberRemoved", listener: (consumerId: string) => void): this;

  emit(event: "stateChange", state: BroadcastState): boolean;
  emit(event: "metadata", metadata: BroadcastTrackMetadata): boolean;
  emit(event: "subscriberAdded", consumerId: string): boolean;
  emit(event: "subscriberRemoved", consumerId: string): boolean;
}
