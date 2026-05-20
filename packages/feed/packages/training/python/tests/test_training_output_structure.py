"""
Tests for Training Output Structure Verification

These tests ensure that the training data pipeline preserves the EXACT
structure of original LLM calls. This is critical because:

1. Training must see identical prompts as inference
2. Distribution shift from modified prompts hurts model performance
3. Input/output pairs must match the original context exactly

Tests verify:
- system_prompt preservation
- user_prompt preservation
- response preservation
- Message order (system → user → assistant)
- No content modification or truncation (unless too long)
- Multi-prompt extraction preserves ALL calls
"""

import sys
from datetime import datetime

import pytest

sys.path.insert(0, ".")

from src.data_bridge.converter import BabylonToAtroposConverter
from src.models import (
    Action,
    BabylonTrajectory,
    EnvironmentState,
    LLMCall,
    TrajectoryStep,
)
from src.training import MultiPromptDatasetBuilder

# ============================================================
# Test Fixtures
# ============================================================


@pytest.fixture
def exact_llm_calls():
    """
    Create LLM calls with EXACT content we want to preserve.
    These have specific formatting that must not be modified.
    """
    return [
        LLMCall(
            model="qwen3-32b",
            system_prompt="You are TRADER-001, a professional crypto trader.\nYour strategy: Buy low, sell high.\nRisk tolerance: Medium.",
            user_prompt="=== MARKET UPDATE ===\nTick: 42\nBTC: $65,000 (+2.3%)\nETH: $3,200 (-0.5%)\n\nYour balance: $10,000\nPositions: BTC long 0.1\n\n=== TASK ===\nAnalyze the market and decide your next action.",
            response="<thinking>\nBTC showing strong momentum at $65,000.\nETH slightly down but within normal range.\nMy BTC position is profitable.\n</thinking>\n\nI will hold my current BTC position and wait for ETH to stabilize before considering entry.",
            reasoning="Market analysis complete",
            temperature=0.7,
            max_tokens=1024,
            purpose="reasoning",
        ),
        LLMCall(
            model="qwen3-32b",
            system_prompt="You are TRADER-001. Execute trades based on your analysis.",
            user_prompt='Previous analysis:\n<thinking>\nBTC showing strong momentum...\n</thinking>\n\nDecide your action. Respond with JSON:\n{"action": "buy|sell|hold", "asset": "BTC|ETH", "amount": number}',
            response='{"action": "hold", "asset": "BTC", "amount": 0, "reasoning": "Maintaining current profitable position"}',
            temperature=0.3,
            max_tokens=512,
            purpose="action",
        ),
        LLMCall(
            model="qwen3-32b",
            system_prompt="Evaluate your trading decisions.",
            user_prompt="You chose to hold BTC.\nCurrent P&L: +$230\nMarket trend: Bullish\n\nRate your decision confidence (0-1):",
            response='{"confidence": 0.85, "risk_assessment": "low", "notes": "Good decision to hold during uptrend"}',
            temperature=0.2,
            max_tokens=256,
            purpose="evaluation",
        ),
    ]


@pytest.fixture
def trajectory_with_exact_calls(exact_llm_calls):
    """Create a trajectory with exact LLM calls to verify preservation."""
    steps = []
    for i, llm_call in enumerate(exact_llm_calls):
        step = TrajectoryStep(
            step_number=i,
            timestamp=int(datetime.now().timestamp() * 1000) + i * 1000,
            environment_state=EnvironmentState(
                agent_balance=10000.0 + i * 100,
                agent_pnl=i * 100.0,
                open_positions=1,
            ),
            llm_calls=[llm_call],
            action=Action(
                action_type="hold" if i < 2 else "evaluate",
                parameters={"asset": "BTC"},
                success=True,
            ),
            reward=0.5,
        )
        steps.append(step)

    return BabylonTrajectory(
        trajectory_id="test-exact-trajectory",
        agent_id="TRADER-001",
        window_id="test-window",
        steps=steps,
        final_pnl=300.0,
        trades_executed=0,
        episode_length=3,
    )


