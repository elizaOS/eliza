"""
Tests for BFCL Evaluators

Tests for AST, Execution, and Relevance evaluators.
"""

import pytest

from benchmarks.bfcl.evaluators import ASTEvaluator, ExecutionEvaluator, RelevanceEvaluator
from benchmarks.bfcl.types import FunctionCall, FunctionDefinition, FunctionParameter


class TestASTEvaluator:
    """Tests for AST evaluator."""

    @pytest.fixture
    def evaluator(self) -> ASTEvaluator:
        return ASTEvaluator()

    def test_exact_match(self, evaluator: ASTEvaluator) -> None:
        """Test exact match evaluation."""
        predicted = [FunctionCall(name="get_weather", arguments={"location": "San Francisco"})]
        expected = [FunctionCall(name="get_weather", arguments={"location": "San Francisco"})]
        assert evaluator.evaluate(predicted, expected) is True

    def test_name_mismatch(self, evaluator: ASTEvaluator) -> None:
        """Test function name mismatch."""
        predicted = [FunctionCall(name="get_weather", arguments={"location": "San Francisco"})]
        expected = [FunctionCall(name="get_temperature", arguments={"location": "San Francisco"})]
        assert evaluator.evaluate(predicted, expected) is False

    def test_argument_mismatch(self, evaluator: ASTEvaluator) -> None:
        """Test argument value mismatch."""
        predicted = [FunctionCall(name="get_weather", arguments={"location": "New York"})]
        expected = [FunctionCall(name="get_weather", arguments={"location": "San Francisco"})]
        assert evaluator.evaluate(predicted, expected) is False

    def test_type_coercion_int_string(self, evaluator: ASTEvaluator) -> None:
        """Test type coercion between int and string."""
        predicted = [FunctionCall(name="set_count", arguments={"count": "5"})]
        expected = [FunctionCall(name="set_count", arguments={"count": 5})]
        assert evaluator.evaluate(predicted, expected) is True

    def test_type_coercion_bool_string(self, evaluator: ASTEvaluator) -> None:
        """Test type coercion between bool and string."""
        predicted = [FunctionCall(name="set_flag", arguments={"enabled": "true"})]
        expected = [FunctionCall(name="set_flag", arguments={"enabled": True})]
        assert evaluator.evaluate(predicted, expected) is True

    def test_strict_type_matching(self) -> None:
        """Test strict type matching mode."""
        evaluator = ASTEvaluator(strict_type_matching=True)
        predicted = [FunctionCall(name="set_count", arguments={"count": "5"})]
        expected = [FunctionCall(name="set_count", arguments={"count": 5})]
        assert evaluator.evaluate(predicted, expected) is False

    def test_empty_calls(self, evaluator: ASTEvaluator) -> None:
        """Test empty call lists match."""
        assert evaluator.evaluate([], []) is True

    def test_count_mismatch(self, evaluator: ASTEvaluator) -> None:
        """Test different number of calls."""
        predicted = [FunctionCall(name="func1", arguments={})]
        expected = [
            FunctionCall(name="func1", arguments={}),
            FunctionCall(name="func2", arguments={}),
        ]
        assert evaluator.evaluate(predicted, expected) is False

    def test_parallel_calls_order_independent(self, evaluator: ASTEvaluator) -> None:
        """Test parallel calls match regardless of order."""
        predicted = [
            FunctionCall(name="func2", arguments={"x": 2}),
            FunctionCall(name="func1", arguments={"x": 1}),
        ]
        expected = [
            FunctionCall(name="func1", arguments={"x": 1}),
            FunctionCall(name="func2", arguments={"x": 2}),
        ]
        assert evaluator.evaluate(predicted, expected) is True

    def test_case_insensitive_names(self) -> None:
        """Test case insensitive name matching."""
        evaluator = ASTEvaluator(case_sensitive_names=False)
        predicted = [FunctionCall(name="GetWeather", arguments={"location": "NYC"})]
        expected = [FunctionCall(name="get_weather", arguments={"location": "NYC"})]
        assert evaluator.evaluate(predicted, expected) is True

    def test_ignore_extra_args(self) -> None:
        """Test ignoring extra arguments."""
        evaluator = ASTEvaluator(ignore_extra_args=True)
        predicted = [FunctionCall(name="func", arguments={"a": 1, "b": 2, "extra": 3})]
        expected = [FunctionCall(name="func", arguments={"a": 1, "b": 2})]
        assert evaluator.evaluate(predicted, expected) is True

    def test_match_details_provides_info(self, evaluator: ASTEvaluator) -> None:
        """Test match details provides diagnostic info."""
        predicted = [FunctionCall(name="func", arguments={"x": 1})]
        expected = [FunctionCall(name="func", arguments={"x": 2})]
        details = evaluator.get_match_details(predicted, expected)
        assert details["overall_match"] is False
        assert "mismatches" in details

    def test_optional_default_can_be_omitted_when_ground_truth_lists_alternatives(
        self,
    ) -> None:
        evaluator = ASTEvaluator()
        function = FunctionDefinition(
            name="measure",
            description="Measure something.",
            parameters={
                "value": FunctionParameter(
                    name="value",
                    param_type="integer",
                    description="Primary value.",
                    required=True,
                ),
                "unit": FunctionParameter(
                    name="unit",
                    param_type="string",
                    description="Unit label.",
                    required=False,
                    default="kg/m³",
                ),
            },
            required_params=["value"],
        )
        predicted = [
            FunctionCall(name="measure", arguments={"value": 3}),
        ]
        expected = [
            FunctionCall(
                name="measure",
                arguments={"value": 3, "unit": ["kg/m³", "kg/m3"]},
            ),
        ]

        assert evaluator.evaluate(predicted, expected, function_defs=[function]) is True

    def test_scalar_prediction_matches_any_ground_truth_alternative(self) -> None:
        evaluator = ASTEvaluator()
        function = FunctionDefinition(
            name="schedule",
            description="Schedule a reminder.",
            parameters={
                "day": FunctionParameter(
                    name="day",
                    param_type="string",
                    description="Day of week.",
                    required=True,
                ),
            },
            required_params=["day"],
        )
        predicted = [
            FunctionCall(name="schedule", arguments={"day": "Monday"}),
        ]
        expected = [
            FunctionCall(name="schedule", arguments={"day": ["Monday", "Mon"]}),
        ]

        assert evaluator.evaluate(predicted, expected, function_defs=[function]) is True
        details = evaluator.get_match_details(predicted, expected, function_defs=[function])
        assert details["overall_match"] is True
        assert details["mismatches"] == []

    def test_array_arguments_still_require_array_shape(self) -> None:
        evaluator = ASTEvaluator()
        function = FunctionDefinition(
            name="search",
            description="Search by columns.",
            parameters={
                "columns": FunctionParameter(
                    name="columns",
                    param_type="string",
                    description="Columns to include.",
                    items={"type": "string"},
                    required=True,
                ),
            },
            required_params=["columns"],
        )
        predicted = [
            FunctionCall(name="search", arguments={"columns": "title"}),
        ]
        expected = [
            FunctionCall(name="search", arguments={"columns": ["title", "body"]}),
        ]

        assert evaluator.evaluate(predicted, expected, function_defs=[function]) is False


