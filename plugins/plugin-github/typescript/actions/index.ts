/**
 * GitHub Actions
 *
 * All available actions for the GitHub plugin.
 */

export { createIssueAction, default as createIssue } from "./createIssue";
export { createPullRequestAction, default as createPullRequest } from "./createPullRequest";
export { reviewPullRequestAction, default as reviewPullRequest } from "./reviewPullRequest";
export { createCommentAction, default as createComment } from "./createComment";
export { createBranchAction, default as createBranch } from "./createBranch";
export { pushCodeAction, default as pushCode } from "./pushCode";
export { mergePullRequestAction, default as mergePullRequest } from "./mergePullRequest";

import { createIssueAction } from "./createIssue";
import { createPullRequestAction } from "./createPullRequest";
import { reviewPullRequestAction } from "./reviewPullRequest";
import { createCommentAction } from "./createComment";
import { createBranchAction } from "./createBranch";
import { pushCodeAction } from "./pushCode";
import { mergePullRequestAction } from "./mergePullRequest";

/**
 * All GitHub actions
 */
export const allActions = [
  createIssueAction,
  createPullRequestAction,
  reviewPullRequestAction,
  createCommentAction,
  createBranchAction,
  pushCodeAction,
  mergePullRequestAction,
];


