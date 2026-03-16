import base64
import logging
from datetime import UTC, datetime

from github import Auth, Github, GithubException
from github.Issue import Issue
from github.IssueComment import IssueComment
from github.PullRequest import PullRequest
from github.PullRequestReview import PullRequestReview
from github.Repository import Repository

from elizaos_plugin_github.config import GitHubConfig
from elizaos_plugin_github.error import (
    BranchExistsError,
    BranchNotFoundError,
    ClientNotInitializedError,
    FileNotFoundError,
    GitHubApiError,
    IssueNotFoundError,
    MergeConflictError,
    PermissionDeniedError,
    PullRequestNotFoundError,
    RateLimitedError,
    RepositoryNotFoundError,
)
from elizaos_plugin_github.types import (
    CreateBranchParams,
    CreateCommentParams,
    CreateCommitParams,
    CreateIssueParams,
    CreatePullRequestParams,
    CreateReviewParams,
    GitHubBranch,
    GitHubBranchRef,
    GitHubComment,
    GitHubCommit,
    GitHubCommitAuthor,
    GitHubDirectoryEntry,
    GitHubFileContent,
    GitHubIssue,
    GitHubLabel,
    GitHubMilestone,
    GitHubPullRequest,
    GitHubRepository,
    GitHubReview,
    GitHubUser,
    IssueState,
    IssueStateReason,
    ListIssuesParams,
    ListPullRequestsParams,
    MergeableState,
    MergePullRequestParams,
    PullRequestState,
    RepositoryRef,
    ReviewState,
    UpdateIssueParams,
)

logger = logging.getLogger(__name__)


