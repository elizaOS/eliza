"""
Type definitions for the GitHub plugin.

Strong types with validation - no Any types allowed.
"""

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator


# =============================================================================
# Core Types
# =============================================================================


class RepositoryRef(BaseModel):
    """GitHub repository reference."""

    model_config = ConfigDict(frozen=True)

    owner: str
    repo: str


class FileChange(BaseModel):
    """File content for commits."""

    model_config = ConfigDict(frozen=True)

    path: str
    content: str
    encoding: Literal["utf-8", "base64"] = "utf-8"
    operation: Literal["add", "modify", "delete"] = "modify"


# =============================================================================
# Issue Types
# =============================================================================


class IssueState(str, Enum):
    """Issue state."""

    OPEN = "open"
    CLOSED = "closed"


class IssueStateReason(str, Enum):
    """Issue state reason."""

    COMPLETED = "completed"
    NOT_PLANNED = "not_planned"
    REOPENED = "reopened"


class GitHubLabel(BaseModel):
    """GitHub label."""

    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    color: str
    description: Optional[str] = None
    default: bool = False


class GitHubMilestone(BaseModel):
    """GitHub milestone."""

    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    description: Optional[str] = None
    state: Literal["open", "closed"]
    due_on: Optional[str] = None
    created_at: str
    updated_at: str
    closed_at: Optional[str] = None
    open_issues: int = 0
    closed_issues: int = 0


class GitHubUser(BaseModel):
    """GitHub user."""

    model_config = ConfigDict(frozen=True)

    id: int
    login: str
    name: Optional[str] = None
    avatar_url: str
    html_url: str
    type: Literal["User", "Organization", "Bot"]


class GitHubIssue(BaseModel):
    """GitHub issue."""

    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    body: Optional[str] = None
    state: IssueState
    state_reason: Optional[IssueStateReason] = None
    user: GitHubUser
    assignees: list[GitHubUser] = []
    labels: list[GitHubLabel] = []
    milestone: Optional[GitHubMilestone] = None
    created_at: str
    updated_at: str
    closed_at: Optional[str] = None
    html_url: str
    comments: int = 0
    is_pull_request: bool = False


class CreateIssueParams(RepositoryRef):
    """Issue creation parameters."""

    model_config = ConfigDict(frozen=True)

    title: str
    body: Optional[str] = None
    assignees: list[str] = []
    labels: list[str] = []
    milestone: Optional[int] = None


class UpdateIssueParams(RepositoryRef):
    """Issue update parameters."""

    model_config = ConfigDict(frozen=False)

    issue_number: int
    title: Optional[str] = None
    body: Optional[str] = None
    state: Optional[IssueState] = None
    state_reason: Optional[IssueStateReason] = None
    assignees: Optional[list[str]] = None
    labels: Optional[list[str]] = None
    milestone: Optional[int] = None


class ListIssuesParams(RepositoryRef):
    """Issue list parameters."""

    model_config = ConfigDict(frozen=True)

    state: Literal["open", "closed", "all"] = "open"
    labels: Optional[str] = None
    sort: Literal["created", "updated", "comments"] = "created"
    direction: Literal["asc", "desc"] = "desc"
    assignee: Optional[str] = None
    creator: Optional[str] = None
    mentioned: Optional[str] = None
    per_page: int = 30
    page: int = 1


# =============================================================================
# Pull Request Types
# =============================================================================


class PullRequestState(str, Enum):
    """Pull request state."""

    OPEN = "open"
    CLOSED = "closed"


class MergeableState(str, Enum):
    """Pull request merge state."""

    MERGEABLE = "mergeable"
    CONFLICTING = "conflicting"
    UNKNOWN = "unknown"


class GitHubBranchRef(BaseModel):
    """Branch reference."""

    model_config = ConfigDict(frozen=True)

    ref: str
    label: str
    sha: str
    repo: Optional[RepositoryRef] = None


class GitHubPullRequest(BaseModel):
    """GitHub pull request."""

    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    body: Optional[str] = None
    state: PullRequestState
    draft: bool = False
    merged: bool = False
    mergeable: Optional[bool] = None
    mergeable_state: MergeableState = MergeableState.UNKNOWN
    user: GitHubUser
    head: GitHubBranchRef
    base: GitHubBranchRef
    assignees: list[GitHubUser] = []
    requested_reviewers: list[GitHubUser] = []
    labels: list[GitHubLabel] = []
    milestone: Optional[GitHubMilestone] = None
    created_at: str
    updated_at: str
    closed_at: Optional[str] = None
    merged_at: Optional[str] = None
    html_url: str
    commits: int = 0
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0


class CreatePullRequestParams(RepositoryRef):
    """Pull request creation parameters."""

    model_config = ConfigDict(frozen=True)

    title: str
    body: Optional[str] = None
    head: str
    base: str
    draft: bool = False
    maintainer_can_modify: bool = True


class UpdatePullRequestParams(RepositoryRef):
    """Pull request update parameters."""

    model_config = ConfigDict(frozen=False)

    pull_number: int
    title: Optional[str] = None
    body: Optional[str] = None
    state: Optional[PullRequestState] = None
    base: Optional[str] = None
    maintainer_can_modify: Optional[bool] = None


class ListPullRequestsParams(RepositoryRef):
    """Pull request list parameters."""

    model_config = ConfigDict(frozen=True)

    state: Literal["open", "closed", "all"] = "open"
    head: Optional[str] = None
    base: Optional[str] = None
    sort: Literal["created", "updated", "popularity", "long-running"] = "created"
    direction: Literal["asc", "desc"] = "desc"
    per_page: int = 30
    page: int = 1


