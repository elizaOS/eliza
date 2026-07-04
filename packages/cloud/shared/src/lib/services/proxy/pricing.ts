// Coordinates cloud service pricing behavior behind route handlers.
import { servicePricingRepository } from "../../../db/repositories";
import { cache } from "../../cache/client";
import { logger } from "../../utils/logger";
import { getProxyConfig } from "./config";

// Fallback used only when a service's DB pricing rows are missing (a data fault,
// e.g. a partially-seeded DB or a new serviceId shipped without a seed). Kept at
// the low end of real per-call prices (sub-cent; cf. the proxy-billing compatibility
// defaults of $0.0003–$0.001) so a pricing miss UNDER-charges rather than billing
// $1.00/call (~1,000–20,000x the true price). Fail-safe for the customer.
const FALLBACK_COST = 0.001;
const inflightPricingLoads = new Map<string, Promise<Record<string, string>>>();

export class PricingNotFoundError extends Error {
  constructor(
    public readonly serviceId: string,
    public readonly method: string,
  ) {
    super(`Pricing not found for service ${serviceId}, method ${method}`);
    this.name = "PricingNotFoundError";
  }
}

async function loadPricingMap(serviceId: string): Promise<Record<string, string>> {
  const existingLoad = inflightPricingLoads.get(serviceId);
  if (existingLoad) {
    return existingLoad;
  }

  const cacheKey = `service-pricing:${serviceId}`;
  const cacheTtl = getProxyConfig().PRICING_CACHE_TTL;
  const loadPromise = (async () => {
    const cached = await cache.get<Record<string, string>>(cacheKey);
    if (cached) {
      return cached;
    }

    const pricingRecords = await servicePricingRepository.listByService(serviceId);
    const pricingMap: Record<string, string> = {};

    if (pricingRecords.length === 0) {
      logger.error("[Pricing] No pricing records in DB, using fallback", {
        serviceId,
        fallback: FALLBACK_COST,
      });
      // Do NOT cache the empty map: caching it would pin the fallback for the
      // whole TTL (up to 5 min) even after the pricing rows land. Leaving it
      // uncached lets a transient/partial-seed miss self-heal on the next call.
      return pricingMap;
    }

    for (const record of pricingRecords) {
      pricingMap[record.method] = String(record.cost);
    }

    await cache.set(cacheKey, pricingMap, cacheTtl);
    return pricingMap;
  })();

  inflightPricingLoads.set(serviceId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    inflightPricingLoads.delete(serviceId);
  }
}

export async function getServiceMethodCost(serviceId: string, method: string): Promise<number> {
  const pricingMap = await loadPricingMap(serviceId);
  const costStr = pricingMap[method];

  if (!costStr) {
    if (Object.keys(pricingMap).length === 0) {
      logger.warn("[Pricing] Missing DB pricing, using fallback", {
        serviceId,
        method,
        fallback: FALLBACK_COST,
      });
      return FALLBACK_COST;
    }
    throw new PricingNotFoundError(serviceId, method);
  }

  const cost = Number.parseFloat(costStr);
  if (!Number.isFinite(cost)) {
    throw new Error(`Invalid pricing for ${serviceId}.${method}: ${costStr}`);
  }
  return cost;
}

/** EVM JSON-RPC batch: sum per-method costs from the pricing table. */
export async function calculateBatchCost(
  serviceId: string,
  allowedMethods: Set<string>,
  body: Array<{ method?: unknown }>,
  maxBatchSize: number,
): Promise<number> {
  if (body.length > maxBatchSize) {
    throw new Error(`Invalid JSON-RPC batch: maximum ${maxBatchSize} requests`);
  }
  const methodCounts = new Map<string, number>();
  for (const item of body) {
    if (!item || typeof item !== "object" || !("method" in item)) {
      throw new Error("Invalid JSON-RPC batch: malformed request");
    }
    const method = String(item.method);
    if (!allowedMethods.has(method)) {
      throw new Error(`Batch contains unsupported method '${method}'.`);
    }
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }

  const costs = await Promise.all(
    Array.from(methodCounts.keys()).map(async (method) => ({
      method,
      cost: await getServiceMethodCost(serviceId, method),
    })),
  );
  return costs.reduce((sum, { method, cost }) => sum + cost * (methodCounts.get(method) ?? 0), 0);
}

export async function invalidateServicePricingCache(serviceId: string): Promise<void> {
  const cacheKey = `service-pricing:${serviceId}`;
  await cache.del(cacheKey);
  inflightPricingLoads.delete(serviceId);
}
