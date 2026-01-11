#![allow(missing_docs)]
//! Type definitions for the GitHub plugin
//!
//! Strong types with validation - no unknown or any types.

use serde::{Deserialize, Serialize};

// =============================================================================
// Core Types
// =============================================================================

/// GitHub repository reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryRef {
    /// Repository owner (username or organization)
    pub owner: String,
    /// Repository name
    pub repo: String,
}

/// File content for commits
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    /// File path relative to repository root
    pub path: String,
    /// File content
    pub content: String,
    /// Encoding (utf-8 or base64)
    #[serde(default = "default_encoding")]
    pub encoding: FileEncoding,
    /// Operation type
    #[serde(default)]
    pub operation: FileOperation,
}

fn default_encoding() -> FileEncoding {
    FileEncoding::Utf8
}

/// File encoding type
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileEncoding {
    /// UTF-8 text
    #[default]
    Utf8,
    /// Base64 encoded
    Base64,
}

/// File operation type
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileOperation {
    /// Add a new file
    Add,
    /// Modify an existing file
    #[default]
    Modify,
    /// Delete a file
    Delete,
}

// =============================================================================
// Issue Types
// =============================================================================

/// Issue state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    /// Open issue
    Open,
    /// Closed issue
    Closed,
}

/// Issue state reason
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStateReason {
    /// Completed
    Completed,
    /// Not planned
    NotPlanned,
    /// Reopened
    Reopened,
}

/// GitHub label
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLabel {
    /// Label ID
    pub id: u64,
    /// Label name
    pub name: String,
    /// Label color (hex without #)
    pub color: String,
    /// Label description
    pub description: Option<String>,
    /// Whether this is a default label
    #[serde(default)]
    pub default: bool,
}

/// GitHub milestone
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubMilestone {
    /// Milestone number
    pub number: u32,
    /// Milestone title
    pub title: String,
    /// Milestone description
    pub description: Option<String>,
    /// Milestone state
    pub state: MilestoneState,
    /// Due date (ISO 8601)
    pub due_on: Option<String>,
    /// Creation timestamp
    pub created_at: String,
    /// Last update timestamp
    pub updated_at: String,
    /// Close timestamp
    pub closed_at: Option<String>,
    /// Open issues count
    #[serde(default)]
    pub open_issues: u32,
    /// Closed issues count
    #[serde(default)]
    pub closed_issues: u32,
}

/// Milestone state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MilestoneState {
    /// Open milestone
    Open,
    /// Closed milestone
    Closed,
}

/// GitHub user
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubUser {
    /// User ID
    pub id: u64,
    /// Username
    pub login: String,
    /// Display name
    pub name: Option<String>,
    /// Avatar URL
    pub avatar_url: String,
    /// HTML profile URL
    pub html_url: String,
    /// User type
    #[serde(rename = "type")]
    pub user_type: UserType,
}

/// User type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserType {
    /// Regular user
    User,
    /// Organization
    Organization,
    /// Bot
    Bot,
}

/// GitHub issue
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubIssue {
    /// Issue number
    pub number: u64,
    /// Issue title
    pub title: String,
    /// Issue body/description
    pub body: Option<String>,
    /// Issue state
    pub state: IssueState,
    /// State reason
    pub state_reason: Option<IssueStateReason>,
    /// Issue author
    pub user: GitHubUser,
    /// Assigned users
    #[serde(default)]
    pub assignees: Vec<GitHubUser>,
    /// Labels
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    /// Milestone
    pub milestone: Option<GitHubMilestone>,
    /// Creation timestamp (ISO 8601)
    pub created_at: String,
    /// Last update timestamp (ISO 8601)
    pub updated_at: String,
    /// Close timestamp (ISO 8601)
    pub closed_at: Option<String>,
    /// HTML URL
    pub html_url: String,
    /// Number of comments
    #[serde(default)]
    pub comments: u32,
    /// Whether this is a pull request
    #[serde(default)]
    pub is_pull_request: bool,
}

