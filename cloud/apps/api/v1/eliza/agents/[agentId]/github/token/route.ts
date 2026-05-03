import { Hono } from "hono";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { managedAgentGithubService } from "@/lib/services/agent-managed-github";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, OPTIONS";

/**
 * Get the GitHub access token for an agent's linked connection.
 *
 * This endpoint is called by the agent runtime to fetch the OAuth token
 * stored in the cloud. The token can then be used for GitHub API calls
 * and as a git credential for push/clone operations.
 */
async function __hono_GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const result = await managedAgentGithubService.getAgentToken({
      agentId,
      organizationId: user.organization_id,
    });

    if (!result) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "No GitHub connection found for this agent",
          },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          accessToken: result.accessToken,
          githubUsername: result.githubUsername,
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
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
