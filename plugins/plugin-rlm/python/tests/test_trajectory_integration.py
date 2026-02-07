"""
Tests for RLM trajectory integration with plugin-trajectory-logger.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from elizaos_plugin_rlm.client import (
    RLMConfig,
    RLMCost,
    RLMResult,
    RLMTrajectory,
    RLMTrajectoryStep,
)
from elizaos_plugin_rlm.trajectory_integration import (
    RLMTrajectoryIntegration,
    convert_rlm_step_to_llm_call,
    convert_rlm_trajectory_to_provider_access,
)


class TestConvertRLMStepToLLMCall:
    """Tests for RLM step to LLM call conversion."""

    def test_basic_conversion(self) -> None:
        """Test basic step conversion."""
        step = RLMTrajectoryStep(
            step_id="step-123",
            step_number=0,
            timestamp_ms=1000000,
            code_executed="prompt[:100]",
            repl_output="First 100 chars...",
            strategy="peek",
            input_tokens=100,
            output_tokens=50,
            duration_ms=500,
        )

        llm_call = convert_rlm_step_to_llm_call(step, model="gemini")

        assert llm_call.call_id == "step-123"
        assert llm_call.timestamp == 1000000
        assert llm_call.model == "gemini"
        assert llm_call.user_prompt == "prompt[:100]"
        assert llm_call.response == "First 100 chars..."
        assert llm_call.prompt_tokens == 100
        assert llm_call.completion_tokens == 50
        assert llm_call.latency_ms == 500

    def test_subcall_purpose(self) -> None:
        """Test subcall step gets reasoning purpose."""
        step = RLMTrajectoryStep(is_subcall=True, strategy="subcall")
        llm_call = convert_rlm_step_to_llm_call(step)
        assert llm_call.purpose == "reasoning"

    def test_regular_step_purpose(self) -> None:
        """Test regular step gets action purpose."""
        step = RLMTrajectoryStep(is_subcall=False, strategy="peek")
        llm_call = convert_rlm_step_to_llm_call(step)
        assert llm_call.purpose == "action"

    def test_strategy_in_reasoning(self) -> None:
        """Test strategy is captured in reasoning field."""
        step = RLMTrajectoryStep(strategy="grep")
        llm_call = convert_rlm_step_to_llm_call(step)
        assert "grep" in (llm_call.reasoning or "")


class TestConvertRLMTrajectoryToProviderAccess:
    """Tests for RLM trajectory to provider access conversion."""

    def test_basic_conversion(self) -> None:
        """Test basic trajectory conversion."""
        trajectory = RLMTrajectory(
            trajectory_id="traj-123",
            prompt_length=5000,
            prompt_preview="Hello world...",
            total_iterations=5,
            subcall_count=2,
            max_depth_reached=3,
            strategies_used=["peek", "grep"],
        )
        trajectory.start_time_ms = 1000
        trajectory.end_time_ms = 2000

        access = convert_rlm_trajectory_to_provider_access(trajectory)

        assert access.provider_id == "rlm"
        assert access.timestamp == 1000
        assert access.query["prompt_length"] == 5000
        assert access.data["trajectory_id"] == "traj-123"
        assert access.data["total_iterations"] == 5
        assert access.data["subcall_count"] == 2

    def test_cost_included(self) -> None:
        """Test cost is included when present."""
        trajectory = RLMTrajectory()
        trajectory.cost = RLMCost(root_input_tokens=100, root_cost_usd=0.01)

        access = convert_rlm_trajectory_to_provider_access(trajectory)

        assert access.data["cost"] is not None
        assert access.data["cost"]["root_input_tokens"] == 100


class TestRLMTrajectoryIntegration:
    """Tests for the RLM trajectory integration class."""

    @pytest.fixture
    def mock_trajectory_logger(self) -> MagicMock:
        """Create a mock trajectory logger service."""
        mock_logger = MagicMock()
        mock_logger.start_trajectory.return_value = "traj-test-123"
        mock_logger.start_step.return_value = "step-test-456"
        mock_logger.get_current_step_id.return_value = "step-test-456"
        mock_logger.end_trajectory = AsyncMock()
        return mock_logger

    def test_initialization(self, mock_trajectory_logger: MagicMock) -> None:
        """Test integration initializes correctly."""
        integration = RLMTrajectoryIntegration(
            mock_trajectory_logger,
            agent_id="test-agent",
        )

        assert integration._agent_id == "test-agent"
        assert integration._client.config.log_trajectories is True
        assert integration._client.config.track_costs is True

    def test_config_override(self, mock_trajectory_logger: MagicMock) -> None:
        """Test custom config is applied."""
        config = RLMConfig(
            backend="openai",
            max_iterations=10,
        )
        integration = RLMTrajectoryIntegration(
            mock_trajectory_logger,
            config,
        )

        assert integration._client.config.backend == "openai"
        assert integration._client.config.max_iterations == 10

    def test_is_available_property(self, mock_trajectory_logger: MagicMock) -> None:
        """Test is_available delegates to client."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)
        # In stub mode without RLM installed
        assert isinstance(integration.is_available, bool)

    def test_callback_registration(self, mock_trajectory_logger: MagicMock) -> None:
        """Test callback registration."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        callback_called = []

        def callback(traj: RLMTrajectory) -> None:
            callback_called.append(traj)

        integration.on_trajectory_complete(callback)
        assert integration._on_trajectory_complete is callback

    @pytest.mark.asyncio
    async def test_infer_starts_trajectory(
        self, mock_trajectory_logger: MagicMock
    ) -> None:
        """Test inference starts a trajectory."""
        integration = RLMTrajectoryIntegration(
            mock_trajectory_logger,
            agent_id="test-agent",
            scenario_id="test-scenario",
        )

        # Run inference (will use stub mode)
        await integration.infer("Hello world")

        mock_trajectory_logger.start_trajectory.assert_called_once()
        call_args = mock_trajectory_logger.start_trajectory.call_args
        assert call_args.kwargs["agent_id"] == "test-agent"
        assert call_args.kwargs["scenario_id"] == "test-scenario"

    @pytest.mark.asyncio
    async def test_infer_ends_trajectory(
        self, mock_trajectory_logger: MagicMock
    ) -> None:
        """Test inference ends trajectory."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        await integration.infer("Hello world")

        mock_trajectory_logger.end_trajectory.assert_called_once()

    @pytest.mark.asyncio
    async def test_infer_returns_result(
        self, mock_trajectory_logger: MagicMock
    ) -> None:
        """Test inference returns RLMResult."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        result = await integration.infer("Hello world")

        assert isinstance(result, RLMResult)
        assert result.stub is True  # RLM not installed

    def test_cost_summary(self, mock_trajectory_logger: MagicMock) -> None:
        """Test cost summary delegation."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        summary = integration.get_cost_summary()

        assert "trajectory_count" in summary
        assert "total_cost_usd" in summary

    def test_export_trajectories(self, mock_trajectory_logger: MagicMock) -> None:
        """Test trajectory export."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        exported = integration.export_rlm_trajectories()

        assert isinstance(exported, list)


class TestRLMTrajectoryIntegrationWithMockedClient:
    """Tests with a mocked RLM client for more control."""

    @pytest.fixture
    def mock_trajectory_logger(self) -> MagicMock:
        """Create a mock trajectory logger service."""
        mock_logger = MagicMock()
        mock_logger.start_trajectory.return_value = "traj-test-123"
        mock_logger.start_step.return_value = "step-test-456"
        mock_logger.get_current_step_id.return_value = "step-test-456"
        mock_logger.end_trajectory = AsyncMock()
        return mock_logger

    @pytest.mark.asyncio
    async def test_logs_trajectory_steps(
        self, mock_trajectory_logger: MagicMock
    ) -> None:
        """Test RLM trajectory steps are logged."""
        # Create a mock RLM trajectory result
        rlm_trajectory = RLMTrajectory(prompt_length=1000)
        rlm_trajectory.add_step(
            RLMTrajectoryStep(strategy="peek", code_executed="x[:100]")
        )
        rlm_trajectory.add_step(
            RLMTrajectoryStep(strategy="grep", code_executed="re.search()")
        )

        mock_result = RLMResult(
            text="Result",
            stub=False,
            trajectory=rlm_trajectory,
            iterations=2,
        )

        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        # Patch the client's infer_with_trajectory
        with patch.object(
            integration._client, "infer_with_trajectory", new_callable=AsyncMock
        ) as mock_infer:
            mock_infer.return_value = mock_result

            result = await integration.infer("Test prompt")

            # Should have started steps for each RLM step
            assert mock_trajectory_logger.start_step.call_count == 2
            assert mock_trajectory_logger.log_llm_call.call_count == 2
            assert mock_trajectory_logger.complete_step.call_count == 2

    @pytest.mark.asyncio
    async def test_callback_fired_on_complete(
        self, mock_trajectory_logger: MagicMock
    ) -> None:
        """Test callback is fired when trajectory completes."""
        rlm_trajectory = RLMTrajectory(prompt_length=100)

        mock_result = RLMResult(
            text="Result",
            stub=False,
            trajectory=rlm_trajectory,
        )

        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        callback_results: list[RLMTrajectory] = []

        def callback(traj: RLMTrajectory) -> None:
            callback_results.append(traj)

        integration.on_trajectory_complete(callback)

        with patch.object(
            integration._client, "infer_with_trajectory", new_callable=AsyncMock
        ) as mock_infer:
            mock_infer.return_value = mock_result

            await integration.infer("Test prompt")

            assert len(callback_results) == 1
            assert callback_results[0] is rlm_trajectory

    @pytest.mark.asyncio
    async def test_error_handling(self, mock_trajectory_logger: MagicMock) -> None:
        """Test error is handled and trajectory ended."""
        integration = RLMTrajectoryIntegration(mock_trajectory_logger)

        with patch.object(
            integration._client,
            "infer_with_trajectory",
            new_callable=AsyncMock,
            side_effect=ValueError("Test error"),
        ):
            with pytest.raises(ValueError, match="Test error"):
                await integration.infer("Test prompt")

            # Trajectory should still be ended
            mock_trajectory_logger.end_trajectory.assert_called_once()
            call_args = mock_trajectory_logger.end_trajectory.call_args
            assert call_args.kwargs["status"] == "error"


class TestConvenienceFunction:
    """Tests for the infer_with_logging convenience function."""

    @pytest.mark.asyncio
    async def test_infer_with_logging(self) -> None:
        """Test convenience function works."""
        from elizaos_plugin_rlm.trajectory_integration import infer_with_logging

        mock_logger = MagicMock()
        mock_logger.start_trajectory.return_value = "traj-123"
        mock_logger.start_step.return_value = "step-123"
        mock_logger.get_current_step_id.return_value = "step-123"
        mock_logger.end_trajectory = AsyncMock()

        result = await infer_with_logging(
            mock_logger,
            "Hello world",
            agent_id="test-agent",
        )

        assert isinstance(result, RLMResult)
        mock_logger.start_trajectory.assert_called_once()
        mock_logger.end_trajectory.assert_called_once()
