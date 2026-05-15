/**
 * GET /api/v1/eliza/github-oauth-complete
 *
 * GitHub OAuth completion endpoint for managed agent flows.
 *
 * The generic OAuth callback redirects here after storing the GitHub
 * credential. This endpoint reads context from query params (set during
 * initiation), links the connection to the agent, then redirects to
 * the dashboard.
 *
 * Security: This endpoint runs as a browser redirect, not an API call,
 * so it cannot use requireUserOrApiKeyWithOrg. Security is provided by:
 * 1. The connection_id was created by the generic callback after
 *    validating a cryptographically random, time-limited state token
 * 2. The org_id and user_id were embedded in the redirect URL by the
 *    authenticated initiation endpoint
 * 3. The agent is validated against the org_id before linking
 * 4. The connection is validated against the org_id before reading
 */

import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { createLifeOpsGithubReturnResponse } from "@/lib/services/agent-github-return";
import { managedAgentGithubService } from "@/lib/services/agent-managed-github";
import { readManagedAgentGithubBinding } from "@/lib/services/eliza-agent-config";
import { oauthService } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const dashboardUrl = `${baseUrl}/dashboard/settings?tab=agents`;

  const agentId = c.req.query("agent_id") ?? null;
  const organizationId = c.req.query("org_id") ?? null;
  const userId = c.req.query("user_id") ?? null;
  const connectionId = c.req.query("connection_id") ?? null;
  const githubConnected = c.req.query("github_connected") ?? null;
  const githubError = c.req.query("github_error") ?? null;
  const postMessage = c.req.query("post_message") === "1";
  const returnUrl = c.req.query("return_url") ?? null;

  const respond = (args: {
    status: "connected" | "error";
    githubUsername?: string | null;
    message?: string | null;
    restarted?: boolean;
    bindingMode?: "cloud-managed" | "shared-owner" | null;
  }): Response => {
    if (postMessage || returnUrl) {
      return createLifeOpsGithubReturnResponse({
        title:
          args.status === "connected"
            ? "Agent GitHub connected"
            : "Agent GitHub setup did not complete",
        message:
          args.status === "connected"
            ? args.restarted
              ? "GitHub is linked to this agent and the cloud runtime is restarting."
              : "GitHub is linked to this agent."
            : args.message || "GitHub setup did not complete.",
        detail: {
          target: "agent",
          status: args.status,
          agentId,
          connectionId,
          githubUsername: args.githubUsername ?? null,
          bindingMode: args.bindingMode ?? null,
          message: args.message ?? null,
          restarted: args.restarted === true,
        },
        postMessage,
        returnUrl,
      });
    }
    if (args.status === "connected") {
      const successParams = [
        "github=connected",
        "managed=1",
        `agentId=${encodeURIComponent(agentId ?? "")}`,
        `githubUsername=${encodeURIComponent(args.githubUsername || "")}`,
        `restarted=${args.restarted ? "1" : "0"}`,
      ].join("&");
      return Response.redirect(`${dashboardUrl}&${successParams}`);
    }
    return Response.redirect(
      `${dashboardUrl}&github_error=${encodeURIComponent(
        args.message || "GitHub setup did not complete.",
      )}`,
    );
  };

  if (githubError) {
    logger.warn("[managed-github] OAuth callback returned error", {
      error: githubError,
      agentId,
    });
    return respond({ status: "error", message: githubError });
  }

  if (!agentId || !organizationId || !userId || !connectionId || githubConnected !== "true") {
    logger.warn("[managed-github] OAuth completion missing required params", {
      hasAgentId: !!agentId,
      hasOrgId: !!organizationId,
      hasUserId: !!userId,
      hasConnectionId: !!connectionId,
      githubConnected,
    });
    return respond({
      status: "error",
      message: "Missing parameters for GitHub linking",
    });
  }

  try {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(agentId, organizationId);
    if (!sandbox) {
      logger.error("[managed-github] Agent not found or org mismatch", {
        agentId,
        organizationId,
      });
      return respond({ status: "error", message: "Agent not found" });
    }

    const existingBinding = readManagedAgentGithubBinding(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
    );
    if (existingBinding?.connectionId === connectionId) {
      logger.info("[managed-github] Connection already linked, skipping", {
        agentId,
        connectionId,
      });
      return respond({
        status: "connected",
        githubUsername: existingBinding.githubUsername || null,
        bindingMode: existingBinding.mode,
        restarted: false,
      });
    }

    const connection = await oauthService.getConnection({
      organizationId,
      connectionId,
    });

    if (!connection) {
      logger.error("[managed-github] Connection not found after OAuth", {
        connectionId,
        agentId,
        organizationId,
      });
      return respond({
        status: "error",
        message: "GitHub connection not found",
      });
    }

    const result = await managedAgentGithubService.connectAgent({
      agentId,
      organizationId,
      binding: {
        mode: "cloud-managed",
        connectionId,
        connectionRole: "agent",
        source: connection.source,
        githubUserId: connection.platformUserId || "",
        githubUsername: connection.username || "",
        githubDisplayName: connection.displayName || undefined,
        githubAvatarUrl: connection.avatarUrl || undefined,
        githubEmail: connection.email || undefined,
        scopes: connection.scopes || [],
        adminElizaUserId: userId,
        connectedAt: new Date().toISOString(),
      },
    });

    logger.info("[managed-github] Auto-linked GitHub to agent after OAuth", {
      agentId,
      connectionId,
      githubUsername: connection.username,
      restarted: result.restarted,
    });

    return respond({
      status: "connected",
      githubUsername: connection.username || null,
      bindingMode: "cloud-managed",
      restarted: result.restarted,
    });
  } catch (error) {
    logger.error("[managed-github] Failed to auto-link GitHub after OAuth", {
      agentId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return respond({
      status: "error",
      message: error instanceof Error ? error.message : "Failed to link GitHub to agent",
    });
  }
});

export default app;
