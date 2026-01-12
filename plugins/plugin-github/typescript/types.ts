import { z } from "zod";

export interface RepositoryRef {
  /** Repository owner (username or organization) */
  owner: string;
  /** Repository name */
  repo: string;
}

export interface FileRef extends RepositoryRef {
  /** File path relative to repository root */
  path: string;
  /** Branch name */
  branch?: string;
}

export interface FileChange {
  /** File path relative to repository root */
  path: string;
  /** File content (string for text, base64 for binary) */
  content: string;
  /** Optional encoding (defaults to utf-8) */
  encoding?: "utf-8" | "base64";
  /** Operation type */
  operation?: "add" | "modify" | "delete";
}

export type IssueState = "open" | "closed";

export type IssueStateReason = "completed" | "not_planned" | "reopened";

export interface GitHubIssue {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
  /** Issue body/description */
  body: string | null;
  /** Issue state */
  state: IssueState;
  /** State reason */
  stateReason: IssueStateReason | null;
  /** Issue author */
  user: GitHubUser;
  /** Assigned users */
  assignees: GitHubUser[];
  /** Labels */
  labels: GitHubLabel[];
  /** Milestone */
  milestone: GitHubMilestone | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Close timestamp (ISO 8601) */
  closedAt: string | null;
  /** HTML URL */
  htmlUrl: string;
  /** Number of comments */
  comments: number;
  /** Whether this is a pull request */
  isPullRequest: boolean;
}

export interface CreateIssueParams extends RepositoryRef {
  /** Issue title */
  title: string;
  /** Issue body/description */
  body?: string;
  /** Assignee usernames */
  assignees?: string[];
  /** Label names */
  labels?: string[];
  /** Milestone number */
  milestone?: number;
}

export interface UpdateIssueParams extends RepositoryRef {
  /** Issue number */
  issueNumber: number;
  /** New title */
  title?: string;
  /** New body */
  body?: string;
  /** New state */
  state?: IssueState;
  /** State reason */
  stateReason?: IssueStateReason;
  /** Assignee usernames */
  assignees?: string[];
  /** Label names */
  labels?: string[];
  /** Milestone number */
  milestone?: number | null;
}

export interface ListIssuesParams extends RepositoryRef {
  /** Filter by state */
  state?: IssueState | "all";
  /** Filter by labels (comma-separated) */
  labels?: string;
  /** Sort field */
  sort?: "created" | "updated" | "comments";
  /** Sort direction */
  direction?: "asc" | "desc";
  /** Filter by assignee username */
  assignee?: string;
  /** Filter by creator username */
  creator?: string;
  /** Filter by mentioned username */
  mentioned?: string;
  /** Results per page */
  perPage?: number;
  /** Page number */
  page?: number;
}

export type PullRequestState = "open" | "closed";

export type MergeableState = "mergeable" | "conflicting" | "unknown";

export interface GitHubPullRequest {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body/description */
  body: string | null;
  /** PR state */
  state: PullRequestState;
  /** Whether PR is a draft */
  draft: boolean;
  /** Whether PR is merged */
  merged: boolean;
  /** Mergeable state */
  mergeable: boolean | null;
  /** Mergeable state detail */
  mergeableState: MergeableState;
  /** PR author */
  user: GitHubUser;
  /** Head branch reference */
  head: GitHubBranchRef;
  /** Base branch reference */
  base: GitHubBranchRef;
  /** Assigned users */
  assignees: GitHubUser[];
  /** Requested reviewers */
  requestedReviewers: GitHubUser[];
  /** Labels */
  labels: GitHubLabel[];
  /** Milestone */
  milestone: GitHubMilestone | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Close timestamp (ISO 8601) */
  closedAt: string | null;
  /** Merge timestamp (ISO 8601) */
  mergedAt: string | null;
  /** HTML URL */
  htmlUrl: string;
  /** Number of commits */
  commits: number;
  /** Number of additions */
  additions: number;
  /** Number of deletions */
  deletions: number;
  /** Number of changed files */
  changedFiles: number;
}

export interface GitHubBranchRef {
  /** Branch name */
  ref: string;
  /** Full ref (refs/heads/...) */
  label: string;
  /** Commit SHA */
  sha: string;
  /** Repository info */
  repo: RepositoryRef | null;
}

export interface CreatePullRequestParams extends RepositoryRef {
  /** PR title */
  title: string;
  /** PR body/description */
  body?: string;
  /** Head branch name */
  head: string;
  /** Base branch name */
  base: string;
  /** Create as draft */
  draft?: boolean;
  /** Allow maintainer edits */
  maintainerCanModify?: boolean;
}

