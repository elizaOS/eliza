"""
Comprehensive Tests for Babylon to Atropos Converter (data_bridge/converter.py)

Tests cover:
- AtroposMessage and AtroposTrajectory creation
- BabylonToAtroposConverter initialization and validation
- Trajectory conversion with quality scoring
- System message building with market outcomes
- Dropout rate calculation
- Window group conversion
- Score calculation integration
- Message assembly from LLM calls and fallback
- Minimum message requirement
"""

from datetime import datetime

import pytest

from src.data_bridge.converter import (
    AtroposMessage,
    AtroposTrajectory,
    BabylonToAtroposConverter,
    ScoredGroupResult,
    calculate_dropout_rate,
)
from src.models import (
    Action,
    BabylonTrajectory,
    EnvironmentState,
    LLMCall,
    MarketOutcomes,
    StockOutcome,
    TrajectoryStep,
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
    user_prompt: str = "Balance: $10000. Decide.",
    response: str = '{"action": "buy", "ticker": "BTC"}',
    system_prompt: str = "You are a trader.",
    **kw,
) -> LLMCall:
    return LLMCall(
        model="test",
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        response=response,
        temperature=0.7,
        max_tokens=2048,
        purpose=purpose,
        **kw,
    )


def make_action(**overrides) -> Action:
    defaults = {"action_type": "buy_prediction", "parameters": {"ticker": "BTC"}, "success": True}
    defaults.update(overrides)
    return Action(**defaults)


def make_step(step_number: int = 0, llm_calls=None, action=None, **kw) -> TrajectoryStep:
    return TrajectoryStep(
        step_number=step_number,
        timestamp=1700000000000,
        environment_state=make_env_state(**kw.get("env", {})),
        llm_calls=llm_calls or [make_llm_call()],
        action=action or make_action(),
        reward=kw.get("reward", 0.5),
    )


def make_trajectory(steps=None, **overrides) -> BabylonTrajectory:
    defaults = {
        "trajectory_id": "traj-001",
        "agent_id": "agent-001",
        "steps": steps or [make_step(0), make_step(1)],
        "final_pnl": 500.0,
    }
    defaults.update(overrides)
    return BabylonTrajectory(**defaults)


def make_market_outcomes() -> MarketOutcomes:
    return MarketOutcomes(
        window_id="w1",
        window_start=datetime(2024, 1, 1),
        window_end=datetime(2024, 1, 2),
        stocks={
            "BTC": StockOutcome(
                ticker="BTC",
                start_price=50000,
                end_price=55000,
                change_percent=10.0,
                sentiment="BULLISH",
                news_events=["Bitcoin hits new ATH"],
            ),
        },
    )


# =============================================================================
# AtroposMessage Tests
# =============================================================================


class TestAtroposMessage:
    def test_to_dict(self):
        msg = AtroposMessage(role="system", content="Hello")
        d = msg.to_dict()
        assert d == {"role": "system", "content": "Hello"}


class TestAtroposTrajectory:
    def test_to_messages_list(self):
        traj = AtroposTrajectory(
            messages=[
                AtroposMessage(role="system", content="sys"),
                AtroposMessage(role="user", content="usr"),
                AtroposMessage(role="assistant", content="ast"),
            ]
        )
        msgs = traj.to_messages_list()
        assert len(msgs) == 3
        assert msgs[0]["role"] == "system"


class TestScoredGroupResult:
    def test_group_size(self):
        result = ScoredGroupResult(
            tokens=[[1, 2], [3, 4]],
            masks=[[1, 1], [1, 1]],
            scores=[0.5, 0.7],
        )
        assert result.group_size == 2

    def test_to_pydantic(self):
        result = ScoredGroupResult(
            tokens=[[1, 2]],
            masks=[[1, 1]],
            scores=[0.5],
            messages=[[{"role": "system", "content": "test"}]],
        )
        pydantic = result.to_pydantic()
        assert pydantic.group_size == 1
        assert pydantic.scores == [0.5]


# =============================================================================
# Converter Initialization Tests
# =============================================================================


class TestConverterInit:
    def test_default_init(self):
        converter = BabylonToAtroposConverter()
        assert converter.dropout_rate == 0.0
        assert converter.max_steps == 20
        assert converter.include_messages is True

    def test_valid_dropout(self):
        converter = BabylonToAtroposConverter(dropout_rate=0.3)
        assert converter.dropout_rate == 0.3

    def test_invalid_dropout_too_high(self):
        with pytest.raises(ValueError, match="dropout_rate"):
            BabylonToAtroposConverter(dropout_rate=0.6)

    def test_invalid_dropout_negative(self):
        with pytest.raises(ValueError, match="dropout_rate"):
            BabylonToAtroposConverter(dropout_rate=-0.1)


