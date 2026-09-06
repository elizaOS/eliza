/**
 * Access-token revocation store.
 *
 * Design: user access tokens are short-lived (15m) so logout revocation is
 * mostly defense-in-depth; high-value agent tokens keep their existing longer
 * TTL and use a server-side revocation line. Multi-instance deployments should
 * set REDIS_URL so revocation state is shared. Outside production, this falls
 * back to in-memory state suitable only for single-instance/embedded mode.
 */

import { logger } from "@elizaos/logger";
import { Redis } from "ioredis";
import { assertRedisUrlTls } from "../../redis/src/index.ts";
import { redactedThrownDiagnostics } from "../../shared/src/index.ts";
import { MONOTONIC_REVOCATION_SCRIPT } from "./revocation-script";

export class TokenRevokedError extends Error {
  constructor(message = "Token has been revoked") {
    super(message);
    this.name = "TokenRevokedError";
  }
}

type ExpiresAt = Date | number;

export interface RevocationStore {
  revokeToken(jti: string, expiresAt: ExpiresAt): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  revokeAgentTokens(
    agentId: string,
    issuedBefore?: number,
    expiresAt?: ExpiresAt,
  ): Promise<number>;
  getAgentRevokedBefore(agentId: string): Promise<number | null>;
  revokeUserTokens(
    userId: string,
    issuedBefore?: number,
    expiresAt?: ExpiresAt,
  ): Promise<number>;
  getUserRevokedBefore(userId: string): Promise<number | null>;
}

function toMillis(value: ExpiresAt): number {
  return value instanceof Date
    ? value.getTime()
    : value > 10_000_000_000
      ? value
      : value * 1000;
}

function ttlMs(expiresAt: ExpiresAt, now = Date.now()): number {
  return Math.max(0, toMillis(expiresAt) - now);
}

const DEFAULT_AGENT_REVOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class InMemoryRevocationStore implements RevocationStore {
  private readonly revokedJtis = new Map<string, number>();
  private readonly agentIssuedBefore = new Map<
    string,
    { issuedBefore: number; expiresAtMs: number }
  >();
  private readonly userIssuedBefore = new Map<
    string,
    { issuedBefore: number; expiresAtMs: number }
  >();

  async revokeToken(jti: string, expiresAt: ExpiresAt): Promise<void> {
    const expiresAtMs = toMillis(expiresAt);
    if (expiresAtMs <= Date.now()) return;
    this.revokedJtis.set(jti, expiresAtMs);
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiresAtMs = this.revokedJtis.get(jti);
    if (!expiresAtMs) return false;
    if (expiresAtMs <= Date.now()) {
      this.revokedJtis.delete(jti);
      return false;
    }
    return true;
  }

  async revokeAgentTokens(
    agentId: string,
    issuedBefore = Math.floor(Date.now() / 1000),
    expiresAt: ExpiresAt = Date.now() + DEFAULT_AGENT_REVOCATION_TTL_MS,
  ): Promise<number> {
    const expiresAtMs = toMillis(expiresAt);
    const existing = this.agentIssuedBefore.get(agentId);
    const active =
      existing && existing.expiresAtMs > Date.now() ? existing : null;
    const effectiveIssuedBefore = Math.max(
      active?.issuedBefore ?? -1,
      issuedBefore,
    );
    this.agentIssuedBefore.set(agentId, {
      issuedBefore: effectiveIssuedBefore,
      expiresAtMs: Math.max(active?.expiresAtMs ?? -1, expiresAtMs),
    });
    return effectiveIssuedBefore;
  }

  async getAgentRevokedBefore(agentId: string): Promise<number | null> {
    const entry = this.agentIssuedBefore.get(agentId);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.agentIssuedBefore.delete(agentId);
      return null;
    }
    return entry.issuedBefore;
  }

  async revokeUserTokens(
    userId: string,
    issuedBefore = Math.floor(Date.now() / 1000),
    expiresAt: ExpiresAt = Date.now() + DEFAULT_AGENT_REVOCATION_TTL_MS,
  ): Promise<number> {
    const expiresAtMs = toMillis(expiresAt);
    const existing = this.userIssuedBefore.get(userId);
    const active =
      existing && existing.expiresAtMs > Date.now() ? existing : null;
    const effectiveIssuedBefore = Math.max(
      active?.issuedBefore ?? -1,
      issuedBefore,
    );
    this.userIssuedBefore.set(userId, {
      issuedBefore: effectiveIssuedBefore,
      expiresAtMs: Math.max(active?.expiresAtMs ?? -1, expiresAtMs),
    });
    return effectiveIssuedBefore;
  }

  async getUserRevokedBefore(userId: string): Promise<number | null> {
    const entry = this.userIssuedBefore.get(userId);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.userIssuedBefore.delete(userId);
      return null;
    }
    return entry.issuedBefore;
  }
}

