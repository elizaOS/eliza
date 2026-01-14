"""Tests for planning plugin actions."""

import pytest

from elizaos_plugin_planning.actions import (
    AnalyzeInputAction,
    ProcessAnalysisAction,
    ExecuteFinalAction,
    CreatePlanAction,
    get_planning_action_names,
)


class TestAnalyzeInputAction:
    """Tests for AnalyzeInputAction."""

    @pytest.fixture
    def action(self) -> AnalyzeInputAction:
        return AnalyzeInputAction()

    def test_action_name(self, action: AnalyzeInputAction) -> None:
        assert action.name == "ANALYZE_INPUT"

    @pytest.mark.asyncio
    async def test_validate(self, action: AnalyzeInputAction) -> None:
        assert await action.validate("any message")

    @pytest.mark.asyncio
    async def test_handler(self, action: AnalyzeInputAction) -> None:
        params = {"text": "hello world test"}
        result = await action.handler(params)

        assert result["action"] == "ANALYZE_INPUT"
        assert result["wordCount"] == 3
        assert result["sentiment"] == "neutral"

    @pytest.mark.asyncio
    async def test_handler_sentiment(self, action: AnalyzeInputAction) -> None:
        params = {"text": "this is urgent!"}
        result = await action.handler(params)
        assert result["sentiment"] == "urgent"


class TestProcessAnalysisAction:
    """Tests for ProcessAnalysisAction."""

    @pytest.fixture
    def action(self) -> ProcessAnalysisAction:
        return ProcessAnalysisAction()

    def test_action_name(self, action: ProcessAnalysisAction) -> None:
        assert action.name == "PROCESS_ANALYSIS"

    @pytest.mark.asyncio
    async def test_handler(self, action: ProcessAnalysisAction) -> None:
        params = {"analysis": {"wordCount": 10, "sentiment": "positive"}}
        result = await action.handler(params)

        assert result["action"] == "PROCESS_ANALYSIS"
        assert "Thank you" in result["suggestedResponse"]

    @pytest.mark.asyncio
    async def test_handler_missing_analysis(self, action: ProcessAnalysisAction) -> None:
        with pytest.raises(ValueError, match="Missing 'analysis' parameter"):
            await action.handler({})


class TestExecuteFinalAction:
    """Tests for ExecuteFinalAction."""

    @pytest.fixture
    def action(self) -> ExecuteFinalAction:
        return ExecuteFinalAction()

    def test_action_name(self, action: ExecuteFinalAction) -> None:
        assert action.name == "EXECUTE_FINAL"

    @pytest.mark.asyncio
    async def test_handler(self, action: ExecuteFinalAction) -> None:
        params = {"decisions": {"requiresAction": True, "suggestedResponse": "Done!"}}
        result = await action.handler(params)

        assert result["action"] == "EXECUTE_FINAL"
        assert result["executedAction"] == "RESPOND"


class TestCreatePlanAction:
    """Tests for CreatePlanAction."""

    @pytest.fixture
    def action(self) -> CreatePlanAction:
        return CreatePlanAction()

    def test_action_name(self, action: CreatePlanAction) -> None:
        assert action.name == "CREATE_PLAN"

    @pytest.mark.asyncio
    async def test_validate(self, action: CreatePlanAction) -> None:
        assert await action.validate("create a comprehensive plan")
        assert await action.validate("organize this project")
        assert not await action.validate("hello world")

    @pytest.mark.asyncio
    async def test_handler(self, action: CreatePlanAction) -> None:
        result = await action.handler({})

        assert result["action"] == "CREATE_PLAN"
        assert "planId" in result
        assert result["totalPhases"] == 3
        assert result["totalTasks"] == 4


class TestActionRegistry:
    """Tests for action registry functions."""

    def test_get_planning_action_names(self) -> None:
        names = get_planning_action_names()
        assert "ANALYZE_INPUT" in names
        assert "PROCESS_ANALYSIS" in names
        assert "EXECUTE_FINAL" in names
        assert "CREATE_PLAN" in names
        assert len(names) == 4
