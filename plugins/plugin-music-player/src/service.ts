import { type IAgentRuntime, logger, Service, type UUID } from "@elizaos/core";
import type { IAudioBroadcast } from "./contracts";
import { Broadcast } from "./core";
import { MusicQueue, type QueuedTrack } from "./queue";
import { AudioRouter, type AudioRoutingMode, ZoneManager } from "./router";
import { AudioCacheService } from "./services/audioCache";

const MUSIC_SERVICE_NAME = "music";

// Optional integration interface for music library
interface MusicLibraryService {
  trackTrackPlayed(
    roomId: UUID,
    track: { url: string; title: string },
    duration: number,
    requestedBy?: { entityId: UUID; name: string },
  ): Promise<void>;
  trackTrackRequest(
    entityId: UUID,
    track: { url: string; title: string },
    roomId?: UUID,
    worldId?: UUID,
  ): Promise<void>;
  trackSkip(
    entityId: UUID,
    trackUrl: string,
    roomId?: UUID,
    worldId?: UUID,
  ): Promise<void>;
}

interface RoutingTarget {
  id: string;
  type: string;
  guildId?: string;
  channelId?: string;
  play?: (
    stream: NodeJS.ReadableStream,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  playAudio?: (
    stream: NodeJS.ReadableStream,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  feed?: (stream: NodeJS.ReadableStream) => Promise<unknown>;
  stop?: () => Promise<unknown>;
  stopAudio?: () => Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Music service that manages music queues and playback
 * Pure playback engine - analytics/preferences are optional via music-library plugin
 */
export class MusicService extends Service {
  static serviceType: string = MUSIC_SERVICE_NAME;
  capabilityDescription = "Play any song on request in voice chat";

  private queues: Map<string, MusicQueue> = new Map(); // key: guildId
  private broadcasts: Map<string, Broadcast> = new Map(); // key: guildId
  private voiceManager: any; // VoiceManager from plugin-discord
  private audioCache: AudioCacheService;
  private readonly audioRouter: AudioRouter = new AudioRouter();
  private readonly zoneManager: ZoneManager = new ZoneManager();

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    // Initialize audio cache with optional cache directory from settings
    const cacheDir = runtime?.getSetting("AUDIO_CACHE_DIR") as
      | string
      | undefined;
    this.audioCache = new AudioCacheService(cacheDir);
  }

  static async start(runtime: IAgentRuntime): Promise<MusicService> {
    logger.debug(`Starting MusicService for agent ${runtime.character.name}`);
    return new MusicService(runtime);
  }

  async stop(): Promise<void> {
    // Stop all queues
    for (const queue of this.queues.values()) {
      await queue.stop();
    }
    this.queues.clear();

    // Destroy all broadcasts
    for (const broadcast of this.broadcasts.values()) {
      broadcast.destroy();
    }
    this.broadcasts.clear();

    await this.audioRouter.unrouteAll();
    this.zoneManager.clear();
  }

  /**
   * Initialize the service with voice manager
   */
  setVoiceManager(voiceManager: any): void {
    this.voiceManager = voiceManager;
  }

  getAudioRouter(): AudioRouter {
    return this.audioRouter;
  }

  getZoneManager(): ZoneManager {
    return this.zoneManager;
  }

  setRoutingMode(mode: AudioRoutingMode): void {
    this.audioRouter.setDefaultMode(mode);
  }

  getRoutingMode(): AudioRoutingMode {
    return this.audioRouter.getDefaultMode();
  }

  registerRoutingTargets(targets: RoutingTarget[]): void {
    this.audioRouter.registerTargets(targets);
  }

  unregisterRoutingTarget(targetId: string): void {
    this.audioRouter.unregisterTarget(targetId);
  }

  listRoutingTargets(): string[] {
    return this.audioRouter.getRegisteredTargetIds();
  }

  async startBroadcastRoute(
    sourceId: string,
    targetIds: string[],
    mode?: AudioRoutingMode,
  ): Promise<{
    sourceId: string;
    targetIds: string[];
    mode: AudioRoutingMode;
  }> {
    const broadcast = this.getBroadcast(sourceId);
    const subscription = broadcast.subscribe(`router:${sourceId}`);
    try {
      await this.audioRouter.route(
        sourceId,
        subscription.stream,
        targetIds,
        mode,
        () => subscription.unsubscribe(),
      );
      return this.audioRouter.getRoute(sourceId)!;
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    }
  }

  async stopBroadcastRoute(sourceId: string): Promise<void> {
    await this.audioRouter.unroute(sourceId);
  }

  getRoutingStatus(): {
    mode: AudioRoutingMode;
    activeRoutes: Array<{
      sourceId: string;
      targetIds: string[];
      mode: AudioRoutingMode;
    }>;
    registeredTargets: string[];
    zoneCount: number;
  } {
    return {
      mode: this.audioRouter.getDefaultMode(),
      activeRoutes: this.audioRouter.getActiveRoutes(),
      registeredTargets: this.audioRouter.getRegisteredTargetIds(),
      zoneCount: this.zoneManager.count(),
    };
  }

  /**
   * Get or create a queue for a guild
   */
  getQueue(guildId: string): MusicQueue {
    if (!this.queues.has(guildId)) {
      const queue = new MusicQueue(
        guildId,
        this.voiceManager ?? null,
        this.runtime,
        this.audioCache,
      );
      this.queues.set(guildId, queue);

      // AUTO-WIRING: Connect queue to broadcast for new architecture
      //
      // WHY: Queue needs to know where to push audio. By giving it a broadcast
      // reference, the queue can call broadcast.pushTrack() when playing tracks.
      // This separates playback logic (queue) from distribution logic (broadcast).
      const broadcast = this.getBroadcast(guildId) as Broadcast;
      queue.setBroadcast(broadcast);
      logger.debug(
        `[MusicService] Auto-wired queue to broadcast for guild ${guildId}`,
      );

      // AUTO-WIRING: Subscribe Discord to broadcast when tracks play
      //
      // WHY ON METADATA EVENT:
      // We can't subscribe Discord immediately (queue might not have tracks yet).
      // When a track starts, broadcast emits 'metadata' event. That's our signal
      // to check if Discord is connected and auto-subscribe it.
      //
      // WHY NOT EVERY TIME:
      // autoSubscribeDiscord() checks if already subscribed. Calling it on every
      // track is idempotent - first call subscribes, subsequent calls do nothing.
      broadcast.on("metadata", async (metadata: any) => {
        logger.info(
          `[MusicService] Broadcast 'metadata' event for guild ${guildId}: ${metadata?.title || "unknown"}`,
        );
        await this.autoSubscribeDiscord(guildId, broadcast);
      });

      // Register track played callback for optional analytics
      queue.onTrackPlayed(async (track, duration) => {
        await this.handleTrackPlayed(guildId, track, duration);
      });

      // Forward queue events to service level for external listeners
      queue.on("track:starting", (track) => {
        logger.debug(`[${guildId}] Track starting: ${track.title}`);
      });
      queue.on("track:started", async (track) => {
        logger.debug(`[${guildId}] Track started: ${track.title}`);
        // Update Discord listening activity when track starts
        await this.updateDiscordListeningActivity(track.title);
      });
      queue.on("track:finished", async (track, duration) => {
        logger.debug(
          `[${guildId}] Track finished: ${track.title} (${duration}s)`,
        );
        // Clear activity when track finishes if queue is empty
        const queueList = queue.getQueue();
        if (queueList.length === 0) {
          await this.clearDiscordActivity();
        }
      });
      queue.on("track:age-restricted", async (track) => {
        logger.info(
          `[${guildId}] Age restriction detected for: ${track.title}`,
        );
        // Send notification to user if runtime is available
        if (this.runtime && track.requestedBy) {
          try {
            const roomId = await this.getRoomIdFromGuild(guildId);
            if (roomId) {
              await this.runtime.createMemory(
                {
                  agentId: this.runtime.agentId,
                  roomId: roomId,
                  entityId: track.requestedBy,
                  content: {
                    source: "discord",
                    text: "One sec, have to find a different version...",
                    actions: [],
                  },
                },
                "messages",
              );
            }
          } catch (error) {
            logger.debug(
              `Could not send age restriction notification: ${error}`,
            );
          }
        }
      });
      queue.on("track:error", async (track, reason) => {
        logger.warn(
          `[${guildId}] Failed to play track ${track.title}: ${reason}`,
        );
        if (this.runtime && track.requestedBy) {
          try {
            const roomId = await this.getRoomIdFromGuild(guildId);
            if (roomId) {
              const normalizedReason = reason || "Unable to fetch audio";
              const reasonLower = normalizedReason.toLowerCase();
              let userHint = normalizedReason;
              if (
                reasonLower.includes("age verification") ||
                reasonLower.includes("sign in") ||
                reasonLower.includes("not a bot") ||
                reasonLower.includes("restricted")
              ) {
                userHint = `${normalizedReason}. Please provide YouTube cookies via YOUTUBE_COOKIES or share a different source.`;
              }

              await this.runtime.createMemory(
                {
                  agentId: this.runtime.agentId,
                  roomId,
                  entityId: track.requestedBy,
                  content: {
                    source: "discord",
                    text: `Couldn't play **${track.title}**: ${userHint}`,
                    actions: [],
                  },
                },
                "messages",
              );
            }
          } catch (error) {
            logger.debug(`Could not send track failure notification: ${error}`);
          }
        }
      });
    }
    return this.queues.get(guildId)!;
  }

  /**
   * Get all queues (for external monitoring)
   */
  getQueues(): Map<string, MusicQueue> {
    return this.queues;
  }

  /**
   * Get audio cache service
   */
  getAudioCache(): AudioCacheService {
    return this.audioCache;
  }

  /**
   * Add a track to the queue
   */
  async addTrack(
    guildId: string,
    track: Omit<QueuedTrack, "id" | "addedAt">,
  ): Promise<QueuedTrack> {
    const queue = this.getQueue(guildId);
    const queuedTrack = await queue.addTrack(track);

    // Optional: Track request in music library if available
    if (this.runtime) {
      try {
        const musicLibrary = this.runtime.getService(
          "musicLibrary",
        ) as MusicLibraryService | null;
        if (musicLibrary?.trackTrackRequest) {
          // Try to get roomId from Discord service
          const roomId = await this.getRoomIdFromGuild(guildId);
          if (roomId && track.requestedBy) {
            await musicLibrary.trackTrackRequest(
              track.requestedBy as UUID,
              { url: track.url, title: track.title },
              roomId,
            );
          }
        }
      } catch (error) {
        logger.debug(
          `Optional music library integration not available: ${error}`,
        );
      }
    }

    return queuedTrack;
  }

  /**
   * Skip current track
   */
  async skip(guildId: string, skipperEntityId?: UUID): Promise<boolean> {
    const queue = this.queues.get(guildId);
    if (!queue) return false;

    const currentTrack = queue.getCurrentTrack();

    // Optional: Track skip in music library if available
    if (this.runtime && currentTrack && skipperEntityId) {
      try {
        const musicLibrary = this.runtime.getService(
          "musicLibrary",
        ) as MusicLibraryService | null;
        if (musicLibrary?.trackSkip) {
          const roomId = await this.getRoomIdFromGuild(guildId);
          if (roomId) {
            await musicLibrary.trackSkip(
              skipperEntityId,
              currentTrack.url,
              roomId,
            );
          }
        }
      } catch (error) {
        logger.debug(
          `Optional music library integration not available: ${error}`,
        );
      }
    }

    return queue.skip();
  }

  /**
   * Pause playback
   */
  async pause(guildId: string): Promise<void> {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    await queue.pause();
  }

  /**
   * Resume playback
   */
  async resume(guildId: string): Promise<void> {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    await queue.resume();
  }

  /**
   * Stop playback for a specific guild
   */
  async stopPlayback(guildId: string): Promise<void> {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    await queue.stop();
  }

  /**
   * Clear queue
   */
  clear(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    queue.clear();
  }

  /**
   * Get queue
   */
  getQueueList(guildId: string): QueuedTrack[] {
    const queue = this.queues.get(guildId);
    if (!queue) return [];
    return queue.getQueue();
  }

  /**
   * Get current track
   */
  getCurrentTrack(guildId: string): QueuedTrack | null {
    const queue = this.queues.get(guildId);
    if (!queue) return null;
    return queue.getCurrentTrack();
  }

  /**
   * Get or create a broadcast for a guild
   * Broadcasts provide a clean interface for multiple consumers (Discord, Web, etc.)
   * to subscribe to the audio stream independently.
   * @param guildId Guild/server ID
   * @returns IAudioBroadcast instance
   */
  getBroadcast(guildId: string): IAudioBroadcast {
    if (!this.broadcasts.has(guildId)) {
      const broadcast = new Broadcast(guildId);
      this.broadcasts.set(guildId, broadcast);
      logger.debug(`[MusicService] Created broadcast for guild ${guildId}`);
    }
    return this.broadcasts.get(guildId)!;
  }

  /**
   * Remove a track from queue
   */
  removeTrack(guildId: string, trackId: string): boolean {
    const queue = this.queues.get(guildId);
    if (!queue) return false;
    return queue.removeTrack(trackId);
  }

  /**
   * Shuffle queue
   */
  shuffle(guildId: string): void {
    const queue = this.queues.get(guildId);
    if (!queue) return;
    queue.shuffle();
  }

  /**
   * Get whether queue is currently playing
   */
  getIsPlaying(guildId: string): boolean {
    const queue = this.queues.get(guildId);
    if (!queue) return false;
    return queue.getIsPlaying();
  }

  /**
   * Get whether playback is paused
   */
  getIsPaused(guildId: string): boolean {
    const queue = this.queues.get(guildId);
    if (!queue) return false;
    return queue.getIsPaused();
  }

  /**
   * Handle track played event (optional analytics integration)
   */
  private async handleTrackPlayed(
    guildId: string,
    track: QueuedTrack,
    duration: number,
  ): Promise<void> {
    if (!this.runtime) return;

    try {
      const musicLibrary = this.runtime.getService(
        "musicLibrary",
      ) as MusicLibraryService | null;
      if (musicLibrary?.trackTrackPlayed) {
        const roomId = await this.getRoomIdFromGuild(guildId);
        if (roomId) {
          await musicLibrary.trackTrackPlayed(
            roomId,
            { url: track.url, title: track.title },
            duration,
            track.requestedBy
              ? { entityId: track.requestedBy as UUID, name: "" }
              : undefined,
          );
        }
      }
    } catch (error) {
      logger.debug(`Optional music library analytics not available: ${error}`);
    }
  }

  /**
   * Helper to get roomId from guildId via Discord service
   */
  private async getRoomIdFromGuild(guildId: string): Promise<UUID | null> {
    if (!this.runtime) return null;

    try {
      const discordService = this.runtime.getService("discord") as any;
      if (discordService?.getDefaultRoomIdForGuild) {
        return discordService.getDefaultRoomIdForGuild(guildId);
      }
    } catch (error) {
      logger.debug(`Could not get roomId from guildId: ${error}`);
    }

    return null;
  }

  /**
   * Update Discord listening activity to show currently playing track
   */
  private async updateDiscordListeningActivity(
    trackTitle: string,
  ): Promise<void> {
    if (!this.runtime) return;

    try {
      const discordService = this.runtime.getService("discord") as any;
      if (discordService?.setListeningActivity) {
        await discordService.setListeningActivity(trackTitle);
        logger.debug(`Updated Discord activity: Listening to "${trackTitle}"`);
      }
    } catch (error) {
      logger.debug(`Could not update Discord listening activity: ${error}`);
    }
  }

  /**
   * Clear Discord activity when music stops
   */
  private async clearDiscordActivity(): Promise<void> {
    if (!this.runtime) return;

    try {
      const discordService = this.runtime.getService("discord") as any;
      if (discordService?.clearActivity) {
        await discordService.clearActivity();
        logger.debug("Cleared Discord activity");
      }
    } catch (error) {
      logger.debug(`Could not clear Discord activity: ${error}`);
    }
  }

  /**
   * Auto-subscribe Discord to broadcast (enables new architecture without requiring radio plugin)
   *
   * WHY AUTO-WIRING:
   * Design goal: music-player + discord should work together WITHOUT needing radio plugin.
   * Radio can add advanced features, but shouldn't be required for basic playback.
   *
   * THE CHALLENGE:
   * - MusicQueue pushes audio to broadcast
   * - Discord needs to subscribe to broadcast
   * - But music-player shouldn't import discord plugin (circular dependency)
   *
   * THE SOLUTION:
   * When a track starts, MusicService (which has access to runtime) checks:
   * 1. Is discord service available? (optional dependency)
   * 2. Is Discord connected to this guild?
   * 3. If yes, auto-subscribe Discord to the broadcast
   * 4. If not yet connected, attach listener to subscribe when it connects
   *
   * This happens transparently - user just plays music, and it works.
   *
   * WHY HANDLE RECONNECTS HERE:
   * Discord will emit status changes (connected/disconnected). MusicService listens
   * and auto-resubscribes on reconnect. This keeps the reconnection logic in one place.
   *
   * GRACEFUL DEGRADATION:
   * If discord service doesn't exist, or doesn't support IAudioSink, this silently
   * does nothing. Old architecture keeps working.
   */
  private async autoSubscribeDiscord(
    guildId: string,
    broadcast: Broadcast,
  ): Promise<void> {
    logger.info(
      `[MusicService] autoSubscribeDiscord called for guild ${guildId}`,
    );

    if (!this.runtime) {
      logger.debug(
        `[MusicService] No runtime available, skipping auto-subscribe`,
      );
      return;
    }

    try {
      // Check if Discord service is available
      const discordService = this.runtime.getService("discord") as any;
      if (!discordService) {
        logger.debug(
          `[MusicService] Discord service not available for guild ${guildId}`,
        );
        return;
      }
      if (!discordService.getAudioSink) {
        logger.debug(
          `[MusicService] Discord service doesn't have getAudioSink method`,
        );
        return;
      }

      // Get Discord audio sink for this guild
      const sink = discordService.getAudioSink(guildId);
      if (!sink) {
        logger.warn(
          `[MusicService] No Discord sink available for guild ${guildId}`,
        );
        return;
      }

      logger.info(
        `[MusicService] Got sink for guild ${guildId}, status: ${sink.status}`,
      );

      const subscriptionId = `discord-${guildId}`;

      // Helper to subscribe to broadcast
      const doSubscribe = async () => {
        logger.info(`[MusicService] doSubscribe called for guild ${guildId}`);
        const alreadySubscribed = broadcast.isSubscribed(subscriptionId);
        logger.info(
          `[MusicService] isSubscribed(${subscriptionId}) = ${alreadySubscribed}`,
        );

        if (alreadySubscribed) {
          logger.warn(
            `[MusicService] Already subscribed for guild ${guildId}, skipping`,
          );
          // Already subscribed, nothing to do
          return;
        }

        try {
          logger.info(
            `[MusicService] Auto-subscribing Discord to broadcast for guild ${guildId}`,
          );
          const subscription = broadcast.subscribe(subscriptionId);
          logger.info(
            `[MusicService] Got subscription for guild ${guildId}, stream readable: ${subscription.stream?.readable}, feeding to sink...`,
          );
          await sink.feed(subscription.stream);
          logger.info(
            `[MusicService] ✅ Discord successfully subscribed to broadcast for guild ${guildId}`,
          );
        } catch (error) {
          logger.error(
            `[MusicService] ❌ Error subscribing Discord to broadcast: ${error}`,
          );
        }
      };

      // ALWAYS attach status change listener
      //
      // WHY ALWAYS:
      // Previously, we only attached the listener if the initial subscription succeeded.
      // This caused a race condition: if sink wasn't connected when 'metadata' fired,
      // we'd skip subscription AND skip attaching the listener, so when sink DID
      // connect later, no one would know to subscribe.
      //
      // WHY CHECK listenerCount:
      // autoSubscribeDiscord() is called on every 'metadata' event (every track).
      // We only want ONE listener per sink, not N listeners for N tracks.
      if (
        sink.listenerCount?.("statusChange") === 0 ||
        !sink._musicServiceListenerAttached
      ) {
        sink._musicServiceListenerAttached = true;

        sink.on("statusChange", async (status: string) => {
          if (status === "connected") {
            // Discord connected/reconnected - subscribe to broadcast
            logger.info(
              `[MusicService] Discord connected for guild ${guildId}, subscribing to broadcast`,
            );

            // Unsubscribe old subscription if exists (for reconnection case)
            if (broadcast.isSubscribed(subscriptionId)) {
              const oldSub = broadcast.subscribe(subscriptionId);
              oldSub.unsubscribe();
            }

            // Subscribe with fresh stream
            const newSubscription = broadcast.subscribe(subscriptionId);
            await sink.feed(newSubscription.stream);
          } else if (status === "disconnected") {
            // Discord disconnected - unsubscribe to clean up
            if (broadcast.isSubscribed(subscriptionId)) {
              logger.debug(
                `[MusicService] Discord disconnected for guild ${guildId}, unsubscribing from broadcast`,
              );
              const sub = broadcast.subscribe(subscriptionId);
              sub.unsubscribe();
            }
          }
        });

        logger.debug(
          `[MusicService] Attached status listener for sink ${guildId}`,
        );
      }

      // If already connected, subscribe now
      if (sink.status === "connected") {
        logger.info(
          `[MusicService] Sink connected, calling doSubscribe for guild ${guildId}`,
        );
        await doSubscribe();
      } else {
        // Not connected yet - listener will handle it when sink connects
        logger.warn(
          `[MusicService] Discord sink not connected for guild ${guildId} (status: ${sink.status}), will subscribe when connected`,
        );
      }
    } catch (error) {
      logger.debug(`[MusicService] Could not auto-subscribe Discord: ${error}`);
      // Non-fatal - old architecture will still work
    }
  }
}
