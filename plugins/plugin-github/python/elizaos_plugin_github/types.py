from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict


class RepositoryRef(BaseModel):
    model_config = ConfigDict(frozen=True)

    owner: str
    repo: str


class FileChange(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: str
    content: str
    encoding: Literal["utf-8", "base64"] = "utf-8"
    operation: Literal["add", "modify", "delete"] = "modify"


class IssueState(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


class IssueStateReason(str, Enum):
    COMPLETED = "completed"
    NOT_PLANNED = "not_planned"
    REOPENED = "reopened"


class GitHubLabel(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    color: str
    description: str | None = None
    default: bool = False


class GitHubMilestone(BaseModel):
    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    description: str | None = None
    state: Literal["open", "closed"]
    due_on: str | None = None
    created_at: str
    updated_at: str
    closed_at: str | None = None
    open_issues: int = 0
    closed_issues: int = 0


class GitHubUser(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: int
    login: str
    name: str | None = None
    avatar_url: str
    html_url: str
    type: Literal["User", "Organization", "Bot"]


class GitHubIssue(BaseModel):
    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    body: str | None = None
    state: IssueState
    state_reason: IssueStateReason | None = None
    user: GitHubUser
    assignees: list[GitHubUser] = []
    labels: list[GitHubLabel] = []
    milestone: GitHubMilestone | None = None
    created_at: str
    updated_at: str
    closed_at: str | None = None
    html_url: str
    comments: int = 0
    is_pull_request: bool = False


class CreateIssueParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    title: str
    body: str | None = None
    assignees: list[str] = []
    labels: list[str] = []
    milestone: int | None = None


class UpdateIssueParams(RepositoryRef):
    model_config = ConfigDict(frozen=False)

    issue_number: int
    title: str | None = None
    body: str | None = None
    state: IssueState | None = None
    state_reason: IssueStateReason | None = None
    assignees: list[str] | None = None
    labels: list[str] | None = None
    milestone: int | None = None


class ListIssuesParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    state: Literal["open", "closed", "all"] = "open"
    labels: str | None = None
    sort: Literal["created", "updated", "comments"] = "created"
    direction: Literal["asc", "desc"] = "desc"
    assignee: str | None = None
    creator: str | None = None
    mentioned: str | None = None
    per_page: int = 30
    page: int = 1


class PullRequestState(str, Enum):
    OPEN = "open"
    CLOSED = "closed"


class MergeableState(str, Enum):
    MERGEABLE = "mergeable"
    CONFLICTING = "conflicting"
    UNKNOWN = "unknown"


class GitHubBranchRef(BaseModel):
    model_config = ConfigDict(frozen=True)

    ref: str
    label: str
    sha: str
    repo: RepositoryRef | None = None


class GitHubPullRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    number: int
    title: str
    body: str | None = None
    state: PullRequestState
    draft: bool = False
    merged: bool = False
    mergeable: bool | None = None
    mergeable_state: MergeableState = MergeableState.UNKNOWN
    user: GitHubUser
    head: GitHubBranchRef
    base: GitHubBranchRef
    assignees: list[GitHubUser] = []
    requested_reviewers: list[GitHubUser] = []
    labels: list[GitHubLabel] = []
    milestone: GitHubMilestone | None = None
    created_at: str
    updated_at: str
    closed_at: str | None = None
    merged_at: str | None = None
    html_url: str
    commits: int = 0
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0


class CreatePullRequestParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    title: str
    body: str | None = None
    head: str
    base: str
    draft: bool = False
    maintainer_can_modify: bool = True


class UpdatePullRequestParams(RepositoryRef):
    model_config = ConfigDict(frozen=False)

    pull_number: int
    title: str | None = None
    body: str | None = None
    state: PullRequestState | None = None
    base: str | None = None
    maintainer_can_modify: bool | None = None


class ListPullRequestsParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    state: Literal["open", "closed", "all"] = "open"
    head: str | None = None
    base: str | None = None
    sort: Literal["created", "updated", "popularity", "long-running"] = "created"
    direction: Literal["asc", "desc"] = "desc"
    per_page: int = 30
    page: int = 1


class MergePullRequestParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    pull_number: int
    commit_title: str | None = None
    commit_message: str | None = None
    merge_method: Literal["merge", "squash", "rebase"] = "merge"
    sha: str | None = None


class ReviewState(str, Enum):
    APPROVED = "APPROVED"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    COMMENTED = "COMMENTED"
    DISMISSED = "DISMISSED"
    PENDING = "PENDING"


class ReviewEvent(str, Enum):
    APPROVE = "APPROVE"
    REQUEST_CHANGES = "REQUEST_CHANGES"
    COMMENT = "COMMENT"


class ReviewCommentInput(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: str
    line: int
    body: str
    side: Literal["LEFT", "RIGHT"] = "RIGHT"
    start_line: int | None = None
    start_side: Literal["LEFT", "RIGHT"] | None = None


class GitHubReview(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: int
    user: GitHubUser
    body: str | None = None
    state: ReviewState
    commit_id: str
    html_url: str
    submitted_at: str | None = None


class CreateReviewParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    pull_number: int
    body: str | None = None
    event: ReviewEvent
    commit_id: str | None = None
    comments: list[ReviewCommentInput] = []


class GitHubComment(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: int
    body: str
    user: GitHubUser
    created_at: str
    updated_at: str
    html_url: str


class CreateCommentParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    issue_number: int
    body: str


class GitHubBranch(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    sha: str
    protected: bool = False


class CreateBranchParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    branch_name: str
    from_ref: str


class GitHubCommitAuthor(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    email: str
    date: str


class GitHubCommit(BaseModel):
    model_config = ConfigDict(frozen=True)

    sha: str
    message: str
    author: GitHubCommitAuthor
    committer: GitHubCommitAuthor
    timestamp: str
    html_url: str
    parents: list[str] = []


class CreateCommitParams(RepositoryRef):
    model_config = ConfigDict(frozen=True)

    message: str
    files: list[FileChange]
    branch: str
    parent_sha: str | None = None
    author_name: str | None = None
    author_email: str | None = None


class GitHubFileContent(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    path: str
    content: str
    sha: str
    size: int
    type: Literal["file", "dir", "symlink", "submodule"]
    encoding: str
    html_url: str
    download_url: str | None = None


class GitHubDirectoryEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    path: str
    sha: str
    size: int
    type: Literal["file", "dir", "symlink", "submodule"]
    html_url: str
    download_url: str | None = None


class GitHubLicense(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: str
    name: str
    spdx_id: str | None = None
    url: str | None = None


class GitHubRepository(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: int
    name: str
    full_name: str
    owner: GitHubUser
    description: str | None = None
    private: bool = False
    fork: bool = False
    default_branch: str
    language: str | None = None
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
    license: GitHubLicense | None = None


# =============================================================================
# Event Types
# =============================================================================


class GitHubEventType(str, Enum):
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
