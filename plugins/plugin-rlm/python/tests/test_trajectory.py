"""
Tests for trajectory logging and cost tracking.

Paper Section 4.1: "We select several examples of snippets from RLM trajectories
to understand how they solve long context problems"

These tests validate the trajectory capture and cost estimation features
that enable paper-compliant observability.
"""

from __future__ import annotations

import pytest

from elizaos_plugin_rlm.client import (
    RLMClient,
    RLMConfig,
    RLMCost,
    RLMResult,
    RLMTrajectory,
    RLMTrajectoryStep,
    detect_strategy,
    estimate_cost,
    estimate_token_count,
)


class TestCostEstimation:
    """Tests for cost estimation utilities."""

    def test_token_count_estimate(self) -> None:
        """Test token count estimation (4 chars per token)."""
        text = "Hello, world!"  # 13 chars
        tokens = estimate_token_count(text)
        assert tokens == 3  # 13 // 4 = 3

    def test_token_count_empty(self) -> None:
        """Test token count for empty string."""
        assert estimate_token_count("") == 0

    def test_token_count_long(self) -> None:
        """Test token count for longer text."""
        text = "a" * 1000
        assert estimate_token_count(text) == 250

    def test_cost_estimation_openai(self) -> None:
        """Test cost estimation for OpenAI."""
        cost = estimate_cost("openai", "gpt-5", 1_000_000, 500_000)
        # gpt-5: $5/1M input, $15/1M output
        expected = 5.0 + 7.5  # 1M * $5 + 0.5M * $15
        assert abs(cost - expected) < 0.01

    def test_cost_estimation_anthropic(self) -> None:
        """Test cost estimation for Anthropic."""
        cost = estimate_cost("anthropic", "claude-3-sonnet", 1_000_000, 1_000_000)
        # claude-3-sonnet: $3/1M input, $15/1M output
        expected = 3.0 + 15.0
        assert abs(cost - expected) < 0.01

    def test_cost_estimation_unknown_model(self) -> None:
        """Test cost estimation falls back for unknown model."""
        cost = estimate_cost("unknown", "unknown-model", 1_000_000, 1_000_000)
        # Fallback: $0.5/1M input, $1.5/1M output
        expected = 0.5 + 1.5
        assert abs(cost - expected) < 0.01


class TestStrategyDetection:
    """Tests for RLM strategy detection."""

    def test_detect_peek_bracket(self) -> None:
        """Test detection of peeking with bracket notation."""
        assert detect_strategy("prompt[:100]") == "peek"
        assert detect_strategy("text[:-50]") == "peek"
        assert detect_strategy("context[:=end]") == "peek"

    def test_detect_grep_regex(self) -> None:
        """Test detection of grepping with regex."""
        assert detect_strategy("re.search(r'pattern', text)") == "grep"
        assert detect_strategy("re.findall(pattern, data)") == "grep"

    def test_detect_chunk_split(self) -> None:
        """Test detection of chunking."""
        assert detect_strategy("text.split('\\n')") == "chunk"
        assert detect_strategy("data.partition('|')") == "chunk"
        assert detect_strategy("chunk_data(text)") == "chunk"

    def test_detect_stitch_join(self) -> None:
        """Test detection of stitching."""
        assert detect_strategy("'\\n'.join(results)") == "stitch"
        assert detect_strategy("concat(a, b)") == "stitch"
        assert detect_strategy("result += part") == "stitch"

    def test_detect_subcall(self) -> None:
        """Test detection of subcalls."""
        # Note: "chunk" pattern is checked before "subcall", so use strings without it
        assert detect_strategy("rlm(text)") == "subcall"
        assert detect_strategy("completion(messages)") == "subcall"
        assert detect_strategy("subcall_to_model(text)") == "subcall"

    def test_detect_other(self) -> None:
        """Test detection falls back to 'other'."""
        assert detect_strategy("x = 5") == "other"
        assert detect_strategy("print(result)") == "other"


