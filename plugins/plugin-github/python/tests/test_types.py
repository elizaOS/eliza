"""Tests for GitHub types."""

from elizaos_plugin_github.types import (
    CreateBranchParams,
    CreateCommentParams,
    CreateIssueParams,
    CreatePullRequestParams,
    GitHubBranch,
    GitHubBranchRef,
    GitHubComment,
    GitHubIssue,
    GitHubPullRequest,
    GitHubUser,
    IssueState,
    MergePullRequestParams,
    PullRequestState,
    ReviewEvent,
)


class TestEnums:
    """Test enum types."""

    def test_issue_state(self):
        """Test IssueState enum."""
        assert IssueState.OPEN.value == "open"
        assert IssueState.CLOSED.value == "closed"

    def test_pull_request_state(self):
        """Test PullRequestState enum."""
        assert PullRequestState.OPEN.value == "open"
        assert PullRequestState.CLOSED.value == "closed"

    def test_merge_pull_request_params(self):
        """Test MergePullRequestParams model with merge_method literal."""
        params = MergePullRequestParams(
            owner="owner",
            repo="repo",
            pull_number=42,
            merge_method="merge",
        )
        assert params.merge_method == "merge"

        params_squash = MergePullRequestParams(
            owner="owner",
            repo="repo",
            pull_number=42,
            merge_method="squash",
        )
        assert params_squash.merge_method == "squash"

        params_rebase = MergePullRequestParams(
            owner="owner",
            repo="repo",
            pull_number=42,
            merge_method="rebase",
        )
        assert params_rebase.merge_method == "rebase"

    def test_review_event(self):
        """Test ReviewEvent enum."""
        assert ReviewEvent.APPROVE.value == "APPROVE"
        assert ReviewEvent.REQUEST_CHANGES.value == "REQUEST_CHANGES"
        assert ReviewEvent.COMMENT.value == "COMMENT"


class TestModels:
    """Test data models."""

    def test_github_user(self):
        """Test GitHubUser model."""
        user = GitHubUser(
            id=1,
            login="testuser",
            avatar_url="https://avatars.githubusercontent.com/u/1",
            html_url="https://github.com/testuser",
            type="User",
        )
        assert user.login == "testuser"
        assert user.type == "User"

    def test_github_issue(self):
        """Test GitHubIssue model."""
        issue = GitHubIssue(
            number=1,
            title="Test Issue",
            body="Issue body",
            state=IssueState.OPEN,
            user=GitHubUser(
                id=1,
                login="testuser",
                avatar_url="https://avatars.githubusercontent.com/u/1",
                html_url="https://github.com/testuser",
                type="User",
            ),
            labels=[],
            assignees=[],
            created_at="2024-01-01T00:00:00Z",
            updated_at="2024-01-01T00:00:00Z",
            html_url="https://github.com/owner/repo/issues/1",
            comments=0,
        )
        assert issue.number == 1
        assert issue.state == IssueState.OPEN
        assert issue.title == "Test Issue"

    def test_github_pull_request(self):
        """Test GitHubPullRequest model."""
        pr = GitHubPullRequest(
            number=42,
            title="Test PR",
            body="PR body",
            state=PullRequestState.OPEN,
            draft=False,
            merged=False,
            user=GitHubUser(
                id=1,
                login="testuser",
                avatar_url="https://avatars.githubusercontent.com/u/1",
                html_url="https://github.com/testuser",
                type="User",
            ),
            head=GitHubBranchRef(
                ref="feature-branch",
                label="owner:feature-branch",
                sha="abc123",
            ),
            base=GitHubBranchRef(
                ref="main",
                label="owner:main",
                sha="def456",
            ),
            labels=[],
            assignees=[],
            requested_reviewers=[],
            created_at="2024-01-01T00:00:00Z",
            updated_at="2024-01-01T00:00:00Z",
            html_url="https://github.com/owner/repo/pull/42",
        )
        assert pr.number == 42
        assert pr.draft is False
        assert pr.head.ref == "feature-branch"

    def test_github_branch(self):
        """Test GitHubBranch model."""
        branch = GitHubBranch(
            name="feature/test",
            sha="abc123def456",
            protected=False,
        )
        assert branch.name == "feature/test"
        assert branch.protected is False

    def test_github_comment(self):
        """Test GitHubComment model."""
        comment = GitHubComment(
            id=123,
            body="This is a comment",
            user=GitHubUser(
                id=1,
                login="testuser",
                avatar_url="https://avatars.githubusercontent.com/u/1",
                html_url="https://github.com/testuser",
                type="User",
            ),
            created_at="2024-01-01T00:00:00Z",
            updated_at="2024-01-01T00:00:00Z",
            html_url="https://github.com/owner/repo/issues/1#issuecomment-123",
        )
        assert comment.id == 123
        assert "comment" in comment.body.lower()


class TestParamModels:
    """Test parameter models."""

    def test_create_issue_params(self):
        """Test CreateIssueParams model."""
        params = CreateIssueParams(
            owner="owner",
            repo="repo",
            title="Issue Title",
            body="Issue body",
            labels=["bug", "priority"],
            assignees=["user1"],
        )
        assert params.title == "Issue Title"
        assert "bug" in params.labels
        assert params.milestone is None

    def test_create_pull_request_params(self):
        """Test CreatePullRequestParams model."""
        params = CreatePullRequestParams(
            owner="owner",
            repo="repo",
            title="PR Title",
            body="PR body",
            head="feature-branch",
            base="main",
            draft=True,
        )
        assert params.head == "feature-branch"
        assert params.base == "main"
        assert params.draft is True

    def test_create_comment_params(self):
        """Test CreateCommentParams model."""
        params = CreateCommentParams(
            owner="owner",
            repo="repo",
            issue_number=1,
            body="Comment body",
        )
        assert params.issue_number == 1
        assert params.body == "Comment body"

    def test_create_branch_params(self):
        """Test CreateBranchParams model."""
        params = CreateBranchParams(
            owner="owner",
            repo="repo",
            branch_name="feature/new",
            from_ref="main",
        )
        assert params.branch_name == "feature/new"
        assert params.from_ref == "main"