class RedisRevocationStore implements RevocationStore {
  private redis: Redis | null = null;
  private readonly fallback = new InMemoryRevocationStore();
  private warnedMemoryFallback = false;

  private getRedis(): Redis | null {
    if (!process.env.REDIS_URL) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Shared token revocation store unavailable");
      }
      // SEC-056: revocation state silently degrading to per-process memory
      // breaks logout/user-wide revocation across instances — say so loudly.
      if (!this.warnedMemoryFallback) {
        this.warnedMemoryFallback = true;
        logger.warn(
          {
            details: [
              "[steward:auth] REDIS_URL unset — token revocation uses per-process memory; " +
                "logout and user/agent-wide revocation do NOT propagate across instances " +
                "(production would fail closed).",
            ],
          },
          "[Login:revocation] warn",
        );
      }
      return null;
    }
    if (!this.redis) {
      // SEC-032: enforce the same rediss:// production TLS assertion as the
      // shared client in @stwd/redis — revocation state is auth data and must
      // not cross a cleartext link.
      assertRedisUrlTls(process.env.REDIS_URL);
      this.redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: false,
        enableReadyCheck: true,
      });
      this.redis.on("error", (err) => {
        logger.warn(
          {
            details: [
              "[steward:auth] Redis revocation unavailable",
              redactedThrownDiagnostics(err),
            ],
          },
          "[Login:revocation] warn",
        );
      });
    }
    return this.redis;
  }

  private fallbackAgentRevokedBefore(agentId: string): Promise<number | null> {
    return this.fallback.getAgentRevokedBefore(agentId);
  }

  private fallbackUserRevokedBefore(userId: string): Promise<number | null> {
    return this.fallback.getUserRevokedBefore(userId);
  }

  async revokeToken(jti: string, expiresAt: ExpiresAt): Promise<void> {
    const ms = ttlMs(expiresAt);
    if (ms <= 0) return;
    const redis = this.getRedis();
    if (!redis) return this.fallback.revokeToken(jti, expiresAt);
    try {
      await redis.set(`revoked:${jti}`, "1", "PX", ms);
    } catch (error) {
      throw new Error("Shared token revocation store unavailable", {
        cause: error,
      });
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    const redis = this.getRedis();
    if (!redis) return this.fallback.isRevoked(jti);
    try {
      return (await redis.exists(`revoked:${jti}`)) === 1;
    } catch (error) {
      throw new Error("Shared token revocation store unavailable", {
        cause: error,
      });
    }
  }

  async revokeAgentTokens(
    agentId: string,
    issuedBefore = Math.floor(Date.now() / 1000),
    expiresAt: ExpiresAt = Date.now() + DEFAULT_AGENT_REVOCATION_TTL_MS,
  ): Promise<number> {
    const ms = ttlMs(expiresAt);
    if (ms <= 0) return issuedBefore;
    const redis = this.getRedis();
    if (!redis)
      return this.fallback.revokeAgentTokens(agentId, issuedBefore, expiresAt);

    try {
      const markerKey = `revoked-agent:${agentId}:${issuedBefore}`;
      const latestKey = `revoked-agent:${agentId}:issued-before`;
      const effective = Number(
        await redis.eval(
          MONOTONIC_REVOCATION_SCRIPT,
          2,
          markerKey,
          latestKey,
          issuedBefore,
          ms,
        ),
      );
      if (!Number.isFinite(effective))
        throw new Error("invalid Redis revocation line result");
      return effective;
    } catch (error) {
      throw new Error("Shared agent revocation store unavailable", {
        cause: error,
      });
    }
  }

  async getAgentRevokedBefore(agentId: string): Promise<number | null> {
    const redis = this.getRedis();
    if (!redis) return this.fallbackAgentRevokedBefore(agentId);
    try {
      const value = await redis.get(`revoked-agent:${agentId}:issued-before`);
      if (!value) return null;
      const issuedBefore = Number(value);
      return Number.isFinite(issuedBefore) ? issuedBefore : null;
    } catch (error) {
      throw new Error("Shared agent revocation store unavailable", {
        cause: error,
      });
    }
  }

  async revokeUserTokens(
    userId: string,
    issuedBefore = Math.floor(Date.now() / 1000),
    expiresAt: ExpiresAt = Date.now() + DEFAULT_AGENT_REVOCATION_TTL_MS,
  ): Promise<number> {
    const ms = ttlMs(expiresAt);
    if (ms <= 0) return issuedBefore;
    const redis = this.getRedis();
    if (!redis)
      return this.fallback.revokeUserTokens(userId, issuedBefore, expiresAt);

    try {
      const markerKey = `revoked-user:${userId}:${issuedBefore}`;
      const latestKey = `revoked-user:${userId}:issued-before`;
      const effective = Number(
        await redis.eval(
          MONOTONIC_REVOCATION_SCRIPT,
          2,
          markerKey,
          latestKey,
          issuedBefore,
          ms,
        ),
      );
      if (!Number.isFinite(effective))
        throw new Error("invalid Redis revocation line result");
      return effective;
    } catch (error) {
      throw new Error("Shared user revocation store unavailable", {
        cause: error,
      });
    }
  }

  async getUserRevokedBefore(userId: string): Promise<number | null> {
    const redis = this.getRedis();
    if (!redis) return this.fallbackUserRevokedBefore(userId);
    try {
      const value = await redis.get(`revoked-user:${userId}:issued-before`);
      if (!value) return null;
      const issuedBefore = Number(value);
      return Number.isFinite(issuedBefore) ? issuedBefore : null;
    } catch (error) {
      throw new Error("Shared user revocation store unavailable", {
        cause: error,
      });
    }
  }
}

