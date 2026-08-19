/**
 * GET /api/v1/eliza/lifeops/github-complete
 *
 * Generic GitHub OAuth completion landing page for the LifeOps + agent flows.
 * Either returns a postMessage / redirect HTML page (when launched from a
 * popup or sandbox iframe), or redirects the user back to the dashboard.
 *
 * No authentication: this is a browser redirect target; security is provided
 * by the upstream OAuth state token, the connection_id, and downstream
 * org-scoped lookups when the user later acts on the connection.
 */

import { Hono } from "hono";
import {
  createLifeOpsGithubReturnResponse,
  normalizePostMessageTargetOrigin,
} from "@/lib/services/agent-github-return";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function __hono_GET(
  request: Request,
  env?: Pick<AppEnv["Bindings"], "NEXT_PUBLIC_APP_URL">,
) {
  const searchParams = new URL(request.url).searchParams;
  const baseUrl = env?.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
  const targetOrigin = normalizePostMessageTargetOrigin(baseUrl);
  const githubConnected = searchParams.get("github_connected");
  const githubError = searchParams.get("github_error");
  const connectionId = searchParams.get("connection_id");
  const rawTarget = searchParams.get("target");
  const agentId = searchParams.get("agent_id");
  const requestedPostMessageValues = searchParams.getAll("post_message");
  const requestedPostMessage = requestedPostMessageValues[0];
  if (
    requestedPostMessageValues.length > 1 ||
    (requestedPostMessage != null &&
      requestedPostMessage !== "" &&
      requestedPostMessage !== "1")
  ) {
    return Response.json({ error: "Invalid post_message" }, { status: 400 });
  }
  const postMessage = requestedPostMessage === "1";
  const returnUrl = searchParams.get("return_url");
  if (
    rawTarget != null &&
    rawTarget !== "" &&
    rawTarget !== "owner" &&
    rawTarget !== "agent"
  ) {
    return Response.json({ error: "Invalid target" }, { status: 400 });
  }
  const target = rawTarget === "agent" && agentId ? "agent" : "owner";
  const dashboardUrl = `${baseUrl}/cloud/settings?tab=${
    target === "agent" ? "agents" : "connections"
  }`;

  if (githubError) {
    if (postMessage || returnUrl) {
      return createLifeOpsGithubReturnResponse({
        title:
          target === "agent"
            ? "Agent GitHub setup did not complete"
            : "LifeOps GitHub setup did not complete",
        message: githubError,
        detail: {
          target,
          status: "error",
          connectionId,
          agentId,
          message: githubError,
        },
        postMessage,
        returnUrl,
        targetOrigin,
      });
    }
    return Response.redirect(
      `${dashboardUrl}&github_error=${encodeURIComponent(githubError)}`,
    );
  }

  if (githubConnected !== "true" || !connectionId) {
    const message = "GitHub setup did not complete.";
    if (postMessage || returnUrl) {
      return createLifeOpsGithubReturnResponse({
        title:
          target === "agent"
            ? "Agent GitHub setup did not complete"
            : "LifeOps GitHub setup did not complete",
        message,
        detail: {
          target,
          status: "error",
          connectionId,
          agentId,
          message,
        },
        postMessage,
        returnUrl,
        targetOrigin,
      });
    }
    return Response.redirect(
      `${dashboardUrl}&github_error=${encodeURIComponent(message)}`,
    );
  }

  if (postMessage || returnUrl) {
    return createLifeOpsGithubReturnResponse({
      title:
        target === "agent"
          ? "Agent GitHub connected"
          : "LifeOps GitHub connected",
      message:
        target === "agent"
          ? "GitHub is connected and ready to link to this agent."
          : "GitHub is connected for LifeOps.",
      detail: {
        target,
        status: "connected",
        connectionId,
        agentId,
      },
      postMessage,
      returnUrl,
      targetOrigin,
    });
  }

  return Response.redirect(
    `${dashboardUrl}&github_connected=true&platform=github&connection_id=${encodeURIComponent(
      connectionId,
    )}`,
  );
}

app.get("/", async (c) => {
  return __hono_GET(c.req.raw, c.env);
});

export default app;
