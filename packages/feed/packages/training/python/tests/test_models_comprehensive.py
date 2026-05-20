"""
Comprehensive Tests for Pydantic Models (models.py)

Tests cover:
- Model instantiation with valid data
- CamelCase alias serialization/deserialization
- Required vs optional fields
- Edge cases (empty lists, zero values, None)
- Field validation and type constraints
- JSON round-trip serialization
- Cross-model relationships
"""

from datetime import datetime

import pytest

from src.models import (
    Action,
    AtroposScoredGroup,
    FeedTrajectory,
    EnvironmentState,
    JudgeResponse,
    JudgeScore,
    LLMCall,
    MarketOutcomes,
    PredictionOutcome,
    ProviderAccess,
    ScamAnalysis,
    StockOutcome,
    TrajectoryGroup,
    TrajectoryStep,
)

# =============================================================================
# Test Fixtures
# =============================================================================


def make_env_state(**overrides) -> EnvironmentState:
    defaults = {
        "agent_balance": 10000.0,
        "agent_pnl": 500.0,
        "open_positions": 3,
        "active_markets": 5,
    }
    defaults.update(overrides)
    return EnvironmentState(**defaults)


def make_llm_call(**overrides) -> LLMCall:
    defaults = {
        "model": "qwen-2.5-72b",
        "system_prompt": "You are a degen trader who loves high risk plays.",
        "user_prompt": "Current Balance: $10000\nAvailable Markets: BTC, ETH",
        "response": '{"action": "buy", "ticker": "BTC", "amount": 100}',
        "temperature": 0.7,
        "max_tokens": 2048,
        "purpose": "action",
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


def make_step(step_number: int = 0, **overrides) -> TrajectoryStep:
    defaults = {
        "step_number": step_number,
        "timestamp": 1700000000000,
        "environment_state": make_env_state(),
        "llm_calls": [make_llm_call()],
        "action": make_action(),
        "reward": 0.5,
    }
    defaults.update(overrides)
    return TrajectoryStep(**defaults)


def make_trajectory(**overrides) -> FeedTrajectory:
    defaults = {
        "trajectory_id": "traj-agent-degen-001",
        "agent_id": "agent-degen-001",
        "steps": [make_step(0), make_step(1)],
        "total_reward": 1.0,
        "final_pnl": 500.0,
    }
    defaults.update(overrides)
    return FeedTrajectory(**defaults)


# =============================================================================
# EnvironmentState Tests
# =============================================================================


class TestEnvironmentState:
    def test_basic_creation(self):
        state = make_env_state()
        assert state.agent_balance == 10000.0
        assert state.agent_pnl == 500.0
        assert state.open_positions == 3
        assert state.active_markets == 5

    def test_camel_case_alias_deserialization(self):
        """Must accept camelCase from JSON (TypeScript side)."""
        data = {
            "agentBalance": 9500.0,
            "agentPnL": -200.0,
            "openPositions": 1,
            "activeMarkets": 3,
        }
        state = EnvironmentState(**data)
        assert state.agent_balance == 9500.0
        assert state.agent_pnl == -200.0
        assert state.open_positions == 1

    def test_pnl_alias_explicit(self):
        """agentPnL uses an explicit alias, not just the generator."""
        state = EnvironmentState(agent_balance=100, agentPnL=-50, open_positions=0)
        assert state.agent_pnl == -50

    def test_json_round_trip(self):
        state = make_env_state()
        json_str = state.model_dump_json(by_alias=True)
        restored = EnvironmentState.model_validate_json(json_str)
        assert restored.agent_balance == state.agent_balance
        assert restored.agent_pnl == state.agent_pnl

    def test_zero_values(self):
        state = EnvironmentState(agent_balance=0.0, agent_pnl=0.0, open_positions=0)
        assert state.agent_balance == 0.0
        assert state.active_markets == 0  # default

    def test_negative_pnl(self):
        state = make_env_state(agent_pnl=-5000.0)
        assert state.agent_pnl == -5000.0

    def test_missing_required_field_raises(self):
        with pytest.raises(Exception):
            EnvironmentState(agent_balance=100.0)  # missing agent_pnl


# =============================================================================
# ScamAnalysis Tests
# =============================================================================


class TestScamAnalysis:
    def test_defaults(self):
        analysis = ScamAnalysis()
        assert analysis.is_scam_suspected is False
        assert analysis.threat_family == "unknown"
        assert analysis.evidence == []
        assert analysis.confidence == 0.0
        assert analysis.grounded is False

    def test_scam_detected(self):
        analysis = ScamAnalysis(
            is_scam_suspected=True,
            threat_family="phishing",
            evidence=["Suspicious link", "Urgent language"],
            risk_signals=["payment_request"],
            confidence=0.95,
        )
        assert analysis.is_scam_suspected is True
        assert len(analysis.evidence) == 2
        assert analysis.confidence == 0.95


# =============================================================================
# LLMCall Tests
# =============================================================================


class TestLLMCall:
    def test_basic_creation(self):
        call = make_llm_call()
        assert call.model == "qwen-2.5-72b"
        assert call.purpose == "action"
        assert "degen trader" in call.system_prompt

    def test_all_valid_purposes(self):
        for purpose in ["action", "reasoning", "evaluation", "response", "other"]:
            call = make_llm_call(purpose=purpose)
            assert call.purpose == purpose

    def test_invalid_purpose_raises(self):
        with pytest.raises(Exception):
            make_llm_call(purpose="invalid_purpose")

    def test_optional_fields_default_none(self):
        call = make_llm_call()
        assert call.model_version is None
        assert call.reasoning is None
        assert call.latency_ms is None
        assert call.prompt_tokens is None
        assert call.metadata is None
        assert call.private_analysis is None

    def test_with_scam_analysis(self):
        analysis = ScamAnalysis(is_scam_suspected=True, threat_family="phishing")
        call = make_llm_call(private_analysis=analysis)
        assert call.private_analysis is not None
        assert call.private_analysis.is_scam_suspected is True

    def test_with_reasoning_trace(self):
        call = make_llm_call(
            reasoning="I should buy BTC because...",
            reasoning_available=True,
            reasoning_source="native",
            trace_visibility="private",
            raw_reasoning_trace="<thinking>buy btc</thinking>",
        )
        assert call.reasoning_available is True
        assert call.trace_visibility == "private"

    def test_empty_prompts_allowed(self):
        """System prompt can be empty (some older trajectories)."""
        call = make_llm_call(system_prompt="", user_prompt="test", response="ok")
        assert call.system_prompt == ""

    def test_camel_case_round_trip(self):
        call = make_llm_call(prompt_tokens=100, completion_tokens=50, latency_ms=200)
        data = call.model_dump(by_alias=True)
        assert "systemPrompt" in data
        assert "userPrompt" in data
        assert "maxTokens" in data
        assert "promptTokens" in data
        restored = LLMCall(**data)
        assert restored.prompt_tokens == 100


# =============================================================================
# Action Tests
# =============================================================================


class TestAction:
    def test_basic_creation(self):
        action = make_action()
        assert action.action_type == "buy_prediction"
        assert action.success is True
        assert action.parameters["ticker"] == "BTC"

    def test_failed_action(self):
        action = make_action(success=False, error="Insufficient balance")
        assert action.success is False
        assert action.error == "Insufficient balance"

    def test_with_reasoning(self):
        action = make_action(
            reasoning="Market is bullish, buying BTC",
            reasoning_available=True,
        )
        assert action.reasoning_available is True

    def test_extra_fields_allowed(self):
        """Action uses extra='allow' config."""
        action = Action(
            action_type="custom_action",
            parameters={"custom": "field"},
            success=True,
            custom_extra_field="extra_value",
        )
        assert action.action_type == "custom_action"


# =============================================================================
# TrajectoryStep Tests
# =============================================================================


class TestTrajectoryStep:
    def test_basic_creation(self):
        step = make_step(0)
        assert step.step_number == 0
        assert step.environment_state.agent_balance == 10000.0
        assert len(step.llm_calls) == 1
        assert step.action is not None
        assert step.reward == 0.5

    def test_step_without_action(self):
        step = make_step(0, action=None)
        assert step.action is None

    def test_step_without_llm_calls(self):
        step = make_step(0, llm_calls=[])
        assert len(step.llm_calls) == 0

    def test_multiple_llm_calls(self):
        calls = [
            make_llm_call(purpose="reasoning"),
            make_llm_call(purpose="action"),
            make_llm_call(purpose="response"),
        ]
        step = make_step(0, llm_calls=calls)
        assert len(step.llm_calls) == 3
        assert step.llm_calls[0].purpose == "reasoning"
        assert step.llm_calls[1].purpose == "action"

    def test_provider_accesses(self):
        access = ProviderAccess(
            provider_name="market_data",
            data={"price": 50000},
            purpose="trading",
        )
        step = make_step(0, provider_accesses=[access])
        assert len(step.provider_accesses) == 1


# =============================================================================
# FeedTrajectory Tests
# =============================================================================


class TestFeedTrajectory:
    def test_basic_creation(self):
        traj = make_trajectory()
        assert traj.trajectory_id == "traj-agent-degen-001"
        assert traj.agent_id == "agent-degen-001"
        assert len(traj.steps) == 2
        assert traj.total_reward == 1.0
        assert traj.final_pnl == 500.0

    def test_default_values(self):
        traj = FeedTrajectory(trajectory_id="t1", agent_id="a1")
        assert traj.id == ""
        assert traj.window_id == "default"
        assert traj.duration_ms == 0
        assert traj.final_pnl == 0.0
        assert traj.final_status == "completed"
        assert traj.trades_executed == 0
        assert traj.steps == []
        assert traj.metadata == {}

    def test_final_pnl_alias(self):
        """finalPnL uses explicit alias."""
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "finalPnL": 1234.56,
        }
        traj = FeedTrajectory(**data)
        assert traj.final_pnl == 1234.56

    def test_not_frozen(self):
        """Trajectory is mutable (frozen=False)."""
        traj = make_trajectory()
        traj.total_reward = 2.0
        assert traj.total_reward == 2.0

    def test_archetype_field(self):
        traj = make_trajectory(archetype="degen")
        assert traj.archetype == "degen"

    def test_json_round_trip(self):
        traj = make_trajectory()
        json_str = traj.model_dump_json(by_alias=True)
        restored = FeedTrajectory.model_validate_json(json_str)
        assert restored.trajectory_id == traj.trajectory_id
        assert restored.final_pnl == traj.final_pnl
        assert len(restored.steps) == len(traj.steps)


