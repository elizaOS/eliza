import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import type { BridgeRequest } from "@/lib/services/eliza-sandbox";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const bridgeRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/v1/eliza/agents/[agentId]/bridge
 * Forward a JSON-RPC request to the sandbox bridge server.
 *
 * Supported methods:
 *   - message.send  { text: string, roomId?: string }
 *   - status.get    {}
 *   - heartbeat     {}
 */
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const body = await request.json();

    const parsed = bridgeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid JSON-RPC request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const rpcRequest = parsed.data as BridgeRequest;
    const response = await elizaSandboxService.bridge(agentId, user.organization_id, rpcRequest);

    return applyCorsHeaders(Response.json(response), CORS_METHODS);
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
