/**
 * GET /api/v1/solana/methods
 *
 * Returns the list of currently allowed Solana RPC methods, sourced from the
 * service_pricing table. Public — useful for API consumers to discover
 * available methods without an API key. CORS handled globally.
 */

import { servicePricingRepository } from "@elizaos/cloud-shared/db/repositories";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const pricingRecords =
      await servicePricingRepository.listByService("solana-rpc");

    // Active methods only, excluding internal underscore-prefixed entries.
    const activeMethods = pricingRecords
      .filter((record) => record.is_active && !record.method.startsWith("_"))
      .map((record) => ({
        method: record.method,
        cost: Number(record.cost),
        description: record.description,
      }))
      .sort((a, b) => a.method.localeCompare(b.method));

    c.header(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=7200",
    );
    return c.json({
      service: "solana-rpc",
      total: activeMethods.length,
      methods: activeMethods,
      note: "Methods are dynamically managed via database. Add new methods via admin API.",
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