# =============================================================================
# Atropos Types Tests
# =============================================================================


class TestAtroposScoredGroup:
    def test_basic_creation(self):
        group = AtroposScoredGroup(
            tokens=[[1, 2, 3], [4, 5, 6]],
            masks=[[1, 1, 1], [1, 1, 1]],
            scores=[0.8, 0.3],
        )
        assert group.group_size == 2

    def test_empty_group(self):
        group = AtroposScoredGroup(tokens=[], masks=[], scores=[])
        assert group.group_size == 0

    def test_with_messages(self):
        group = AtroposScoredGroup(
            tokens=[[1, 2]],
            masks=[[1, 1]],
            scores=[0.5],
            messages=[[{"role": "system", "content": "test"}]],
        )
        assert len(group.messages) == 1


# =============================================================================
# TrajectoryGroup Tests
# =============================================================================


class TestTrajectoryGroup:
    def test_basic_creation(self):
        t1 = make_trajectory(trajectory_id="t1", final_pnl=100.0)
        t2 = make_trajectory(trajectory_id="t2", final_pnl=-50.0)
        group = TrajectoryGroup(
            group_key="window-1",
            window_id="w1",
            trajectories=[t1, t2],
        )
        assert group.size == 2

    def test_pnl_stats(self):
        t1 = make_trajectory(trajectory_id="t1", final_pnl=100.0)
        t2 = make_trajectory(trajectory_id="t2", final_pnl=-50.0)
        t3 = make_trajectory(trajectory_id="t3", final_pnl=200.0)
        group = TrajectoryGroup(group_key="test", window_id="w1", trajectories=[t1, t2, t3])
        stats = group.get_pnl_stats()
        assert stats["min"] == -50.0
        assert stats["max"] == 200.0
        assert abs(stats["mean"] - 83.333) < 0.1

    def test_empty_group_stats(self):
        group = TrajectoryGroup(group_key="test", window_id="w1", trajectories=[])
        stats = group.get_pnl_stats()
        assert stats["min"] == 0
        assert stats["max"] == 0
        assert stats["mean"] == 0