/// Issue creation parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateIssueParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Issue title
    pub title: String,
    /// Issue body
    pub body: Option<String>,
    /// Assignee usernames
    #[serde(default)]
    pub assignees: Vec<String>,
    /// Label names
    #[serde(default)]
    pub labels: Vec<String>,
    /// Milestone number
    pub milestone: Option<u32>,
}

/// Issue update parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateIssueParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Issue number
    pub issue_number: u64,
    /// New title
    pub title: Option<String>,
    /// New body
    pub body: Option<String>,
    /// New state
    pub state: Option<IssueState>,
    /// State reason
    pub state_reason: Option<IssueStateReason>,
    /// Assignee usernames
    pub assignees: Option<Vec<String>>,
    /// Label names
    pub labels: Option<Vec<String>>,
    /// Milestone number
    pub milestone: Option<u32>,
}

/// Issue list parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListIssuesParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Filter by state
    #[serde(default = "default_issue_state_filter")]
    pub state: IssueStateFilter,
    /// Filter by labels
    pub labels: Option<String>,
    /// Sort field
    #[serde(default)]
    pub sort: IssueSort,
    /// Sort direction
    #[serde(default)]
    pub direction: SortDirection,
    /// Filter by assignee
    pub assignee: Option<String>,
    /// Filter by creator
    pub creator: Option<String>,
    /// Results per page
    #[serde(default = "default_per_page")]
    pub per_page: u8,
    /// Page number
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

/// Issue state filter
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueStateFilter {
    /// Open issues
    #[default]
    Open,
    /// Closed issues
    Closed,
    /// All issues
    All,
}

/// Issue sort field
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueSort {
    /// Sort by creation date
    #[default]
    Created,
    /// Sort by update date
    Updated,
    /// Sort by comment count
    Comments,
}

/// Sort direction
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    /// Ascending order
    Asc,
    /// Descending order
    #[default]
    Desc,
}

// =============================================================================
// Pull Request Types
// =============================================================================

/// Pull request state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestState {
    /// Open PR
    Open,
    /// Closed PR
    Closed,
}

/// Mergeable state
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeableState {
    /// Mergeable
    Mergeable,
    /// Has conflicts
    Conflicting,
    /// Unknown
    #[default]
    Unknown,
}

/// Branch reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubBranchRef {
    /// Branch name
    #[serde(rename = "ref")]
    pub branch_ref: String,
    /// Full ref label
    pub label: String,
    /// Commit SHA
    pub sha: String,
    /// Repository info
    pub repo: Option<RepositoryRef>,
}

/// GitHub pull request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubPullRequest {
    /// PR number
    pub number: u64,
    /// PR title
    pub title: String,
    /// PR body
    pub body: Option<String>,
    /// PR state
    pub state: PullRequestState,
    /// Whether PR is a draft
    #[serde(default)]
    pub draft: bool,
    /// Whether PR is merged
    #[serde(default)]
    pub merged: bool,
    /// Mergeable state
    pub mergeable: Option<bool>,
    /// Mergeable state detail
    #[serde(default)]
    pub mergeable_state: MergeableState,
    /// PR author
    pub user: GitHubUser,
    /// Head branch reference
    pub head: GitHubBranchRef,
    /// Base branch reference
    pub base: GitHubBranchRef,
    /// Assigned users
    #[serde(default)]
    pub assignees: Vec<GitHubUser>,
    /// Requested reviewers
    #[serde(default)]
    pub requested_reviewers: Vec<GitHubUser>,
    /// Labels
    #[serde(default)]
    pub labels: Vec<GitHubLabel>,
    /// Milestone
    pub milestone: Option<GitHubMilestone>,
    /// Creation timestamp
    pub created_at: String,
    /// Update timestamp
    pub updated_at: String,
    /// Close timestamp
    pub closed_at: Option<String>,
    /// Merge timestamp
    pub merged_at: Option<String>,
    /// HTML URL
    pub html_url: String,
    /// Number of commits
    #[serde(default)]
    pub commits: u32,
    /// Additions count
    #[serde(default)]
    pub additions: u32,
    /// Deletions count
    #[serde(default)]
    pub deletions: u32,
    /// Changed files count
    #[serde(default)]
    pub changed_files: u32,
}