class TestExecutionEvaluator:
    """Tests for Execution evaluator."""

    @pytest.fixture
    def evaluator(self) -> ExecutionEvaluator:
        return ExecutionEvaluator()

    @pytest.mark.asyncio
    async def test_execute_mock_function(self, evaluator: ExecutionEvaluator) -> None:
        """Test executing a mock function."""

        async def mock_add(a: int, b: int) -> int:
            return a + b

        evaluator.register_mock("add", mock_add)

        call = FunctionCall(name="add", arguments={"a": 2, "b": 3})
        success, result, error = await evaluator.execute(call)

        assert success is True
        assert result == 5
        assert error is None

    @pytest.mark.asyncio
    async def test_execute_missing_function(self, evaluator: ExecutionEvaluator) -> None:
        """Test executing a missing function."""
        call = FunctionCall(name="nonexistent", arguments={})
        success, result, error = await evaluator.execute(call)

        assert success is False
        assert result is None
        assert "No mock handler" in error

    @pytest.mark.asyncio
    async def test_execute_all_functions(self, evaluator: ExecutionEvaluator) -> None:
        """Test executing multiple functions."""

        async def mock_func(x: int) -> int:
            return x * 2

        evaluator.register_mock("double", mock_func)

        calls = [
            FunctionCall(name="double", arguments={"x": 1}),
            FunctionCall(name="double", arguments={"x": 2}),
        ]
        success, results, errors = await evaluator.execute_all(calls)

        assert success is True
        assert results == [2, 4]
        assert errors == []

    @pytest.mark.asyncio
    async def test_no_auto_success_mocks(self, evaluator: ExecutionEvaluator) -> None:
        """The previous synthetic always-success mock generator has been
        removed. setup_standard_mocks is now a no-op; unregistered functions
        must NOT be silently accepted."""
        evaluator.setup_standard_mocks()  # intentional no-op
        from benchmarks.bfcl.types import FunctionDefinition
        evaluator.register_mocks_from_definitions([
            FunctionDefinition(name="get_weather", description="", parameters={}),
        ])  # intentional no-op

        call = FunctionCall(
            name="get_weather",
            arguments={"location": "San Francisco", "unit": "celsius"},
        )
        success, result, error = await evaluator.execute(call)

        assert success is False, (
            "Unregistered functions must NOT auto-succeed — the previous "
            "behaviour made exec_accuracy meaningless."
        )
        assert result is None
        assert "No mock handler" in (error or "")

    @pytest.mark.asyncio
    async def test_preconfigured_result(self, evaluator: ExecutionEvaluator) -> None:
        """Test pre-configured results."""
        evaluator.registry.register_result("custom", {"status": "ok"})

        call = FunctionCall(name="custom", arguments={})
        success, result, error = await evaluator.execute(call)

        assert success is True
        assert result == {"status": "ok"}


