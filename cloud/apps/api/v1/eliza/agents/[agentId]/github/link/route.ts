import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { managedAgentGithubService } from "@/lib/services/agent-managed-github";
import { oauthService } from "@/lib/services/oauth";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const linkSchema = z.object({
  connectionId: z.string().trim().min(1),
});

/**
 * Link a GitHub OAuth connection to an agent.
 *
 * Called after the generic OAuth callback completes. The frontend reads the
 * `connection_id` from the redirect URL params and calls this endpoint to
 * bind the credential to the agent, storing the binding in agent_config and
 * restarting the agent if it's running.
 */
async function __hono_POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const body = await request.json().catch(() => ({}));
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "connectionId is required" }, { status: 400 }),
        CORS_METHODS,
      );
    }

    const { connectionId } = parsed.data;

    // Verify the connection exists and belongs to this org
    const connection = await oauthService.getConnection({
      organizationId: user.organization_id,
      connectionId,
    });

    if (!connection) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "OAuth connection not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    if (connection.platform !== "github") {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Connection is not a GitHub connection" },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const connectionRole =
      connection.connectionRole === "owner" || connection.connectionRole === "agent"
        ? connection.connectionRole
        : undefined;

    const result = await managedAgentGithubService.connectAgent({
      agentId,
      organizationId: user.organization_id,
      binding: {
        mode: connectionRole === "owner" ? "shared-owner" : "cloud-managed",
        connectionId,
        connectionRole,
        source: connection.source,
        githubUserId: connection.platformUserId || "",
        githubUsername: connection.username || "",
        githubDisplayName: connection.displayName || undefined,
        githubAvatarUrl: connection.avatarUrl || undefined,
        githubEmail: connection.email || undefined,
        scopes: connection.scopes || [],
        adminElizaUserId: user.id,
        connectedAt: new Date().toISOString(),
      },
    });

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          ...result.status,
          restarted: result.restarted,
        },
      }),
      CORS_METHODS,
    );
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
