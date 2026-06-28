import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  handlePublicMarketDataPreviewRequest,
  PUBLIC_MARKET_PREVIEW_CORS_METHODS,
  PUBLIC_MARKET_TOKEN_RATE_LIMIT,
} from "@/lib/services/market-preview";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

async function __next_OPTIONS() {
  return handleCorsOptions(PUBLIC_MARKET_PREVIEW_CORS_METHODS);
}

async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ chain: string; address: string }> },
) {
  const { chain, address } = await params;
  return applyCorsHeaders(
    await handlePublicMarketDataPreviewRequest({
      chain,
      address,
      method: "getTokenOverview",
      parameterName: "address",
      routeLabel: "token-preview",
    }),
    PUBLIC_MARKET_PREVIEW_CORS_METHODS,
  );
}

const ROUTE_PARAM_SPEC = [
  { name: "chain", splat: false },
  { name: "address", splat: false },
] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.options("/", () => __next_OPTIONS());
honoRouter.get("/", rateLimit(PUBLIC_MARKET_TOKEN_RATE_LIMIT), async (c) => {
  try {
    return await handleGET(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
