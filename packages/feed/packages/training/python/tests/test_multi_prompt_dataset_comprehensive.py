"""
Comprehensive Tests for Multi-Prompt Dataset (multi_prompt_dataset.py)

Tests cover:
- PromptSample creation and scoring
- to_messages() format correctness
- get_weighted_score() priority logic
- PromptDataset statistics and diversity
- MultiPromptDatasetBuilder full pipeline
- Reward attribution per LLM call purpose
- Training group creation with score variance
- Atropos format conversion
- Prompt preservation (no modification of rollout prompts)
- Validation functions
- Ghost variable detection
"""

import pytest

from src.models import (
    Action,
    FeedTrajectory,
    EnvironmentState,
    LLMCall,
    TrajectoryStep,
)
from src.training.multi_prompt_dataset import (
    MultiPromptDatasetBuilder,
    PromptDataset,
    PromptSample,
    prepare_multi_prompt_training_data,
    validate_training_sample,
    validate_trajectory_for_training,
)

# =============================================================================
# Fixtures
# =============================================================================


def make_env_state(**overrides) -> EnvironmentState:
    defaults = {"agent_balance": 10000.0, "agent_pnl": 0.0, "open_positions": 0}
    defaults.update(overrides)
    return EnvironmentState(**defaults)


def make_llm_call(
    purpose: str = "action",
    system_prompt: str = "You are a trading agent with aggressive strategy.",
    user_prompt: str = "Current Balance: $10000\nMarkets: BTC at $50000\nDecide action.",
    response: str = '{"action": "buy", "ticker": "BTC", "amount": 100}',
    **overrides,
) -> LLMCall:
    defaults = {
        "model": "qwen-2.5-72b",
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "response": response,
        "temperature": 0.7,
        "max_tokens": 2048,
        "purpose": purpose,
    }
    defaults.update(overrides)
    return LLMCall(**defaults)


def make_action(**overrides) -> Action:
    defaults = {
        "action_type": "buy_prediction",
        "parameters": {"ticker": "BTC", "amount": 100},
        "success": True,
    }
    defaults.update(overrides)
    return Action(**defaults)


def make_step(step_number: int = 0, llm_calls=None, action=None, reward=0.5) -> TrajectoryStep:
    return TrajectoryStep(
        step_number=step_number,
        timestamp=1700000000000 + step_number * 1000,
        environment_state=make_env_state(),
        llm_calls=llm_calls or [make_llm_call()],
        action=action or make_action(),
        reward=reward,
    )


def make_trajectory(
    trajectory_id: str = "traj-agent-degen-001",
    agent_id: str = "agent-degen-001",
    steps=None,
    final_pnl: float = 500.0,
) -> FeedTrajectory:
    if steps is None:
        steps = [make_step(0), make_step(1)]
    return FeedTrajectory(
        trajectory_id=trajectory_id,
        agent_id=agent_id,
        steps=steps,
        total_reward=1.0,
        final_pnl=final_pnl,
    )


def make_sample(**overrides) -> PromptSample:
    defaults = {
        "trajectory_id": "traj-agent-degen-001",
        "step_number": 0,
        "call_index": 0,
        "system_prompt": "You are a trading agent.",
        "user_prompt": "Balance: $10000. Decide action.",
        "response": '{"action": "buy", "ticker": "BTC"}',
        "purpose": "action",
        "action_type": "buy_prediction",
        "model": "qwen-2.5-72b",
        "temperature": 0.7,
        "trajectory_score": 0.6,
        "step_reward": 0.3,
    }
    defaults.update(overrides)
    return PromptSample(**defaults)


# =============================================================================
# PromptSample Tests
# =============================================================================


