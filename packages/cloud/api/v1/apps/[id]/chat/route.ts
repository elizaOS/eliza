/** Delegates app-scoped chat to the canonical cache-only inference pipeline. */

import { Hono } from "hono";
import { handleChatCompletionsPOST } from "@/api/v1/chat/completions/route";
import { getGenerativeExecutionContext } from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  addCorsHeaders,
  createPreflightResponse,
} from "@/lib/middleware/cors-apps";
import type { AppEnv } from "@/types/cloud-worker-env";

const honoRouter = new Hono<AppEnv>();

honoRouter.options("/", (c) =>
  createPreflightResponse(c.req.header("origin") ?? null, ["POST", "OPTIONS"]),
);

honoRouter.post("/", async (c) => {
  const appId = c.req.param("id");
  if (!appId) {
    return Response.json(
      {
        error: {
          message: "Missing app id",
          type: "invalid_request_error",
          code: "missing_required_parameter",
        },
      },
      { status: 400 },
    );
  }

  try {
    const response = await handleChatCompletionsPOST(c.req.raw, {
      requiredAppId: appId,
      traceId: c.get("traceId"),
      executionCtx: getGenerativeExecutionContext(c),
    });
    return addCorsHeaders(response, c.req.header("origin") ?? null, [
      "POST",
      "OPTIONS",
    ]);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default honoRouter;