@pytest.fixture
def multi_call_step():
    """Create a step with multiple LLM calls (reasoning + action)."""
    reasoning_call = LLMCall(
        model="qwen3-32b",
        system_prompt="Analyze market conditions.",
        user_prompt="Current price: $100\nTrend: Up\n\nAnalyze:",
        response="Market is bullish. RSI at 65 suggests continued uptrend. Volume increasing.",
        purpose="reasoning",
        temperature=0.7,
        max_tokens=512,
    )
    action_call = LLMCall(
        model="qwen3-32b",
        system_prompt="Execute trading decision.",
        user_prompt="Based on analysis: 'Market is bullish...'\n\nDecide action:",
        response='{"action": "buy", "size": 0.5}',
        purpose="action",
        temperature=0.3,
        max_tokens=256,
    )
    return TrajectoryStep(
        step_number=0,
        timestamp=1000000,
        environment_state=EnvironmentState(
            agent_balance=10000.0,
            agent_pnl=0.0,
            open_positions=0,
        ),
        llm_calls=[reasoning_call, action_call],
        action=Action(action_type="buy", parameters={"size": 0.5}, success=True),
        reward=1.0,
    )


# ============================================================
# Test: Exact Prompt Preservation
# ============================================================


class TestExactPromptPreservation:
    """Verify that training samples preserve exact prompts."""

    def test_system_prompt_preserved_exactly(self, trajectory_with_exact_calls, exact_llm_calls):
        """System prompt must be preserved character-for-character."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        # Get all samples
        all_samples = []
        for dataset in builder.datasets.values():
            all_samples.extend(dataset.samples)

        # Verify each original LLM call has a corresponding sample with exact system_prompt
        for original_call in exact_llm_calls:
            matching_sample = next(
                (s for s in all_samples if s.system_prompt == original_call.system_prompt),
                None,
            )
            assert matching_sample is not None, (
                f"No sample found with exact system_prompt:\n"
                f"Expected: {original_call.system_prompt[:100]}..."
            )
            assert matching_sample.system_prompt == original_call.system_prompt

    def test_user_prompt_preserved_exactly(self, trajectory_with_exact_calls, exact_llm_calls):
        """User prompt must be preserved character-for-character."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        all_samples = []
        for dataset in builder.datasets.values():
            all_samples.extend(dataset.samples)

        for original_call in exact_llm_calls:
            matching_sample = next(
                (s for s in all_samples if s.user_prompt == original_call.user_prompt),
                None,
            )
            assert matching_sample is not None, (
                f"No sample found with exact user_prompt:\n"
                f"Expected: {original_call.user_prompt[:100]}..."
            )
            assert matching_sample.user_prompt == original_call.user_prompt

    def test_response_preserved_exactly(self, trajectory_with_exact_calls, exact_llm_calls):
        """Response must be preserved character-for-character."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        all_samples = []
        for dataset in builder.datasets.values():
            all_samples.extend(dataset.samples)

        for original_call in exact_llm_calls:
            matching_sample = next(
                (s for s in all_samples if s.response == original_call.response),
                None,
            )
            assert matching_sample is not None, (
                f"No sample found with exact response:\nExpected: {original_call.response[:100]}..."
            )
            assert matching_sample.response == original_call.response

    def test_newlines_and_formatting_preserved(self, trajectory_with_exact_calls):
        """Newlines, indentation, and special formatting must be preserved."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        # Get reasoning samples (they have the most complex formatting)
        reasoning_samples = builder.datasets["reasoning"].samples

        assert len(reasoning_samples) > 0, "Should have reasoning samples"

        # Check that multi-line content is preserved
        sample = reasoning_samples[0]

        # The original has multiple newlines in system_prompt
        assert "\n" in sample.system_prompt, "Newlines should be preserved in system_prompt"

        # The response has <thinking> tags with newlines
        assert "<thinking>" in sample.response, "XML-style tags should be preserved"
        assert "</thinking>" in sample.response, "Closing tags should be preserved"


# ============================================================
# Test: Message Structure
# ============================================================