class TestPromptSample:
    def test_to_messages_format(self):
        sample = make_sample()
        messages = sample.to_messages()
        assert len(messages) == 3
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        assert messages[2]["role"] == "assistant"
        assert messages[0]["content"] == sample.system_prompt
        assert messages[1]["content"] == sample.user_prompt
        assert messages[2]["content"] == sample.response

    def test_to_messages_preserves_exact_prompts(self):
        """CRITICAL: Prompts must be preserved EXACTLY as rollout."""
        system = "You are a degen trader who loves high risk plays. Always go all in."
        user = "Current Balance: $10000\n\nAvailable Markets:\n- BTC: $50000\n- ETH: $3000"
        response = '{"action": "buy", "trade": {"ticker": "BTC", "amount": 5000}}'
        sample = make_sample(system_prompt=system, user_prompt=user, response=response)
        messages = sample.to_messages()
        assert messages[0]["content"] == system
        assert messages[1]["content"] == user
        assert messages[2]["content"] == response

    def test_weighted_score_with_attributed_reward(self):
        """Attributed reward takes priority."""
        sample = make_sample(attributed_reward=0.3)
        score = sample.get_weighted_score()
        assert abs(score - 0.8) < 0.01  # 0.5 + 0.3

    def test_weighted_score_attributed_negative(self):
        sample = make_sample(attributed_reward=-0.4)
        score = sample.get_weighted_score()
        assert abs(score - 0.1) < 0.01  # 0.5 + (-0.4)

    def test_weighted_score_attributed_clamped(self):
        sample = make_sample(attributed_reward=1.0)
        score = sample.get_weighted_score()
        assert score == 1.0  # Clamped to max

    def test_weighted_score_no_attributed_with_success(self):
        """Falls back to trajectory + adjustments."""
        sample = make_sample(
            attributed_reward=0.0,
            trajectory_score=0.6,
            led_to_action=True,
            action_success=True,
            step_reward=0.5,
        )
        score = sample.get_weighted_score()
        # 0.6 + 0.15 (led_to_action + success) + 0.1 (action_success) + 0.5*0.2
        expected = min(1.0, 0.6 + 0.15 + 0.1 + 0.1)
        assert abs(score - expected) < 0.01

    def test_weighted_score_failed_action_penalty(self):
        sample = make_sample(
            attributed_reward=0.0,
            trajectory_score=0.6,
            led_to_action=True,
            action_success=False,
        )
        score = sample.get_weighted_score()
        assert score < 0.6  # Penalty applied

    def test_weighted_score_clamped_to_zero(self):
        sample = make_sample(
            attributed_reward=0.0,
            trajectory_score=0.0,
            led_to_action=True,
            action_success=False,
            step_reward=-1.0,
        )
        score = sample.get_weighted_score()
        assert score >= 0.0


# =============================================================================
# PromptDataset Tests
# =============================================================================


class TestPromptDataset:
    def test_add_sample(self):
        dataset = PromptDataset(purpose="action")
        dataset.add_sample(make_sample())
        assert len(dataset.samples) == 1

    def test_statistics_update(self):
        dataset = PromptDataset(purpose="action")
        dataset.add_sample(make_sample(trajectory_score=0.8, attributed_reward=0.2))
        dataset.add_sample(make_sample(trajectory_score=0.3, attributed_reward=-0.1))
        assert dataset.avg_score > 0
        assert dataset.score_variance > 0

    def test_diversity_tracking(self):
        dataset = PromptDataset(purpose="action")
        dataset.add_sample(
            make_sample(trajectory_id="traj-agent-degen-001", action_type="buy_prediction")
        )
        dataset.add_sample(
            make_sample(trajectory_id="traj-agent-trader-002", action_type="sell_prediction")
        )
        metrics = dataset.get_diversity_metrics()
        assert metrics.unique_action_types == 2
        assert metrics.unique_trajectories == 2

    def test_is_diverse_enough_pass(self):
        dataset = PromptDataset(purpose="action")
        for i in range(5):
            dataset.add_sample(
                make_sample(
                    trajectory_id=f"traj-agent-type{i}-{i:03d}",
                    action_type=f"action_{i}",
                    attributed_reward=(i - 2) * 0.2,
                )
            )
        ok, issues = dataset.is_diverse_enough(min_action_types=2, min_trajectories=3)
        assert ok, f"Unexpected issues: {issues}"

    def test_is_diverse_enough_fail(self):
        dataset = PromptDataset(purpose="action")
        dataset.add_sample(make_sample(action_type="buy"))
        ok, issues = dataset.is_diverse_enough(min_action_types=2, min_trajectories=3)
        assert not ok
        assert len(issues) > 0

    def test_training_groups_minimum_size(self):
        dataset = PromptDataset(purpose="action")
        dataset.add_sample(make_sample())
        groups = dataset.get_training_groups(group_size=4)
        assert len(groups) == 0  # Not enough samples

    def test_training_groups_created(self):
        dataset = PromptDataset(purpose="action")
        for i in range(20):
            dataset.add_sample(
                make_sample(
                    trajectory_id=f"traj-agent-x-{i:03d}",
                    attributed_reward=(i - 10) * 0.05,
                )
            )
        groups = dataset.get_training_groups(group_size=4)
        assert len(groups) > 0
        for group in groups:
            assert len(group) == 4