/// PR creation parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePullRequestParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// PR title
    pub title: String,
    /// PR body
    pub body: Option<String>,
    /// Head branch
    pub head: String,
    /// Base branch
    pub base: String,
    /// Create as draft
    #[serde(default)]
    pub draft: bool,
    /// Allow maintainer edits
    #[serde(default = "default_true")]
    pub maintainer_can_modify: bool,
}

fn default_true() -> bool {
    true
}

/// PR merge parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergePullRequestParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// PR number
    pub pull_number: u64,
    /// Commit title
    pub commit_title: Option<String>,
    /// Commit message
    pub commit_message: Option<String>,
    /// Merge method
    #[serde(default)]
    pub merge_method: MergeMethod,
    /// SHA to verify
    pub sha: Option<String>,
}

/// Merge method
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    /// Regular merge
    #[default]
    Merge,
    /// Squash merge
    Squash,
    /// Rebase merge
    Rebase,
}

// =============================================================================
// Review Types
// =============================================================================

/// Review state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewState {
    /// Approved
    Approved,
    /// Changes requested
    ChangesRequested,
    /// Commented
    Commented,
    /// Dismissed
    Dismissed,
    /// Pending
    Pending,
}

/// Review event
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    /// Approve
    Approve,
    /// Request changes
    RequestChanges,
    /// Comment
    Comment,
}

/// GitHub review
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubReview {
    /// Review ID
    pub id: u64,
    /// Review author
    pub user: GitHubUser,
    /// Review body
    pub body: Option<String>,
    /// Review state
    pub state: ReviewState,
    /// Commit SHA reviewed
    pub commit_id: String,
    /// HTML URL
    pub html_url: String,
    /// Submission timestamp
    pub submitted_at: Option<String>,
}

/// Create review parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateReviewParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// PR number
    pub pull_number: u64,
    /// Review body
    pub body: Option<String>,
    /// Review event
    pub event: ReviewEvent,
    /// Commit SHA
    pub commit_id: Option<String>,
    /// Review comments
    #[serde(default)]
    pub comments: Vec<ReviewCommentInput>,
}

/// Review comment input
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewCommentInput {
    /// File path
    pub path: String,
    /// Line number
    pub line: u32,
    /// Comment body
    pub body: String,
    /// Diff side
    #[serde(default)]
    pub side: DiffSide,
    /// Start line for multi-line
    pub start_line: Option<u32>,
    /// Start side for multi-line
    pub start_side: Option<DiffSide>,
}

/// Diff side
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiffSide {
    /// Left side
    Left,
    /// Right side
    #[default]
    Right,
}

// =============================================================================
// Comment Types
// =============================================================================

/// GitHub comment
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubComment {
    /// Comment ID
    pub id: u64,
    /// Comment body
    pub body: String,
    /// Comment author
    pub user: GitHubUser,
    /// Creation timestamp
    pub created_at: String,
    /// Update timestamp
    pub updated_at: String,
    /// HTML URL
    pub html_url: String,
}

/// Create comment parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommentParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Issue/PR number
    pub issue_number: u64,
    /// Comment body
    pub body: String,
}

// =============================================================================
// Branch Types
// =============================================================================

/// GitHub branch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubBranch {
    /// Branch name
    pub name: String,
    /// Latest commit SHA
    pub sha: String,
    /// Whether branch is protected
    #[serde(default)]
    pub protected: bool,
}

/// Create branch parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateBranchParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// New branch name
    pub branch_name: String,
    /// Source ref
    pub from_ref: String,
}

// =============================================================================
// Commit Types
// =============================================================================

/// Commit author
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubCommitAuthor {
    /// Author name
    pub name: String,
    /// Author email
    pub email: String,
    /// Timestamp
    pub date: String,
}

