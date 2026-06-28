import { Hono } from "hono";
import { appsRepository } from "@/db/repositories/apps";
import { isAllowedOrigin } from "@/lib/security/origin-validation";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

// CORS headers - fully open, security via auth tokens
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-App-Id, X-Request-ID",
  "Access-Control-Max-Age": "86400",
};

/**
 * OPTIONS /api/v1/apps/[id]/public
 * CORS preflight handler
 */
async function __hono_OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * GET /api/v1/apps/[id]/public
 *
 * Get public information about an app.
 * No authentication required - used for OAuth authorization screens.
 *
 * Only returns non-sensitive information like name, description, logo.
 */
async function __hono_GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    const app = await appsRepository.findPublicInfoById(id);

    if (!app) {
      return Response.json(
        { success: false, error: "App not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const redirectUri = new URL(request.url).searchParams.get("redirect_uri");
    if (redirectUri) {
      const allowedOrigins = await appsService.getAllowedOrigins(app);

      if (!isAllowedOrigin(allowedOrigins, redirectUri)) {
        return Response.json(
          { success: false, error: "redirect_uri is not allowed for this app" },
          { status: 400, headers: CORS_HEADERS },
        );
      }
    }

    return Response.json(
      {
        success: true,
        app: {
          id: app.id,
          name: app.name,
          description: app.description,
          logo_url: app.logo_url,
          website_url: app.website_url,
        },
      },
      { headers: CORS_HEADERS },
    );
  } catch (error) {
    logger.error("Failed to get public app info:", error);
    return Response.json(
      {
        success: false,
        error: "Failed to get app info",
      },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async () => __hono_OPTIONS());
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
