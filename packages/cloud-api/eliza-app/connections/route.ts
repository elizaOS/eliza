/**
 * GET /api/eliza-app/connections
 *
 * Returns OAuth connection status for the requested platform (default
 * `google`). Authenticates via the eliza-app session token in the
 * Authorization header.
 */

import { Hono } from "hono";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { getProvider } from "@/lib/services/oauth/provider-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Authorization header required", code: "UNAUTHORIZED" }, 401);
  }

  const session = await elizaAppSessionService.validateAuthHeader(authHeader);
  if (!session) {
    return c.json({ error: "Invalid or expired session", code: "INVALID_SESSION" }, 401);
  }

  const platform = (c.req.query("platform") || "google").toLowerCase();
  if (!getProvider(platform)) {
    return c.json({ error: "Unsupported platform", code: "PLATFORM_NOT_SUPPORTED" }, 400);
  }

  try {
    const { oauthService } = await import("@/lib/services/oauth");
    const connections = await oauthService.listConnections({
      organizationId: session.organizationId,
      userId: session.userId,
      platform,
    });

    const active = connections.find((connection) => connection.status === "active");
    const expired = connections.find((connection) => connection.status === "expired");
    const current = active ?? expired ?? null;

    return c.json({
      platform,
      connected: Boolean(active),
      status: active ? "active" : expired ? "expired" : "not_connected",
      email: current?.email ?? null,
      scopes: current?.scopes ?? [],
      linkedAt: current?.linkedAt?.toISOString() ?? null,
      connectionId: current?.id ?? null,
      message: active
        ? null
        : expired
          ? "Connection expired. Reconnect Google to keep Gmail and Calendar working."
          : "Not connected yet.",
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to load connection status",
        code: "CONNECTION_STATUS_FAILED",
      },
      500,
    );
  }
});

export default app;
