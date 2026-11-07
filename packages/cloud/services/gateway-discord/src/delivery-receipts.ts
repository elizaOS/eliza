import {
  cloudflareDeliveryReceiptStore,
  DeliveryReceiptStateError,
} from "@elizaos/cloud-services-common/delivery-receipts";
import type { DiscordInternalDeliveryDependencies } from "./internal-delivery";

/** Capture the configured receipt authority at gateway startup. */
export function discordDeliveryReceiptStore(
  redis: DiscordInternalDeliveryDependencies["receipts"],
  env: Record<string, string | undefined> = process.env,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): DiscordInternalDeliveryDependencies["receipts"] {
  const backend = env.CLOUD_GATEWAY_RECEIPTS_BACKEND ?? "redis";
  if (backend === "redis") return redis;
  if (backend !== "cloudflare")
    throw new DeliveryReceiptStateError(
      "Invalid CLOUD_GATEWAY_RECEIPTS_BACKEND",
    );
  const store = cloudflareDeliveryReceiptStore(env, fetcher);
  return {
    get: (key) => store.get(key),
    set: (key, value, options) => store.set(key, value, options),
    delete: (key) => store.del(key),
  };
}
