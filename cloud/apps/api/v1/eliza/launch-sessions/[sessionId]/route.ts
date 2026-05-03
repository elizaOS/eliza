import { Hono } from "hono";
import { cache } from "@/lib/cache/client";
import {
  type ManagedLaunchSessionPayload,
  resolveElizaLaunchAllowedOrigins,
  resolveLaunchSessionCacheKey,
} from "@/lib/services/eliza-managed-launch";
import type { AppEnv } from "@/types/cloud-worker-env";

function getCorsHeaders(origin: string | null): HeadersInit {
  const allowedOrigins = new Set(resolveElizaLaunchAllowedOrigins());
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

async function __hono_OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request.headers.get("origin")),
  });
}

type RouteParams = { params: Promise<{ sessionId: string }> };

async function __hono_GET(request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  const headers = getCorsHeaders(request.headers.get("origin"));
  const payload = await cache.getAndDelete<ManagedLaunchSessionPayload>(
    resolveLaunchSessionCacheKey(sessionId),
  );

  if (!payload) {
    return Response.json(
      {
        success: false,
        error: "Launch session not found or expired",
      },
      {
        status: 404,
        headers,
      },
    );
  }

  return Response.json(
    {
      success: true,
      data: payload,
    },
    { headers },
  );
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", async (c) => __hono_OPTIONS(c.req.raw));
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ sessionId: c.req.param("sessionId")! }) }),
);
export default __hono_app;
