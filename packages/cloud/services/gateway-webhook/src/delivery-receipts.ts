import {
  cloudflareDeliveryReceiptStore,
  DeliveryReceiptStateError,
  type DeliveryReceiptStore,
} from "@elizaos/cloud-services-common/delivery-receipts";
import type { GatewayRedis } from "./redis";

/** Capture one authority for the whole delivery attempt, including receipt recovery. */
export function deliveryReceiptStore(
  redis: GatewayRedis,
): DeliveryReceiptStore {
  const backend = process.env.CLOUD_GATEWAY_RECEIPTS_BACKEND ?? "redis";
  if (backend === "cloudflare")
    return cloudflareDeliveryReceiptStore(process.env);
  if (backend !== "redis")
    throw new DeliveryReceiptStateError(
      "Invalid CLOUD_GATEWAY_RECEIPTS_BACKEND",
    );
  return {
    get: (key) => redis.get(key),
    set: (key, value, options) => redis.set(key, value, options),
    del: (key) => redis.del(key),
    delIfEquals: (key, value) => redis.delIfEquals(key, value),
    async replaceIfEquals(key, expected, value, seconds) {
      return (
        Number(
          await redis.eval(
            'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3]); return 1 end return 0',
            [key],
            [expected, value, String(seconds)],
          ),
        ) === 1
      );
    },
  };
}