class TestRLMCost:
    """Tests for RLMCost dataclass."""

    def test_cost_initialization(self) -> None:
        """Test cost defaults to zero."""
        cost = RLMCost()
        assert cost.root_input_tokens == 0
        assert cost.root_output_tokens == 0
        assert cost.total_tokens == 0
        assert cost.total_cost_usd == 0.0

    def test_cost_total_tokens(self) -> None:
        """Test total token calculation."""
        cost = RLMCost(
            root_input_tokens=100,
            root_output_tokens=50,
            subcall_input_tokens=200,
            subcall_output_tokens=100,
        )
        assert cost.total_tokens == 450

    def test_cost_total_usd(self) -> None:
        """Test total cost calculation."""
        cost = RLMCost(
            root_cost_usd=0.05,
            subcall_cost_usd=0.03,
        )
        assert abs(cost.total_cost_usd - 0.08) < 0.001

    def test_cost_to_dict(self) -> None:
        """Test cost serialization."""
        cost = RLMCost(
            root_input_tokens=100,
            root_output_tokens=50,
            root_cost_usd=0.01,
        )
        d = cost.to_dict()
        assert d["root_input_tokens"] == 100
        assert d["root_output_tokens"] == 50
        assert d["root_cost_usd"] == 0.01
        assert "total_tokens" in d
        assert "total_cost_usd" in d


class TestRLMTrajectoryStep:
    """Tests for RLMTrajectoryStep dataclass."""

    def test_step_has_unique_id(self) -> None:
        """Test each step gets a unique ID."""
        step1 = RLMTrajectoryStep()
        step2 = RLMTrajectoryStep()
        assert step1.step_id != step2.step_id

    def test_step_timestamp(self) -> None:
        """Test step has timestamp."""
        step = RLMTrajectoryStep()
        assert step.timestamp_ms > 0

    def test_step_to_dict(self) -> None:
        """Test step serialization."""
        step = RLMTrajectoryStep(
            step_number=1,
            code_executed="prompt[:100]",
            repl_output="First 100 chars...",
            strategy="peek",
        )
        d = step.to_dict()
        assert d["step_number"] == 1
        assert d["code_executed"] == "prompt[:100]"
        assert d["strategy"] == "peek"

    def test_step_truncates_output(self) -> None:
        """Test step truncates long output in to_dict."""
        long_output = "x" * 1000
        step = RLMTrajectoryStep(repl_output=long_output)
        d = step.to_dict()
        assert len(d["repl_output"]) == 500  # Truncated


class TestRLMTrajectory:
    """Tests for RLMTrajectory dataclass."""

    def test_trajectory_has_unique_id(self) -> None:
        """Test trajectory gets a unique ID."""
        t1 = RLMTrajectory()
        t2 = RLMTrajectory()
        assert t1.trajectory_id != t2.trajectory_id

    def test_trajectory_add_step(self) -> None:
        """Test adding steps to trajectory."""
        traj = RLMTrajectory()
        step1 = RLMTrajectoryStep(strategy="peek")
        step2 = RLMTrajectoryStep(strategy="grep")

        traj.add_step(step1)
        traj.add_step(step2)

        assert len(traj.steps) == 2
        assert traj.total_iterations == 2
        assert traj.steps[0].step_number == 0
        assert traj.steps[1].step_number == 1

    def test_trajectory_tracks_strategies(self) -> None:
        """Test trajectory tracks unique strategies used."""
        traj = RLMTrajectory()
        traj.add_step(RLMTrajectoryStep(strategy="peek"))
        traj.add_step(RLMTrajectoryStep(strategy="grep"))
        traj.add_step(RLMTrajectoryStep(strategy="peek"))  # Duplicate

        assert len(traj.strategies_used) == 2
        assert "peek" in traj.strategies_used
        assert "grep" in traj.strategies_used

    def test_trajectory_counts_subcalls(self) -> None:
        """Test trajectory counts subcalls."""
        traj = RLMTrajectory()
        traj.add_step(RLMTrajectoryStep(is_subcall=False))
        traj.add_step(RLMTrajectoryStep(is_subcall=True))
        traj.add_step(RLMTrajectoryStep(is_subcall=True))

        assert traj.subcall_count == 2

    def test_trajectory_duration(self) -> None:
        """Test trajectory duration calculation."""
        traj = RLMTrajectory()
        traj.start_time_ms = 1000
        traj.end_time_ms = 5000
        assert traj.duration_ms == 4000

    def test_trajectory_to_dict(self) -> None:
        """Test trajectory serialization."""
        traj = RLMTrajectory(prompt_length=500, prompt_preview="Hello...")
        traj.add_step(RLMTrajectoryStep(strategy="peek"))
        traj.end_time_ms = traj.start_time_ms + 1000
        traj.final_response = "Result"

        d = traj.to_dict()
        assert d["prompt_length"] == 500
        assert d["prompt_preview"] == "Hello..."
        assert len(d["steps"]) == 1
        assert d["final_response"] == "Result"
        assert d["duration_ms"] == 1000


