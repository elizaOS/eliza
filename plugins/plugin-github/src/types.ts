/**
 * @module types
 * @description Shared types for the GitHub plugin
 */

import type { Octokit } from "@octokit/rest";

/**
 * Identifies which configured token (user-acting or agent-acting) an action
 * should execute under. The plugin loads two independent PATs so the user
 * and agent personas can act separately on the same repo.
 */
export type GitHubIdentity = "user" | "agent";

/**
 * Service contract exposed to actions. Actions resolve their Octokit client
 * via this interface and never read environment variables directly.
 */
export interface IGitHubService {
  getOctokit(as: GitHubIdentity): Octokit | null;
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
