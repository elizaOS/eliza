import { PassThrough, type Readable } from "node:stream";
import { logger } from "@elizaos/core";

/** Minimal VoiceTarget shape — avoids hard dep on @elizaos/plugin-discord. */
interface VoiceTarget {
  id: string;
  type: string;
  guildId?: string;
  channelId?: string;
  play?: (stream: Readable, opts?: Record<string, unknown>) => Promise<unknown>;
  playAudio?: (
    stream: Readable,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  feed?: (stream: Readable) => Promise<unknown>;
  stop?: () => Promise<unknown>;
  stopAudio?: () => Promise<unknown>;
  [key: string]: unknown;
}

/**
 * Audio routing mode
 */
export type AudioRoutingMode = "simulcast" | "independent";

/**
 * Configuration for audio routing
 */
export interface AudioRouteConfig {
  sourceId: string;
  targetIds: string[];
  mode?: AudioRoutingMode;
}

/**
 * Active audio route state
 */
interface ActiveRoute {
  sourceId: string;
  targetIds: string[];
  mode: AudioRoutingMode;
  sourceStream: Readable;
  streams: Map<string, PassThrough>; // target ID -> cloned stream
  cleanup: () => void;
}

/**
 * AudioRouter manages routing of audio streams to multiple voice targets
 * Supports both simulcast (same stream to all) and independent (separate streams) modes
 */
export class AudioRouter {
  private routes: Map<string, ActiveRoute> = new Map(); // sourceId -> route
  private defaultMode: AudioRoutingMode = "simulcast";
  private targetRegistry: Map<string, VoiceTarget> = new Map();

  constructor(defaultMode: AudioRoutingMode = "simulcast") {
    this.defaultMode = defaultMode;
  }

  /**
   * Register voice targets for routing
   */
  registerTargets(targets: VoiceTarget[]): void {
    for (const target of targets) {
      this.targetRegistry.set(target.id, target);
      logger.debug(`[AudioRouter] Registered target: ${target.id}`);
    }
  }

  /**
   * Unregister voice targets
   */
  unregisterTarget(targetId: string): void {
    this.targetRegistry.delete(targetId);
    logger.debug(`[AudioRouter] Unregistered target: ${targetId}`);
  }

  /**
   * Get registered target by ID
   */
  getTarget(targetId: string): VoiceTarget | undefined {
    return this.targetRegistry.get(targetId);
  }

  /**
   * Route an audio stream to multiple targets
   * @param sourceId Unique identifier for the audio source
   * @param stream The audio stream to route
   * @param targetIds Array of target IDs to route to
   * @param mode Routing mode (defaults to configured default)
   */
  async route(
    sourceId: string,
    stream: Readable,
    targetIds: string[],
    mode?: AudioRoutingMode,
    onCleanup?: () => void,
  ): Promise<void> {
    const routingMode = mode || this.defaultMode;

    // Clean up existing route if any
    await this.unroute(sourceId);

    logger.log(
      `[AudioRouter] Routing ${sourceId} to ${targetIds.length} target(s) in ${routingMode} mode`,
    );

    // Validate targets exist
    const validTargets = targetIds
      .map((id) => this.targetRegistry.get(id))
      .filter((t): t is VoiceTarget => t !== undefined);

    if (validTargets.length === 0) {
      throw new Error(`No valid targets found for route ${sourceId}`);
    }

    if (validTargets.length < targetIds.length) {
      logger.warn(
        `[AudioRouter] Some targets not found. Requested: ${targetIds.length}, Found: ${validTargets.length}`,
      );
    }

    if (routingMode === "simulcast") {
      await this.routeSimulcast(sourceId, stream, validTargets, onCleanup);
    } else {
      await this.routeIndependent(sourceId, stream, validTargets, onCleanup);
    }
  }