/// GitHub commit
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubCommit {
    /// Commit SHA
    pub sha: String,
    /// Commit message
    pub message: String,
    /// Commit author
    pub author: GitHubCommitAuthor,
    /// Commit committer
    pub committer: GitHubCommitAuthor,
    /// Timestamp
    pub timestamp: String,
    /// HTML URL
    pub html_url: String,
    /// Parent SHAs
    #[serde(default)]
    pub parents: Vec<String>,
}

/// Create commit parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommitParams {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Commit message
    pub message: String,
    /// Files to commit
    pub files: Vec<FileChange>,
    /// Branch name
    pub branch: String,
    /// Parent SHA
    pub parent_sha: Option<String>,
    /// Author name
    pub author_name: Option<String>,
    /// Author email
    pub author_email: Option<String>,
}

// =============================================================================
// File Types
// =============================================================================

/// GitHub file content
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubFileContent {
    /// File name
    pub name: String,
    /// File path
    pub path: String,
    /// File content (decoded)
    pub content: String,
    /// Content SHA
    pub sha: String,
    /// File size
    pub size: u64,
    /// File type
    #[serde(rename = "type")]
    pub file_type: FileType,
    /// Encoding
    pub encoding: String,
    /// HTML URL
    pub html_url: String,
    /// Download URL
    pub download_url: Option<String>,
}

/// File type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    /// Regular file
    File,
    /// Directory
    Dir,
    /// Symbolic link
    Symlink,
    /// Submodule
    Submodule,
}

/// Directory entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubDirectoryEntry {
    /// Entry name
    pub name: String,
    /// Entry path
    pub path: String,
    /// Entry SHA
    pub sha: String,
    /// Entry size
    pub size: u64,
    /// Entry type
    #[serde(rename = "type")]
    pub entry_type: FileType,
    /// HTML URL
    pub html_url: String,
    /// Download URL
    pub download_url: Option<String>,
}

// =============================================================================
// Repository Types
// =============================================================================

/// GitHub repository
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubRepository {
    /// Repository ID
    pub id: u64,
    /// Repository name
    pub name: String,
    /// Full name (owner/repo)
    pub full_name: String,
    /// Repository owner
    pub owner: GitHubUser,
    /// Description
    pub description: Option<String>,
    /// Whether repository is private
    pub private: bool,
    /// Whether repository is a fork
    pub fork: bool,
    /// Default branch name
    pub default_branch: String,
    /// Primary language
    pub language: Option<String>,
    /// Star count
    pub stargazers_count: u32,
    /// Fork count
    pub forks_count: u32,
    /// Open issues count
    pub open_issues_count: u32,
    /// Watcher count
    pub watchers_count: u32,
    /// HTML URL
    pub html_url: String,
    /// Clone URL
    pub clone_url: String,
    /// SSH URL
    pub ssh_url: String,
    /// Creation timestamp
    pub created_at: String,
    /// Update timestamp
    pub updated_at: String,
    /// Push timestamp
    pub pushed_at: String,
    /// Topics
    #[serde(default)]
    pub topics: Vec<String>,
    /// License
    pub license: Option<GitHubLicense>,
}

/// GitHub license
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitHubLicense {
    /// License key
    pub key: String,
    /// License name
    pub name: String,
    /// SPDX ID
    pub spdx_id: Option<String>,
    /// URL
    pub url: Option<String>,
}

// =============================================================================
// Event Types
// =============================================================================

/// GitHub event types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitHubEventType {
    /// Push event
    Push,
    /// Pull request event
    PullRequest,
    /// Pull request review event
    PullRequestReview,
    /// Pull request review comment event
    PullRequestReviewComment,
    /// Issues event
    Issues,
    /// Issue comment event
    IssueComment,
    /// Create event
    Create,
    /// Delete event
    Delete,
    /// Fork event
    Fork,
    /// Star event
    Star,
    /// Watch event
    Watch,
    /// Release event
    Release,
    /// Workflow run event
    WorkflowRun,
    /// Check run event
    CheckRun,
    /// Check suite event
    CheckSuite,
    /// Status event
    Status,
}







