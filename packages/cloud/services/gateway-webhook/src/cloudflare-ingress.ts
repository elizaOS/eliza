import {
  cloudflareIngressTransport,
  HOLD_INDEX_KEY,
  HOLD_REMOVE_SCRIPT,
  HOLD_SAVE_SCRIPT,
  isIngressKey,
  WebhookIngressStateError,
} from "@elizaos/cloud-services-common/webhook-ingress";
import type { GatewayRedis } from "./redis";

/** Routes only the audited ingress keyspace; selected state never falls back. */
export function withCloudflareIngress(
  redis: GatewayRedis,
  env: Record<string, string | undefined> = process.env,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): GatewayRedis {
  const backend = env.CLOUD_WEBHOOK_INGRESS_BACKEND ?? "redis";
  if (backend === "redis") return redis;
  if (backend !== "cloudflare")
    throw new WebhookIngressStateError("Invalid CLOUD_WEBHOOK_INGRESS_BACKEND");
  const call = cloudflareIngressTransport(env, fetcher);
  const owns = (key: string) => isIngressKey(key) || key === HOLD_INDEX_KEY;
  async function count(operation: string, fields: object): Promise<number> {
    const value = await call(operation, fields);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new WebhookIngressStateError(
        "Invalid ingress mutation acknowledgement",
      );
    return value;
  }
  function unsupported(): never {
    throw new WebhookIngressStateError("Unsupported ingress operation");
  }
  return {
    async get<T>(key: string): Promise<T | null> {
      if (!owns(key)) return redis.get<T>(key);
      const value = await call("get", { key });
      if (value === null) return null;
      if (typeof value !== "string")
        throw new WebhookIngressStateError("Invalid ingress value");
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    },
    async set(key, value, options = {}) {
      if (!owns(key)) return redis.set(key, value, options);
      const result = await call("set", { key, value, ...options });
      if (result !== null && result !== "OK")
        throw new WebhookIngressStateError(
          "Invalid ingress write acknowledgement",
        );
      return result;
    },
    del: (key) => (owns(key) ? count("del", { key }) : redis.del(key)),
    expire: (key, seconds) =>
      owns(key)
        ? count("expire", { key, seconds })
        : redis.expire(key, seconds),
    delIfEquals: async (key, value) =>
      owns(key)
        ? (await count("delIfEquals", { key, value })) === 1
        : redis.delIfEquals(key, value),
    expireIfEquals: async (key, value, seconds) =>
      owns(key)
        ? (await count("expireIfEquals", { key, value, seconds })) === 1
        : redis.expireIfEquals(key, value, seconds),
    lpush: (key, value) =>
      owns(key) ? unsupported() : redis.lpush(key, value),
    ltrim: (key, start, stop) =>
      owns(key) ? unsupported() : redis.ltrim(key, start, stop),
    zadd: (key, score, member) =>
      owns(key)
        ? count("zadd", { key, score, member })
        : redis.zadd(key, score, member),
    zrem: (key, member) =>
      owns(key) ? count("zrem", { key, member }) : redis.zrem(key, member),
    async zrangebyscore(key, min, max, limit) {
      if (!owns(key)) return redis.zrangebyscore(key, min, max, limit);
      const value = await call("due", { key, min, max, limit });
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        throw new WebhookIngressStateError("Invalid ingress retry index");
      return value as string[];
    },
    eval(script, keys, args) {
      if (!keys.some(owns)) return redis.eval(script, keys, args);
      if (!keys.every(owns)) return unsupported();
      if (script === HOLD_SAVE_SCRIPT) return count("hold", { keys, args });
      if (script === HOLD_REMOVE_SCRIPT)
        return count("removeHeld", { keys, args });
      return unsupported();
    },
    quit: () => redis.quit?.() ?? Promise.resolve(),
  };
}