export interface UpdatePullRequestParams extends RepositoryRef {
  /** PR number */
  pullNumber: number;
  /** New title */
  title?: string;
  /** New body */
  body?: string;
  /** New state */
  state?: PullRequestState;
  /** New base branch */
  base?: string;
  /** Maintainer can modify */
  maintainerCanModify?: boolean;
}

export interface MergePullRequestParams extends RepositoryRef {
  /** PR number */
  pullNumber: number;
  /** Commit title */
  commitTitle?: string;
  /** Commit message */
  commitMessage?: string;
  /** Merge method */
  mergeMethod?: "merge" | "squash" | "rebase";
  /** SHA to verify */
  sha?: string;
}

export interface ListPullRequestsParams extends RepositoryRef {
  /** Filter by state */
  state?: PullRequestState | "all";
  /** Filter by head branch */
  head?: string;
  /** Filter by base branch */
  base?: string;
  /** Sort field */
  sort?: "created" | "updated" | "popularity" | "long-running";
  /** Sort direction */
  direction?: "asc" | "desc";
  /** Results per page */
  perPage?: number;
  /** Page number */
  page?: number;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface GitHubReview {
  /** Review ID */
  id: number;
  /** Review author */
  user: GitHubUser;
  /** Review body */
  body: string | null;
  /** Review state */
  state: ReviewState;
  /** Commit SHA reviewed */
  commitId: string;
  /** HTML URL */
  htmlUrl: string;
  /** Submission timestamp (ISO 8601) */
  submittedAt: string | null;
}

export interface GitHubReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  side: "LEFT" | "RIGHT";
  user: GitHubUser;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  inReplyToId: number | null;
}

export interface CreateReviewParams extends RepositoryRef {
  /** PR number */
  pullNumber: number;
  /** Review body */
  body?: string;
  /** Review event */
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  /** Commit SHA to review */
  commitId?: string;
  /** Review comments */
  comments?: ReviewCommentInput[];
}

export interface ReviewCommentInput {
  /** File path */
  path: string;
  /** Line number */
  line: number;
  /** Comment body */
  body: string;
  /** Diff side */
  side?: "LEFT" | "RIGHT";
  /** Start line for multi-line comment */
  startLine?: number;
  /** Start side for multi-line comment */
  startSide?: "LEFT" | "RIGHT";
}

export interface GitHubComment {
  /** Comment ID */
  id: number;
  /** Comment body */
  body: string;
  /** Comment author */
  user: GitHubUser;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** HTML URL */
  htmlUrl: string;
}

export interface CreateCommentParams extends RepositoryRef {
  /** Issue or PR number */
  issueNumber: number;
  /** Comment body */
  body: string;
}

export interface GitHubBranch {
  /** Branch name */
  name: string;
  /** Latest commit SHA */
  sha: string;
  /** Whether branch is protected */
  protected: boolean;
}

export interface CreateBranchParams extends RepositoryRef {
  /** New branch name */
  branchName: string;
  /** Source ref (branch name or SHA) */
  fromRef: string;
}

export interface GitHubCommit {
  /** Commit SHA */
  sha: string;
  /** Commit message */
  message: string;
  /** Commit author */
  author: GitHubCommitAuthor;
  /** Commit committer */
  committer: GitHubCommitAuthor;
  /** Commit timestamp (ISO 8601) */
  timestamp: string;
  /** HTML URL */
  htmlUrl: string;
  /** Parent commit SHAs */
  parents: string[];
}

export interface GitHubCommitAuthor {
  /** Author name */
  name: string;
  /** Author email */
  email: string;
  /** Timestamp (ISO 8601) */
  date: string;
}

export interface CreateCommitParams extends RepositoryRef {
  /** Commit message */
  message: string;
  /** Files to commit */
  files: FileChange[];
  /** Branch name */
  branch: string;
  /** Parent commit SHA (optional, uses branch head) */
  parentSha?: string;
  /** Author name (optional, uses authenticated user) */
  authorName?: string;
  /** Author email (optional) */
  authorEmail?: string;
}

export interface GitHubFileContent {
  /** File name */
  name: string;
  /** File path */
  path: string;
  /** File content (decoded) */
  content: string;
  /** Content SHA */
  sha: string;
  /** File size in bytes */
  size: number;
  /** File type */
  type: "file" | "dir" | "symlink" | "submodule";
  /** Encoding (usually base64) */
  encoding: string;
  /** HTML URL */
  htmlUrl: string;
  /** Download URL */
  downloadUrl: string | null;
}

export interface GetFileParams extends FileRef {}

