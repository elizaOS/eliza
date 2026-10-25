// Handles v1 cloud API v1 chain transfers chain address route traffic with route-local auth expectations.

import { isValidAddress } from "@elizaos/cloud-shared/lib/services/proxy/address-validation";
import {
  chainDataConfig,
  chainDataHandler,
} from "@elizaos/cloud-shared/lib/services/proxy/chain-data";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import { ALCHEMY_SLUGS } from "@elizaos/cloud-shared/lib/services/proxy/rpc";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";

const CORS_METHODS = "GET, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  return applyCorsHeaders(
    await executeGuardedPaidProxyWithPreflight(c, () => {
      const chain = (c.req.param("chain") ?? "").toLowerCase();
      const address = c.req.param("address") ?? "";
      const direction = c.req.query("direction") ?? "out";
      if (!ALCHEMY_SLUGS[chain]) {
        return c.json(
          {
            error: "Invalid chain",
            details: `Supported chains: ${Object.keys(ALCHEMY_SLUGS).join(", ")}`,
          },
          400,
        );
      }
      if (!isValidAddress(chain, address)) {
        return c.json(
          {
            error: "Invalid address format",
            details: `Address format invalid for chain: ${chain}`,
          },
          400,
        );
      }
      if (direction !== "in" && direction !== "out") {
        return c.json(
          {
            error: "Invalid direction",
            details: "Use direction=in or direction=out",
          },
          400,
        );
      }
      return {
        config: chainDataConfig,
        work: chainDataHandler,
        body: {
          method: "getAssetTransfers",
          chain,
          params:
            direction === "in"
              ? { toAddress: address }
              : { fromAddress: address },
        },
      };
    }),
    CORS_METHODS,
  );
});

export default app;