class GitHubService:
    def __init__(self, config: GitHubConfig) -> None:
        self._config = config
        self._client: Github | None = None

    @property
    def config(self) -> GitHubConfig:
        return self._config

    def _get_client(self) -> Github:
        if self._client is None:
            raise ClientNotInitializedError()
        return self._client

    async def start(self) -> None:
        logger.info("Starting GitHub service...")

        self._config.validate_all()

        auth = Auth.Token(self._config.api_token)
        self._client = Github(auth=auth)

        try:
            user = self._client.get_user()
            logger.info(f"GitHub service started - authenticated as {user.login}")
        except GithubException as e:
            raise self._map_exception(e, "", "") from e

    async def stop(self) -> None:
        logger.info("Stopping GitHub service...")
        if self._client:
            self._client.close()
            self._client = None
        logger.info("GitHub service stopped")

    async def get_repository(self, params: RepositoryRef) -> GitHubRepository:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            return self._map_repository(repo)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def create_issue(self, params: CreateIssueParams) -> GitHubIssue:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            issue = repo.create_issue(
                title=params.title,
                body=params.body or "",
                assignees=params.assignees,
                labels=params.labels,
                milestone=repo.get_milestone(params.milestone) if params.milestone else None,
            )
            return self._map_issue(issue)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def get_issue(self, owner: str, repo: str, issue_number: int) -> GitHubIssue:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            issue = repo_obj.get_issue(issue_number)
            return self._map_issue(issue)
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if isinstance(exc, RepositoryNotFoundError):
                raise IssueNotFoundError(issue_number, owner, repo_name) from e
            raise exc from e

    async def update_issue(self, params: UpdateIssueParams) -> GitHubIssue:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            issue = repo.get_issue(params.issue_number)

            kwargs: dict[str, object] = {}
            if params.title is not None:
                kwargs["title"] = params.title
            if params.body is not None:
                kwargs["body"] = params.body
            if params.state is not None:
                kwargs["state"] = params.state.value
            if params.assignees is not None:
                kwargs["assignees"] = params.assignees
            if params.labels is not None:
                kwargs["labels"] = params.labels
            if params.milestone is not None:
                kwargs["milestone"] = repo.get_milestone(params.milestone)

            issue.edit(**kwargs)
            return self._map_issue(issue)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def list_issues(self, params: ListIssuesParams) -> list[GitHubIssue]:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            issues = repo.get_issues(
                state=params.state,
                sort=params.sort,
                direction=params.direction,
                labels=params.labels.split(",") if params.labels else [],
                assignee=params.assignee or "none",
            )

            result: list[GitHubIssue] = []
            start = (params.page - 1) * params.per_page
            end = start + params.per_page

            for i, issue in enumerate(issues):
                if i < start:
                    continue
                if i >= end:
                    break
                if issue.pull_request is None:
                    result.append(self._map_issue(issue))

            return result
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def create_pull_request(self, params: CreatePullRequestParams) -> GitHubPullRequest:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            pr = repo.create_pull(
                title=params.title,
                body=params.body or "",
                head=params.head,
                base=params.base,
                draft=params.draft,
                maintainer_can_modify=params.maintainer_can_modify,
            )
            return self._map_pull_request(pr)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def get_pull_request(self, owner: str, repo: str, pull_number: int) -> GitHubPullRequest:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            pr = repo_obj.get_pull(pull_number)
            return self._map_pull_request(pr)
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if isinstance(exc, RepositoryNotFoundError):
                raise PullRequestNotFoundError(pull_number, owner, repo_name) from e
            raise exc from e

    async def list_pull_requests(self, params: ListPullRequestsParams) -> list[GitHubPullRequest]:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            prs = repo.get_pulls(
                state=params.state,
                sort=params.sort,
                direction=params.direction,
                head=params.head,
                base=params.base,
            )

            result: list[GitHubPullRequest] = []
            start = (params.page - 1) * params.per_page
            end = start + params.per_page

            for i, pr in enumerate(prs):
                if i < start:
                    continue
                if i >= end:
                    break
                result.append(self._map_pull_request(pr))

            return result
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def merge_pull_request(self, params: MergePullRequestParams) -> tuple[str, bool, str]:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            pr = repo.get_pull(params.pull_number)

            result = pr.merge(
                commit_title=params.commit_title,
                commit_message=params.commit_message,
                merge_method=params.merge_method,
                sha=params.sha,
            )

            return (result.sha, result.merged, result.message)
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if isinstance(exc, GitHubApiError) and exc.status == 405:
                raise MergeConflictError(params.pull_number, owner, repo_name) from e
            raise exc from e

    async def create_review(self, params: CreateReviewParams) -> GitHubReview:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            pr = repo.get_pull(params.pull_number)

            review = pr.create_review(
                body=params.body,
                event=params.event.value,
                commit=repo.get_commit(params.commit_id) if params.commit_id else None,
                comments=[
                    {
                        "path": c.path,
                        "line": c.line,
                        "body": c.body,
                        "side": c.side,
                    }
                    for c in params.comments
                ],
            )

            return self._map_review(review)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def create_comment(self, params: CreateCommentParams) -> GitHubComment:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")
            issue = repo.get_issue(params.issue_number)
            comment = issue.create_comment(params.body)
            return self._map_comment(comment)
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    # ===========================================================================
    # Branch Operations
    # ===========================================================================

    async def create_branch(self, params: CreateBranchParams) -> GitHubBranch:
        """Create a new branch."""
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")

            try:
                ref = repo.get_git_ref(f"heads/{params.from_ref}")
                sha = ref.object.sha
            except GithubException:
                sha = params.from_ref

            repo.create_git_ref(f"refs/heads/{params.branch_name}", sha)

            return GitHubBranch(
                name=params.branch_name,
                sha=sha,
                protected=False,
            )
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if "already exists" in str(e):
                raise BranchExistsError(params.branch_name, owner, repo_name) from e
            raise exc from e

    async def delete_branch(self, owner: str, repo: str, branch_name: str) -> None:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            ref = repo_obj.get_git_ref(f"heads/{branch_name}")
            ref.delete()
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if isinstance(exc, RepositoryNotFoundError):
                raise BranchNotFoundError(branch_name, owner, repo_name) from e
            raise exc from e

    async def list_branches(
        self, owner: str, repo: str, per_page: int = 30, page: int = 1
    ) -> list[GitHubBranch]:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            branches = repo_obj.get_branches()

            result: list[GitHubBranch] = []
            start = (page - 1) * per_page
            end = start + per_page

            for i, branch in enumerate(branches):
                if i < start:
                    continue
                if i >= end:
                    break
                result.append(
                    GitHubBranch(
                        name=branch.name,
                        sha=branch.commit.sha,
                        protected=branch.protected,
                    )
                )

            return result
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def get_file(
        self, owner: str, repo: str, path: str, branch: str | None = None
    ) -> GitHubFileContent:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            content = repo_obj.get_contents(path, ref=branch or self._config.branch)

            if isinstance(content, list):
                raise FileNotFoundError(f"{path} is a directory, not a file", owner, repo_name)

            decoded_content = ""
            if content.content:
                decoded_content = base64.b64decode(content.content).decode("utf-8")

            return GitHubFileContent(
                name=content.name,
                path=content.path,
                content=decoded_content,
                sha=content.sha,
                size=content.size,
                type="file",
                encoding=content.encoding or "base64",
                html_url=content.html_url,
                download_url=content.download_url,
            )
        except GithubException as e:
            exc = self._map_exception(e, owner, repo_name)
            if isinstance(exc, RepositoryNotFoundError):
                raise FileNotFoundError(path, owner, repo_name) from e
            raise exc from e

    async def list_directory(
        self, owner: str, repo: str, path: str, branch: str | None = None
    ) -> list[GitHubDirectoryEntry]:
        """List directory contents."""
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(owner, repo)

        try:
            repo_obj = client.get_repo(f"{owner}/{repo_name}")
            contents = repo_obj.get_contents(path, ref=branch or self._config.branch)

            if not isinstance(contents, list):
                raise FileNotFoundError(f"{path} is a file, not a directory", owner, repo_name)

            return [
                GitHubDirectoryEntry(
                    name=c.name,
                    path=c.path,
                    sha=c.sha,
                    size=c.size,
                    type=c.type,
                    html_url=c.html_url,
                    download_url=c.download_url,
                )
                for c in contents
            ]
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def create_commit(self, params: CreateCommitParams) -> GitHubCommit:
        client = self._get_client()
        owner, repo_name = self._resolve_repo_ref(params.owner, params.repo)

        try:
            repo = client.get_repo(f"{owner}/{repo_name}")

            ref = repo.get_git_ref(f"heads/{params.branch}")
            parent_sha = params.parent_sha or ref.object.sha

            parent_commit = repo.get_git_commit(parent_sha)

            tree_elements = []
            for file in params.files:
                if file.operation == "delete":
                    continue

                content = file.content
                if file.encoding == "base64":
                    blob = repo.create_git_blob(content, "base64")
                else:
                    blob = repo.create_git_blob(content, "utf-8")

                tree_elements.append(
                    {
                        "path": file.path,
                        "mode": "100644",
                        "type": "blob",
                        "sha": blob.sha,
                    }
                )

            # Create tree
            new_tree = repo.create_git_tree(tree_elements, parent_commit.tree)

            # Create commit
            author_name = params.author_name or client.get_user().name or "elizaos"
            author_email = params.author_email or f"{author_name}@users.noreply.github.com"

            commit = repo.create_git_commit(
                message=params.message,
                tree=new_tree,
                parents=[parent_commit],
            )

            ref.edit(commit.sha)

            return GitHubCommit(
                sha=commit.sha,
                message=commit.message,
                author=GitHubCommitAuthor(
                    name=author_name,
                    email=author_email,
                    date=datetime.now(UTC).isoformat(),
                ),
                committer=GitHubCommitAuthor(
                    name=author_name,
                    email=author_email,
                    date=datetime.now(UTC).isoformat(),
                ),
                timestamp=datetime.now(UTC).isoformat(),
                html_url=commit.html_url,
                parents=[parent_sha],
            )
        except GithubException as e:
            raise self._map_exception(e, owner, repo_name) from e

    async def get_authenticated_user(self) -> GitHubUser:
        client = self._get_client()
        user = client.get_user()
        return self._map_user_from_named_user(user)

    def _resolve_repo_ref(self, owner: str | None, repo: str | None) -> tuple[str, str]:
        return self._config.get_repository_ref(owner, repo)

    def _map_exception(self, e: GithubException, owner: str, repo: str) -> Exception:
        status = e.status

        if status == 401:
            return PermissionDeniedError("Invalid or missing authentication token")

        if status == 403:
            # Check for rate limiting
            rate_limit = e.headers.get("X-RateLimit-Remaining")
            if rate_limit == "0":
                reset = e.headers.get("X-RateLimit-Reset")
                if reset:
                    reset_time = datetime.fromtimestamp(int(reset), tz=UTC)
                    retry_after = int((reset_time - datetime.now(UTC)).total_seconds() * 1000)
                    return RateLimitedError(max(retry_after, 0), 0, reset_time)
            return PermissionDeniedError(str(e.data))

        if status == 404:
            return RepositoryNotFoundError(owner, repo)

        if status == 409:
            message = str(e.data) if e.data else ""
            if "merge" in message.lower():
                return MergeConflictError(0, owner, repo)
            if "already exists" in message.lower():
                return BranchExistsError("unknown", owner, repo)

        if status == 422:
            return GitHubApiError(status, str(e.data))

        return GitHubApiError(status, str(e.data))

    def _map_repository(self, repo: Repository) -> GitHubRepository:
        return GitHubRepository(
            id=repo.id,
            name=repo.name,
            full_name=repo.full_name,
            owner=self._map_user_from_named_user(repo.owner),
            description=repo.description,
            private=repo.private,
            fork=repo.fork,
            default_branch=repo.default_branch,
            language=repo.language,
            stargazers_count=repo.stargazers_count,
            forks_count=repo.forks_count,
            open_issues_count=repo.open_issues_count,
            watchers_count=repo.watchers_count,
            html_url=repo.html_url,
            clone_url=repo.clone_url,
            ssh_url=repo.ssh_url,
            created_at=repo.created_at.isoformat() if repo.created_at else "",
            updated_at=repo.updated_at.isoformat() if repo.updated_at else "",
            pushed_at=repo.pushed_at.isoformat() if repo.pushed_at else "",
            topics=repo.topics or [],
            license=None,  # Would need mapping
        )

    def _map_user_from_named_user(self, user: object) -> GitHubUser:
        return GitHubUser(
            id=user.id,  # type: ignore
            login=user.login,  # type: ignore
            name=getattr(user, "name", None),
            avatar_url=user.avatar_url,  # type: ignore
            html_url=user.html_url,  # type: ignore
            type=user.type,  # type: ignore
        )

    def _map_issue(self, issue: Issue) -> GitHubIssue:
        return GitHubIssue(
            number=issue.number,
            title=issue.title,
            body=issue.body,
            state=IssueState(issue.state),
            state_reason=IssueStateReason(issue.state_reason) if issue.state_reason else None,
            user=self._map_user_from_named_user(issue.user),
            assignees=[self._map_user_from_named_user(a) for a in issue.assignees],
            labels=[
                GitHubLabel(
                    id=label.id,
                    name=label.name,
                    color=label.color,
                    description=label.description,
                    default=label.default,
                )
                for label in issue.labels
            ],
            milestone=(
                GitHubMilestone(
                    number=issue.milestone.number,
                    title=issue.milestone.title,
                    description=issue.milestone.description,
                    state=issue.milestone.state,
                    due_on=issue.milestone.due_on.isoformat() if issue.milestone.due_on else None,
                    created_at=issue.milestone.created_at.isoformat(),
                    updated_at=issue.milestone.updated_at.isoformat(),
                    closed_at=(
                        issue.milestone.closed_at.isoformat() if issue.milestone.closed_at else None
                    ),
                    open_issues=issue.milestone.open_issues,
                    closed_issues=issue.milestone.closed_issues,
                )
                if issue.milestone
                else None
            ),
            created_at=issue.created_at.isoformat(),
            updated_at=issue.updated_at.isoformat(),
            closed_at=issue.closed_at.isoformat() if issue.closed_at else None,
            html_url=issue.html_url,
            comments=issue.comments,
            is_pull_request=issue.pull_request is not None,
        )

    def _map_pull_request(self, pr: PullRequest) -> GitHubPullRequest:
        """Map pull request to type."""
        return GitHubPullRequest(
            number=pr.number,
            title=pr.title,
            body=pr.body,
            state=PullRequestState(pr.state),
            draft=pr.draft,
            merged=pr.merged,
            mergeable=pr.mergeable,
            mergeable_state=MergeableState(pr.mergeable_state)
            if pr.mergeable_state
            else MergeableState.UNKNOWN,
            user=self._map_user_from_named_user(pr.user),
            head=GitHubBranchRef(
                ref=pr.head.ref,
                label=pr.head.label,
                sha=pr.head.sha,
                repo=RepositoryRef(owner=pr.head.repo.owner.login, repo=pr.head.repo.name)
                if pr.head.repo
                else None,
            ),
            base=GitHubBranchRef(
                ref=pr.base.ref,
                label=pr.base.label,
                sha=pr.base.sha,
                repo=RepositoryRef(owner=pr.base.repo.owner.login, repo=pr.base.repo.name)
                if pr.base.repo
                else None,
            ),
            assignees=[self._map_user_from_named_user(a) for a in pr.assignees],
            requested_reviewers=[self._map_user_from_named_user(r) for r in pr.requested_reviewers],
            labels=[
                GitHubLabel(
                    id=label.id,
                    name=label.name,
                    color=label.color,
                    description=label.description,
                    default=label.default,
                )
                for label in pr.labels
            ],
            milestone=None,  # Would need full mapping
            created_at=pr.created_at.isoformat(),
            updated_at=pr.updated_at.isoformat(),
            closed_at=pr.closed_at.isoformat() if pr.closed_at else None,
            merged_at=pr.merged_at.isoformat() if pr.merged_at else None,
            html_url=pr.html_url,
            commits=pr.commits,
            additions=pr.additions,
            deletions=pr.deletions,
            changed_files=pr.changed_files,
        )

    def _map_review(self, review: PullRequestReview) -> GitHubReview:
        return GitHubReview(
            id=review.id,
            user=self._map_user_from_named_user(review.user),
            body=review.body,
            state=ReviewState(review.state),
            commit_id=review.commit_id,
            html_url=review.html_url,
            submitted_at=review.submitted_at.isoformat() if review.submitted_at else None,
        )

    def _map_comment(self, comment: IssueComment) -> GitHubComment:
        return GitHubComment(
            id=comment.id,
            body=comment.body,
            user=self._map_user_from_named_user(comment.user),
            created_at=comment.created_at.isoformat(),
            updated_at=comment.updated_at.isoformat(),
            html_url=comment.html_url,
        )