  /**
   * Simulcast mode: Clone single stream to all targets
   * Uses PassThrough streams to multiplex
   */
  private async routeSimulcast(
    sourceId: string,
    sourceStream: Readable,
    targets: VoiceTarget[],
    onCleanup?: () => void,
  ): Promise<void> {
    const streams = new Map<string, PassThrough>();
    const playbackPromises: Promise<void>[] = [];

    // Create PassThrough stream for each target
    for (const target of targets) {
      const clonedStream = new PassThrough();
      streams.set(target.id, clonedStream);

      // Pipe source to cloned stream
      sourceStream.pipe(clonedStream);

      // Start playback on target
      playbackPromises.push(
        this.startTargetPlayback(target, clonedStream).catch((error) => {
          logger.error(
            `[AudioRouter] Playback failed on ${target.id}: ${error}`,
          );
        }),
      );
    }

    // Wait for all playback to start
    await Promise.all(playbackPromises);

    // Store route state
    const cleanup = () => {
      for (const stream of streams.values()) {
        sourceStream.unpipe(stream);
        stream.end();
        stream.destroy();
      }
      onCleanup?.();
    };

    this.routes.set(sourceId, {
      sourceId,
      targetIds: targets.map((t) => t.id),
      mode: "simulcast",
      sourceStream,
      streams,
      cleanup,
    });

    logger.log(
      `[AudioRouter] Simulcast route ${sourceId} established to ${targets.length} target(s)`,
    );
  }

  /**
   * Independent mode: Separate streams per target
   * Note: This requires the source to provide multiple independent streams
   * For now, this will use the same stream but track separately
   */
  private async routeIndependent(
    sourceId: string,
    sourceStream: Readable,
    targets: VoiceTarget[],
    onCleanup?: () => void,
  ): Promise<void> {
    const streams = new Map<string, PassThrough>();
    const playbackPromises: Promise<void>[] = [];

    // In independent mode, each target gets its own stream clone
    // This allows different playback states per target
    for (const target of targets) {
      const independentStream = new PassThrough();
      streams.set(target.id, independentStream);

      // Pipe source to each independent stream
      sourceStream.pipe(independentStream);

      // Start playback on target
      playbackPromises.push(
        this.startTargetPlayback(target, independentStream).catch((error) => {
          logger.error(
            `[AudioRouter] Independent playback failed on ${target.id}: ${error}`,
          );
        }),
      );
    }

    // Wait for all playback to start
    await Promise.all(playbackPromises);

    // Store route state
    const cleanup = () => {
      for (const stream of streams.values()) {
        sourceStream.unpipe(stream);
        stream.end();
        stream.destroy();
      }
      onCleanup?.();
    };

    this.routes.set(sourceId, {
      sourceId,
      targetIds: targets.map((t) => t.id),
      mode: "independent",
      sourceStream,
      streams,
      cleanup,
    });

    logger.log(
      `[AudioRouter] Independent route ${sourceId} established to ${targets.length} target(s)`,
    );
  }

  /**
   * Stop routing for a source
   */
  async unroute(sourceId: string): Promise<void> {
    const route = this.routes.get(sourceId);
    if (!route) {
      return;
    }

    logger.log(`[AudioRouter] Unrouting ${sourceId}`);

    // Stop playback on all targets
    const stopPromises = route.targetIds.map(async (targetId) => {
      const target = this.targetRegistry.get(targetId);
      if (target) {
        try {
          await this.stopTargetPlayback(target);
        } catch (error) {
          logger.error(`[AudioRouter] Failed to stop ${targetId}: ${error}`);
        }
      }
    });

    await Promise.all(stopPromises);

    // Cleanup streams
    route.cleanup();

    // Remove route
    this.routes.delete(sourceId);

    logger.log(`[AudioRouter] Route ${sourceId} removed`);
  }

  /**
   * Stop all active routes
   */
  async unrouteAll(): Promise<void> {
    const sourceIds = Array.from(this.routes.keys());
    await Promise.all(sourceIds.map((id) => this.unroute(id)));
  }

