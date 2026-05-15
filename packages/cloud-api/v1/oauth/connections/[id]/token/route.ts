import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/oauth/connections/:id/token
 *
 * Removed. Raw OAuth tokens must never be exposed via user-facing APIs.
 */

async function __hono_GET() {
  return Response.json({ error: "Not Found" }, { status: 404 });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async () => __hono_GET());
export const GET = () => __hono_GET();
export default __hono_app;
