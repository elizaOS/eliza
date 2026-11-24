import {
  ApiError,
  safeUnknownErrorMessage,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
// Handles v1 cloud API v1 eliza google calendar calendars route traffic with route-local auth expectations.

import { agentGoogleRouteDeps } from "@elizaos/cloud-shared/lib/services/agent-google-route-deps";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppContext, AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

async function __hono_GET(request: Request, context: AppContext) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const rawSide = searchParams.get("side");
    const grantId = searchParams.get("grantId")?.trim() || undefined;
    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return Response.json(
        { error: "side must be owner or agent." },
        { status: 400 },
      );
    }

    const user = await agentGoogleRouteDeps.requireMailUser(context, rawSide === "agent" ? "agent" : "owner");
    return Response.json(
      await agentGoogleRouteDeps.listManagedGoogleCalendars({
        organizationId: user.organization_id,
        userId: user.id,
        side: rawSide === "agent" ? "agent" : "owner",
        grantId,
      }),
    );
  } catch (error) {
    if (error instanceof ApiError)
      return Response.json(error.toJSON(), { status: error.status });
    if (error instanceof agentGoogleRouteDeps.AgentGoogleConnectorError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    logger.error("[Google Calendar] Failed to list calendars:", error);
    return Response.json(
      {
        error: safeUnknownErrorMessage(error),
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw, c));
export default __hono_app;
