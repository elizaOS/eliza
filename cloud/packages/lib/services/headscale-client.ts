/**
 * Headscale VPN Client
 * REST API client for the Headscale coordination server.
 * Ported from eliza-cloud's headscale-manager.ts
 *
 * Provides node management, pre-auth key generation, and route control
 * for container VPN enrollment via the Headscale API.
 */

import { logger } from "@/lib/utils/logger";

const HEADSCALE_API_URL = process.env.HEADSCALE_API_URL || "http://localhost:8081";
const HEADSCALE_API_KEY = process.env.HEADSCALE_API_KEY || "";
const HEADSCALE_USER = process.env.HEADSCALE_USER || "agent";

/** Default timeout for API requests (ms) */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Timeout for health checks (ms) */
const HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadscaleNode {
  id: string;
  name: string;
  user: { name: string };
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  createdAt: string;
}

export interface HeadscalePreAuthKey {
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
}

export interface HeadscaleRoute {
  id: string;
  node: string;
  prefix: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HeadscaleClient {
  private baseUrl: string;
  private apiKey: string;
  private user: string;

  constructor(opts?: { apiUrl?: string; apiKey?: string; user?: string }) {
    this.baseUrl = opts?.apiUrl || HEADSCALE_API_URL;
    this.apiKey = opts?.apiKey || HEADSCALE_API_KEY;
    this.user = opts?.user || HEADSCALE_USER;
  }

  // -------------------------------------------------------------------------
  // Server status
  // -------------------------------------------------------------------------

  /**
   * Check whether the Headscale server is reachable and return high-level stats.
   */
  async getStatus(): Promise<{ online: boolean; nodeCount: number }> {
    try {
      const healthResp = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });

      if (!healthResp.ok) {
        logger.warn("[headscale] health check returned non-OK status");
        return { online: false, nodeCount: 0 };
      }

      const nodes = await this.listNodes();
      return { online: true, nodeCount: nodes.length };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn("[headscale] status check failed:", msg);
      return { online: false, nodeCount: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Node management
  // -------------------------------------------------------------------------

  /** List all registered nodes. */
  async listNodes(): Promise<HeadscaleNode[]> {
    try {
      const data = await this.request<{ nodes?: HeadscaleNode[] }>("GET", "/api/v1/node");
      return data.nodes ?? [];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("[headscale] error listing nodes:", msg);
      return [];
    }
  }

  /** Find a node by its hostname. */
  async getNodeByName(name: string): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodes();
    return nodes.find((n) => n.name === name) ?? null;
  }

  /** Get the first IP address for a node identified by hostname. */
  async getNodeIP(name: string): Promise<string | null> {
    const node = await this.getNodeByName(name);
    if (!node || node.ipAddresses.length === 0) return null;
    return node.ipAddresses[0];
  }

  /** Delete a node from the Headscale network. */
  async deleteNode(nodeId: string): Promise<void> {
    try {
      logger.info(`[headscale] deleting node ${nodeId}`);
      await this.request<Record<string, unknown>>("DELETE", `/api/v1/node/${nodeId}`);
      logger.info(`[headscale] deleted node ${nodeId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      // 404 is acceptable – node already gone
      if (msg.includes("404")) {
        logger.warn(`[headscale] node ${nodeId} already deleted (404)`);
        return;
      }
      logger.error(`[headscale] error deleting node ${nodeId}:`, msg);
      throw error;
    }
  }

  /** Set ACL tags on a node (PUT /api/v1/node/{nodeId}/tags). */
  async setNodeTags(nodeId: string, tags: string[]): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("POST", `/api/v1/node/${nodeId}/tags`, { tags });
      logger.info(`[headscale] set tags on node ${nodeId}: ${tags.join(", ")}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale] error setting tags on node ${nodeId}:`, msg);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Pre-auth keys
  // -------------------------------------------------------------------------

  /**
   * Create a pre-auth key that containers use to join the VPN on boot.
   *
   * @param opts.reusable   Allow the key to be used more than once (default false)
   * @param opts.ephemeral  Node will be removed once it goes offline (default false)
   * @param opts.expiration ISO-8601 expiration timestamp (default: 10 min from now)
   * @param opts.aclTags    ACL tags to attach to the key (default: ["tag:agent"])
   */
  async createPreAuthKey(opts?: {
    reusable?: boolean;
    ephemeral?: boolean;
    expiration?: string;
    aclTags?: string[];
  }): Promise<HeadscalePreAuthKey> {
    const { reusable = false, ephemeral = false, expiration, aclTags = ["tag:agent"] } = opts ?? {};

    // 10-minute window is sufficient for container boot + VPN enrollment.
    // Previous 24h was unnecessarily large for single-use ephemeral keys.
    const expirationTime = expiration ?? new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const userId = await this.resolveUserId();

    const data = await this.request<{
      preAuthKey?: HeadscalePreAuthKey;
    }>("POST", "/api/v1/preauthkey", {
      user: userId,
      reusable,
      ephemeral,
      expiration: expirationTime,
      aclTags,
    });

    const key = data.preAuthKey;
    if (!key?.key) {
      throw new Error("[headscale] No pre-auth key returned from API");
    }

    logger.info("[headscale] created pre-auth key");
    return key;
  }

  /** List all pre-auth keys for the configured user. */
  async listPreAuthKeys(): Promise<HeadscalePreAuthKey[]> {
    try {
      const data = await this.request<{
        preAuthKeys?: HeadscalePreAuthKey[];
      }>("GET", "/api/v1/preauthkey");
      return data.preAuthKeys ?? [];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error("[headscale] error listing pre-auth keys:", msg);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /** List all advertised routes across nodes. */
  async listRoutes(): Promise<HeadscaleRoute[]> {
    try {
      const data = await this.request<{ routes?: HeadscaleRoute[] }>("GET", "/api/v1/routes");
      return data.routes ?? [];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      // Some older Headscale versions may not support /routes
      if (msg.includes("404")) {
        logger.warn("[headscale] routes endpoint not supported; returning empty list");
        return [];
      }
      logger.error("[headscale] error listing routes:", msg);
      return [];
    }
  }

  /** Enable an advertised route by its ID. */
  async enableRoute(routeId: string): Promise<void> {
    try {
      await this.request<Record<string, unknown>>("POST", `/api/v1/routes/${routeId}/enable`);
      logger.info(`[headscale] enabled route ${routeId}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[headscale] error enabling route ${routeId}:`, msg);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generic HTTP request helper for the Headscale REST API.
   * All requests include the Bearer token and an abort timeout.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Log raw body at debug level only — don't leak it into error messages
      logger.debug(`[headscale] API error body for ${method} ${path}:`, {
        body: text,
      });
      throw new Error(`Headscale API ${method} ${path} failed: ${resp.status} ${resp.statusText}`);
    }

    // Some endpoints (DELETE) may not return a body
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await resp.json()) as T;
    }

    return {} as T;
  }

  /**
   * Resolve the configured HEADSCALE_USER to a numeric user ID.
   * Falls back to listing users via the API if the value isn't already numeric.
   */
  private async resolveUserId(): Promise<number> {
    // If user looks numeric, use directly
    if (/^\d+$/.test(this.user)) {
      return Number(this.user);
    }

    // Otherwise look it up via the users endpoint
    const data = await this.request<{
      users?: Array<{ id: number | string; name: string }>;
    }>("GET", "/api/v1/user");

    const users = data.users ?? [];
    const match = users.find((u) => u.name === this.user || String(u.id) === this.user);

    if (!match?.id || !/^\d+$/.test(String(match.id))) {
      throw new Error(`[headscale] user not found or invalid: ${this.user}`);
    }

    return Number(match.id);
  }
}

/** Default singleton instance using environment variables. */
export const headscaleClient = new HeadscaleClient();
