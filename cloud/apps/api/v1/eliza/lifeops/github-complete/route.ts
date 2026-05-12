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
import { createLifeOpsGithubReturnResponse } from "@/lib/services/agent-github-return";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function __hono_GET(request: Request, env?: Pick<AppEnv["Bindings"], "NEXT_PUBLIC_APP_URL">) {
  const searchParams = new URL(request.url).searchParams;
  const baseUrl = env?.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
  const githubConnected = searchParams.get("github_connected");
  const githubError = searchParams.get("github_error");
  const connectionId = searchParams.get("connection_id");
  const rawTarget = searchParams.get("target");
  const agentId = searchParams.get("agent_id");
  const postMessage = searchParams.get("post_message") === "1";
  const returnUrl = searchParams.get("return_url");
  const target = rawTarget === "agent" && agentId ? "agent" : "owner";
  const dashboardUrl = `${baseUrl}/dashboard/settings?tab=${
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
      });
    }
    return Response.redirect(`${dashboardUrl}&github_error=${encodeURIComponent(githubError)}`);
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
      });
    }
    return Response.redirect(`${dashboardUrl}&github_error=${encodeURIComponent(message)}`);
  }

  if (postMessage || returnUrl) {
    return createLifeOpsGithubReturnResponse({
      title: target === "agent" ? "Agent GitHub connected" : "LifeOps GitHub connected",
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

export { __hono_GET as GET };