const redisRevocationStore = new RedisRevocationStore();
let embeddedRevocationStore: RevocationStore | undefined;

/** Selects the durable database store while the embedded server owns its connection. */
export function setDatabaseRevocationStore(
  store: RevocationStore | undefined,
): void {
  embeddedRevocationStore = store;
}

function activeRevocationStore(): RevocationStore {
  return embeddedRevocationStore ?? redisRevocationStore;
}

export const revocationStore: RevocationStore = {
  revokeToken: (...args) => activeRevocationStore().revokeToken(...args),
  isRevoked: (...args) => activeRevocationStore().isRevoked(...args),
  revokeAgentTokens: (...args) =>
    activeRevocationStore().revokeAgentTokens(...args),
  getAgentRevokedBefore: (...args) =>
    activeRevocationStore().getAgentRevokedBefore(...args),
  revokeUserTokens: (...args) =>
    activeRevocationStore().revokeUserTokens(...args),
  getUserRevokedBefore: (...args) =>
    activeRevocationStore().getUserRevokedBefore(...args),
};

export async function assertTokenNotRevoked(payload: {
  jti?: string;
  exp?: number;
  iat?: number;
  agentId?: unknown;
  userId?: unknown;
  scope?: unknown;
}): Promise<void> {
  if (payload.jti && (await revocationStore.isRevoked(payload.jti))) {
    throw new TokenRevokedError();
  }

  if (
    payload.scope === "agent" &&
    typeof payload.agentId === "string" &&
    payload.iat
  ) {
    const issuedBefore = await revocationStore.getAgentRevokedBefore(
      payload.agentId,
    );
    if (issuedBefore !== null && payload.iat <= issuedBefore) {
      throw new TokenRevokedError(
        "Agent tokens issued at or before the revocation line have been revoked",
      );
    }
  }

  if (typeof payload.userId === "string" && payload.iat) {
    const issuedBefore = await revocationStore.getUserRevokedBefore(
      payload.userId,
    );
    if (issuedBefore !== null && payload.iat <= issuedBefore) {
      throw new TokenRevokedError(
        "User tokens issued at or before the revocation line have been revoked",
      );
    }
  }
}
