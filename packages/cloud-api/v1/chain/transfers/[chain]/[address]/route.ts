import { Hono } from "hono";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { executeWithBody } from "@/lib/services/proxy/engine";
import { isValidAddress } from "@/lib/services/proxy/services/address-validation";
import { chainDataConfig, chainDataHandler } from "@/lib/services/proxy/services/chain-data";
import { ALCHEMY_SLUGS } from "@/lib/services/proxy/services/rpc";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.get("/", async (c) => {
  const chain = (c.req.param("chain") ?? "").toLowerCase();
  const address = c.req.param("address") ?? "";
  const direction = c.req.query("direction") ?? "out";

  if (!ALCHEMY_SLUGS[chain]) {
    return applyCorsHeaders(
      c.json(
        {
          error: "Invalid chain",
          details: `Supported chains: ${Object.keys(ALCHEMY_SLUGS).join(", ")}`,
        },
        400,
      ),
      CORS_METHODS,
    );
  }

  if (!isValidAddress(chain, address)) {
    return applyCorsHeaders(
      c.json(
        {
          error: "Invalid address format",
          details: `Address format invalid for chain: ${chain}`,
        },
        400,
      ),
      CORS_METHODS,
    );
  }

  if (direction !== "in" && direction !== "out") {
    return applyCorsHeaders(
      c.json({ error: "Invalid direction", details: "Use direction=in or direction=out" }, 400),
      CORS_METHODS,
    );
  }

  return applyCorsHeaders(
    await executeWithBody(chainDataConfig, chainDataHandler, c.req.raw, {
      method: "getAssetTransfers",
      chain,
      params: direction === "in" ? { toAddress: address } : { fromAddress: address },
    }),
    CORS_METHODS,
  );
});

export default app;
