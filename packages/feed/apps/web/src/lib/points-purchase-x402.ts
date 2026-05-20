import 'server-only';

import { type RedisClient, X402Manager } from '@feed/a2a';
import { ensureRedisReady, type RedisInstance } from '@feed/api';
import { getCurrentRpcUrl } from '@feed/shared';

function ioredisToX402Redis(redis: RedisInstance): RedisClient {
  return {
    get: (key) => redis.get(key),
    set: async (key, value, options) => {
      if (options?.ex !== undefined) {
        await redis.set(key, value, 'EX', options.ex);
      } else {
        await redis.set(key, value);
      }
    },
    del: async (key) => {
      await redis.del(key);
    },
    keys: (pattern) => redis.keys(pattern),
  };
}

let managerPromise: Promise<X402Manager> | null = null;

/**
 * Shared X402 manager for points purchase. Uses Redis when `REDIS_URL` is
 * configured so create-payment and verify-payment see the same pending state
 * across Vercel/serverless instances.
 */
export function getPointsPurchaseX402Manager(): Promise<X402Manager> {
  if (!managerPromise) {
    managerPromise = (async () => {
      const redis = await ensureRedisReady();
      return new X402Manager({
        rpcUrl: getCurrentRpcUrl(),
        paymentTimeout: 15 * 60 * 1000,
        redis: redis ? ioredisToX402Redis(redis) : undefined,
      });
    })();
    void managerPromise.catch(() => {
      managerPromise = null;
    });
  }
  return managerPromise;
}
