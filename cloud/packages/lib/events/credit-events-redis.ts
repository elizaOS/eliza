/**
 * Redis-backed credit event emitter for serverless environments.
 *
 * Uses Redis queues to coordinate credit update events across multiple serverless instances.
 */

import { buildRedisClient, type CompatibleRedis } from "@/lib/cache/redis-factory";
import { logger } from "@/lib/utils/logger";

/** Environment prefix — prevents cross-env event queue collisions. */
const ENV_PREFIX = process.env.ENVIRONMENT || "local";

/**
 * Credit update event structure.
 */
export interface CreditUpdateEvent {
  organizationId: string;
  newBalance: number;
  delta: number;
  reason: string;
  userId?: string;
  timestamp: Date;
}

/**
 * Raw event data from Redis before timestamp conversion
 */
interface RawCreditUpdateEvent {
  organizationId: string;
  newBalance: number;
  delta: number;
  reason: string;
  userId?: string;
  timestamp: string;
}

/**
 * Type guard to check if a value is a valid RawCreditUpdateEvent
 */
function isRawCreditUpdateEvent(value: unknown): value is RawCreditUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.organizationId === "string" &&
    typeof obj.newBalance === "number" &&
    typeof obj.delta === "number" &&
    typeof obj.reason === "string" &&
    typeof obj.timestamp === "string"
  );
}

/**
 * Redis subscription client for credit updates.
 */
export interface RedisSubscriptionClient {
  /** Unsubscribe from credit updates. */
  unsubscribe: () => Promise<void>;
  /** Organization ID being subscribed to. */
  organizationId: string;
}

/**
 * Redis-backed credit event emitter for distributed environments.
 */
class RedisCreditEventEmitter {
  private static instance: RedisCreditEventEmitter;
  private redis: CompatibleRedis | null = null;
  private enabled: boolean = false;
  private activeSubscriptions = new Map<string, number>();

  private constructor() {
    this.initialize();
  }

  private initialize(): void {
    this.redis = buildRedisClient();
    this.enabled = this.redis !== null;
  }

  public static getInstance(): RedisCreditEventEmitter {
    if (!RedisCreditEventEmitter.instance) {
      RedisCreditEventEmitter.instance = new RedisCreditEventEmitter();
    }
    return RedisCreditEventEmitter.instance;
  }

  public async emitCreditUpdate(event: CreditUpdateEvent): Promise<void> {
    if (!this.enabled || !this.redis) {
      return;
    }

    const channel = `${ENV_PREFIX}:credits:${event.organizationId}:queue`;
    const message = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });

    await this.redis.rpush(channel, message);
    await this.redis.expire(channel, 300);
  }

  public async subscribeToCreditUpdates(
    organizationId: string,
    handler: (event: CreditUpdateEvent) => void | Promise<void>,
  ): Promise<RedisSubscriptionClient> {
    if (!this.enabled || !this.redis) {
      return {
        organizationId,
        unsubscribe: async () => {
          // No-op
        },
      };
    }

    const channel = `${ENV_PREFIX}:credits:${organizationId}`;

    const subscriptionRedis = buildRedisClient();
    if (!subscriptionRedis) {
      return {
        organizationId,
        unsubscribe: async () => {
          // No-op
        },
      };
    }

    const processMessage = async (message: string | Record<string, unknown>) => {
      // Upstash Redis client auto-parses JSON, so message might already be an object
      let parsed: unknown;
      if (typeof message === "string") {
        parsed = JSON.parse(message);
      } else if (typeof message === "object" && message !== null) {
        parsed = message;
      } else {
        return;
      }

      if (!isRawCreditUpdateEvent(parsed)) {
        logger.warn("[Credit Events Redis] Invalid event format:", parsed);
        return;
      }

      const event: CreditUpdateEvent = {
        organizationId: parsed.organizationId,
        newBalance: parsed.newBalance,
        delta: parsed.delta,
        reason: parsed.reason,
        userId: parsed.userId,
        timestamp: new Date(parsed.timestamp),
      };

      await handler(event);
    };

    let isActive = true;

    const pollSubscription = async () => {
      const queueKey = `${channel}:queue`;
      const BATCH_SIZE = 100;
      const POLL_INTERVAL_MS = 1000;

      while (isActive) {
        const popped = await subscriptionRedis.lpop<string | Record<string, unknown>>(
          queueKey,
          BATCH_SIZE,
        );

        if (Array.isArray(popped) && popped.length > 0) {
          for (const message of popped) {
            await processMessage(message);
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    };

    pollSubscription();

    this.incrementConnections(organizationId);

    return {
      organizationId,
      unsubscribe: async () => {
        isActive = false;
        this.decrementConnections(organizationId);
      },
    };
  }

  public incrementConnections(organizationId: string): void {
    const count = this.activeSubscriptions.get(organizationId) || 0;
    this.activeSubscriptions.set(organizationId, count + 1);
  }

  public decrementConnections(organizationId: string): void {
    const count = this.activeSubscriptions.get(organizationId) || 0;
    const newCount = Math.max(0, count - 1);
    this.activeSubscriptions.set(organizationId, newCount);

    if (newCount === 0) {
      this.activeSubscriptions.delete(organizationId);
    }
  }

  public getActiveConnections(organizationId: string): number {
    return this.activeSubscriptions.get(organizationId) || 0;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getStats(): {
    enabled: boolean;
    totalOrganizations: number;
    totalConnections: number;
    organizations: Array<{ id: string; connections: number }>;
  } {
    const organizations = Array.from(this.activeSubscriptions.entries()).map(
      ([id, connections]) => ({ id, connections }),
    );

    return {
      enabled: this.enabled,
      totalOrganizations: this.activeSubscriptions.size,
      totalConnections: organizations.reduce((sum, org) => sum + org.connections, 0),
      organizations,
    };
  }
}

export const redisCreditEventEmitter = RedisCreditEventEmitter.getInstance();
