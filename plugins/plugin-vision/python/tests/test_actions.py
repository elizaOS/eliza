"""Tests for vision plugin actions."""

from __future__ import annotations

from typing import Any

import pytest

from elizaos_vision.actions import (
    CaptureImageAction,
    DescribeSceneAction,
    IdentifyPersonAction,
    KillAutonomousAction,
    NameEntityAction,
    SetVisionModeAction,
    TrackEntityAction,
    capture_image_action,
    describe_scene_action,
    identify_person_action,
    kill_autonomous_action,
    name_entity_action,
    set_vision_mode_action,
    track_entity_action,
)

from .conftest import MockMessage, MockRuntime


class TestDescribeSceneAction:
    """Tests for DescribeSceneAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert DescribeSceneAction.name == "DESCRIBE_SCENE"
        assert "ANALYZE_SCENE" in DescribeSceneAction.similes
        assert "WHAT_DO_YOU_SEE" in DescribeSceneAction.similes
        assert DescribeSceneAction.enabled is True
        assert len(DescribeSceneAction.description) > 0

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await DescribeSceneAction.validate(mock_runtime)
        assert result is False

    @pytest.mark.asyncio
    async def test_handler_no_service(
        self, mock_runtime: MockRuntime, mock_message: MockMessage
    ) -> None:
        """Test handler when service unavailable."""
        result = await DescribeSceneAction.handler(mock_runtime, mock_message)
        assert result["values"]["success"] is False
        assert result["values"]["vision_available"] is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert describe_scene_action is not None
        assert describe_scene_action.name == "DESCRIBE_SCENE"


class TestCaptureImageAction:
    """Tests for CaptureImageAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert CaptureImageAction.name == "CAPTURE_IMAGE"
        assert "TAKE_PHOTO" in CaptureImageAction.similes
        assert "SCREENSHOT" in CaptureImageAction.similes
        assert CaptureImageAction.enabled is False  # Privacy-sensitive

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await CaptureImageAction.validate(mock_runtime)
        assert result is False

    @pytest.mark.asyncio
    async def test_handler_no_service(
        self, mock_runtime: MockRuntime, mock_message: MockMessage
    ) -> None:
        """Test handler when service unavailable."""
        result = await CaptureImageAction.handler(mock_runtime, mock_message)
        assert result["values"]["success"] is False
        assert result["values"]["vision_available"] is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert capture_image_action is not None


class TestSetVisionModeAction:
    """Tests for SetVisionModeAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert SetVisionModeAction.name == "SET_VISION_MODE"
        assert "set vision mode" in SetVisionModeAction.similes
        assert SetVisionModeAction.enabled is True

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await SetVisionModeAction.validate(mock_runtime)
        assert result is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert set_vision_mode_action is not None


class TestNameEntityAction:
    """Tests for NameEntityAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert NameEntityAction.name == "NAME_ENTITY"
        assert "name the person" in NameEntityAction.similes
        assert NameEntityAction.enabled is True

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await NameEntityAction.validate(mock_runtime)
        assert result is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert name_entity_action is not None


class TestIdentifyPersonAction:
    """Tests for IdentifyPersonAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert IdentifyPersonAction.name == "IDENTIFY_PERSON"
        assert "who is that" in IdentifyPersonAction.similes
        assert IdentifyPersonAction.enabled is False  # Privacy-sensitive

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await IdentifyPersonAction.validate(mock_runtime)
        assert result is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert identify_person_action is not None


class TestTrackEntityAction:
    """Tests for TrackEntityAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert TrackEntityAction.name == "TRACK_ENTITY"
        assert "track the" in TrackEntityAction.similes
        assert TrackEntityAction.enabled is False  # Privacy-sensitive

    @pytest.mark.asyncio
    async def test_validate_no_service(self, mock_runtime: MockRuntime) -> None:
        """Test validate returns False when no service."""
        result = await TrackEntityAction.validate(mock_runtime)
        assert result is False

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert track_entity_action is not None


class TestKillAutonomousAction:
    """Tests for KillAutonomousAction."""

    def test_action_metadata(self) -> None:
        """Test action metadata."""
        assert KillAutonomousAction.name == "KILL_AUTONOMOUS"
        assert "STOP_AUTONOMOUS" in KillAutonomousAction.similes
        assert KillAutonomousAction.enabled is False  # Potentially dangerous

    @pytest.mark.asyncio
    async def test_validate_always_true(self) -> None:
        """Test validate always returns True."""
        result = await KillAutonomousAction.validate()
        assert result is True

    @pytest.mark.asyncio
    async def test_handler_no_autonomous_service(
        self, mock_runtime: MockRuntime, mock_message: MockMessage
    ) -> None:
        """Test handler when autonomous service not found."""
        callback_results: list[dict[str, Any]] = []

        async def callback(data: dict[str, Any]) -> None:
            callback_results.append(data)

        await KillAutonomousAction.handler(mock_runtime, mock_message, callback=callback)
        assert len(callback_results) == 1
        assert "No autonomous loop" in callback_results[0]["text"]

    def test_action_instance_exists(self) -> None:
        """Test that action instance is created."""
        assert kill_autonomous_action is not None


class TestActionCallbacks:
    """Tests for action callbacks."""

    @pytest.mark.asyncio
    async def test_describe_scene_callback(
        self, mock_runtime: MockRuntime, mock_message: MockMessage
    ) -> None:
        """Test callback is called for describe scene."""
        callback_results: list[dict[str, Any]] = []

        async def callback(data: dict[str, Any]) -> None:
            callback_results.append(data)

        await DescribeSceneAction.handler(mock_runtime, mock_message, callback=callback)
        assert len(callback_results) == 1
        assert "thought" in callback_results[0]
        assert "text" in callback_results[0]
        assert "actions" in callback_results[0]

    @pytest.mark.asyncio
    async def test_capture_image_callback(
        self, mock_runtime: MockRuntime, mock_message: MockMessage
    ) -> None:
        """Test callback is called for capture image."""
        callback_results: list[dict[str, Any]] = []

        async def callback(data: dict[str, Any]) -> None:
            callback_results.append(data)

        await CaptureImageAction.handler(mock_runtime, mock_message, callback=callback)
        assert len(callback_results) == 1
        assert "thought" in callback_results[0]