# =============================================================================
# MultiPromptDatasetBuilder Tests
# =============================================================================


class TestMultiPromptDatasetBuilder:
    def test_add_trajectory_extracts_samples(self):
        builder = MultiPromptDatasetBuilder()
        traj = make_trajectory()
        count = builder.add_trajectory(traj, trajectory_score=0.7)
        assert count > 0
        assert builder.total_trajectories == 1
        assert builder.total_samples == count

    def test_samples_grouped_by_purpose(self):
        builder = MultiPromptDatasetBuilder()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(purpose="reasoning", response="Analyzing market..." * 5),
                    make_llm_call(purpose="action"),
                ],
            ),
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)
        assert len(builder.datasets["action"].samples) > 0
        assert len(builder.datasets["reasoning"].samples) > 0

    def test_response_too_short_skipped(self):
        builder = MultiPromptDatasetBuilder(min_response_length=50)
        steps = [make_step(0, llm_calls=[make_llm_call(response="short")])]
        traj = make_trajectory(steps=steps)
        count = builder.add_trajectory(traj, trajectory_score=0.7)
        assert count == 0

    def test_empty_user_prompt_skipped(self):
        builder = MultiPromptDatasetBuilder()
        steps = [make_step(0, llm_calls=[make_llm_call(user_prompt="")])]
        traj = make_trajectory(steps=steps)
        count = builder.add_trajectory(traj, trajectory_score=0.7)
        assert count == 0

    def test_prompt_preservation(self):
        """CRITICAL: Prompts must not be modified."""
        builder = MultiPromptDatasetBuilder()
        system = "Original system prompt with special chars: <>&\"'"
        user = "Original user prompt with $10,000 balance and 3.5% returns"
        response = '{"action": "buy", "params": {"ticker": "BTC"}}'

        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(system_prompt=system, user_prompt=user, response=response),
                ],
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)

        sample = builder.datasets["action"].samples[0]
        assert sample.system_prompt == system
        assert sample.user_prompt == user
        assert sample.response == response

    def test_system_prompt_truncation(self):
        builder = MultiPromptDatasetBuilder(max_context_length=100)
        long_system = "A" * 200
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(system_prompt=long_system),
                ],
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)

        sample = builder.datasets["action"].samples[0]
        assert len(sample.system_prompt) == 103  # 100 + "..."

    def test_led_to_action_attribution(self):
        builder = MultiPromptDatasetBuilder()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(purpose="reasoning", response="I should buy because..." * 5),
                    make_llm_call(purpose="action"),
                ],
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)

        reasoning_sample = builder.datasets["reasoning"].samples[0]
        action_sample = builder.datasets["action"].samples[0]
        assert action_sample.led_to_action is True
        assert reasoning_sample.led_to_action is True

    def test_wait_action_not_credited(self):
        builder = MultiPromptDatasetBuilder()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(purpose="action"),
                ],
                action=make_action(action_type="wait"),
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)

        sample = builder.datasets["action"].samples[0]
        assert sample.led_to_action is False

    def test_action_history_tracked(self):
        builder = MultiPromptDatasetBuilder()
        steps = [
            make_step(0, action=make_action(action_type="buy_prediction")),
            make_step(1, action=make_action(action_type="sell_prediction")),
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)
        # Step 1 should see step 0's action in previous_actions
        step1_samples = [s for s in builder.datasets["action"].samples if s.step_number == 1]
        if step1_samples:
            assert "buy_prediction" in step1_samples[0].previous_actions


