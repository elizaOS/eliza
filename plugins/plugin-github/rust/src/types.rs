#![allow(missing_docs)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryRef {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub content: String,
    #[serde(default = "default_encoding")]
    pub encoding: FileEncoding,
    #[serde(default)]
    pub operation: FileOperation,
}

fn default_encoding() -> FileEncoding {
    FileEncoding::Utf8
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileEncoding {
    #[default]
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOperation {
    Add,
    #[default]
    Modify,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStateReason {
    Completed,
    NotPlanned,
    Reopened,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    pub id: u64,
    pub name: String,
    pub color: String,
    pub description: Option<String>,
    #[serde(default)]
    pub default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubMilestone {
    pub number: u32,
    pub title: String,
    pub description: Option<String>,
    pub state: MilestoneState,
    pub due_on: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    #[serde(default)]
    pub open_issues: u32,
    #[serde(default)]
    pub closed_issues: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MilestoneState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    pub id: u64,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: String,
    pub html_url: String,
    #[serde(rename = "type")]
    pub user_type: UserType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserType {
    User,
    Organization,
    Bot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssue {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: IssueState,
    pub state_reason: Option<IssueStateReason>,
    pub user: GitHubUser,
    #[serde(default)]
    pub assignees: Vec<GitHubUser>,
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    pub milestone: Option<GitHubMilestone>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub comments: u32,
    #[serde(default)]
    pub is_pull_request: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIssueParams {
    pub owner: String,
    pub repo: String,
    pub title: String,
    pub body: Option<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub milestone: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateIssueParams {
    pub owner: String,
    pub repo: String,
    pub issue_number: u64,
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    pub state_reason: Option<IssueStateReason>,
    pub assignees: Option<Vec<String>>,
    pub labels: Option<Vec<String>>,
    pub milestone: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListIssuesParams {
    pub owner: String,
    pub repo: String,
    #[serde(default = "default_issue_state_filter")]
    pub state: IssueStateFilter,
    pub labels: Option<String>,
    #[serde(default)]
    pub sort: IssueSort,
    #[serde(default)]
    pub direction: SortDirection,
    pub assignee: Option<String>,
    pub creator: Option<String>,
    #[serde(default = "default_per_page")]
    pub per_page: u8,
    #[serde(default = "default_page")]
    pub page: u32,
}

fn default_issue_state_filter() -> IssueStateFilter {
    IssueStateFilter::Open
}

fn default_per_page() -> u8 {
    30
}

fn default_page() -> u32 {
    1
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueStateFilter {
    #[default]
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSort {
    #[default]
    Created,
    Updated,
    Comments,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeableState {
    Mergeable,
    Conflicting,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubBranchRef {
    #[serde(rename = "ref")]
    pub branch_ref: String,
    pub label: String,
    pub sha: String,
    pub repo: Option<RepositoryRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPullRequest {
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub state: PullRequestState,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub merged: bool,
    pub mergeable: Option<bool>,
    #[serde(default)]
    pub mergeable_state: MergeableState,
    pub user: GitHubUser,
    pub head: GitHubBranchRef,
    pub base: GitHubBranchRef,
    #[serde(default)]
    pub assignees: Vec<GitHubUser>,
    #[serde(default)]
    pub requested_reviewers: Vec<GitHubUser>,
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    pub milestone: Option<GitHubMilestone>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub commits: u32,
    #[serde(default)]
    pub additions: u32,
    #[serde(default)]
    pub deletions: u32,
    #[serde(default)]
    pub changed_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePullRequestParams {
    pub owner: String,
    pub repo: String,
    pub title: String,
    pub body: Option<String>,
    pub head: String,
    pub base: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default = "default_true")]
    pub maintainer_can_modify: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergePullRequestParams {
    pub owner: String,
    pub repo: String,
    pub pull_number: u64,
    pub commit_title: Option<String>,
    pub commit_message: Option<String>,
    #[serde(default)]
    pub merge_method: MergeMethod,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    #[default]
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubReview {
    pub id: u64,
    pub user: GitHubUser,
    pub body: Option<String>,
    pub state: ReviewState,
    pub commit_id: String,
    pub html_url: String,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReviewParams {
    pub owner: String,
    pub repo: String,
    pub pull_number: u64,
    pub body: Option<String>,
    pub event: ReviewEvent,
    pub commit_id: Option<String>,
    #[serde(default)]
    pub comments: Vec<ReviewCommentInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewCommentInput {
    pub path: String,
    pub line: u32,
    pub body: String,
    #[serde(default)]
    pub side: DiffSide,
    pub start_line: Option<u32>,
    pub start_side: Option<DiffSide>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiffSide {
    Left,
    #[default]
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubComment {
    pub id: u64,
    pub body: String,
    pub user: GitHubUser,
    pub created_at: String,
    pub updated_at: String,
    pub html_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommentParams {
    pub owner: String,
    pub repo: String,
    pub issue_number: u64,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubBranch {
    pub name: String,
    pub sha: String,
    #[serde(default)]
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateBranchParams {
    pub owner: String,
    pub repo: String,
    pub branch_name: String,
    pub from_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubCommitAuthor {
    pub name: String,
    pub email: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubCommit {
    pub sha: String,
    pub message: String,
    pub author: GitHubCommitAuthor,
    pub committer: GitHubCommitAuthor,
    pub timestamp: String,
    pub html_url: String,
    #[serde(default)]
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommitParams {
    pub owner: String,
    pub repo: String,
    pub message: String,
    pub files: Vec<FileChange>,
    pub branch: String,
    pub parent_sha: Option<String>,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubFileContent {
    pub name: String,
    pub path: String,
    pub content: String,
    pub sha: String,
    pub size: u64,
    #[serde(rename = "type")]
    pub file_type: FileType,
    pub encoding: String,
    pub html_url: String,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    File,
    Dir,
    Symlink,
    Submodule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubDirectoryEntry {
    pub name: String,
    pub path: String,
    pub sha: String,
    pub size: u64,
    #[serde(rename = "type")]
    pub entry_type: FileType,
    pub html_url: String,
    pub download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepository {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub owner: GitHubUser,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub default_branch: String,
    pub language: Option<String>,
    pub stargazers_count: u32,
    pub forks_count: u32,
    pub open_issues_count: u32,
    pub watchers_count: u32,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub created_at: String,
    pub updated_at: String,
    pub pushed_at: String,
    #[serde(default)]
    pub topics: Vec<String>,
    pub license: Option<GitHubLicense>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLicense {
    pub key: String,
    pub name: String,
    pub spdx_id: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitHubEventType {
    Push,
    PullRequest,
    PullRequestReview,
    PullRequestReviewComment,
    Issues,
    IssueComment,
    Create,
    Delete,
    Fork,
    Star,
    Watch,
    Release,
    WorkflowRun,
    CheckRun,
    CheckSuite,
    Status,
}