export interface GitHubDirectoryEntry {
  /** Entry name */
  name: string;
  /** Entry path */
  path: string;
  /** Entry SHA */
  sha: string;
  /** Entry size (0 for directories) */
  size: number;
  /** Entry type */
  type: "file" | "dir" | "symlink" | "submodule";
  /** HTML URL */
  htmlUrl: string;
  /** Download URL (null for directories) */
  downloadUrl: string | null;
}

export interface GitHubRepository {
  /** Repository ID */
  id: number;
  /** Repository name */
  name: string;
  /** Full name (owner/repo) */
  fullName: string;
  /** Repository owner */
  owner: GitHubUser;
  /** Description */
  description: string | null;
  /** Whether repository is private */
  private: boolean;
  /** Whether repository is a fork */
  fork: boolean;
  /** Default branch name */
  defaultBranch: string;
  /** Primary language */
  language: string | null;
  /** Star count */
  stargazersCount: number;
  /** Fork count */
  forksCount: number;
  /** Open issues count */
  openIssuesCount: number;
  /** Watcher count */
  watchersCount: number;
  /** HTML URL */
  htmlUrl: string;
  /** Clone URL */
  cloneUrl: string;
  /** SSH URL */
  sshUrl: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Last push timestamp (ISO 8601) */
  pushedAt: string;
  /** Topics */
  topics: string[];
  /** License */
  license: GitHubLicense | null;
}

export interface GitHubLicense {
  /** License key */
  key: string;
  /** License name */
  name: string;
  /** SPDX ID */
  spdxId: string | null;
  /** URL */
  url: string | null;
}

export interface GitHubUser {
  /** User ID */
  id: number;
  /** Username */
  login: string;
  /** Display name */
  name: string | null;
  /** Avatar URL */
  avatarUrl: string;
  /** HTML profile URL */
  htmlUrl: string;
  /** User type */
  type: "User" | "Organization" | "Bot";
}

export interface GitHubLabel {
  /** Label ID */
  id: number;
  /** Label name */
  name: string;
  /** Label color (hex without #) */
  color: string;
  /** Label description */
  description: string | null;
  /** Whether this is a default label */
  default: boolean;
}

export interface GitHubMilestone {
  /** Milestone number */
  number: number;
  /** Milestone title */
  title: string;
  /** Milestone description */
  description: string | null;
  /** Milestone state */
  state: "open" | "closed";
  /** Due date (ISO 8601) */
  dueOn: string | null;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Close timestamp (ISO 8601) */
  closedAt: string | null;
  /** Open issues count */
  openIssues: number;
  /** Closed issues count */
  closedIssues: number;
}

export type GitHubEventType =
  | "push"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issues"
  | "issue_comment"
  | "create"
  | "delete"
  | "fork"
  | "star"
  | "watch"
  | "release"
  | "workflow_run"
  | "check_run"
  | "check_suite"
  | "status";

export interface GitHubWebhookEvent {
  /** Event action */
  action?: string;
  /** Sender (user who triggered the event) */
  sender: GitHubUser;
  /** Repository */
  repository: GitHubRepository;
  /** Organization (if applicable) */
  organization?: GitHubUser;
}

export interface PushEventPayload extends GitHubWebhookEvent {
  /** Ref that was pushed (refs/heads/...) */
  ref: string;
  /** Before SHA */
  before: string;
  /** After SHA */
  after: string;
  /** Whether ref was created */
  created: boolean;
  /** Whether ref was deleted */
  deleted: boolean;
  /** Whether push was forced */
  forced: boolean;
  /** Commits in the push */
  commits: PushCommit[];
  /** Head commit */
  headCommit: PushCommit | null;
  /** Compare URL */
  compare: string;
  /** Pusher info */
  pusher: { name: string; email: string };
}

export interface PushCommit {
  /** Commit SHA */
  id: string;
  /** Commit message */
  message: string;
  /** Commit timestamp (ISO 8601) */
  timestamp: string;
  /** Commit URL */
  url: string;
  /** Author */
  author: { name: string; email: string };
  /** Committer */
  committer: { name: string; email: string };
  /** Added files */
  added: string[];
  /** Removed files */
  removed: string[];
  /** Modified files */
  modified: string[];
}

export interface PullRequestEventPayload extends GitHubWebhookEvent {
  action:
    | "opened"
    | "closed"
    | "reopened"
    | "synchronize"
    | "edited"
    | "assigned"
    | "unassigned"
    | "labeled"
    | "unlabeled"
    | "ready_for_review"
    | "converted_to_draft"
    | "review_requested"
    | "review_request_removed";
  /** Pull request number */
  number: number;
  /** Pull request */
  pullRequest: GitHubPullRequest;
}

