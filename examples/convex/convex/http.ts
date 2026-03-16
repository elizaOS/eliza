/**
 * Convex HTTP router — exposes the elizaOS agent over HTTP.
 *
 * Routes:
 *   POST /chat   — send a message and receive a response
 *   GET  /health — health-check / readiness probe
 */

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal, api } from "./_generated/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ============================================================================
// Routes
// ============================================================================

const http = httpRouter();

// -- CORS preflight ----------------------------------------------------------

http.route({
  path: "/chat",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }),
});

// -- POST /chat --------------------------------------------------------------

http.route({
  path: "/chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = (await request.json()) as Record<string, unknown>;

      const message =
        typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        return jsonResponse(
          { error: "message is required and must be a non-empty string" },
          400,
        );
      }

      const conversationId =
        typeof body.conversationId === "string"
          ? body.conversationId
          : crypto.randomUUID();

      const userId =
        typeof body.userId === "string" ? body.userId : undefined;

      const result = await ctx.runAction(internal.agent.chat, {
        message,
        conversationId,
        userId,
      });

      return jsonResponse({
        response: result.response,
        conversationId: result.conversationId,
        agentName: result.agentName,
        provider: result.provider,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Internal server error";
      console.error("[elizaOS] Chat error:", errorMessage);
      return jsonResponse({ error: errorMessage }, 500);
    }
  }),
});

// -- GET /health -------------------------------------------------------------

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return jsonResponse({
      status: "healthy",
      runtime: "elizaos-convex",
      version: "2.0.0-alpha",
    });
  }),
});

// -- GET /messages -----------------------------------------------------------

http.route({
  path: "/messages",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");

    if (!conversationId) {
      return jsonResponse(
        { error: "conversationId query param is required" },
        400,
      );
    }

    const messages = await ctx.runQuery(api.messages.list, {
      conversationId,
    });

    return jsonResponse({ messages, conversationId });
  }),
});

export default http;