class TestMessageStructure:
    """Verify correct message structure for training."""

    def test_to_messages_returns_correct_order(self, trajectory_with_exact_calls):
        """Messages must be in order: system, user, assistant."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        for purpose, dataset in builder.datasets.items():
            for sample in dataset.samples:
                messages = sample.to_messages()

                assert len(messages) == 3, f"Should have 3 messages, got {len(messages)}"
                assert messages[0]["role"] == "system", "First message should be system"
                assert messages[1]["role"] == "user", "Second message should be user"
                assert messages[2]["role"] == "assistant", "Third message should be assistant"

    def test_to_messages_content_matches_fields(self, trajectory_with_exact_calls):
        """Message content must match sample fields exactly."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        for purpose, dataset in builder.datasets.items():
            for sample in dataset.samples:
                messages = sample.to_messages()

                assert messages[0]["content"] == sample.system_prompt
                assert messages[1]["content"] == sample.user_prompt
                assert messages[2]["content"] == sample.response

    def test_no_empty_messages(self, trajectory_with_exact_calls):
        """No message should be empty."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        for purpose, dataset in builder.datasets.items():
            for sample in dataset.samples:
                messages = sample.to_messages()

                for msg in messages:
                    assert msg["content"], f"Empty content in {msg['role']} message"
                    assert len(msg["content"]) >= 1, f"Content too short in {msg['role']}"


# ============================================================
# Test: Multi-Prompt Extraction
# ============================================================


class TestMultiPromptExtraction:
    """Verify all LLM calls from a step are extracted."""

    def test_all_calls_in_step_extracted(self, multi_call_step):
        """All LLM calls in a step should become separate samples."""
        trajectory = BabylonTrajectory(
            trajectory_id="test-multi",
            agent_id="agent-1",
            steps=[multi_call_step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder()
        samples_added = builder.add_trajectory(trajectory, trajectory_score=0.8)

        # Should have 2 samples (reasoning + action)
        assert samples_added == 2, f"Expected 2 samples, got {samples_added}"

        # Verify we have one of each purpose
        reasoning_count = len(builder.datasets["reasoning"].samples)
        action_count = len(builder.datasets["action"].samples)

        assert reasoning_count == 1, f"Expected 1 reasoning sample, got {reasoning_count}"
        assert action_count == 1, f"Expected 1 action sample, got {action_count}"

    def test_call_order_preserved(self, multi_call_step):
        """Calls should be indexed in order they appear in step."""
        trajectory = BabylonTrajectory(
            trajectory_id="test-order",
            agent_id="agent-1",
            steps=[multi_call_step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory, trajectory_score=0.8)

        # Get all samples and sort by call_index
        all_samples = []
        for dataset in builder.datasets.values():
            all_samples.extend(dataset.samples)

        sorted_samples = sorted(all_samples, key=lambda s: s.call_index)

        # First call (index 0) should be reasoning
        assert sorted_samples[0].purpose == "reasoning"
        # Second call (index 1) should be action
        assert sorted_samples[1].purpose == "action"

    def test_each_call_gets_unique_index(self, multi_call_step):
        """Each LLM call should have a unique call_index within the step."""
        trajectory = BabylonTrajectory(
            trajectory_id="test-index",
            agent_id="agent-1",
            steps=[multi_call_step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory, trajectory_score=0.8)

        all_samples = []
        for dataset in builder.datasets.values():
            all_samples.extend(dataset.samples)

        # Filter to same step
        step_samples = [s for s in all_samples if s.step_number == 0]
        call_indices = [s.call_index for s in step_samples]

        # Should have unique indices
        assert len(call_indices) == len(set(call_indices)), (
            f"Call indices should be unique: {call_indices}"
        )


# ============================================================
# Test: Converter Structure
# ============================================================


class TestConverterStructure:
    """Verify converter produces correct message structure."""

    def test_converter_includes_all_llm_calls(self, trajectory_with_exact_calls):
        """Converter should include all LLM calls, not just the first."""
        converter = BabylonToAtroposConverter()
        result = converter.convert_trajectory(trajectory_with_exact_calls)

        # Count assistant messages (each LLM call produces one)
        assistant_count = sum(1 for m in result.messages if m.role == "assistant")

        # Should have one assistant message per LLM call
        expected_calls = sum(len(step.llm_calls) for step in trajectory_with_exact_calls.steps)
        assert assistant_count == expected_calls, (
            f"Expected {expected_calls} assistant messages, got {assistant_count}"
        )

    def test_converter_message_content_matches_calls(
        self, trajectory_with_exact_calls, exact_llm_calls
    ):
        """Converter messages should match original LLM call content."""
        converter = BabylonToAtroposConverter()
        result = converter.convert_trajectory(trajectory_with_exact_calls)

        # Get all assistant messages
        assistant_messages = [m for m in result.messages if m.role == "assistant"]

        # Each should match an original response
        original_responses = [call.response for call in exact_llm_calls]

        for msg in assistant_messages:
            assert msg.content in original_responses, (
                f"Converter output doesn't match any original response:\n"
                f"Got: {msg.content[:100]}..."
            )

    def test_converter_preserves_user_prompts(self, trajectory_with_exact_calls, exact_llm_calls):
        """Converter should preserve user prompts exactly."""
        converter = BabylonToAtroposConverter()
        result = converter.convert_trajectory(trajectory_with_exact_calls)

        # Get user messages (skip system message at index 0)
        user_messages = [m for m in result.messages if m.role == "user"]

        # Each should match an original user_prompt
        original_prompts = [call.user_prompt for call in exact_llm_calls]

        for msg in user_messages:
            assert msg.content in original_prompts, (
                f"Converter user prompt doesn't match original:\nGot: {msg.content[:100]}..."
            )


# ============================================================
# Test: Purpose-Specific Extraction
# ============================================================


class TestPurposeExtraction:
    """Verify samples are correctly categorized by purpose."""

    def test_reasoning_samples_in_reasoning_dataset(self, trajectory_with_exact_calls):
        """Reasoning calls should go to reasoning dataset."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        reasoning_samples = builder.datasets["reasoning"].samples

        for sample in reasoning_samples:
            assert sample.purpose == "reasoning", (
                f"Sample in reasoning dataset has wrong purpose: {sample.purpose}"
            )

    def test_action_samples_in_action_dataset(self, trajectory_with_exact_calls):
        """Action calls should go to action dataset."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        action_samples = builder.datasets["action"].samples

        for sample in action_samples:
            assert sample.purpose == "action", (
                f"Sample in action dataset has wrong purpose: {sample.purpose}"
            )

    def test_evaluation_samples_in_evaluation_dataset(self, trajectory_with_exact_calls):
        """Evaluation calls should go to evaluation dataset."""
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        eval_samples = builder.datasets["evaluation"].samples

        for sample in eval_samples:
            assert sample.purpose == "evaluation", (
                f"Sample in evaluation dataset has wrong purpose: {sample.purpose}"
            )


# ============================================================
# Test: Edge Cases
# ============================================================


class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_empty_system_prompt_allowed(self):
        """Empty system prompt should be allowed (will be empty string)."""
        llm_call = LLMCall(
            model="qwen3-32b",
            system_prompt="",  # Empty!
            user_prompt="What is 2+2?",
            response="The answer is 4. This is basic arithmetic.",  # Must be > 10 chars
            purpose="action",
            temperature=0.7,
            max_tokens=100,
        )
        step = TrajectoryStep(
            step_number=0,
            timestamp=1000000,
            environment_state=EnvironmentState(
                agent_balance=10000.0, agent_pnl=0.0, open_positions=0
            ),
            llm_calls=[llm_call],
            action=Action(action_type="answer", parameters={}, success=True),
            reward=1.0,
        )
        trajectory = BabylonTrajectory(
            trajectory_id="test-empty-system",
            agent_id="agent-1",
            steps=[step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder()
        samples = builder.add_trajectory(trajectory, trajectory_score=0.8)

        assert samples == 1, "Should add sample even with empty system prompt"

        sample = builder.datasets["action"].samples[0]
        assert sample.system_prompt == "", "Empty system prompt should be preserved as empty"

    def test_short_response_filtered(self):
        """Responses shorter than min_response_length should be filtered."""
        llm_call = LLMCall(
            model="qwen3-32b",
            system_prompt="You are a helper.",
            user_prompt="What?",
            response="OK",  # Too short (< 10 chars default)
            purpose="action",
            temperature=0.7,
            max_tokens=100,
        )
        step = TrajectoryStep(
            step_number=0,
            timestamp=1000000,
            environment_state=EnvironmentState(
                agent_balance=10000.0, agent_pnl=0.0, open_positions=0
            ),
            llm_calls=[llm_call],
            action=Action(action_type="ok", parameters={}, success=True),
            reward=1.0,
        )
        trajectory = BabylonTrajectory(
            trajectory_id="test-short",
            agent_id="agent-1",
            steps=[step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder(min_response_length=10)
        samples = builder.add_trajectory(trajectory, trajectory_score=0.8)

        assert samples == 0, "Short response should be filtered"

    def test_special_characters_preserved(self):
        """Special characters, unicode, and JSON should be preserved."""
        llm_call = LLMCall(
            model="qwen3-32b",
            system_prompt='Special chars: "quotes", <tags>, & ampersand, émojis: 🚀💰',
            user_prompt='JSON: {"key": "value", "nested": {"a": 1}}',
            response="Unicode: ñ, ü, 日本語, العربية\nNewlines\tand\ttabs",
            purpose="action",
            temperature=0.7,
            max_tokens=100,
        )
        step = TrajectoryStep(
            step_number=0,
            timestamp=1000000,
            environment_state=EnvironmentState(
                agent_balance=10000.0, agent_pnl=0.0, open_positions=0
            ),
            llm_calls=[llm_call],
            action=Action(action_type="test", parameters={}, success=True),
            reward=1.0,
        )
        trajectory = BabylonTrajectory(
            trajectory_id="test-special",
            agent_id="agent-1",
            steps=[step],
            episode_length=1,
        )

        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory, trajectory_score=0.8)

        sample = builder.datasets["action"].samples[0]

        # Verify special characters preserved
        assert "🚀" in sample.system_prompt, "Emoji should be preserved"
        assert '"key"' in sample.user_prompt, "JSON quotes should be preserved"
        assert "日本語" in sample.response, "Japanese should be preserved"
        assert "\t" in sample.response, "Tabs should be preserved"


# ============================================================
# Test: Consistency Between Systems
# ============================================================


class TestSystemConsistency:
    """Verify consistency between MultiPromptDatasetBuilder and Converter."""

    def test_both_systems_extract_same_responses(self, trajectory_with_exact_calls):
        """Both extraction systems should produce the same responses."""
        # Extract with MultiPromptDatasetBuilder
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        builder_responses = set()
        for dataset in builder.datasets.values():
            for sample in dataset.samples:
                builder_responses.add(sample.response)

        # Extract with Converter
        converter = BabylonToAtroposConverter()
        result = converter.convert_trajectory(trajectory_with_exact_calls)

        converter_responses = set()
        for msg in result.messages:
            if msg.role == "assistant":
                converter_responses.add(msg.content)

        # Should have the same responses
        assert builder_responses == converter_responses, (
            f"Responses differ between systems:\n"
            f"Builder only: {builder_responses - converter_responses}\n"
            f"Converter only: {converter_responses - builder_responses}"
        )

    def test_both_systems_extract_same_user_prompts(self, trajectory_with_exact_calls):
        """Both systems should preserve the same user prompts."""
        # Extract with MultiPromptDatasetBuilder
        builder = MultiPromptDatasetBuilder()
        builder.add_trajectory(trajectory_with_exact_calls, trajectory_score=0.8)

        builder_prompts = set()
        for dataset in builder.datasets.values():
            for sample in dataset.samples:
                builder_prompts.add(sample.user_prompt)

        # Extract with Converter
        converter = BabylonToAtroposConverter()
        result = converter.convert_trajectory(trajectory_with_exact_calls)

        converter_prompts = set()
        for msg in result.messages:
            if msg.role == "user":
                converter_prompts.add(msg.content)

        # Should have the same prompts
        assert builder_prompts == converter_prompts, (
            f"User prompts differ between systems:\n"
            f"Builder only: {builder_prompts - converter_prompts}\n"
            f"Converter only: {converter_prompts - builder_prompts}"
        )
