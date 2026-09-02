// Handles v1 cloud API v1 chain nfts chain address route traffic with route-local auth expectations.
import { Hono } from "hono";
import { executeGuardedPaidProxyWithPreflight } from "@/api-app/lib/guarded-paid-proxy";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { isValidAddress } from "@/lib/services/proxy/services/address-validation";
import {
  chainDataConfig,
  chainDataHandler,
} from "@/lib/services/proxy/services/chain-data";
import { ALCHEMY_SLUGS } from "@/lib/services/proxy/services/rpc";
import type { AppEnv } from "@/types/cloud-worker-env";

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
          method: "getNFTsForOwner",
          chain,
          params: { owner: address },
        },
      };
    }),
    CORS_METHODS,
  );
});

export default app;