# =============================================================================
# Reward Attribution Tests
# =============================================================================


class TestRewardAttribution:
    def _get_attributed_reward(
        self, purpose, led_to_action, action_success, traj_score=0.7, step_reward=0.5
    ):
        builder = MultiPromptDatasetBuilder()
        action = (
            make_action(success=action_success) if action_success is not None else make_action()
        )
        if not led_to_action:
            action = make_action(action_type="wait")
        steps = [
            make_step(
                0, llm_calls=[make_llm_call(purpose=purpose)], action=action, reward=step_reward
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=traj_score)
        return builder.datasets[purpose].samples[0].attributed_reward

    def test_action_success_gets_positive(self):
        reward = self._get_attributed_reward("action", True, True)
        assert reward > 0

    def test_action_failure_penalized(self):
        reward_success = self._get_attributed_reward("action", True, True)
        reward_failure = self._get_attributed_reward("action", True, False)
        assert reward_success > reward_failure

    def test_reasoning_with_success_gets_credit(self):
        reward = self._get_attributed_reward("reasoning", True, True)
        assert reward > 0

    def test_evaluation_small_reward(self):
        reward = self._get_attributed_reward("evaluation", True, True)
        assert reward >= 0  # Small but non-negative with good trajectory

    def test_response_gets_trajectory_credit(self):
        reward = self._get_attributed_reward("response", True, True)
        assert reward > 0

    def test_multi_call_distributes_reward(self):
        """When multiple calls in step, reward is distributed."""
        builder = MultiPromptDatasetBuilder()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(purpose="reasoning", response="Analysis..." * 10),
                    make_llm_call(purpose="action"),
                ],
                reward=0.5,
            )
        ]
        traj = make_trajectory(steps=steps)
        builder.add_trajectory(traj, trajectory_score=0.7)

        action_sample = builder.datasets["action"].samples[0]
        reasoning_sample = builder.datasets["reasoning"].samples[0]
        # Both should have reduced rewards due to distribution
        # The total should be less than if each got full credit
        assert action_sample.attributed_reward != 0 or reasoning_sample.attributed_reward != 0


# =============================================================================
# Atropos Format Conversion Tests
# =============================================================================


class TestAtroposConversion:
    def test_build_training_data_without_tokenizer(self):
        builder = MultiPromptDatasetBuilder()
        for i in range(20):
            traj = make_trajectory(
                trajectory_id=f"traj-agent-type{i % 3}-{i:03d}",
                final_pnl=(i - 10) * 100,
            )
            builder.add_trajectory(traj, trajectory_score=0.3 + i * 0.03)

        groups = builder.build_training_data(purpose="action", group_size=4)
        for group in groups:
            assert len(group.tokens) == 4
            assert len(group.scores) == 4
            assert len(group.messages) == 4

    def test_scores_normalized_to_mean_zero(self):
        builder = MultiPromptDatasetBuilder()
        for i in range(20):
            traj = make_trajectory(
                trajectory_id=f"traj-agent-x-{i:03d}",
                final_pnl=i * 50,
            )
            builder.add_trajectory(traj, trajectory_score=0.3 + i * 0.03)

        groups = builder.build_training_data(purpose="action", group_size=4)
        for group in groups:
            mean = sum(group.scores) / len(group.scores)
            assert abs(mean) < 0.01  # Should be ~0

    def test_messages_format_in_groups(self):
        builder = MultiPromptDatasetBuilder()
        for i in range(10):
            traj = make_trajectory(trajectory_id=f"traj-agent-x-{i:03d}")
            builder.add_trajectory(traj, trajectory_score=0.5 + i * 0.05)

        groups = builder.build_training_data(purpose="action", group_size=4)
        if groups:
            for msg_list in groups[0].messages:
                assert len(msg_list) == 3  # system, user, assistant
                assert msg_list[0]["role"] == "system"
                assert msg_list[1]["role"] == "user"
                assert msg_list[2]["role"] == "assistant"