class TestRLMClientTrajectory:
    """Tests for RLMClient trajectory features."""

    def test_client_config_trajectory_enabled(self) -> None:
        """Test client config has trajectory option."""
        config = RLMConfig(log_trajectories=True)
        assert config.log_trajectories is True

    def test_client_config_cost_tracking_enabled(self) -> None:
        """Test client config has cost tracking option."""
        config = RLMConfig(track_costs=True)
        assert config.track_costs is True

    def test_client_collects_trajectories(self) -> None:
        """Test client collects trajectories."""
        config = RLMConfig(log_trajectories=False)  # Don't auto-log
        client = RLMClient(config)
        assert client.trajectories == []

    @pytest.mark.asyncio
    async def test_stub_mode_with_trajectory(self) -> None:
        """Test stub mode still returns result with trajectory capability."""
        config = RLMConfig(log_trajectories=True)
        client = RLMClient(config)

        if client.is_available:
            pytest.skip("RLM is available, cannot test stub mode")

        result = await client.infer("Hello")
        assert result.stub is True
        assert "[RLM STUB]" in result.text

    def test_client_export_trajectories(self) -> None:
        """Test client can export trajectories."""
        client = RLMClient()
        exported = client.export_trajectories()
        assert isinstance(exported, list)

    def test_client_clear_trajectories(self) -> None:
        """Test client can clear trajectories."""
        client = RLMClient()
        client._trajectories.append(RLMTrajectory())
        assert len(client.trajectories) == 1

        client.clear_trajectories()
        assert len(client.trajectories) == 0

    def test_cost_summary_empty(self) -> None:
        """Test cost summary with no trajectories."""
        client = RLMClient()
        summary = client.get_cost_summary()
        assert summary["trajectory_count"] == 0
        assert summary["total_tokens"] == 0
        assert summary["total_cost_usd"] == 0.0

    def test_cost_summary_aggregates(self) -> None:
        """Test cost summary aggregates across trajectories."""
        client = RLMClient()

        traj1 = RLMTrajectory()
        traj1.cost = RLMCost(root_input_tokens=100, root_cost_usd=0.01)
        client._trajectories.append(traj1)

        traj2 = RLMTrajectory()
        traj2.cost = RLMCost(root_input_tokens=200, root_cost_usd=0.02)
        client._trajectories.append(traj2)

        summary = client.get_cost_summary()
        assert summary["trajectory_count"] == 2
        assert summary["root_input_tokens"] == 300
        assert abs(summary["root_cost_usd"] - 0.03) < 0.001


class TestDualModelConfig:
    """Tests for dual-model configuration (Paper Section 3.2)."""

    def test_config_root_model(self) -> None:
        """Test config has root model setting."""
        config = RLMConfig(root_model="gpt-5")
        assert config.root_model == "gpt-5"

    def test_config_subcall_model(self) -> None:
        """Test config has subcall model setting."""
        config = RLMConfig(subcall_model="gpt-5-mini")
        assert config.subcall_model == "gpt-5-mini"

    def test_config_subcall_backend(self) -> None:
        """Test config has subcall backend setting."""
        config = RLMConfig(subcall_backend="anthropic")
        assert config.subcall_backend == "anthropic"

    def test_effective_subcall_backend_fallback(self) -> None:
        """Test effective subcall backend falls back to main backend."""
        config = RLMConfig(backend="openai", subcall_backend="")
        assert config.effective_subcall_backend == "openai"

    def test_effective_subcall_backend_override(self) -> None:
        """Test effective subcall backend uses override."""
        config = RLMConfig(backend="openai", subcall_backend="anthropic")
        assert config.effective_subcall_backend == "anthropic"

    def test_effective_subcall_model_fallback(self) -> None:
        """Test effective subcall model falls back to root model."""
        config = RLMConfig(root_model="gpt-5", subcall_model="")
        assert config.effective_subcall_model == "gpt-5"

    def test_effective_subcall_model_override(self) -> None:
        """Test effective subcall model uses override."""
        config = RLMConfig(root_model="gpt-5", subcall_model="gpt-5-mini")
        assert config.effective_subcall_model == "gpt-5-mini"


