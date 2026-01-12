"""Tests for the Linear service."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_linear.services.linear import LinearService
from elizaos_plugin_linear.types import (
    LinearAuthenticationError,
    LinearIssueInput,
)


class TestRuntime:
    """Test runtime for testing."""

    def __init__(self, settings: dict[str, str | None] | None = None) -> None:
        self._settings = settings or {}

    def get_setting(self, key: str) -> str | None:
        return self._settings.get(key)


@pytest.fixture
def test_runtime() -> TestRuntime:
    """Create a test runtime with test settings."""
    return TestRuntime(
        {
            "LINEAR_API_KEY": "test-api-key",
            "LINEAR_WORKSPACE_ID": "test-workspace",
        }
    )


class TestLinearService:
    """Tests for LinearService."""

    def test_init_without_api_key_raises_error(self) -> None:
        """Test that initialization without API key raises error."""
        runtime = TestRuntime()

        with pytest.raises(LinearAuthenticationError, match="Linear API key is required"):
            LinearService(runtime)

    def test_init_with_api_key_succeeds(self, test_runtime: TestRuntime) -> None:
        """Test that initialization with API key succeeds."""
        service = LinearService(test_runtime)

        assert service.config.api_key == "test-api-key"
        assert service.config.workspace_id == "test-workspace"

    @pytest.mark.asyncio
    async def test_start_validates_connection(self, test_runtime: TestRuntime) -> None:
        """Test that start validates the API connection."""
        with patch.object(LinearService, "_validate_connection", new_callable=AsyncMock):
            service = await LinearService.start(test_runtime)

            assert service is not None
            service._validate_connection.assert_called_once()  # type: ignore

    def test_activity_log_operations(self, test_runtime: TestRuntime) -> None:
        """Test activity log operations."""
        service = LinearService(test_runtime)

        # Clear log
        service.clear_activity_log()
        assert len(service.get_activity_log()) == 0

        # Add activity via internal method
        service._log_activity("test_action", "issue", "test-123", {"test": "data"}, True)

        activity = service.get_activity_log()
        assert len(activity) == 1
        assert activity[0].action == "test_action"
        assert activity[0].resource_type == "issue"
        assert activity[0].success is True

        # Clear again
        service.clear_activity_log()
        assert len(service.get_activity_log()) == 0

    def test_activity_log_limit(self, test_runtime: TestRuntime) -> None:
        """Test activity log respects limit."""
        service = LinearService(test_runtime)
        service.clear_activity_log()

        # Add more than limit
        for i in range(15):
            service._log_activity(f"action_{i}", "issue", f"id-{i}", {}, True)

        # Get with limit
        activity = service.get_activity_log(limit=5)
        assert len(activity) == 5

    def test_activity_log_filter(self, test_runtime: TestRuntime) -> None:
        """Test activity log filtering."""
        service = LinearService(test_runtime)
        service.clear_activity_log()

        service._log_activity("create_issue", "issue", "id-1", {}, True)
        service._log_activity("update_issue", "issue", "id-2", {}, False)
        service._log_activity("create_issue", "issue", "id-3", {}, True)

        # Filter by success
        successful = service.get_activity_log(filter_by={"success": True})
        assert len(successful) == 2

        failed = service.get_activity_log(filter_by={"success": False})
        assert len(failed) == 1

    @pytest.mark.asyncio
    async def test_get_teams(self, test_runtime: TestRuntime) -> None:
        """Test get teams."""
        service = LinearService(test_runtime)

        mock_response = {
            "data": {
                "teams": {
                    "nodes": [
                        {
                            "id": "team-1",
                            "name": "Engineering",
                            "key": "ENG",
                            "description": "Test",
                        },
                        {"id": "team-2", "name": "Design", "key": "DES", "description": None},
                    ]
                }
            }
        }

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = MagicMock(status_code=200, json=lambda: mock_response)

            teams = await service.get_teams()

            assert len(teams) == 2
            assert teams[0]["name"] == "Engineering"
            assert teams[1]["key"] == "DES"

    @pytest.mark.asyncio
    async def test_create_issue(self, test_runtime: TestRuntime) -> None:
        """Test create issue."""
        service = LinearService(test_runtime)

        mock_response = {
            "data": {
                "issueCreate": {
                    "success": True,
                    "issue": {
                        "id": "issue-123",
                        "identifier": "ENG-123",
                        "title": "Test Issue",
                        "url": "https://linear.app/test/issue/ENG-123",
                    },
                }
            }
        }

        with patch.object(service._client, "post", new_callable=AsyncMock) as mock_post:
            mock_post.return_value = MagicMock(status_code=200, json=lambda: mock_response)

            issue_input = LinearIssueInput(
                title="Test Issue",
                team_id="team-123",
                description="Test description",
                priority=3,
            )

            issue = await service.create_issue(issue_input)

            assert issue["identifier"] == "ENG-123"
            assert issue["title"] == "Test Issue"

            # Check activity was logged
            activity = service.get_activity_log()
            assert len(activity) == 1
            assert activity[0].action == "create_issue"