class MergePullRequestParams(RepositoryRef):
    """Pull request merge parameters."""

    model_config = ConfigDict(frozen=True)

    pull_number: int
    commit_title: Optional[str] = None
    commit_message: Optional[str] = None
    merge_method: Literal["merge", "squash", "rebase"] = "merge"
    sha: Optional[str] = None


# =============================================================================
# Review Types
# =============================================================================


class ReviewState(str, Enum):
    """Review state."""

    APPROVED = "APPROVED"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    COMMENTED = "COMMENTED"
    DISMISSED = "DISMISSED"
    PENDING = "PENDING"


class ReviewEvent(str, Enum):
    """Review event type."""

    APPROVE = "APPROVE"
    REQUEST_CHANGES = "REQUEST_CHANGES"
    COMMENT = "COMMENT"


class ReviewCommentInput(BaseModel):
    """Review comment input."""

    model_config = ConfigDict(frozen=True)

    path: str
    line: int
    body: str
    side: Literal["LEFT", "RIGHT"] = "RIGHT"
    start_line: Optional[int] = None
    start_side: Optional[Literal["LEFT", "RIGHT"]] = None


class GitHubReview(BaseModel):
    """GitHub pull request review."""

    model_config = ConfigDict(frozen=True)

    id: int
    user: GitHubUser
    body: Optional[str] = None
    state: ReviewState
    commit_id: str
    html_url: str
    submitted_at: Optional[str] = None


class CreateReviewParams(RepositoryRef):
    """Create review parameters."""

    model_config = ConfigDict(frozen=True)

    pull_number: int
    body: Optional[str] = None
    event: ReviewEvent
    commit_id: Optional[str] = None
    comments: list[ReviewCommentInput] = []


# =============================================================================
# Comment Types
# =============================================================================


class GitHubComment(BaseModel):
    """GitHub issue/PR comment."""

    model_config = ConfigDict(frozen=True)

    id: int
    body: str
    user: GitHubUser
    created_at: str
    updated_at: str
    html_url: str


class CreateCommentParams(RepositoryRef):
    """Create comment parameters."""

    model_config = ConfigDict(frozen=True)

    issue_number: int
    body: str


# =============================================================================
# Branch Types
# =============================================================================


class GitHubBranch(BaseModel):
    """GitHub branch."""

    model_config = ConfigDict(frozen=True)

    name: str
    sha: str
    protected: bool = False


class CreateBranchParams(RepositoryRef):
    """Create branch parameters."""

    model_config = ConfigDict(frozen=True)

    branch_name: str
    from_ref: str


# =============================================================================
# Commit Types
# =============================================================================


class GitHubCommitAuthor(BaseModel):
    """Commit author info."""

    model_config = ConfigDict(frozen=True)

    name: str
    email: str
    date: str


class GitHubCommit(BaseModel):
    """GitHub commit."""

    model_config = ConfigDict(frozen=True)

    sha: str
    message: str
    author: GitHubCommitAuthor
    committer: GitHubCommitAuthor
    timestamp: str
    html_url: str
    parents: list[str] = []


class CreateCommitParams(RepositoryRef):
    """Create commit parameters."""

    model_config = ConfigDict(frozen=True)

    message: str
    files: list[FileChange]
    branch: str
    parent_sha: Optional[str] = None
    author_name: Optional[str] = None
    author_email: Optional[str] = None


# =============================================================================
# File Types
# =============================================================================


class GitHubFileContent(BaseModel):
    """GitHub file content."""

    model_config = ConfigDict(frozen=True)

    name: str
    path: str
    content: str
    sha: str
    size: int
    type: Literal["file", "dir", "symlink", "submodule"]
    encoding: str
    html_url: str
    download_url: Optional[str] = None


class GitHubDirectoryEntry(BaseModel):
    """Directory entry."""

    model_config = ConfigDict(frozen=True)

    name: str
    path: str
    sha: str
    size: int
    type: Literal["file", "dir", "symlink", "submodule"]
    html_url: str
    download_url: Optional[str] = None


# =============================================================================
# Repository Types
# =============================================================================


class GitHubLicense(BaseModel):
    """GitHub license."""

    model_config = ConfigDict(frozen=True)

    key: str
    name: str
    spdx_id: Optional[str] = None
    url: Optional[str] = None


class GitHubRepository(BaseModel):
    """GitHub repository."""

    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    full_name: str
    owner: GitHubUser
    description: Optional[str] = None
    private: bool = False
    fork: bool = False
    default_branch: str
    language: Optional[str] = None
    stargazers_count: int = 0
    forks_count: int = 0
    open_issues_count: int = 0
    watchers_count: int = 0
    html_url: str
    clone_url: str
    ssh_url: str
    created_at: str
    updated_at: str
    pushed_at: str
    topics: list[str] = []
    license: Optional[GitHubLicense] = None


# =============================================================================
# Event Types
# =============================================================================


class GitHubEventType(str, Enum):
    """GitHub event types."""

    PUSH = "push"
    PULL_REQUEST = "pull_request"
    PULL_REQUEST_REVIEW = "pull_request_review"
    PULL_REQUEST_REVIEW_COMMENT = "pull_request_review_comment"
    ISSUES = "issues"
    ISSUE_COMMENT = "issue_comment"
    CREATE = "create"
    DELETE = "delete"
    FORK = "fork"
    STAR = "star"
    WATCH = "watch"
    RELEASE = "release"
    WORKFLOW_RUN = "workflow_run"
    CHECK_RUN = "check_run"
    CHECK_SUITE = "check_suite"
    STATUS = "status"