class TestRLMResultWithTrajectory:
    """Tests for RLMResult with trajectory and cost."""

    def test_result_has_cost_field(self) -> None:
        """Test result has cost field."""
        result = RLMResult(text="Hello")
        assert result.cost is None

    def test_result_has_trajectory_field(self) -> None:
        """Test result has trajectory field."""
        result = RLMResult(text="Hello")
        assert result.trajectory is None

    def test_result_with_cost(self) -> None:
        """Test result with cost attached."""
        cost = RLMCost(root_input_tokens=100, root_cost_usd=0.01)
        result = RLMResult(text="Hello", cost=cost)
        assert result.cost is not None
        assert result.cost.root_input_tokens == 100

    def test_result_with_trajectory(self) -> None:
        """Test result with trajectory attached."""
        traj = RLMTrajectory(prompt_length=500)
        result = RLMResult(text="Hello", trajectory=traj)
        assert result.trajectory is not None
        assert result.trajectory.prompt_length == 500

    def test_result_to_dict_with_cost_trajectory(self) -> None:
        """Test result serialization includes cost and trajectory."""
        cost = RLMCost(root_input_tokens=100)
        traj = RLMTrajectory()
        result = RLMResult(text="Hello", cost=cost, trajectory=traj)

        d = result.to_dict()
        assert d["cost"] is not None
        assert d["trajectory"] is not None
        assert d["cost"]["root_input_tokens"] == 100


# ============================================================================
# COMPREHENSIVE TEST EXPANSION - Trajectory Edge Cases and Output Verification
# ============================================================================


