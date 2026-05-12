/**
 * GET /api/v1/x402
 * x402 facilitator discovery endpoint — returns supported schemes, networks,
 * and signer addresses. Public; no auth required.
 */

import { Hono } from "hono";
import { x402FacilitatorService } from "@/lib/services/x402-facilitator";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  await x402FacilitatorService.initialize();

  if (!x402FacilitatorService.isReady()) {
    return c.json(
      {
        success: false,
        error: "x402 facilitator is not configured",
        code: "FACILITATOR_NOT_CONFIGURED",
      },
      503,
    );
  }

  const supported = x402FacilitatorService.getSupported();

  c.header("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
  return c.json({
    success: true,
    ...supported,
    version: "1.0.0",
  });
});

export default app;