# =============================================================================
# Trajectory Conversion Tests
# =============================================================================


class TestConvertTrajectory:
    def test_basic_conversion(self):
        converter = BabylonToAtroposConverter()
        traj = make_trajectory()
        result = converter.convert_trajectory(traj)
        assert result is not None
        assert len(result.messages) >= 3  # system + at least user + assistant
        assert result.messages[0].role == "system"

    def test_system_message_contains_agent_info(self):
        converter = BabylonToAtroposConverter()
        traj = make_trajectory(agent_id="agent-degen-42", window_id="window-7")
        result = converter.convert_trajectory(traj)
        assert "agent-degen-42" in result.messages[0].content
        assert "window-7" in result.messages[0].content

    def test_system_message_with_market_outcomes(self):
        converter = BabylonToAtroposConverter()
        outcomes = make_market_outcomes()
        traj = make_trajectory()
        result = converter.convert_trajectory(traj, market_outcomes=outcomes)
        system = result.messages[0].content
        assert "BTC" in system
        assert "50000" in system or "50,000" in system
        assert "BULLISH" in system

    def test_llm_calls_become_messages(self):
        converter = BabylonToAtroposConverter()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(user_prompt="Question 1", response="Answer 1"),
                    make_llm_call(user_prompt="Question 2", response="Answer 2"),
                ],
            )
        ]
        traj = make_trajectory(steps=steps)
        result = converter.convert_trajectory(traj)
        # System + 2*(user+assistant) = 5
        assert len(result.messages) == 5

    def test_fallback_without_llm_calls(self):
        """Steps without LLM calls use environment state fallback."""
        converter = BabylonToAtroposConverter()
        step = TrajectoryStep(
            step_number=0,
            timestamp=1700000000000,
            environment_state=make_env_state(agent_balance=8500, agent_pnl=-1500),
            llm_calls=[],
            action=make_action(),
        )
        traj = make_trajectory(steps=[step])
        result = converter.convert_trajectory(traj)
        # Should have fallback user message with balance
        user_msgs = [m for m in result.messages if m.role == "user"]
        assert any("8500" in m.content for m in user_msgs)

    def test_max_steps_truncation(self):
        converter = BabylonToAtroposConverter(max_steps=3)
        steps = [make_step(i) for i in range(10)]
        traj = make_trajectory(steps=steps)
        result = converter.convert_trajectory(traj)
        # Should only include last 3 steps + system message
        user_msgs = [m for m in result.messages if m.role == "user"]
        assert len(user_msgs) <= 3

    def test_score_calculated(self):
        converter = BabylonToAtroposConverter()
        traj = make_trajectory(final_pnl=500.0)
        result = converter.convert_trajectory(traj)
        assert isinstance(result.score, float)

    def test_metadata_populated(self):
        converter = BabylonToAtroposConverter()
        traj = make_trajectory(
            trajectory_id="traj-test",
            agent_id="agent-test",
            window_id="win-test",
            final_pnl=123.45,
        )
        result = converter.convert_trajectory(traj)
        assert result.metadata["trajectory_id"] == "traj-test"
        assert result.metadata["agent_id"] == "agent-test"
        assert result.metadata["final_pnl"] == 123.45

    def test_insufficient_messages_raises(self):
        converter = BabylonToAtroposConverter()
        # Step with empty LLM calls and no action
        step = TrajectoryStep(
            step_number=0,
            timestamp=0,
            environment_state=make_env_state(),
            llm_calls=[make_llm_call(user_prompt="", response="")],
        )
        traj = make_trajectory(steps=[step])
        with pytest.raises(ValueError, match="messages"):
            converter.convert_trajectory(traj)

    def test_dropout_can_return_none(self):
        converter = BabylonToAtroposConverter(dropout_rate=0.5)
        traj = make_trajectory()
        # Run multiple times - some should be None
        results = [converter.convert_trajectory(traj) for _ in range(100)]
        assert any(r is None for r in results)
        assert any(r is not None for r in results)

    def test_empty_llm_call_skipped(self):
        converter = BabylonToAtroposConverter()
        steps = [
            make_step(
                0,
                llm_calls=[
                    make_llm_call(user_prompt="", response=""),
                    make_llm_call(user_prompt="Valid question", response="Valid answer"),
                ],
            )
        ]
        traj = make_trajectory(steps=steps)
        result = converter.convert_trajectory(traj)
        user_msgs = [m for m in result.messages if m.role == "user"]
        assert len(user_msgs) == 1  # Only the valid one