class TestCostEstimationEdgeCases:
    """Edge cases for cost estimation."""

    def test_token_count_single_char(self) -> None:
        """Test token count for single character."""
        assert estimate_token_count("a") == 0
        assert estimate_token_count("ab") == 0
        assert estimate_token_count("abc") == 0
        assert estimate_token_count("abcd") == 1

    def test_token_count_exact_multiple_of_four(self) -> None:
        """Test token count for strings that are exact multiples of 4."""
        assert estimate_token_count("1234") == 1
        assert estimate_token_count("12345678") == 2
        assert estimate_token_count("123456789012") == 3

    def test_token_count_unicode_characters(self) -> None:
        """Test token count with unicode (may differ from actual tokenization)."""
        # Unicode chars still count as single chars in len()
        unicode_text = "Hello 世界"  # 8 chars including space
        assert estimate_token_count(unicode_text) == 2

    def test_token_count_emojis(self) -> None:
        """Test token count with emojis (note: Python len counts code points)."""
        emoji_text = "🌍🌎🌏"  # 3 emoji code points
        # In Python, each emoji is 1 char (code point), so 3 chars = 0 tokens
        # Note: Actual tokenizers count emojis differently
        assert estimate_token_count(emoji_text) == 0

    def test_cost_with_actual_model_prices(self) -> None:
        """Test cost calculation with actual model prices from MODEL_PRICING."""
        # gpt-5: $2.5/1M input, $10/1M output
        cost = estimate_cost("openai", "gpt-5", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert abs(cost - 12.5) < 0.001

    def test_cost_with_anthropic_models(self) -> None:
        """Test cost calculation for Anthropic models."""
        # claude-3-opus-20240229: $15/1M input, $75/1M output
        cost = estimate_cost("anthropic", "claude-3-opus-20240229", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert abs(cost - 90.0) < 0.001

    def test_cost_with_gemini_models(self) -> None:
        """Test cost calculation for Gemini models."""
        # gemini-2.0-flash: $0.075/1M input, $0.30/1M output
        cost = estimate_cost("gemini", "gemini-2.0-flash", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert abs(cost - 0.375) < 0.001

    def test_cost_with_groq_models(self) -> None:
        """Test cost calculation for Groq models."""
        # llama-3.1-70b-versatile: $0.59/1M input, $0.79/1M output
        cost = estimate_cost("groq", "llama-3.1-70b-versatile", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert abs(cost - 1.38) < 0.001

    def test_cost_free_model(self) -> None:
        """Test cost calculation for free models."""
        # gemini-2.0-flash-exp is free during preview
        cost = estimate_cost("gemini", "gemini-2.0-flash-exp", 1_000_000, 1_000_000, warn_on_fallback=False)
        assert cost == 0.0


class TestStrategyDetectionComprehensive:
    """Comprehensive strategy detection tests."""

    def test_peek_patterns_comprehensive(self) -> None:
        """Test all peek pattern variations."""
        peek_patterns = [
            "prompt[:100]",
            "text[:-50]",
            "context[:=end]",
            "data[-100:]",
            "content[0:500]",
            "PROMPT[:100]",  # Case insensitive
        ]
        for pattern in peek_patterns:
            assert detect_strategy(pattern) == "peek", f"Failed for: {pattern}"

    def test_grep_patterns_comprehensive(self) -> None:
        """Test all grep pattern variations."""
        grep_patterns = [
            "re.search(r'pattern', text)",
            "re.findall(pattern, data)",
            "grep -E 'pattern' file",
            "RE.SEARCH(pattern, text)",  # Case insensitive
        ]
        for pattern in grep_patterns:
            assert detect_strategy(pattern) == "grep", f"Failed for: {pattern}"

    def test_chunk_patterns_comprehensive(self) -> None:
        """Test all chunk pattern variations."""
        chunk_patterns = [
            "text.split('\\n')",
            "data.partition('|')",
            "chunk_data(text)",
            "process_chunk(data)",
            "TEXT.SPLIT()",  # Case insensitive
        ]
        for pattern in chunk_patterns:
            assert detect_strategy(pattern) == "chunk", f"Failed for: {pattern}"

    def test_stitch_patterns_comprehensive(self) -> None:
        """Test all stitch pattern variations."""
        stitch_patterns = [
            "'\\n'.join(results)",
            "concat(a, b)",
            "result += part",
            "concatenate(items)",
            "JOIN(parts)",  # Case insensitive
        ]
        for pattern in stitch_patterns:
            assert detect_strategy(pattern) == "stitch", f"Failed for: {pattern}"

    def test_subcall_patterns_comprehensive(self) -> None:
        """Test all subcall pattern variations."""
        # Note: subcall detection is last, so patterns must not match earlier ones
        subcall_patterns = [
            "rlm(text)",
            "completion(messages)",
            "subcall_to_model(data)",
        ]
        for pattern in subcall_patterns:
            result = detect_strategy(pattern)
            assert result == "subcall", f"Failed for: {pattern}, got: {result}"


class TestTrajectoryStepEdgeCases:
    """Edge cases for RLMTrajectoryStep."""

    def test_step_empty_code(self) -> None:
        """Test step with empty code."""
        step = RLMTrajectoryStep(code_executed="")
        d = step.to_dict()
        assert d["code_executed"] == ""

    def test_step_very_long_output_truncation(self) -> None:
        """Test step truncates very long output to exactly 500 chars."""
        long_output = "x" * 1000
        step = RLMTrajectoryStep(repl_output=long_output)
        d = step.to_dict()
        assert len(d["repl_output"]) == 500
        assert d["repl_output"] == "x" * 500

    def test_step_output_exactly_500_chars(self) -> None:
        """Test step preserves output of exactly 500 chars."""
        exact_output = "y" * 500
        step = RLMTrajectoryStep(repl_output=exact_output)
        d = step.to_dict()
        assert len(d["repl_output"]) == 500

    def test_step_output_under_500_chars(self) -> None:
        """Test step preserves output under 500 chars."""
        short_output = "z" * 100
        step = RLMTrajectoryStep(repl_output=short_output)
        d = step.to_dict()
        assert d["repl_output"] == short_output

    def test_step_unique_ids_are_uuid_format(self) -> None:
        """Test step IDs are valid UUID format."""
        import uuid
        step = RLMTrajectoryStep()
        # Should not raise
        uuid.UUID(step.step_id)


class TestTrajectoryEdgeCases:
    """Edge cases for RLMTrajectory."""

    def test_trajectory_unique_ids_are_uuid_format(self) -> None:
        """Test trajectory IDs are valid UUID format."""
        import uuid
        traj = RLMTrajectory()
        # Should not raise
        uuid.UUID(traj.trajectory_id)

    def test_trajectory_empty_strategies_list(self) -> None:
        """Test trajectory with no strategies used."""
        traj = RLMTrajectory()
        assert traj.strategies_used == []
        d = traj.to_dict()
        assert d["strategies_used"] == []

    def test_trajectory_duplicate_strategies_not_added(self) -> None:
        """Test duplicate strategies aren't added twice."""
        traj = RLMTrajectory()
        traj.add_step(RLMTrajectoryStep(strategy="peek"))
        traj.add_step(RLMTrajectoryStep(strategy="peek"))
        traj.add_step(RLMTrajectoryStep(strategy="peek"))
        
        assert traj.strategies_used == ["peek"]

    def test_trajectory_none_strategy_not_added(self) -> None:
        """Test None strategy isn't added to strategies_used."""
        traj = RLMTrajectory()
        traj.add_step(RLMTrajectoryStep(strategy=None))
        
        assert traj.strategies_used == []

    def test_trajectory_empty_string_strategy_added(self) -> None:
        """Test empty string strategy behavior."""
        traj = RLMTrajectory()
        traj.add_step(RLMTrajectoryStep(strategy=""))
        
        # Empty string is truthy in the "if step.strategy" check... no wait it's falsy
        # So empty string should NOT be added
        assert "" not in traj.strategies_used or traj.strategies_used == []

    def test_trajectory_step_numbering_sequential(self) -> None:
        """Test step numbers are assigned sequentially starting at 0."""
        traj = RLMTrajectory()
        for i in range(5):
            traj.add_step(RLMTrajectoryStep())
        
        for i, step in enumerate(traj.steps):
            assert step.step_number == i

    def test_trajectory_final_response_truncation(self) -> None:
        """Test final response truncation in to_dict."""
        traj = RLMTrajectory()
        traj.final_response = "x" * 1000
        
        d = traj.to_dict()
        assert len(d["final_response"]) == 500

    def test_trajectory_empty_final_response(self) -> None:
        """Test empty final response."""
        traj = RLMTrajectory()
        traj.final_response = ""
        
        d = traj.to_dict()
        assert d["final_response"] == ""


class TestCostDataclassEdgeCases:
    """Edge cases for RLMCost dataclass."""

    def test_cost_all_zeros(self) -> None:
        """Test cost with all zero values."""
        cost = RLMCost()
        assert cost.total_tokens == 0
        assert cost.total_cost_usd == 0.0

    def test_cost_only_root_tokens(self) -> None:
        """Test cost with only root tokens."""
        cost = RLMCost(root_input_tokens=100, root_output_tokens=50)
        assert cost.total_tokens == 150

    def test_cost_only_subcall_tokens(self) -> None:
        """Test cost with only subcall tokens."""
        cost = RLMCost(subcall_input_tokens=200, subcall_output_tokens=100)
        assert cost.total_tokens == 300

    def test_cost_to_dict_preserves_all_fields(self) -> None:
        """Test to_dict preserves all fields."""
        cost = RLMCost(
            root_input_tokens=100,
            root_output_tokens=50,
            subcall_input_tokens=200,
            subcall_output_tokens=100,
            root_cost_usd=0.05,
            subcall_cost_usd=0.03,
        )
        d = cost.to_dict()
        
        assert d["root_input_tokens"] == 100
        assert d["root_output_tokens"] == 50
        assert d["subcall_input_tokens"] == 200
        assert d["subcall_output_tokens"] == 100
        assert d["root_cost_usd"] == 0.05
        assert d["subcall_cost_usd"] == 0.03
        assert d["total_tokens"] == 450
        assert abs(d["total_cost_usd"] - 0.08) < 0.0001


class TestClientTrajectoryEdgeCases:
    """Edge cases for client trajectory methods."""

    def test_export_trajectories_empty(self) -> None:
        """Test exporting empty trajectories list."""
        client = RLMClient()
        exported = client.export_trajectories()
        assert exported == []

    def test_export_trajectories_with_data(self) -> None:
        """Test exporting trajectories with data."""
        client = RLMClient()
        traj = RLMTrajectory(prompt_length=100)
        traj.final_response = "Test response"
        client._trajectories.append(traj)
        
        exported = client.export_trajectories()
        assert len(exported) == 1
        assert exported[0]["prompt_length"] == 100

    def test_clear_trajectories_multiple(self) -> None:
        """Test clearing multiple trajectories."""
        client = RLMClient()
        for _ in range(5):
            client._trajectories.append(RLMTrajectory())
        
        assert len(client.trajectories) == 5
        client.clear_trajectories()
        assert len(client.trajectories) == 0

    def test_cost_summary_single_trajectory(self) -> None:
        """Test cost summary with single trajectory."""
        client = RLMClient()
        traj = RLMTrajectory()
        traj.cost = RLMCost(
            root_input_tokens=100,
            root_output_tokens=50,
            root_cost_usd=0.01,
        )
        client._trajectories.append(traj)
        
        summary = client.get_cost_summary()
        assert summary["trajectory_count"] == 1
        assert summary["root_input_tokens"] == 100
        assert summary["root_output_tokens"] == 50
        assert abs(summary["root_cost_usd"] - 0.01) < 0.0001

    def test_cost_summary_trajectory_without_cost(self) -> None:
        """Test cost summary with trajectory that has no cost attached."""
        client = RLMClient()
        traj = RLMTrajectory()
        traj.cost = None  # No cost attached
        client._trajectories.append(traj)
        
        summary = client.get_cost_summary()
        assert summary["trajectory_count"] == 1
        # Tokens and costs should be 0 since no cost was attached
