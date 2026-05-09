/**
 * @module plugin-github
 * @description elizaOS plugin for GitHub integration.
 *
 * Actions:
 *   - GITHUB_PR_OP (review requires confirmation)
 *   - GITHUB_ISSUE_OP (write ops require confirmation)
 *   - GITHUB_NOTIFICATION_TRIAGE
 *
 * Auth: role-tagged account records with legacy PAT fallback.
 *   - GITHUB_ACCOUNTS   — JSON account records ({accountId, role, token})
 *   - GITHUB_USER_PAT   — legacy user acting on their own behalf
 *   - GITHUB_AGENT_PAT  — legacy agent acting on its own behalf
 *   E2E fallbacks: ELIZA_E2E_GITHUB_USER_PAT / ELIZA_E2E_GITHUB_AGENT_PAT.
 *
 * Each action takes an `as: "user" | "agent"` option and may take accountId
 * to select a specific account. GITHUB_PR_OP review and
 * GITHUB_NOTIFICATION_TRIAGE default to `"user"`; the other ops default to
 * `"agent"`.
 */

import type http from "node:http";
import type { IAgentRuntime, Plugin, Route } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { issueOpAction } from "./actions/issue-op.js";
import { notificationTriageAction } from "./actions/notification-triage.js";
import { prOpAction } from "./actions/pr-op.js";
import { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";
import { handleGitHubRoutes } from "./routes/github-routes.js";
import { registerGitHubSearchCategory } from "./search-category.js";
import { GitHubService } from "./services/github-service.js";

type RouteAuthState = {
  current: unknown;
};

type EnsureRouteAuthorized = (
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: RouteAuthState,
  options?: { skipCsrf?: boolean; now?: number },
) => Promise<boolean>;

function createGitHubRouteHandler(method: "GET" | "POST" | "DELETE") {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(httpReq.url ?? "/api/github/token", "http://localhost");
    const state = { current: runtime } as RouteAuthState;
    const { ensureRouteAuthorized } = (await import(
      ["@elizaos", "app-core", "api", "auth"].join("/")
    )) as { ensureRouteAuthorized: EnsureRouteAuthorized };
    if (!(await ensureRouteAuthorized(httpReq, httpRes, state))) return;
    await handleGitHubRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
    });
  };
}

export { issueOpAction } from "./actions/issue-op.js";
export {
  notificationTriageAction,
  scoreNotification,
  type TriagedNotification,
} from "./actions/notification-triage.js";
export { prOpAction } from "./actions/pr-op.js";
export * from "./accounts.js";
export { createGitHubConnectorAccountProvider } from "./connector-account-provider.js";
export { GitHubService } from "./services/github-service.js";
export * from "./types.js";

const githubRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("GET"),
  },
  {
    type: "POST",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("POST"),
  },
  {
    type: "DELETE",
    path: "/api/github/token",
    rawPath: true,
    handler: createGitHubRouteHandler("DELETE"),
  },
];

export const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub integration for pull requests, issues, and notification triage",
  services: [GitHubService],
  actions: [prOpAction, issueOpAction, notificationTriageAction],
  routes: githubRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerGitHubSearchCategory(runtime);
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createGitHubConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:github",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register GitHub provider with ConnectorAccountManager",
      );
    }
  },
};

export default githubPlugin;
