"""Tests for N8n actions."""

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed")

from elizaos_plugin_n8n.actions.cancel_plugin import CancelPluginAction
from elizaos_plugin_n8n.actions.check_status import CheckStatusAction
from elizaos_plugin_n8n.actions.create_from_description import CreateFromDescriptionAction
from elizaos_plugin_n8n.actions.create_plugin import (
    ActionContext,
    CreatePluginAction,
)


class TestCreatePluginAction:
    """Tests for CreatePluginAction."""

    @pytest.fixture
    def action(self) -> CreatePluginAction:
        """Create action instance."""
        return CreatePluginAction()

    @pytest.mark.asyncio
    async def test_name(self, action: CreatePluginAction) -> None:
        """Test action name."""
        assert action.name == "createPlugin"

    @pytest.mark.asyncio
    async def test_validate_with_json(self, action: CreatePluginAction) -> None:
        """Test validation with JSON specification."""
        context = ActionContext(
            message_text='{"name": "@elizaos/plugin-test", "description": "Test plugin"}',
            state={},
        )
        result = await action.validate(context)
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_json(self, action: CreatePluginAction) -> None:
        """Test validation without JSON."""
        context = ActionContext(
            message_text="Create a weather plugin",
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_execute_valid_json(self, action: CreatePluginAction) -> None:
        """Test execute with valid JSON."""
        context = ActionContext(
            message_text='{"name": "@elizaos/plugin-test", "description": "Test"}',
            state={},
        )
        result = await action.execute(context)
        assert result.success is True
        assert "@elizaos/plugin-test" in result.text


class TestCheckStatusAction:
    """Tests for CheckStatusAction."""

    @pytest.fixture
    def action(self) -> CheckStatusAction:
        """Create action instance."""
        return CheckStatusAction()

    @pytest.mark.asyncio
    async def test_name(self, action: CheckStatusAction) -> None:
        """Test action name."""
        assert action.name == "checkPluginCreationStatus"

    @pytest.mark.asyncio
    async def test_validate_no_jobs(self, action: CheckStatusAction) -> None:
        """Test validation with no jobs."""
        context = ActionContext(
            message_text="check status",
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_with_jobs(self, action: CheckStatusAction) -> None:
        """Test validation with jobs."""
        context = ActionContext(
            message_text="check status",
            state={"jobs": [{"id": "job-1"}]},
        )
        result = await action.validate(context)
        assert result is True


class TestCancelPluginAction:
    """Tests for CancelPluginAction."""

    @pytest.fixture
    def action(self) -> CancelPluginAction:
        """Create action instance."""
        return CancelPluginAction()

    @pytest.mark.asyncio
    async def test_name(self, action: CancelPluginAction) -> None:
        """Test action name."""
        assert action.name == "cancelPluginCreation"

    @pytest.mark.asyncio
    async def test_validate_no_active_job(self, action: CancelPluginAction) -> None:
        """Test validation with no active job."""
        context = ActionContext(
            message_text="cancel",
            state={"jobs": [{"status": "completed"}]},
        )
        result = await action.validate(context)
        assert result is False


class TestCreateFromDescriptionAction:
    """Tests for CreateFromDescriptionAction."""

    @pytest.fixture
    def action(self) -> CreateFromDescriptionAction:
        """Create action instance."""
        return CreateFromDescriptionAction()

    @pytest.mark.asyncio
    async def test_name(self, action: CreateFromDescriptionAction) -> None:
        """Test action name."""
        assert action.name == "createPluginFromDescription"

    @pytest.mark.asyncio
    async def test_validate_short_message(self, action: CreateFromDescriptionAction) -> None:
        """Test validation with short message."""
        context = ActionContext(
            message_text="short",
            state={},
        )
        result = await action.validate(context)
        assert result is False

    @pytest.mark.asyncio
    async def test_validate_long_message(self, action: CreateFromDescriptionAction) -> None:
        """Test validation with long message."""
        context = ActionContext(
            message_text="I need a plugin that helps manage weather data and forecasts",
            state={},
        )
        result = await action.validate(context)
        assert result is True

    @pytest.mark.asyncio
    async def test_execute_weather_plugin(self, action: CreateFromDescriptionAction) -> None:
        """Test execute for weather plugin."""
        context = ActionContext(
            message_text="I need a plugin that shows weather information",
            state={},
        )
        result = await action.execute(context)
        assert result.success is True
        assert "weather" in result.data["pluginName"]
