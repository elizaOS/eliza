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

type GitHubLabelSummary =
  | string
  | {
      name?: string | null;
    };

type GitHubIssueDetail = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body?: string | null;
  labels?: Array<GitHubLabelSummary | null> | null;
  user?: GitHubUserSummary | null;
};

type GitHubIssueCommentResult = {
  id: number;
  html_url: string;
};

type GitHubAddLabelsResult = Array<GitHubLabelSummary | null>;

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
    addLabels: OctokitEndpoint<
      Octokit["issues"]["addLabels"],
      GitHubAddLabelsResult
    >;
    create: OctokitEndpoint<Octokit["issues"]["create"], GitHubIssueResult>;
    createComment: OctokitEndpoint<
      Octokit["issues"]["createComment"],
      GitHubIssueCommentResult
    >;
    get: OctokitEndpoint<Octokit["issues"]["get"], GitHubIssueDetail>;
    listForRepo: OctokitEndpoint<
      Octokit["issues"]["listForRepo"],
      GitHubIssueDetail[]
    >;
    update: OctokitEndpoint<Octokit["issues"]["update"], GitHubIssueDetail>;
  };
  pulls: {
    createReview: OctokitEndpoint<
      Octokit["pulls"]["createReview"],
      GitHubReviewResult
    >;
    list: OctokitEndpoint<Octokit["pulls"]["list"], GitHubPullRequestSummary[]>;
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
  getOctokit(
    selector:
      | GitHubIdentity
      | { as?: GitHubIdentity; role?: GitHubIdentity; accountId?: string },
  ): GitHubOctokitClient | null;
}

export const GITHUB_SERVICE_TYPE = "github";

export const GitHubActions = {
  GITHUB_ISSUE_OP: "GITHUB_ISSUE",
  GITHUB_PR_OP: "GITHUB_PR",
  GITHUB_NOTIFICATION_TRIAGE: "GITHUB_NOTIFICATION_TRIAGE",
} as const;

/** Issue ops accepted by GITHUB_ISSUE_OP. */
export type GitHubIssueOp =
  | "create"
  | "assign"
  | "close"
  | "reopen"
  | "comment"
  | "label";

/** PR ops accepted by GITHUB_PR_OP. */
export type GitHubPrOp = "list" | "review";

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
  accountId?: string;
  confirmed?: boolean;
}
