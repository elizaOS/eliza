// Handles v1 cloud API v1 eliza agents agentid github oauth route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
// redirect-validation not needed — GitHub uses generic OAuth callback which
// restricts to ALLOWED_REDIRECT_PATHS; we always redirect to a cloud path.
import {
  getProvider,
  isProviderConfigured,
} from "@/lib/services/oauth/provider-registry";
import { initiateOAuth2 } from "@/lib/services/oauth/providers";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { resolveManagedGitHubReturnUrl } from "../connect-flow";

const CORS_METHODS = "POST, OPTIONS";

const oauthLinkSchema = z.object({
  scopes: z.array(z.string()).optional(),
  postMessage: z.boolean().optional(),
  returnUrl: z.string().trim().max(2048).optional(),
});

async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const provider = getProvider("github");
    if (!provider || !isProviderConfigured(provider)) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "GitHub OAuth is not configured" },
          { status: 503 },
        ),
        CORS_METHODS,
      );
    }

    const sandbox = await elizaSandboxService.getAgent(
      agentId,
      user.organization_id,
    );
    if (!sandbox) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsed = oauthLinkSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const scopes = parsed.data.scopes || provider.defaultScopes || [];
    const redirectUrl = resolveManagedGitHubReturnUrl(
      agentId,
      user.organization_id,
      user.id,
      {
        postMessage: parsed.data.postMessage,
        returnUrl: parsed.data.returnUrl,
      },
    );

    const result = await initiateOAuth2(provider, {
      organizationId: user.organization_id,
      userId: user.id,
      redirectUrl,
      scopes,
      connectionRole: "agent",
    });

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          authorizeUrl: result.authUrl,
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
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
