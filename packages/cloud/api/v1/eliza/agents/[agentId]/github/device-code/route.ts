// Handles v1 cloud API v1 eliza agents agentid github device code route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { managedAgentGithubService } from "@/lib/services/agent-managed-github";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import {
  getProvider,
  isProviderConfigured,
} from "@/lib/services/oauth/provider-registry";
import { initiateOAuth2 } from "@/lib/services/oauth/providers";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  GITHUB_DEVICE_CONNECT_EXPIRES_IN_SECONDS,
  GITHUB_DEVICE_CONNECT_POLL_INTERVAL_SECONDS,
  resolveManagedGitHubPollUrl,
  resolveManagedGitHubReturnUrl,
} from "../connect-flow";

const CORS_METHODS = "POST, OPTIONS";

const deviceConnectSchema = z.object({
  scopes: z.array(z.string()).optional(),
  postMessage: z.boolean().optional(),
  returnUrl: z.string().trim().max(2048).optional(),
});

/**
 * Start a device-friendly GitHub connect flow for a managed cloud agent.
 *
 * GitHub OAuth Apps do not expose a native device-code grant for arbitrary
 * OAuth Apps. This endpoint therefore returns the existing short-lived GitHub
 * authorize URL as the QR/tap-through payload, then tells the originating
 * instance to poll the org-scoped managed GitHub status endpoint.
 */
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
    const parsed = deviceConnectSchema.safeParse(body);
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
    const status = await managedAgentGithubService.getStatus({
      agentId,
      organizationId: user.organization_id,
    });
    const pollUrl = resolveManagedGitHubPollUrl(agentId);
    const verificationUri = result.authUrl;

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          flow: "browser_oauth_qr",
          provider: "github",
          agentId,
          authorizeUrl: verificationUri,
          verificationUri,
          verificationUriComplete: verificationUri,
          verification_uri: verificationUri,
          verification_uri_complete: verificationUri,
          qr: verificationUri,
          qrPayload: verificationUri,
          expiresIn: GITHUB_DEVICE_CONNECT_EXPIRES_IN_SECONDS,
          expires_in: GITHUB_DEVICE_CONNECT_EXPIRES_IN_SECONDS,
          interval: GITHUB_DEVICE_CONNECT_POLL_INTERVAL_SECONDS,
          pollUrl,
          poll_url: pollUrl,
          poll: {
            method: "GET",
            url: pollUrl,
            interval: GITHUB_DEVICE_CONNECT_POLL_INTERVAL_SECONDS,
          },
          status,
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
