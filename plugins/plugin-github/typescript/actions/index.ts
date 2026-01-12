export { createBranchAction, default as createBranch } from "./createBranch";
export { createCommentAction, default as createComment } from "./createComment";
export { createIssueAction, default as createIssue } from "./createIssue";
export {
  createPullRequestAction,
  default as createPullRequest,
} from "./createPullRequest";
export {
  default as mergePullRequest,
  mergePullRequestAction,
} from "./mergePullRequest";
export { default as pushCode, pushCodeAction } from "./pushCode";
export {
  default as reviewPullRequest,
  reviewPullRequestAction,
} from "./reviewPullRequest";

import { createBranchAction } from "./createBranch";
import { createCommentAction } from "./createComment";
import { createIssueAction } from "./createIssue";
import { createPullRequestAction } from "./createPullRequest";
import { mergePullRequestAction } from "./mergePullRequest";
import { pushCodeAction } from "./pushCode";
import { reviewPullRequestAction } from "./reviewPullRequest";

export const allActions = [
  createIssueAction,
  createPullRequestAction,
  reviewPullRequestAction,
  createCommentAction,
  createBranchAction,
  pushCodeAction,
  mergePullRequestAction,
];
