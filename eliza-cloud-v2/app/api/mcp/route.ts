import type { NextRequest } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { checkRateLimitRedis } from "@/lib/middleware/rate-limit-redis";
import { authContextStorage } from "./lib/context";

export const maxDuration = 60;

/**
 * Response shape from mcp-handler's createMcpHandler().
 * We extract properties manually because undici polyfills Response,
 * breaking instanceof checks with Next.js native Response.
 */
interface McpHandlerResponse {
  status: number;
  statusText?: string;
  headers?: Headers;
  text?: () => Promise<string>;
}

function isMcpHandlerResponse(resp: unknown): resp is McpHandlerResponse {
  return (
    typeof resp === "object" &&
    resp !== null &&
    typeof (resp as McpHandlerResponse).status === "number"
  );
}

// Lazy-loaded MCP handler to avoid triggering undici Response polyfill
// at module evaluation time. The polyfill breaks NextResponse instanceof
// checks in other routes. See: https://github.com/vercel/next.js/issues/58611
let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

export async function getMcpHandler() {
  if (mcpHandler) return mcpHandler;

  // Dynamic imports to delay polyfill until first MCP request
  const { createMcpHandler } = await import("mcp-handler");
  const {
    registerCreditTools,
    registerApiKeyTools,
    registerGenerationTools,
    registerMemoryTools,
    registerConversationTools,
    registerAgentTools,
    registerContainerTools,
    registerMcpTools,
    registerRoomTools,
    registerUserTools,
    registerKnowledgeTools,
    registerRedemptionTools,
    registerAnalyticsTools,
    registerGoogleTools,
    registerLinearTools,
    registerNotionTools,
    registerGitHubTools,
  } = await import("./tools");

  mcpHandler = createMcpHandler(
    (server) => {
      registerCreditTools(server);
      registerApiKeyTools(server);
      registerGenerationTools(server);
      registerMemoryTools(server);
      registerConversationTools(server);
      registerAgentTools(server);
      registerContainerTools(server);
      registerMcpTools(server);
      registerRoomTools(server);
      registerUserTools(server);
      registerKnowledgeTools(server);
      registerRedemptionTools(server);
      registerAnalyticsTools(server);
      registerGoogleTools(server);
      registerLinearTools(server);
      registerNotionTools(server);
      registerGitHubTools(server);
    },
    {},
    { basePath: "/api" },
  );

  return mcpHandler;
}

/**
 * Handles MCP protocol requests (GET, POST, DELETE).
 */
export async function GET(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handleMcpRequest(req);
}

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);

    // Rate limiting
    const rateLimitKey = `mcp:ratelimit:${authResult.user.organization_id}`;
    const rateLimit = await checkRateLimitRedis(rateLimitKey, 60000, 100);

    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Call MCP handler with auth context (lazy-loaded)
    const handler = await getMcpHandler();
    const mcpResponse = await authContextStorage.run(authResult, async () => {
      return await handler(req as Request);
    });

    if (!mcpResponse) {
      return new Response(JSON.stringify({ error: "no_response" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Convert MCP handler response (use type guard for safety)
    if (!isMcpHandlerResponse(mcpResponse)) {
      return new Response(JSON.stringify({ error: "invalid_response" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const bodyText = mcpResponse.text ? await mcpResponse.text() : "";
    const headers: Record<string, string> = {};
    if (
      mcpResponse.headers &&
      typeof mcpResponse.headers.forEach === "function"
    ) {
      mcpResponse.headers.forEach((value: string, key: string) => {
        headers[key] = value;
      });
    }

    return new Response(bodyText, {
      status: mcpResponse.status,
      headers,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const isAuthError =
      errorMessage.includes("API key") ||
      errorMessage.includes("auth") ||
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Authentication");

    // Use native Response - polyfill breaks NextResponse instanceof checks
    // See: https://github.com/vercel/next.js/issues/58611
    return new Response(
      JSON.stringify({
        error: isAuthError ? "authentication_failed" : "internal_error",
        error_description: errorMessage,
      }),
      {
        status: isAuthError ? 401 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