class TestRelevanceEvaluator:
    """Tests for Relevance evaluator."""

    @pytest.fixture
    def evaluator(self) -> RelevanceEvaluator:
        return RelevanceEvaluator()

    def test_relevant_with_calls(self, evaluator: RelevanceEvaluator) -> None:
        """Test relevant query with function calls."""
        calls = [FunctionCall(name="get_weather", arguments={})]
        assert evaluator.evaluate(calls, is_relevant=True) is True

    def test_relevant_without_calls(self, evaluator: RelevanceEvaluator) -> None:
        """Test relevant query without function calls (should fail)."""
        calls: list[FunctionCall] = []
        assert evaluator.evaluate(calls, is_relevant=True) is False

    def test_irrelevant_with_calls(self, evaluator: RelevanceEvaluator) -> None:
        """Test irrelevant query with function calls (should fail)."""
        calls = [FunctionCall(name="get_weather", arguments={})]
        assert evaluator.evaluate(calls, is_relevant=False) is False

    def test_irrelevant_without_calls(self, evaluator: RelevanceEvaluator) -> None:
        """Test irrelevant query without function calls."""
        calls: list[FunctionCall] = []
        assert evaluator.evaluate(calls, is_relevant=False) is True

    def test_decline_detection(self, evaluator: RelevanceEvaluator) -> None:
        """Test decline indicator detection."""
        response = "I cannot help with that as no function is applicable."
        analysis = evaluator.get_decline_analysis(response)
        assert analysis["has_decline"] is True
        assert len(analysis["found_indicators"]) > 0

    def test_evaluate_with_confidence(self, evaluator: RelevanceEvaluator) -> None:
        """Test evaluation with confidence scoring."""
        calls = [FunctionCall(name="func", arguments={})]
        correct, confidence, reasoning = evaluator.evaluate_with_confidence(
            calls,
            is_relevant=True,
        )
        assert correct is True
        assert confidence == 1.0
        assert "Correctly" in reasoning
