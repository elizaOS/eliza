/**
 * @module plugin-github
 * @description elizaOS plugin for GitHub integration.
 *
 * Actions:
 *   - LIST_PRS
 *   - REVIEW_PR (confirmed)
 *   - CREATE_ISSUE (confirmed)
 *   - ASSIGN_ISSUE (confirmed)
 *   - GITHUB_NOTIFICATION_TRIAGE
 *
 * Auth: two independent PATs.
 *   - GITHUB_USER_PAT   — the user acting on their own behalf
 *   - GITHUB_AGENT_PAT  — the agent acting on its own behalf
 *   E2E fallbacks: ELIZA_E2E_GITHUB_USER_PAT / ELIZA_E2E_GITHUB_AGENT_PAT.
 *
 * Each action takes an `as: "user" | "agent"` option that selects which
 * token executes the request. REVIEW_PR and GITHUB_NOTIFICATION_TRIAGE
 * default to `"user"`; the other actions default to `"agent"`.
 */

import type http from "node:http";
import { ensureRouteAuthorized } from "@elizaos/app-core/api/auth";
import type { CompatRuntimeState } from "@elizaos/app-core/api/compat-route-shared";
import type { Plugin, Route } from "@elizaos/core";
import { assignIssueAction } from "./actions/assign-issue.js";
import { createIssueAction } from "./actions/create-issue.js";
import { listPrsAction } from "./actions/list-prs.js";
import { notificationTriageAction } from "./actions/notification-triage.js";
import { reviewPrAction } from "./actions/review-pr.js";
import { handleGitHubRoutes } from "./routes/github-routes.js";
import { GitHubService } from "./services/github-service.js";

function createGitHubRouteHandler(method: "GET" | "POST" | "DELETE") {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const url = new URL(
      httpReq.url ?? "/api/github/token",
      "http://localhost",
    );
    const state = { current: runtime } as CompatRuntimeState;
    if (!(await ensureRouteAuthorized(httpReq, httpRes, state))) return;
    await handleGitHubRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
    });
  };
}

export { assignIssueAction } from "./actions/assign-issue.js";
export { createIssueAction } from "./actions/create-issue.js";
export { listPrsAction } from "./actions/list-prs.js";
export {
  notificationTriageAction,
  scoreNotification,
  type TriagedNotification,
} from "./actions/notification-triage.js";
export { reviewPrAction } from "./actions/review-pr.js";
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
  actions: [
    listPrsAction,
    reviewPrAction,
    createIssueAction,
    assignIssueAction,
    notificationTriageAction,
  ],
  routes: githubRoutes,
};

export default githubPlugin;