# =============================================================================
# JudgeResponse Tests
# =============================================================================


class TestJudgeResponse:
    def test_get_score_for(self):
        response = JudgeResponse(
            reasoning="Good trading",
            scores=[
                JudgeScore(trajectory_id="t1", score=0.8, explanation="good"),
                JudgeScore(trajectory_id="t2", score=0.3, explanation="bad"),
            ],
        )
        assert response.get_score_for("t1") == 0.8
        assert response.get_score_for("t2") == 0.3
        assert response.get_score_for("t3") is None

    def test_score_bounds(self):
        """Scores must be between 0.0 and 1.0."""
        with pytest.raises(Exception):
            JudgeScore(trajectory_id="t1", score=1.5, explanation="too high")
        with pytest.raises(Exception):
            JudgeScore(trajectory_id="t1", score=-0.1, explanation="too low")


# =============================================================================
# MarketOutcomes Tests
# =============================================================================


class TestMarketOutcomes:
    def test_basic_creation(self):
        outcomes = MarketOutcomes(
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
                ),
            },
            predictions={
                "btc-100k": PredictionOutcome(
                    market_id="btc-100k",
                    question="Will BTC hit 100K?",
                    outcome="UNRESOLVED",
                    final_probability=0.65,
                ),
            },
        )
        assert outcomes.stocks["BTC"].start_price == 50000
        assert outcomes.predictions["btc-100k"].outcome == "UNRESOLVED"
