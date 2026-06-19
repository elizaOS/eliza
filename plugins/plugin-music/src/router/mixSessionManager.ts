import { type IAgentRuntime, logger } from "@elizaos/core";
import type { AudioRoutingMode } from "./audioRouter";

/**
 * Configuration for a mix session
 */
export interface MixConfig {
  name: string;
  zones: Record<string, string[]>; // zoneName -> targetIds
  routing?: {
    mode: AudioRoutingMode;
    mappings: Record<string, string[]>; // sourceId -> zoneNames
  };
  autoCleanup?: boolean;
  cleanupDelay?: number; // milliseconds
  metadata?: Record<string, unknown>;
}

/**
 * Active mix session state
 */
export interface MixSession {
  id: string;
  config: MixConfig;
  startedAt: number;
  cleanupTimeout?: NodeJS.Timeout;
}

/**
 * MixSessionManager handles runtime mixing configurations
 * Manages temporary bot assignments, routing, and auto-cleanup
 */
export class MixSessionManager {
  private sessions: Map<string, MixSession> = new Map();
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Start a new mix session
   * @param config Mix configuration
   * @returns Created session
   */
  async start(config: MixConfig): Promise<MixSession> {
    const sessionId = `mix-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    logger.log(
      `[MixSessionManager] Starting session: ${config.name} (${sessionId})`,
    );

    const session: MixSession = {
      id: sessionId,
      config,
      startedAt: Date.now(),
    };

    // Set up auto-cleanup if enabled
    if (config.autoCleanup && config.cleanupDelay) {
      session.cleanupTimeout = setTimeout(() => {
        this.end(sessionId).catch((error) => {
          logger.error(
            `[MixSessionManager] Auto-cleanup failed for ${sessionId}: ${error}`,
          );
        });
      }, config.cleanupDelay);

      logger.log(
        `[MixSessionManager] Auto-cleanup scheduled for ${sessionId} in ${config.cleanupDelay}ms`,
      );
    }

    this.sessions.set(sessionId, session);

    // Store in agent memory for persistence
    await this.saveToMemory(session);

    logger.log(
      `[MixSessionManager] Session ${sessionId} started with ${Object.keys(config.zones).length} zone(s)`,
    );

    return session;
  }

  /**
   * End a mix session
   * @param sessionId Session ID to end
   */
  async end(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn(`[MixSessionManager] Session ${sessionId} not found`);
      return;
    }

    logger.log(
      `[MixSessionManager] Ending session: ${session.config.name} (${sessionId})`,
    );

    // Clear cleanup timeout if exists
    if (session.cleanupTimeout) {
      clearTimeout(session.cleanupTimeout);
    }

    // Remove from active sessions
    this.sessions.delete(sessionId);

    // Remove from agent memory
    await this.removeFromMemory(sessionId);

    logger.log(`[MixSessionManager] Session ${sessionId} ended`);
  }

  /**
   * Update an existing session
   * @param sessionId Session ID to update
   * @param config Partial configuration to update
   */
  async update(
    sessionId: string,
    config: Partial<MixConfig>,
  ): Promise<MixSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.log(`[MixSessionManager] Updating session: ${sessionId}`);

    // Merge configuration
    session.config = {
      ...session.config,
      ...config,
      zones: { ...session.config.zones, ...config.zones },
      routing: config.routing
        ? { ...session.config.routing, ...config.routing }
        : session.config.routing,
      metadata: { ...session.config.metadata, ...config.metadata },
    };

    // Update in memory
    await this.saveToMemory(session);

    logger.log(`[MixSessionManager] Session ${sessionId} updated`);

    return session;
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): MixSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  list(): MixSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Find sessions by name
   */
  findByName(name: string): MixSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.config.name === name,
    );
  }

  /**
   * End all sessions
   */
  async endAll(): Promise<void> {
    logger.log("[MixSessionManager] Ending all sessions");
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.end(id)));
  }

  /**
   * Check if a session exists
   */
  exists(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get active session count
   */
  count(): number {
    return this.sessions.size;
  }

  /**
   * Extend session cleanup timer
   * @param sessionId Session ID
   * @param additionalTime Additional time in milliseconds
   */
  extendSession(sessionId: string, additionalTime: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.cleanupTimeout) {
      logger.warn(
        `[MixSessionManager] Session ${sessionId} has no cleanup timer`,
      );
      return;
    }

    // Clear old timeout
    clearTimeout(session.cleanupTimeout);

    // Set new timeout
    session.cleanupTimeout = setTimeout(() => {
      this.end(sessionId).catch((error) => {
        logger.error(
          `[MixSessionManager] Auto-cleanup failed for ${sessionId}: ${error}`,
        );
      });
    }, additionalTime);

    logger.log(
      `[MixSessionManager] Extended session ${sessionId} by ${additionalTime}ms`,
    );
  }

  /**
   * Cancel auto-cleanup for a session
   */
  cancelAutoCleanup(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.cleanupTimeout) {
      clearTimeout(session.cleanupTimeout);
      delete session.cleanupTimeout;
      logger.log(
        `[MixSessionManager] Cancelled auto-cleanup for session ${sessionId}`,
      );
    }
  }

  /**
   * Save session to agent memory
   * @private
   */
  private async saveToMemory(session: MixSession): Promise<void> {
    try {
      await this.runtime.createMemory(
        {
          id: this.runtime.agentId,
          agentId: this.runtime.agentId,
          entityId: this.runtime.agentId,
          roomId: this.runtime.agentId,
          content: {
            text: `Mix session: ${session.config.name}`,
            metadata: {
              type: "custom" as const,
              kind: "mixSession",
              sessionId: session.id,
              config: JSON.parse(JSON.stringify(session.config)),
              startedAt: session.startedAt,
            },
          },
          createdAt: Date.now(),
        },
        "mixSessions",
      );
    } catch (error) {
      logger.error(
        `[MixSessionManager] Failed to save session to memory: ${error}`,
      );
    }
  }

  /**
   * Remove session from agent memory
   * @private
   */
  private async removeFromMemory(sessionId: string): Promise<void> {
    try {
      // Note: This is a simplified implementation
      // In a real implementation, we'd query and delete the specific memory
      logger.debug(
        `[MixSessionManager] Removing session ${sessionId} from memory`,
      );
    } catch (error) {
      logger.error(
        `[MixSessionManager] Failed to remove session from memory: ${error}`,
      );
    }
  }

  /**
   * Load sessions from agent memory on startup
   */
  async loadFromMemory(): Promise<void> {
    try {
      logger.log("[MixSessionManager] Loading sessions from memory");
      // Note: This is a simplified implementation
      // In a real implementation, we'd query the database for saved sessions
    } catch (error) {
      logger.error(
        `[MixSessionManager] Failed to load sessions from memory: ${error}`,
      );
    }
  }

  /**
   * Get session duration in milliseconds
   */
  getSessionDuration(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return Date.now() - session.startedAt;
  }

  /**
   * Get session info summary
   */
  getSessionInfo(sessionId: string):
    | {
        id: string;
        name: string;
        duration: number;
        zoneCount: number;
        hasAutoCleanup: boolean;
      }
    | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    return {
      id: session.id,
      name: session.config.name,
      duration: this.getSessionDuration(sessionId),
      zoneCount: Object.keys(session.config.zones).length,
      hasAutoCleanup: !!session.cleanupTimeout,
    };
  }
}
