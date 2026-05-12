/**
 * POST /api/eliza-app/connections/:platform/initiate
 *
 * Starts the OAuth flow for the requested platform. Returns the
 * provider-specific `authUrl` plus the CSRF `state`. Auth via Bearer
 * eliza-app session token.
 */

import { Hono } from "hono";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { OAuthError, oauthService } from "@/lib/services/oauth";
import { getProvider } from "@/lib/services/oauth/provider-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

interface InitiateBody {
  returnPath?: string;
  scopes?: string[];
}

function sanitizeReturnPath(path: string | undefined): string {
  if (!path || !path.startsWith("/")) return "/connected";
  return path;
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization header required", code: "UNAUTHORIZED" }, 401);
  }

  const session = await elizaAppSessionService.validateAuthHeader(authHeader);
  if (!session) {
    return c.json({ error: "Invalid or expired session", code: "INVALID_SESSION" }, 401);
  }

  const platform = (c.req.param("platform") ?? "").toLowerCase();
  const provider = getProvider(platform);
  if (!provider) {
    return c.json({ error: "Unsupported platform", code: "PLATFORM_NOT_SUPPORTED" }, 400);
  }

  let body: InitiateBody = {};
  try {
    body = (await c.req.json()) as InitiateBody;
  } catch {
    // Empty body is fine.
  }

  const returnPath = sanitizeReturnPath(body.returnPath);
  const redirectUrl = `/api/eliza-app/auth/connection-success?source=eliza-app&return_path=${encodeURIComponent(returnPath)}`;

  try {
    const result = await oauthService.initiateAuth({
      organizationId: session.organizationId,
      userId: session.userId,
      platform,
      redirectUrl,
      scopes: body.scopes,
    });
    return c.json({
      authUrl: result.authUrl,
      state: result.state,
      provider: { id: provider.id, name: provider.name },
    });
  } catch (error) {
    if (error instanceof OAuthError) {
      return c.json({ error: error.message, code: error.code }, error.httpStatus as 400);
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to initiate OAuth",
        code: "INITIATE_FAILED",
      },
      500,
    );
  }
});

export default app;
