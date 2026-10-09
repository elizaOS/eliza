// Handles v1 cloud API v1 chain tokens chain address route traffic with route-local auth expectations.

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
      return {
        config: chainDataConfig,
        work: chainDataHandler,
        body: {
          method: "getTokenBalances",
          chain,
          params: { address },
        },
      };
    }),
    CORS_METHODS,
  );
});

export default app;
