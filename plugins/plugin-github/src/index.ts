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
 *   E2E fallbacks: MILADY_E2E_GITHUB_USER_PAT / MILADY_E2E_GITHUB_AGENT_PAT.
 *
 * Each action takes an `as: "user" | "agent"` option that selects which
 * token executes the request. REVIEW_PR and GITHUB_NOTIFICATION_TRIAGE
 * default to `"user"`; the other actions default to `"agent"`.
 */

import type { Plugin } from "@elizaos/core";
import { assignIssueAction } from "./actions/assign-issue.js";
import { createIssueAction } from "./actions/create-issue.js";
import { listPrsAction } from "./actions/list-prs.js";
import { notificationTriageAction } from "./actions/notification-triage.js";
import { reviewPrAction } from "./actions/review-pr.js";
import { GitHubService } from "./services/github-service.js";

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
};

export default githubPlugin;