  /**
   * Get active routes
   */
  getActiveRoutes(): Array<{
    sourceId: string;
    targetIds: string[];
    mode: AudioRoutingMode;
  }> {
    return Array.from(this.routes.values()).map((route) => ({
      sourceId: route.sourceId,
      targetIds: route.targetIds,
      mode: route.mode,
    }));
  }

  /**
   * Set default routing mode
   */
  setDefaultMode(mode: AudioRoutingMode): void {
    this.defaultMode = mode;
    logger.log(`[AudioRouter] Default mode set to: ${mode}`);
  }

  /**
   * Get default routing mode
   */
  getDefaultMode(): AudioRoutingMode {
    return this.defaultMode;
  }

  /**
   * Get all registered routing target IDs
   */
  getRegisteredTargetIds(): string[] {
    return Array.from(this.targetRegistry.keys());
  }

  /**
   * Check if a source is currently routed
   */
  isRouted(sourceId: string): boolean {
    return this.routes.has(sourceId);
  }

  /**
   * Get route info for a source
   */
  getRoute(sourceId: string) {
    const route = this.routes.get(sourceId);
    if (!route) return undefined;

    return {
      sourceId: route.sourceId,
      targetIds: route.targetIds,
      mode: route.mode,
    };
  }

  /**
   * Add target to existing route
   */
  async addTargetToRoute(sourceId: string, targetId: string): Promise<void> {
    const route = this.routes.get(sourceId);
    if (!route) {
      throw new Error(`Route ${sourceId} not found`);
    }

    const target = this.targetRegistry.get(targetId);
    if (!target) {
      throw new Error(`Target ${targetId} not found`);
    }

    if (route.targetIds.includes(targetId)) {
      logger.warn(
        `[AudioRouter] Target ${targetId} already in route ${sourceId}`,
      );
      return;
    }

    // Create new stream for this target
    const newStream = new PassThrough();

    route.sourceStream.pipe(newStream);
    await this.startTargetPlayback(target, newStream);

    route.targetIds.push(targetId);
    route.streams.set(targetId, newStream);
    logger.log(`[AudioRouter] Added target ${targetId} to route ${sourceId}`);
  }

  /**
   * Remove target from existing route
   */
  async removeTargetFromRoute(
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const route = this.routes.get(sourceId);
    if (!route) {
      throw new Error(`Route ${sourceId} not found`);
    }

    const targetIndex = route.targetIds.indexOf(targetId);
    if (targetIndex === -1) {
      logger.warn(`[AudioRouter] Target ${targetId} not in route ${sourceId}`);
      return;
    }

    // Stop playback on this target
    const target = this.targetRegistry.get(targetId);
    if (target) {
      await this.stopTargetPlayback(target);
    }

    // Clean up stream
    const stream = route.streams.get(targetId);
    if (stream) {
      stream.end();
      stream.destroy();
      route.streams.delete(targetId);
    }

    // Remove from route
    route.targetIds.splice(targetIndex, 1);

    logger.log(
      `[AudioRouter] Removed target ${targetId} from route ${sourceId}`,
    );

    // If no targets left, unroute completely
    if (route.targetIds.length === 0) {
      await this.unroute(sourceId);
    }
  }

  private async startTargetPlayback(
    target: VoiceTarget,
    stream: Readable,
  ): Promise<void> {
    if (typeof target.play === "function") {
      await target.play(stream);
      return;
    }
    if (typeof target.playAudio === "function") {
      await target.playAudio(stream);
      return;
    }
    if (typeof target.feed === "function") {
      await target.feed(stream);
      return;
    }
    throw new Error(
      `Target ${target.id} does not expose play(), playAudio(), or feed()`,
    );
  }

  private async stopTargetPlayback(target: VoiceTarget): Promise<void> {
    if (typeof target.stop === "function") {
      await target.stop();
      return;
    }
    if (typeof target.stopAudio === "function") {
      await target.stopAudio();
    }
  }
}