export interface IssueEventPayload extends GitHubWebhookEvent {
  action:
    | "opened"
    | "closed"
    | "reopened"
    | "edited"
    | "assigned"
    | "unassigned"
    | "labeled"
    | "unlabeled"
    | "pinned"
    | "unpinned"
    | "milestoned"
    | "demilestoned"
    | "transferred"
    | "deleted";
  /** Issue */
  issue: GitHubIssue;
}

export interface CommentEventPayload extends GitHubWebhookEvent {
  action: "created" | "edited" | "deleted";
  /** Issue or PR */
  issue: GitHubIssue;
  /** Comment */
  comment: GitHubComment;
}

export interface GitHubSettings {
  /** GitHub API token */
  apiToken: string;
  /** Default repository owner */
  owner?: string;
  /** Default repository name */
  repo?: string;
  /** Default branch */
  branch?: string;
  /** Webhook secret */
  webhookSecret?: string;
  /** GitHub App ID */
  appId?: string;
  /** GitHub App private key */
  appPrivateKey?: string;
  /** GitHub App installation ID */
  installationId?: string;
}

export const repositoryRefSchema = z.object({
  owner: z.string().min(1, "Owner is required"),
  repo: z.string().min(1, "Repo is required"),
});

export const fileRefSchema = repositoryRefSchema.extend({
  path: z.string().min(1, "Path is required"),
  branch: z.string().optional(),
});

export const createIssueSchema = repositoryRefSchema.extend({
  title: z.string().min(1, "Title is required"),
  body: z.string().optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.number().optional(),
});

export const updateIssueSchema = repositoryRefSchema.extend({
  issueNumber: z.number().min(1, "Issue number is required"),
  title: z.string().optional(),
  body: z.string().optional(),
  state: z.enum(["open", "closed"]).optional(),
  stateReason: z.enum(["completed", "not_planned", "reopened"]).optional(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.number().nullable().optional(),
});

export const createPullRequestSchema = repositoryRefSchema.extend({
  title: z.string().min(1, "Title is required"),
  body: z.string().optional(),
  head: z.string().min(1, "Head branch is required"),
  base: z.string().min(1, "Base branch is required"),
  draft: z.boolean().optional(),
  maintainerCanModify: z.boolean().optional(),
});

export const createReviewSchema = repositoryRefSchema.extend({
  pullNumber: z.number().min(1, "Pull request number is required"),
  body: z.string().optional(),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  commitId: z.string().optional(),
  comments: z
    .array(
      z.object({
        path: z.string(),
        line: z.number(),
        body: z.string(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        startLine: z.number().optional(),
        startSide: z.enum(["LEFT", "RIGHT"]).optional(),
      })
    )
    .optional(),
});

export const createCommentSchema = repositoryRefSchema.extend({
  issueNumber: z.number().min(1, "Issue number is required"),
  body: z.string().min(1, "Comment body is required"),
});

export const createBranchSchema = repositoryRefSchema.extend({
  branchName: z.string().min(1, "Branch name is required"),
  fromRef: z.string().min(1, "Source ref is required"),
});

export const createCommitSchema = repositoryRefSchema.extend({
  message: z.string().min(1, "Commit message is required"),
  files: z.array(
    z.object({
      path: z.string().min(1, "File path is required"),
      content: z.string(),
      encoding: z.enum(["utf-8", "base64"]).optional(),
      operation: z.enum(["add", "modify", "delete"]).optional(),
    })
  ),
  branch: z.string().min(1, "Branch is required"),
  parentSha: z.string().optional(),
  authorName: z.string().optional(),
  authorEmail: z.string().optional(),
});

export const mergePullRequestSchema = repositoryRefSchema.extend({
  pullNumber: z.number().min(1, "Pull request number is required"),
  commitTitle: z.string().optional(),
  commitMessage: z.string().optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  sha: z.string().optional(),
});

export const gitHubSettingsSchema = z.object({
  apiToken: z.string().min(1, "API token is required"),
  owner: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  webhookSecret: z.string().optional(),
  appId: z.string().optional(),
  appPrivateKey: z.string().optional(),
  installationId: z.string().optional(),
});

export function formatZodErrors(error: z.ZodError): string {
  const flattened = error.flatten();
  const fieldErrors = Object.entries(flattened.fieldErrors)
    .map(
      ([field, messages]) =>
        `${field}: ${Array.isArray(messages) ? messages.join(", ") : String(messages)}`
    )
    .join("; ");
  const formErrors = flattened.formErrors.join(", ");
  return [fieldErrors, formErrors].filter(Boolean).join("; ");
}
