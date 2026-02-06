import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import ngrok from "ngrok";
import { nanoid } from "nanoid";

interface Tunnel {
  id: string;
  url: string;
  port: number;
  createdAt: number;
  expiresAt: number;
  purpose: string;
}

/**
 * Service for managing ngrok tunnels
 * Provides secure temporary access to forms without exposing server location
 */
export class NgrokService extends Service {
  static serviceType = "NGROK";
  capabilityDescription =
    "Manages secure ngrok tunnels for temporary form access";

  private tunnels: Map<string, Tunnel> = new Map();
  private tunnelTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEFAULT_TUNNEL_DURATION = 30 * 60 * 1000; // 30 minutes
  private ngrok: typeof ngrok;

  constructor(runtime: IAgentRuntime, ngrokModule: typeof ngrok = ngrok) {
    super(runtime);
    this.ngrok = ngrokModule;
  }

  async start(): Promise<void> {
    logger.info("[NgrokService] Starting ngrok service");

    // Set ngrok auth token if available
    const authToken = this.runtime.getSetting("NGROK_AUTH_TOKEN");
    if (authToken) {
      await this.ngrok.authtoken(authToken);
      logger.info("[NgrokService] Ngrok auth token configured");
    } else {
      logger.warn(
        "[NgrokService] No NGROK_AUTH_TOKEN found, using anonymous tunnels (limited)",
      );
    }
  }

  /**
   * Create a new tunnel for a specific port
   */
  async createTunnel(
    port: number,
    purpose: string,
    duration?: number,
  ): Promise<{ id: string; url: string }> {
    try {
      logger.info(
        `[NgrokService] Creating tunnel for port ${port}, purpose: ${purpose}`,
      );

      // Create ngrok tunnel
      const url = await this.ngrok.connect({
        addr: port,
        proto: "http",
        region: "us", // Can be configured
        onStatusChange: (status) => {
          logger.debug(`[NgrokService] Tunnel status: ${status}`);
        },
      });

      const tunnelId = nanoid();
      const tunnelDuration = duration || this.DEFAULT_TUNNEL_DURATION;
      const tunnel: Tunnel = {
        id: tunnelId,
        url,
        port,
        createdAt: Date.now(),
        expiresAt: Date.now() + tunnelDuration,
        purpose,
      };

      this.tunnels.set(tunnelId, tunnel);

      // Set automatic cleanup
      const timeout = setTimeout(() => {
        this.closeTunnel(tunnelId);
      }, tunnelDuration);

      this.tunnelTimeouts.set(tunnelId, timeout);

      logger.info(
        `[NgrokService] Tunnel created: ${url} (expires in ${tunnelDuration / 1000}s)`,
      );

      return { id: tunnelId, url };
    } catch (error) {
      logger.error("[NgrokService] Failed to create tunnel:", error);
      throw new Error(`Failed to create tunnel: ${error.message}`);
    }
  }

  /**
   * Close a specific tunnel
   */
  async closeTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      logger.warn(`[NgrokService] Tunnel ${tunnelId} not found`);
      return;
    }

    try {
      logger.info(`[NgrokService] Closing tunnel ${tunnelId} (${tunnel.url})`);

      // Disconnect ngrok tunnel
      await this.ngrok.disconnect(tunnel.url);

      // Clear timeout
      const timeout = this.tunnelTimeouts.get(tunnelId);
      if (timeout) {
        clearTimeout(timeout);
        this.tunnelTimeouts.delete(tunnelId);
      }

      // Remove from tracking
      this.tunnels.delete(tunnelId);

      logger.info(`[NgrokService] Tunnel ${tunnelId} closed successfully`);
    } catch (error) {
      logger.error(`[NgrokService] Error closing tunnel ${tunnelId}:`, error);
    }
  }

  /**
   * Get tunnel info
   */
  getTunnel(tunnelId: string): Tunnel | null {
    return this.tunnels.get(tunnelId) || null;
  }

  /**
   * Get all active tunnels
   */
  getActiveTunnels(): Tunnel[] {
    return Array.from(this.tunnels.values());
  }

  /**
   * Check if a tunnel is still active
   */
  isTunnelActive(tunnelId: string): boolean {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return false;

    return Date.now() < tunnel.expiresAt;
  }

  /**
   * Extend tunnel duration
   */
  extendTunnel(tunnelId: string, additionalTime: number): boolean {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return false;

    // Clear old timeout
    const oldTimeout = this.tunnelTimeouts.get(tunnelId);
    if (oldTimeout) {
      clearTimeout(oldTimeout);
    }

    // Extend expiration
    tunnel.expiresAt += additionalTime;

    // Set new timeout
    const newTimeout = setTimeout(() => {
      this.closeTunnel(tunnelId);
    }, tunnel.expiresAt - Date.now());

    this.tunnelTimeouts.set(tunnelId, newTimeout);

    logger.info(
      `[NgrokService] Extended tunnel ${tunnelId} by ${additionalTime / 1000}s`,
    );

    return true;
  }

  /**
   * Clean up expired tunnels
   */
  async cleanupExpiredTunnels(): Promise<void> {
    const now = Date.now();
    const expiredTunnels: string[] = [];

    for (const [id, tunnel] of this.tunnels) {
      if (now >= tunnel.expiresAt) {
        expiredTunnels.push(id);
      }
    }

    for (const id of expiredTunnels) {
      await this.closeTunnel(id);
    }

    if (expiredTunnels.length > 0) {
      logger.info(
        `[NgrokService] Cleaned up ${expiredTunnels.length} expired tunnels`,
      );
    }
  }

  /**
   * Stop the service and close all tunnels
   */
  async stop(): Promise<void> {
    logger.info("[NgrokService] Stopping ngrok service");

    // Close all tunnels
    const tunnelIds = Array.from(this.tunnels.keys());
    for (const id of tunnelIds) {
      await this.closeTunnel(id);
    }

    // Kill ngrok process
    await this.ngrok.kill();

    logger.info("[NgrokService] Ngrok service stopped");
  }
}
