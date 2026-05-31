/**
 * SandboxRegistry (agent runtime) — self-registers a cloud-provisioned
 * container in the shared Upstash Redis so the multi-tenant gateways
 * (`gateway-discord`, `gateway-webhook`) can resolve `agent_id -> server URL`
 * and forward inbound platform messages to THIS container.
 *
 * WHY this lives in `packages/agent` (and duplicates the logic in
 * `packages/app-core/src/services/sandbox-registry.ts`):
 * The published cloud image runs `packages/agent/dist/bin.js` as its
 * entrypoint (see `packages/app-core/deploy/Dockerfile.ci` APP_ENTRYPOINT).
 * That entrypoint boots the agent runtime in `packages/agent/src/runtime/eliza.ts`,
 * which CANNOT import `@elizaos/app-core` without creating an
 * `agent -> app-core -> agent` workspace cycle. The app-core copy therefore
 * never executes in a provisioned container. This is a deliberate, minimal
 * backport scoped to the container self-registration seam (Path A).
 *
 * It writes two Redis keys with a short TTL; a periodic heartbeat refreshes
 * the TTL while the container is alive, and `unregister()` deletes them on
 * graceful shutdown if they still point at this container. If the container
 * crashes, the keys expire naturally and the gateways stop routing to a dead
 * address.
 *
 *   server:<serverName>:url = <serverUrl>   (resolver address)
 *   agent:<agentId>:server  = <serverName>  (agent -> server pointer)
 *
 * Implementation note: this uses the Upstash REST API directly via `fetch`
 * instead of the `@upstash/redis` SDK so it adds no new dependency to the
 * agent package (which is also bundled for mobile). The pipeline endpoint
 * applies both SET-with-EX commands atomically server-side.
 */

import { logger } from "@elizaos/core";

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface SandboxRegistryConfig {
  redisUrl: string;
  redisToken: string;
  agentId: string;
  serverName: string;
  serverUrl: string;
  /**
   * TTL for both Redis keys in seconds. Keep this at least 3x the heartbeat
   * interval so one missed tick does not expire a healthy container.
   */
  ttlSeconds: number;
}

export class SandboxRegistry {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: SandboxRegistryConfig) {}

  async register(): Promise<void> {
    await this.writeKeys();
    logger.info(
      `[sandbox-registry] Registered ${this.config.serverName} -> ${this.config.serverUrl} (agent ${this.config.agentId}, ttl ${this.config.ttlSeconds}s)`,
    );
  }

  async refresh(): Promise<void> {
    await this.writeKeys();
  }

  async unregister(): Promise<void> {
    const { serverName, serverUrl, agentId } = this.config;
    const serverUrlKey = `server:${serverName}:url`;
    const agentServerKey = `agent:${agentId}:server`;
    const [registeredUrl, registeredServer] = await Promise.all([
      this.get(serverUrlKey),
      this.get(agentServerKey),
    ]);
    const keysToDelete: string[] = [];
    if (registeredUrl === serverUrl) keysToDelete.push(serverUrlKey);
    if (registeredServer === serverName) keysToDelete.push(agentServerKey);
    if (keysToDelete.length > 0) {
      await this.command(["DEL", ...keysToDelete]);
    }
    logger.info(
      `[sandbox-registry] Unregistered ${serverName} (agent ${agentId})`,
    );
  }

  startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      void this.refresh().catch((err) => {
        logger.warn(
          `[sandbox-registry] Heartbeat refresh failed: ${formatErr(err)}`,
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
   * Atomic two-key write via the Upstash REST pipeline endpoint. Both keys
   * must succeed together — partial state would let gateways resolve
   * `agent:X:server` to a stale `server:Y:url` value or miss a routing entry
   * whose other half was just renewed.
   */
  private async writeKeys(): Promise<void> {
    const { serverName, serverUrl, agentId, ttlSeconds } = this.config;
    const ttl = String(ttlSeconds);
    await this.pipeline([
      ["SET", `server:${serverName}:url`, serverUrl, "EX", ttl],
      ["SET", `agent:${agentId}:server`, serverName, "EX", ttl],
    ]);
  }

  private async get(key: string): Promise<string | null> {
    const result = await this.command(["GET", key]);
    return typeof result === "string" ? result : null;
  }

  private async command(args: string[]): Promise<unknown> {
    const res = await fetch(this.config.redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      throw new Error(
        `Upstash command failed: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`Upstash error: ${json.error}`);
    return json.result;
  }

  private async pipeline(commands: string[][]): Promise<void> {
    const res = await fetch(`${this.config.redisUrl}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      throw new Error(
        `Upstash pipeline failed: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as Array<{ error?: string }>;
    if (Array.isArray(json)) {
      for (const entry of json) {
        if (entry?.error) throw new Error(`Upstash error: ${entry.error}`);
      }
    }
  }
}

/**
 * Reads the SANDBOX_REGISTRY_* and SANDBOX_* env vars and returns a fully
 * wired `SandboxRegistry`, or `null` if the sandbox context is not configured
 * (e.g. local dev, non-Hetzner deployment). Caller must call `register()` and
 * `startHeartbeat(...)` after a successful boot.
 *
 * This is the FEATURE FLAG for container self-registration: when the five env
 * vars are absent (every non-provisioned runtime), this returns null and the
 * runtime behaves exactly as before. Only a cloud-provisioned container
 * carrying the full SANDBOX_REGISTRY_* set will register.
 */
export function buildSandboxRegistryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  ttlSeconds = 90,
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
