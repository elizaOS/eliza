/**
 * Credit event emitter that switches between Redis and in-memory based on environment.
 *
 * Automatically uses Redis in serverless/production environments for multi-instance compatibility.
 */

import { EventEmitter } from "events";
import { assertPersistentCloudStateConfigured } from "@/lib/utils/persistence-guard";
import type { CreditUpdateEvent } from "./credit-events-redis";
import { redisCreditEventEmitter } from "./credit-events-redis";

export type { CreditUpdateEvent };

/**
 * Stats returned by Redis credit event emitter
 */
interface RedisCreditStats {
  enabled: boolean;
  totalOrganizations: number;
  totalConnections: number;
  organizations: Array<{ id: string; connections: number }>;
}

/**
 * In-memory mode warning details
 */
interface InMemoryWarning {
  warning: string;
}

/**
 * Function to unsubscribe from credit updates.
 */
export type UnsubscribeFunction = () => void;

/**
 * Credit event emitter that adapts to environment.
 */
class CreditEventEmitter {
  private static instance: CreditEventEmitter;
  private inMemoryEmitter: EventEmitter | null = null;
  private lastEnvCheck: { useRedis: boolean; timestamp: number } | null = null;
  private initLogged: boolean = false;

  private constructor() {
    // Defer initialization until first use
  }

  public static getInstance(): CreditEventEmitter {
    if (!CreditEventEmitter.instance) {
      CreditEventEmitter.instance = new CreditEventEmitter();
    }
    return CreditEventEmitter.instance;
  }

  /**
   * Check if we should use Redis at runtime
   * This checks environment variables on every call to handle
   * hot reloading and module caching issues in development
   */
  private shouldUseRedis(): boolean {
    // Check environment variables at runtime
    const isServerless =
      process.env.NODE_ENV === "production" || process.env.FORCE_REDIS_EVENTS === "true";

    const redisConfigured = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
    assertPersistentCloudStateConfigured("credit-events", redisConfigured);

    const useRedis = isServerless && redisConfigured;

    // Initialize emitter if needed
    if (!useRedis && !this.inMemoryEmitter) {
      this.inMemoryEmitter = new EventEmitter();
    }
    this.initLogged = true;

    // Cache the decision for this run
    this.lastEnvCheck = { useRedis, timestamp: Date.now() };

    // Ensure in-memory emitter exists if we need it
    if (!useRedis && !this.inMemoryEmitter) {
      this.inMemoryEmitter = new EventEmitter();
    }

    return useRedis;
  }

  public async emitCreditUpdate(event: CreditUpdateEvent): Promise<void> {
    const useRedis = this.shouldUseRedis();

    if (useRedis) {
      await redisCreditEventEmitter.emitCreditUpdate(event);
    } else if (this.inMemoryEmitter) {
      this.inMemoryEmitter.emit("credit-update", event);
    }
  }

  public subscribeToCreditUpdates(
    organizationId: string,
    handler: (event: CreditUpdateEvent) => void | Promise<void>,
  ): UnsubscribeFunction {
    const useRedis = this.shouldUseRedis();

    if (useRedis) {
      redisCreditEventEmitter.subscribeToCreditUpdates(organizationId, handler);

      // Return sync unsubscribe function
      return () => {
        // Unsubscribe is handled by Redis cleanup
      };
    } else if (this.inMemoryEmitter) {
      const listener = (event: CreditUpdateEvent) => {
        if (event.organizationId === organizationId) {
          handler(event);
        }
      };

      this.inMemoryEmitter.on("credit-update", listener);

      return () => {
        this.inMemoryEmitter?.off("credit-update", listener);
      };
    } else {
      return () => {};
    }
  }

  public incrementConnections(organizationId: string): void {
    if (this.shouldUseRedis()) {
      redisCreditEventEmitter.incrementConnections(organizationId);
    }
  }

  public decrementConnections(organizationId: string): void {
    if (this.shouldUseRedis()) {
      redisCreditEventEmitter.decrementConnections(organizationId);
    }
  }

  public getActiveConnections(organizationId: string): number {
    if (this.shouldUseRedis()) {
      return redisCreditEventEmitter.getActiveConnections(organizationId);
    }
    return 0;
  }

  public isServerlessCompatible(): boolean {
    return this.shouldUseRedis();
  }

  public getStats(): {
    mode: "redis" | "in-memory";
    serverlessCompatible: boolean;
    details: RedisCreditStats | InMemoryWarning;
  } {
    if (this.shouldUseRedis()) {
      return {
        mode: "redis",
        serverlessCompatible: true,
        details: redisCreditEventEmitter.getStats(),
      };
    }

    return {
      mode: "in-memory",
      serverlessCompatible: false,
      details: {
        warning: "In-memory mode - not suitable for multi-instance serverless",
      },
    };
  }
}

export const creditEventEmitter = CreditEventEmitter.getInstance();
