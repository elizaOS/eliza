/**
 * Headscale VPN Integration
 *
 * Higher-level service that ties Headscale VPN to the Docker container
 * lifecycle. Handles pre-auth key generation, VPN registration polling,
 * and cleanup when containers are removed.
 *
 * Flow:
 *  1. prepareContainerVPN(agentId) — generates a pre-auth key + env vars
 *  2. Container boots, runs `tailscale up --authkey=... --hostname=...`
 *  3. waitForVPNRegistration(agentId) — polls headscale until the node appears
 *  4. cleanupContainerVPN(agentId) — removes the VPN node when the container dies
 */

import { logger } from "@/lib/utils/logger";
import { HeadscaleClient, headscaleClient } from "./headscale-client";

/** Initial polling interval when waiting for VPN registration (ms). */
const POLL_INTERVAL_INITIAL_MS = 1_000;

/** Maximum polling interval after exponential backoff (ms). */
const POLL_INTERVAL_MAX_MS = 8_000;

/** Default timeout for VPN registration (ms). */
const DEFAULT_REGISTRATION_TIMEOUT_MS = 60_000;

/** Headscale server URL passed to containers so tailscale can find the coord server. */
const HEADSCALE_URL = process.env.HEADSCALE_API_URL || "http://localhost:8081";

export class HeadscaleIntegration {
  private client: HeadscaleClient;

  constructor(client?: HeadscaleClient) {
    this.client = client ?? headscaleClient;
  }

  // -------------------------------------------------------------------------
  // Container lifecycle hooks
  // -------------------------------------------------------------------------

  /**
   * Prepare VPN credentials for a new agent container.
   *
   * Returns a single-use, ephemeral pre-auth key and the full set of
   * environment variables the container needs to join the VPN on boot.
   */
  async prepareContainerVPN(agentId: string): Promise<{
    preAuthKey: string;
    envVars: Record<string, string>;
  }> {
    logger.info(`[headscale-integration] preparing VPN for agent ${agentId}`);

    try {
      const preAuthKeyObj = await this.client.createPreAuthKey({
        reusable: false,
        ephemeral: true,
        aclTags: ["tag:agent"],
      });

      // Sanitize agentId for use as a DNS-safe Tailscale hostname:
      // replace non-alphanumeric chars with hyphens, strip leading/trailing hyphens, truncate to 63 chars
      const tsHostname =
        agentId
          .replace(/[^a-zA-Z0-9-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 63) || "agent";

      const envVars: Record<string, string> = {
        HEADSCALE_URL,
        TS_AUTHKEY: preAuthKeyObj.key,
        TS_HOSTNAME: tsHostname,
        TS_STATE_DIR: "/var/lib/tailscale",
        TS_EXTRA_ARGS: "--accept-routes",
      };

      logger.info(`[headscale-integration] VPN prepared for agent ${agentId}`);

      return { preAuthKey: preAuthKeyObj.key, envVars };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale-integration] failed to prepare VPN for ${agentId}:`, msg);
      throw error;
    }
  }

  /**
   * Wait for a container to register on the VPN and return its IP.
   *
   * Polls `headscaleClient.getNodeByName(agentId)` every {@link POLL_INTERVAL_MS}
   * until the node appears and has at least one IP address, or the timeout
   * expires.
   *
   * @param agentId   Hostname the container registers with (matches TS_HOSTNAME).
   * @param timeoutMs Maximum time to wait (default 60 s).
   * @returns The first VPN IP address, or `null` if the timeout was reached.
   */
  async waitForVPNRegistration(
    agentId: string,
    timeoutMs: number = DEFAULT_REGISTRATION_TIMEOUT_MS,
  ): Promise<string | null> {
    logger.info(
      `[headscale-integration] waiting for VPN registration: ${agentId} (timeout ${timeoutMs}ms)`,
    );

    const deadline = Date.now() + timeoutMs;
    let interval = POLL_INTERVAL_INITIAL_MS;

    while (Date.now() < deadline) {
      try {
        const node = await this.client.getNodeByName(agentId);

        if (node && node.ipAddresses.length > 0) {
          const ip = node.ipAddresses[0];
          logger.info(`[headscale-integration] VPN registered for ${agentId}: ${ip}`);
          return ip;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Distinguish auth errors (401/403) from transient failures
        if (msg.includes("401") || msg.includes("403")) {
          logger.error(
            `[headscale-integration] Auth error polling VPN for ${agentId}: ${msg} — check HEADSCALE_API_KEY`,
          );
          return null; // bail early, retrying won't help
        }
        // Transient errors (network, timeout) — keep polling
        logger.debug(`[headscale-integration] Poll error for ${agentId}: ${msg}`);
      }

      // Exponential backoff with jitter to avoid thundering-herd on
      // Headscale during bulk container provisioning.
      const jitter = Math.floor(Math.random() * interval * 0.3);
      const sleepMs = Math.min(interval + jitter, deadline - Date.now());
      if (sleepMs <= 0) break;
      await sleep(sleepMs);
      interval = Math.min(interval * 1.5, POLL_INTERVAL_MAX_MS);
    }

    logger.warn(`[headscale-integration] VPN registration timeout for ${agentId}`);
    return null;
  }

  /**
   * Clean up the VPN node when a container is deleted.
   *
   * Finds the node by hostname and deletes it from the Headscale network.
   * Silently succeeds if the node was already removed.
   */
  async cleanupContainerVPN(agentId: string): Promise<void> {
    logger.info(`[headscale-integration] cleaning up VPN node for ${agentId}`);

    try {
      const node = await this.client.getNodeByName(agentId);

      if (!node) {
        logger.info(
          `[headscale-integration] no VPN node found for ${agentId}, nothing to clean up`,
        );
        return;
      }

      await this.client.deleteNode(node.id);
      logger.info(`[headscale-integration] VPN node cleaned up for ${agentId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[headscale-integration] error cleaning up VPN for ${agentId}:`, msg);
      // Don't rethrow — cleanup failures should not block container deletion
    }
  }

  /**
   * Get the VPN IP for a running container.
   *
   * @returns The first VPN IP, or `null` if the node isn't registered.
   */
  async getContainerVPNIP(agentId: string): Promise<string | null> {
    try {
      return await this.client.getNodeIP(agentId);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[headscale-integration] error getting VPN IP for ${agentId}:`, msg);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default singleton instance. */
export const headscaleIntegration = new HeadscaleIntegration();
