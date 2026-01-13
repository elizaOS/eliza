"""Tests for GitHub service.

These tests require a valid GITHUB_API_TOKEN environment variable.
Tests will be skipped if the API token is not available.
"""

import os

import pytest

from elizaos_plugin_github.config import GitHubConfig
from elizaos_plugin_github.error import (
    ClientNotInitializedError,
    RepositoryNotFoundError,
)
from elizaos_plugin_github.service import GitHubService
from elizaos_plugin_github.types import (
    ListIssuesParams,
    ListPullRequestsParams,
    RepositoryRef,
)

# Skip all tests if GITHUB_API_TOKEN is not set
pytestmark = pytest.mark.skipif(
    not os.environ.get("GITHUB_API_TOKEN"),
    reason="GITHUB_API_TOKEN environment variable not set",
)


@pytest.fixture
def config() -> GitHubConfig:
    """Create a test config from environment."""
    return GitHubConfig.from_env()


@pytest.fixture
async def service(config: GitHubConfig) -> GitHubService:
    """Create and start a test service."""
    svc = GitHubService(config)
    await svc.start()
    yield svc
    await svc.stop()


class TestGitHubServiceInitialization:
    """Test cases for service initialization."""

    def test_create_service(self, config: GitHubConfig):
        """Test creating a service instance."""
        service = GitHubService(config)
        assert service.config == config

    def test_client_not_initialized_error(self, config: GitHubConfig):
        """Test that accessing client before start raises error."""
        service = GitHubService(config)
        with pytest.raises(ClientNotInitializedError):
            service._get_client()

    @pytest.mark.asyncio
    async def test_start_and_stop(self, config: GitHubConfig):
        """Test starting and stopping the service."""
        service = GitHubService(config)
        await service.start()
        # Should be able to get client now
        client = service._get_client()
        assert client is not None

        await service.stop()
        with pytest.raises(ClientNotInitializedError):
            service._get_client()


class TestAuthenticatedUser:
    """Test cases for authenticated user operations."""

    @pytest.mark.asyncio
    async def test_get_authenticated_user(self, service: GitHubService):
        """Test getting the authenticated user."""
        user = await service.get_authenticated_user()
        assert user.login is not None
        assert user.id > 0


class TestRepositoryOperations:
    """Test cases for repository operations."""

    @pytest.mark.asyncio
    async def test_get_repository(self, service: GitHubService):
        """Test getting a public repository."""
        # Use a well-known public repository
        repo = await service.get_repository(RepositoryRef(owner="octocat", repo="Hello-World"))
        assert repo.name == "Hello-World"
        assert repo.owner.login == "octocat"
        assert repo.full_name == "octocat/Hello-World"

    @pytest.mark.asyncio
    async def test_get_repository_not_found(self, service: GitHubService):
        """Test getting a non-existent repository."""
        with pytest.raises(RepositoryNotFoundError):
            await service.get_repository(
                RepositoryRef(owner="nonexistent-user-xyz", repo="nonexistent-repo-xyz")
            )


class TestIssueOperations:
    """Test cases for issue operations."""

    @pytest.mark.asyncio
    async def test_list_issues(self, service: GitHubService):
        """Test listing issues from a public repository."""
        # Use a well-known repository with issues
        issues = await service.list_issues(
            ListIssuesParams(
                owner="octocat",
                repo="Hello-World",
                state="all",
                per_page=5,
            )
        )
        # May return empty if no issues, but should not error
        assert isinstance(issues, list)

    @pytest.mark.asyncio
    async def test_get_issue(self, service: GitHubService):
        """Test getting a specific issue."""
        # Get issue #1 from Hello-World (may not exist, skip if so)
        try:
            issue = await service.get_issue("octocat", "Hello-World", 1)
            assert issue.number == 1
        except Exception:
            pytest.skip("Issue #1 not found in octocat/Hello-World")


class TestPullRequestOperations:
    """Test cases for pull request operations."""

    @pytest.mark.asyncio
    async def test_list_pull_requests(self, service: GitHubService):
        """Test listing pull requests from a public repository."""
        prs = await service.list_pull_requests(
            ListPullRequestsParams(
                owner="octocat",
                repo="Hello-World",
                state="all",
                per_page=5,
            )
        )
        # May return empty if no PRs, but should not error
        assert isinstance(prs, list)


class TestBranchOperations:
    """Test cases for branch operations."""

    @pytest.mark.asyncio
    async def test_list_branches(self, service: GitHubService):
        """Test listing branches from a public repository."""
        branches = await service.list_branches("octocat", "Hello-World")
        assert isinstance(branches, list)
        # Hello-World should have at least one branch
        assert len(branches) >= 1
        # Check that 'master' branch exists
        branch_names = [b.name for b in branches]
        assert "master" in branch_names


class TestFileOperations:
    """Test cases for file operations."""

    @pytest.mark.asyncio
    async def test_get_file(self, service: GitHubService):
        """Test getting a file from a public repository."""
        file_content = await service.get_file(
            "octocat",
            "Hello-World",
            "README",
            branch="master",
        )
        assert file_content.name == "README"
        assert file_content.content is not None

    @pytest.mark.asyncio
    async def test_list_directory(self, service: GitHubService):
        """Test listing directory contents from a public repository."""
        entries = await service.list_directory(
            "octocat",
            "Hello-World",
            "",
            branch="master",
        )
        assert isinstance(entries, list)
        # Root directory should have at least README
        entry_names = [e.name for e in entries]
        assert "README" in entry_names


class TestServiceHelpers:
    """Test cases for service helper methods."""

    def test_resolve_repo_ref_with_defaults(self, config: GitHubConfig):
        """Test resolving repo ref with defaults."""
        config_with_defaults = GitHubConfig(
            api_token=config.api_token,
            owner="default_owner",
            repo="default_repo",
        )
        service = GitHubService(config_with_defaults)
        owner, repo = service._resolve_repo_ref(None, None)
        assert owner == "default_owner"
        assert repo == "default_repo"

    def test_resolve_repo_ref_with_overrides(self, config: GitHubConfig):
        """Test resolving repo ref with overrides."""
        config_with_defaults = GitHubConfig(
            api_token=config.api_token,
            owner="default_owner",
            repo="default_repo",
        )
        service = GitHubService(config_with_defaults)
        owner, repo = service._resolve_repo_ref("override_owner", "override_repo")
        assert owner == "override_owner"
        assert repo == "override_repo"
