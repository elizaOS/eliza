/**
 * MCP Schema Cache - Optional Redis caching for serverless cold start optimization
 *
 * When enabled (via env vars), caches tool schemas to avoid MCP connection on cold start.
 * When disabled or misconfigured, gracefully falls back to direct MCP connections.
 *
 * Environment variables:
 * - MCP_SCHEMA_CACHE_ENABLED: "true" to enable (default: disabled)
 * - MCP_CACHE_REDIS_URL: Upstash REST API URL (https://..., NOT rediss://)
 * - MCP_CACHE_REDIS_TOKEN: Upstash REST API token
 * - MCP_SCHEMA_CACHE_TTL: Cache TTL in seconds (default: 3600)
 */

import { logger } from "@elizaos/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "crypto";
import type { CachedServerSchema, McpServerConfig } from "../types";

const CACHE_KEY_PREFIX = "mcp:schema:v1";
const DEFAULT_TTL = 3600;

/** Simple Upstash REST client - avoids heavy dependencies */
class UpstashClient {
  constructor(
    private url: string,
    private token: string,
  ) {
    // Validate URL format
    if (url.startsWith("redis://") || url.startsWith("rediss://")) {
      throw new Error(
        "MCP_CACHE_REDIS_URL must be Upstash REST URL (https://...), not Redis protocol URL",
      );
    }
    this.url = url.replace(/\/$/, "");
  }

  private async exec<T>(cmd: string[]): Promise<T | null> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { result?: T };
      return (data.result ?? null) as T | null;
    } catch {
      return null;
    }
  }

  get = (key: string) => this.exec<string>(["GET", key]);
  setex = (key: string, ttl: number, val: string) => this.exec(["SETEX", key, String(ttl), val]);
  del = (key: string) => this.exec(["DEL", key]);
}

/**
 * MCP Schema Cache - singleton for caching tool schemas
 */
export class McpSchemaCache {
  private client: UpstashClient | null = null;
  private ttl: number;

  constructor() {
    const enabled = process.env.MCP_SCHEMA_CACHE_ENABLED === "true";
    const url = process.env.MCP_CACHE_REDIS_URL;
    const token = process.env.MCP_CACHE_REDIS_TOKEN;
    this.ttl = parseInt(process.env.MCP_SCHEMA_CACHE_TTL || String(DEFAULT_TTL), 10);

    if (!enabled) {
      logger.debug("[McpSchemaCache] Disabled");
      return;
    }

    if (!url || !token) {
      logger.warn(
        "[McpSchemaCache] Enabled but missing MCP_CACHE_REDIS_URL or MCP_CACHE_REDIS_TOKEN",
      );
      return;
    }

    try {
      this.client = new UpstashClient(url, token);
      logger.info(`[McpSchemaCache] Enabled (TTL: ${this.ttl}s)`);
    } catch (e) {
      logger.error(`[McpSchemaCache] Init failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  /** Hash config to detect changes */
  hashConfig(config: McpServerConfig): string {
    // Sort keys recursively to ensure consistent hashing regardless of key order
    const sortedJson = JSON.stringify(config, (_, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value)
            .sort()
            .reduce((sorted: Record<string, unknown>, key) => {
              sorted[key] = value[key];
              return sorted;
            }, {})
        : value,
    );
    return createHash("sha256").update(sortedJson).digest("hex").slice(0, 16);
  }

  private key(agentId: string, serverName: string): string {
    return `${CACHE_KEY_PREFIX}:${agentId}:${serverName}`;
  }

  /** Get cached schemas (returns null on miss or error) */
  async getSchemas(
    agentId: string,
    serverName: string,
    configHash: string,
  ): Promise<CachedServerSchema | null> {
    if (!this.client) return null;

    try {
      const raw = await this.client.get(this.key(agentId, serverName));
      if (!raw) return null;

      const cached: CachedServerSchema = JSON.parse(raw);
      if (cached.configHash !== configHash) {
        await this.client.del(this.key(agentId, serverName));
        logger.debug(`[McpSchemaCache] Config changed for ${serverName}, invalidated`);
        return null;
      }

      logger.info(`[McpSchemaCache] Hit: ${serverName} (${cached.tools.length} tools)`);
      return cached;
    } catch {
      return null;
    }
  }

  /** Cache schemas (fails silently) */
  async setSchemas(
    agentId: string,
    serverName: string,
    configHash: string,
    tools: Tool[],
  ): Promise<void> {
    if (!this.client) return;

    try {
      const cached: CachedServerSchema = {
        serverName,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        cachedAt: Date.now(),
        configHash,
      };
      await this.client.setex(this.key(agentId, serverName), this.ttl, JSON.stringify(cached));
      logger.info(`[McpSchemaCache] Cached: ${serverName} (${tools.length} tools)`);
    } catch {
      // Silent fail - caching is optional
    }
  }

  /** Convert cached schemas to Tool format */
  static toTools(cached: CachedServerSchema): Tool[] {
    return cached.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object" as const, properties: {} },
    }));
  }
}

// Singleton
let instance: McpSchemaCache | null = null;
export function getSchemaCache(): McpSchemaCache {
  if (!instance) instance = new McpSchemaCache();
  return instance;
}