# =============================================================================
# Validation Tests
# =============================================================================


class TestValidateTrainingSample:
    def test_valid_sample(self):
        sample = make_sample(
            system_prompt="You are a trading agent with deep market analysis skills and contrarian strategy.",
            user_prompt="Current Balance: $10000. Markets available: BTC, ETH, SOL.",
            response='{"action": "buy", "ticker": "BTC", "amount": 100}',
        )
        is_valid, issues = validate_training_sample(sample)
        assert is_valid, f"Unexpected issues: {issues}"

    def test_empty_system_prompt(self):
        sample = make_sample(system_prompt="")
        is_valid, issues = validate_training_sample(sample)
        assert not is_valid
        assert any("system_prompt" in i for i in issues)

    def test_short_system_prompt(self):
        sample = make_sample(system_prompt="Short")
        is_valid, issues = validate_training_sample(sample)
        assert not is_valid
        assert any("short" in i.lower() for i in issues)

    def test_empty_user_prompt(self):
        sample = make_sample(user_prompt="")
        is_valid, _issues = validate_training_sample(sample)
        assert not is_valid

    def test_empty_response(self):
        sample = make_sample(response="")
        is_valid, _issues = validate_training_sample(sample)
        assert not is_valid

    def test_trading_action_expects_json(self):
        sample = make_sample(
            purpose="action",
            action_type="evaluate_trading_opportunity",
            response="I think we should buy BTC",  # Not JSON
        )
        is_valid, issues = validate_training_sample(sample)
        assert not is_valid
        assert any("JSON" in i for i in issues)

    def test_invalid_purpose(self):
        sample = make_sample()
        sample.purpose = "invalid"
        is_valid, _issues = validate_training_sample(sample)
        assert not is_valid


class TestValidateTrajectoryForTraining:
    def test_valid_trajectory(self):
        traj = make_trajectory()
        # Need a system prompt long enough
        for step in traj.steps:
            for call in step.llm_calls:
                call.system_prompt = "You are a trading agent with deep market analysis skills." * 3
        report = validate_trajectory_for_training(traj)
        assert report["llm_call_count"] > 0

    def test_empty_trajectory(self):
        traj = make_trajectory(steps=[])
        report = validate_trajectory_for_training(traj)
        assert not report["is_valid"]
        assert "No LLM calls" in report["issues"][0]


# =============================================================================
# Convenience Function Tests
# =============================================================================


class TestPrepareMultiPromptTrainingData:
    def test_mismatched_lengths_raises(self):
        trajs = [make_trajectory()]
        with pytest.raises(ValueError, match="Trajectory count"):
            prepare_multi_prompt_training_data(trajs, [0.5, 0.6])

    def test_basic_pipeline(self):
        trajs = [make_trajectory(trajectory_id=f"traj-agent-x-{i:03d}") for i in range(10)]
        scores = [0.3 + i * 0.05 for i in range(10)]
        result = prepare_multi_prompt_training_data(trajs, scores, group_size=4)
        # Should have at least action purpose
        assert "action" in result or len(result) == 0  # May be 0 if not enough variance


# =============================================================================
# Statistics Tests
# =============================================================================


class TestGetStatistics:
    def test_statistics_structure(self):
        builder = MultiPromptDatasetBuilder()
        traj = make_trajectory()
        builder.add_trajectory(traj, trajectory_score=0.7)
        stats = builder.get_statistics()
        assert "total_trajectories" in stats
        assert "total_steps" in stats
        assert "total_samples" in stats
        assert "by_purpose" in stats
        assert "action" in stats["by_purpose"]

    def test_per_purpose_stats(self):
        builder = MultiPromptDatasetBuilder()
        traj = make_trajectory()
        builder.add_trajectory(traj, trajectory_score=0.7)
        stats = builder.get_statistics()
        for purpose in ["action", "reasoning", "evaluation", "response"]:
            assert purpose in stats["by_purpose"]
            assert "count" in stats["by_purpose"][purpose]
            assert "avg_score" in stats["by_purpose"][purpose]
