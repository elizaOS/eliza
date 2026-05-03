/**
 * @module types
 * @description Shared types for the GitHub plugin
 */

import type { Octokit } from "@octokit/rest";

type OctokitEndpoint<T, Data> = T extends (...args: infer Args) => unknown
  ? (...args: Args) => Promise<{ data: Data }>
  : never;

/**
 * Identifies which configured token (user-acting or agent-acting) an action
 * should execute under. The plugin loads two independent PATs so the user
 * and agent personas can act separately on the same repo.
 */
export type GitHubIdentity = "user" | "agent";

type GitHubUserSummary = {
  login?: string | null;
};

type GitHubPullRequestSummary = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: GitHubUserSummary | null;
};

type GitHubSearchIssueSummary = {
  repository_url: string;
  number: number;
  title: string;
  state: string;
  html_url: string;
  user?: GitHubUserSummary | null;
};

type GitHubReviewResult = {
  id: number;
};

type GitHubIssueResult = {
  number: number;
  html_url: string;
};

type GitHubAssigneesResult = {
  assignees?: Array<GitHubUserSummary | null> | null;
};

type GitHubNotificationSummary = {
  id: string;
  reason?: string | null;
  repository?: {
    full_name?: string | null;
    pushed_at?: string | null;
  };
  subject?: {
    title?: string | null;
    type?: string | null;
    url?: string | null;
  };
  updated_at: string;
};

/**
 * Narrow Octokit surface used by this plugin's actions. Keeping the service
 * contract structural makes tests and local API mocks straightforward without
 * depending on the full Octokit class shape.
 */
export interface GitHubOctokitClient {
  activity: {
    listNotificationsForAuthenticatedUser: OctokitEndpoint<
      Octokit["activity"]["listNotificationsForAuthenticatedUser"],
      GitHubNotificationSummary[]
    >;
  };
  issues: {
    addAssignees: OctokitEndpoint<
      Octokit["issues"]["addAssignees"],
      GitHubAssigneesResult
    >;
    create: OctokitEndpoint<Octokit["issues"]["create"], GitHubIssueResult>;
  };
  pulls: {
    createReview: OctokitEndpoint<
      Octokit["pulls"]["createReview"],
      GitHubReviewResult
    >;
    list: OctokitEndpoint<
      Octokit["pulls"]["list"],
      GitHubPullRequestSummary[]
    >;
  };
  search: {
    issuesAndPullRequests: OctokitEndpoint<
      Octokit["search"]["issuesAndPullRequests"],
      { items: GitHubSearchIssueSummary[] }
    >;
  };
}

/**
 * Service contract exposed to actions. Actions resolve their Octokit client
 * via this interface and never read environment variables directly.
 */
export interface IGitHubService {
  getOctokit(as: GitHubIdentity): GitHubOctokitClient | null;
}

export const GITHUB_SERVICE_TYPE = "github";

export const GitHubActions = {
  LIST_PRS: "LIST_PRS",
  REVIEW_PR: "REVIEW_PR",
  CREATE_ISSUE: "CREATE_ISSUE",
  ASSIGN_ISSUE: "ASSIGN_ISSUE",
  GITHUB_NOTIFICATION_TRIAGE: "GITHUB_NOTIFICATION_TRIAGE",
} as const;

/**
 * Structured result returned by action handlers. Actions never throw —
 * recoverable problems are surfaced as `{ success: false }` with a reason,
 * and destructive actions surface a confirmation request distinctly.
 */
export type GitHubActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string }
  | { success: false; requiresConfirmation: true; preview: string };

export interface RateLimitError {
  kind: "rate-limit";
  resetAtMs: number | null;
  message: string;
}

/** Parameters shared by every action invocation. */
export interface BaseActionOptions {
  as?: GitHubIdentity;
  confirmed?: boolean;
}
