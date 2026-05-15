/**
 * SandboxRegistry — self-registers the sandbox container in the shared
 * Upstash Redis so the multi-tenant gateways (`gateway-discord`,
 * `gateway-webhook`) can resolve `agent_id → server URL` and forward inbound
 * platform messages here.
 *
 * Two Redis keys are written with a short TTL; a periodic heartbeat refreshes
 * the TTL while the sandbox is alive, and `unregister()` deletes them on
 * graceful shutdown. If the container crashes, the keys expire naturally and
 * the gateways stop routing to a dead address.
 *
 *   server:<serverName>:url = <serverUrl>   (resolver address)
 *   agent:<agentId>:server  = <serverName>  (agent → server pointer)
 *
 * The write pattern mirrors `packages/cloud-services/agent-server/src/agent-manager.ts:refreshRedisState`
 * but is stripped to a single-tenant sandbox: one agent, one server, no
 * capacity bookkeeping.
 */

import { logger } from "@elizaos/core";
import { Redis } from "@upstash/redis";

export interface SandboxRegistryConfig {
  redisUrl: string;
  redisToken: string;
  agentId: string;
  serverName: string;
  serverUrl: string;
  /** TTL for both Redis keys in seconds. The heartbeat must refresh at half this interval (or sooner) to avoid windows where the keys expire while the sandbox is healthy. */
  ttlSeconds: number;
}

export class SandboxRegistry {
  private readonly redis: Redis;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: SandboxRegistryConfig) {
    this.redis = new Redis({ url: config.redisUrl, token: config.redisToken });
  }

  async register(): Promise<void> {
    await this.writeKeys();
    logger.info(
      `[sandbox-registry] Registered ${this.config.serverName} → ${this.config.serverUrl} (agent ${this.config.agentId}, ttl ${this.config.ttlSeconds}s)`,
    );
  }

  async refresh(): Promise<void> {
    await this.writeKeys();
  }

  async unregister(): Promise<void> {
    const { serverName, agentId } = this.config;
    await this.redis.del(`server:${serverName}:url`, `agent:${agentId}:server`);
    logger.info(
      `[sandbox-registry] Unregistered ${serverName} (agent ${agentId})`,
    );
  }

  startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      void this.refresh().catch((err) => {
        logger.warn(
          `[sandbox-registry] Heartbeat refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);

    if (
      typeof this.heartbeatTimer === "object" &&
      "unref" in this.heartbeatTimer
    ) {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Atomic two-key write via Upstash pipeline. Both keys must succeed
   * together — partial state would let gateways resolve `agent:X:server` to
   * a stale `server:Y:url` value or miss a routing entry whose other half
   * was just renewed.
   */
  private async writeKeys(): Promise<void> {
    const { serverName, serverUrl, agentId, ttlSeconds } = this.config;
    await this.redis
      .pipeline()
      .set(`server:${serverName}:url`, serverUrl, { ex: ttlSeconds })
      .set(`agent:${agentId}:server`, serverName, { ex: ttlSeconds })
      .exec();
  }
}

/**
 * Reads the SANDBOX_REGISTRY_* and SANDBOX_* env vars and returns a fully
 * wired `SandboxRegistry`, or `null` if the sandbox context is not
 * configured (e.g. local dev, non-Hetzner deployment). Caller must call
 * `register()` and `startHeartbeat(...)` after a successful boot.
 */
export function buildSandboxRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  ttlSeconds = 60,
): SandboxRegistry | null {
  const redisUrl = env.SANDBOX_REGISTRY_REDIS_URL?.trim();
  const redisToken = env.SANDBOX_REGISTRY_REDIS_TOKEN?.trim();
  const agentId = env.SANDBOX_AGENT_ID?.trim();
  const serverName = env.SANDBOX_SERVER_NAME?.trim();
  const serverUrl = env.SANDBOX_PUBLIC_URL?.trim();

  if (!redisUrl || !redisToken || !agentId || !serverName || !serverUrl) {
    return null;
  }

  return new SandboxRegistry({
    redisUrl,
    redisToken,
    agentId,
    serverName,
    serverUrl,
    ttlSeconds,
  });
}
