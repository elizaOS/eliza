// Handles v1 cloud API v1 oauth token platform route traffic with route-local auth expectations.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

/**
 * GET /api/v1/oauth/token/:platform
 *
 * Removed. Raw OAuth tokens must never be exposed via user-facing APIs.
 */

async function __hono_GET() {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async () => __hono_GET());
export default __hono_app;