# =============================================================================
# Window Group Conversion Tests
# =============================================================================


class TestConvertWindowGroup:
    def test_basic_group(self):
        converter = BabylonToAtroposConverter()
        trajs = [make_trajectory(trajectory_id=f"t{i}") for i in range(4)]
        result = converter.convert_window_group(trajs, None)
        assert result.group_size >= 2
        assert len(result.scores) == result.group_size

    def test_too_few_trajectories(self):
        converter = BabylonToAtroposConverter()
        with pytest.raises(ValueError, match="2\\+ trajectories"):
            converter.convert_window_group([make_trajectory()], None)

    def test_sampling_when_too_many(self):
        converter = BabylonToAtroposConverter()
        trajs = [make_trajectory(trajectory_id=f"t{i}") for i in range(20)]
        result = converter.convert_window_group(trajs, None, max_per_group=5)
        assert result.group_size <= 5

    def test_messages_included(self):
        converter = BabylonToAtroposConverter(include_messages=True)
        trajs = [make_trajectory(trajectory_id=f"t{i}") for i in range(3)]
        result = converter.convert_window_group(trajs, None)
        assert len(result.messages) == result.group_size

    def test_messages_excluded(self):
        converter = BabylonToAtroposConverter(include_messages=False)
        trajs = [make_trajectory(trajectory_id=f"t{i}") for i in range(3)]
        result = converter.convert_window_group(trajs, None)
        assert result.messages == []


# =============================================================================
# Dropout Rate Calculation Tests
# =============================================================================


class TestCalculateDropoutRate:
    def test_no_dropout_needed(self):
        assert calculate_dropout_rate(10, 20) == 0.0
        assert calculate_dropout_rate(10, 10) == 0.0

    def test_basic_dropout(self):
        rate = calculate_dropout_rate(100, 50)
        # 1 - 50/100 = 0.5, but capped at max_dropout=0.3
        assert rate == 0.3

    def test_capped_at_max(self):
        rate = calculate_dropout_rate(1000, 10)
        assert rate <= 0.3

    def test_custom_max(self):
        rate = calculate_dropout_rate(1000, 10, max_dropout=0.5)
        assert rate <= 0.5

    def test_exact_calculation(self):
        rate = calculate_dropout_rate(100, 80)
        assert abs(rate - 0.2) < 0.01


# =============================================================================
# Quality Scoring Integration Tests
# =============================================================================


class TestQualityScoringIntegration:
    def test_good_xml_improves_score(self):
        converter = BabylonToAtroposConverter()
        good_step = make_step(
            0,
            llm_calls=[
                make_llm_call(
                    response='<decisions><decision ticker="BTC" amount="100">buy</decision></decisions>',
                ),
            ],
        )
        bad_step = make_step(
            0,
            llm_calls=[
                make_llm_call(response="just text no xml"),
            ],
        )
        good_traj = make_trajectory(steps=[good_step], final_pnl=500)
        bad_traj = make_trajectory(steps=[bad_step], final_pnl=500)

        good_result = converter.convert_trajectory(good_traj)
        bad_result = converter.convert_trajectory(bad_traj)
        # Good format should contribute to higher score
        assert good_result.metadata["format_score"] > bad_result.metadata["format_score"]

    def test_risk_penalty_tracked(self):
        converter = BabylonToAtroposConverter()
        # High exposure step
        step = make_step(
            0,
            llm_calls=[make_llm_call()],
            action=make_action(action_type="buy"),
            env={"open_positions": 15},  # High exposure
        )
        traj = make_trajectory(steps=[step])
        result = converter.convert_trajectory(traj)
        assert "risk_penalties" in result.metadata


# =============================================================================
# Balance Calculation Tests
# =============================================================================


class TestBalanceCalculation:
    def test_balance_from_steps(self):
        converter = BabylonToAtroposConverter()
        steps = [
            make_step(0, env={"agent_balance": 10000}),
            make_step(1, env={"agent_balance": 10500}),
        ]
        traj = make_trajectory(steps=steps, final_pnl=500)
        result = converter.convert_trajectory(traj)
        # Score should reflect proper balance tracking
        assert result.score is not None

    def test_balance_fallback_to_trajectory(self):
        converter = BabylonToAtroposConverter()
        traj = make_trajectory(steps=[make_step(0)])
        traj.final_balance = 10500.0
        result = converter.convert_trajectory(traj)
        assert result.score is not None
