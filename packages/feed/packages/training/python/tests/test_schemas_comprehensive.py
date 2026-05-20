"""
Comprehensive Tests for Schema Validation (schemas.py)

Tests cover:
- Field name normalization (camelCase <-> snake_case)
- EnvironmentStateSchema construction and validation
- TrustStateSchema construction
- ActionParametersSchema with all field variants
- ActionResultSchema construction
- ActionSchema with reasoning fields
- LLMCallSchema field normalization
- StepSchema composition
- TrajectorySchema from JSON and DB formats
- Step parsing from JSON
- Archetype extraction
- Validation functions (trajectory, step, LLM call)
- Format comparison (JSON vs DB)
- Edge cases (missing fields, invalid JSON, empty data)
"""

import json

from src.training.schemas import (
    ActionParametersSchema,
    EnvironmentStateSchema,
    LLMCallSchema,
    StepSchema,
    TrajectorySchema,
    TrustStateSchema,
    ValidationResult,
    compare_trajectory_formats,
    validate_llm_call,
    validate_step,
    validate_trajectory,
)

# =============================================================================
# EnvironmentStateSchema Tests
# =============================================================================


class TestEnvironmentStateSchema:
    def test_from_camel_case(self):
        data = {
            "agentBalance": 9500.0,
            "agentPnL": -500.0,
            "openPositions": 2,
            "timestamp": 1700000000,
        }
        state = EnvironmentStateSchema.from_dict(data)
        assert state.agent_balance == 9500.0
        assert state.agent_pnl == -500.0
        assert state.open_positions == 2

    def test_from_snake_case(self):
        data = {
            "agent_balance": 9500.0,
            "agent_pnl": -500.0,
            "open_positions": 2,
        }
        state = EnvironmentStateSchema.from_dict(data)
        assert state.agent_balance == 9500.0
        assert state.agent_pnl == -500.0

    def test_defaults(self):
        state = EnvironmentStateSchema.from_dict({})
        assert state.agent_balance == 0.0
        assert state.agent_pnl == 0.0
        assert state.open_positions == 0

    def test_group_chat_fields(self):
        data = {
            "groupChatsActive": 3,
            "groupChatFacts": ["fact1", "fact2"],
            "groupChatIntelTokenEstimate": 500,
        }
        state = EnvironmentStateSchema.from_dict(data)
        assert state.group_chats_active == 3
        assert state.group_chat_facts == ["fact1", "fact2"]
        assert state.group_chat_intel_token_estimate == 500

    def test_working_memory_fields(self):
        data = {
            "workingMemoryFactCount": 5,
            "workingMemoryActiveThesis": "BTC will reach 100K by EOY",
        }
        state = EnvironmentStateSchema.from_dict(data)
        assert state.working_memory_fact_count == 5
        assert state.working_memory_active_thesis == "BTC will reach 100K by EOY"

    def test_context_breakdown(self):
        data = {
            "contextBreakdown": {
                "system": 500,
                "markets": 1000,
                "positions": 200,
                "groupChat": 800,
            },
        }
        state = EnvironmentStateSchema.from_dict(data)
        assert state.context_breakdown["system"] == 500
        assert state.context_breakdown["groupChat"] == 800


# =============================================================================
# TrustStateSchema Tests
# =============================================================================


class TestTrustStateSchema:
    def test_from_camel_case(self):
        data = {
            "trustScore": 0.8,
            "scamRisk": 0.2,
            "scamLossesAvoided": 1500.0,
            "unsafeDisclosures": 0,
        }
        state = TrustStateSchema.from_dict(data)
        assert state.trust_score == 0.8
        assert state.scam_risk == 0.2
        assert state.scam_losses_avoided == 1500.0
        assert state.unsafe_disclosures == 0

    def test_from_snake_case(self):
        data = {"trust_score": 0.9, "scam_risk": 0.1}
        state = TrustStateSchema.from_dict(data)
        assert state.trust_score == 0.9

    def test_defaults(self):
        state = TrustStateSchema.from_dict({})
        assert state.trust_score is None
        assert state.scam_risk is None


# =============================================================================
# ActionParametersSchema Tests
# =============================================================================


class TestActionParametersSchema:
    def test_trading_params(self):
        data = {"ticker": "BTC", "amount": 1000, "leverage": 2.0, "confidence": 0.85}
        params = ActionParametersSchema.from_dict(data)
        assert params.ticker == "BTC"
        assert params.amount == 1000
        assert params.leverage == 2.0
        assert params.confidence == 0.85

    def test_amount_aliases(self):
        """Amount can come from size or quantity fields."""
        for field in ["amount", "size", "quantity"]:
            data = {field: 500}
            params = ActionParametersSchema.from_dict(data)
            assert params.amount == 500

    def test_market_id_aliases(self):
        for field in ["marketId", "market"]:
            data = {field: "btc-100k"}
            params = ActionParametersSchema.from_dict(data)
            assert params.market_id == "btc-100k"

    def test_social_params(self):
        data = {"targetUserId": "user-123", "recipientId": "user-456", "message": "Hello"}
        params = ActionParametersSchema.from_dict(data)
        assert params.target_user_id == "user-123"
        assert params.message == "Hello"


# =============================================================================
# LLMCallSchema Tests
# =============================================================================


class TestLLMCallSchema:
    def test_from_camel_case(self):
        data = {
            "model": "qwen-2.5-72b",
            "purpose": "action",
            "systemPrompt": "You are a trader.",
            "userPrompt": "Balance: $10000",
            "response": '{"action": "buy"}',
            "temperature": 0.7,
            "maxTokens": 2048,
        }
        call = LLMCallSchema.from_dict(data)
        assert call.model == "qwen-2.5-72b"
        assert call.system_prompt == "You are a trader."
        assert call.user_prompt == "Balance: $10000"
        assert call.max_tokens == 2048

    def test_from_snake_case(self):
        data = {
            "model": "test",
            "system_prompt": "sys",
            "user_prompt": "usr",
            "max_tokens": 1024,
        }
        call = LLMCallSchema.from_dict(data)
        assert call.system_prompt == "sys"
        assert call.max_tokens == 1024

    def test_reasoning_fields(self):
        data = {
            "model": "test",
            "reasoningAvailable": True,
            "reasoningSource": "native",
            "traceVisibility": "private",
            "rawReasoningTrace": "<thinking>buy btc</thinking>",
        }
        call = LLMCallSchema.from_dict(data)
        assert call.reasoning_available is True
        assert call.reasoning_source == "native"
        assert call.trace_visibility == "private"
        assert call.raw_reasoning_trace == "<thinking>buy btc</thinking>"

    def test_defaults(self):
        call = LLMCallSchema.from_dict({"model": "test"})
        assert call.purpose == "action"
        assert call.temperature == 0.7
        assert call.max_tokens == 1000
        assert call.reasoning_available is False

    def test_missing_model_defaults_unknown(self):
        call = LLMCallSchema.from_dict({})
        assert call.model == "unknown"


# =============================================================================
# StepSchema Tests
# =============================================================================


class TestStepSchema:
    def test_from_camel_case(self):
        data = {
            "stepNumber": 3,
            "timestamp": 1700000000,
            "environmentState": {"agentBalance": 10000, "agentPnL": 0},
            "action": {"actionType": "buy_prediction", "parameters": {"ticker": "BTC"}},
            "llmCalls": [{"model": "qwen", "systemPrompt": "test", "response": "ok"}],
            "reward": 0.5,
        }
        step = StepSchema.from_dict(data)
        assert step.step_number == 3
        assert step.environment_state.agent_balance == 10000
        assert step.action.action_type == "buy_prediction"
        assert len(step.llm_calls) == 1
        assert step.llm_calls[0].model == "qwen"
        assert step.reward == 0.5

    def test_from_snake_case(self):
        data = {
            "step_number": 5,
            "environment_state": {"agent_balance": 8000},
            "action": {"action_type": "sell"},
            "llm_calls": [],
        }
        step = StepSchema.from_dict(data)
        assert step.step_number == 5
        assert step.environment_state.agent_balance == 8000

    def test_trust_state(self):
        data = {
            "stepNumber": 0,
            "trustState": {"trustScore": 0.8, "scamRisk": 0.1},
        }
        step = StepSchema.from_dict(data)
        assert step.trust_state.trust_score == 0.8


# =============================================================================
# TrajectorySchema Tests
# =============================================================================


class TestTrajectorySchema:
    def test_from_camel_case(self):
        data = {
            "trajectoryId": "traj-001",
            "agentId": "agent-001",
            "windowId": "window-1",
            "finalPnL": 500.0,
            "episodeLength": 10,
            "stepsJson": json.dumps(
                [
                    {
                        "stepNumber": 0,
                        "action": {"actionType": "buy"},
                        "environmentState": {"agentBalance": 10000},
                    },
                ]
            ),
        }
        traj = TrajectorySchema.from_dict(data)
        assert traj.trajectory_id == "traj-001"
        assert traj.final_pnl == 500.0
        assert traj.episode_length == 10

    def test_from_snake_case(self):
        data = {
            "trajectory_id": "traj-002",
            "agent_id": "agent-002",
            "window_id": "window-2",
            "final_pnl": -200.0,
        }
        traj = TrajectorySchema.from_dict(data)
        assert traj.trajectory_id == "traj-002"
        assert traj.final_pnl == -200.0

    def test_get_steps(self):
        steps_data = [
            {
                "stepNumber": 0,
                "action": {"actionType": "buy"},
                "environmentState": {"agentBalance": 10000},
            },
            {
                "stepNumber": 1,
                "action": {"actionType": "sell"},
                "environmentState": {"agentBalance": 10500},
            },
        ]
        traj = TrajectorySchema.from_dict(
            {
                "trajectoryId": "t1",
                "agentId": "a1",
                "windowId": "w1",
                "stepsJson": json.dumps(steps_data),
            }
        )
        steps = traj.get_steps()
        assert len(steps) == 2
        assert steps[0].action.action_type == "buy"
        assert steps[1].action.action_type == "sell"

    def test_get_steps_invalid_json(self):
        traj = TrajectorySchema.from_dict(
            {
                "trajectoryId": "t1",
                "agentId": "a1",
                "windowId": "w1",
                "stepsJson": "not valid json",
            }
        )
        steps = traj.get_steps()
        assert steps == []

    def test_extract_archetype_from_trajectory(self):
        traj = TrajectorySchema.from_dict(
            {
                "trajectoryId": "t1",
                "agentId": "a1",
                "windowId": "w1",
                "archetype": "degen",
            }
        )
        assert traj.extract_archetype_from_steps() == "degen"

    def test_extract_archetype_from_step_params(self):
        steps_data = [
            {
                "stepNumber": 0,
                "action": {"actionType": "buy", "parameters": {"archetype": "trader"}},
                "environmentState": {},
            },
        ]
        traj = TrajectorySchema.from_dict(
            {
                "trajectoryId": "t1",
                "agentId": "a1",
                "windowId": "w1",
                "stepsJson": json.dumps(steps_data),
            }
        )
        assert traj.extract_archetype_from_steps() == "trader"

    def test_extract_archetype_from_result(self):
        steps_data = [
            {
                "stepNumber": 0,
                "action": {"actionType": "buy", "result": {"archetype": "researcher"}},
                "environmentState": {},
            },
        ]
        traj = TrajectorySchema.from_dict(
            {
                "trajectoryId": "t1",
                "agentId": "a1",
                "windowId": "w1",
                "stepsJson": json.dumps(steps_data),
            }
        )
        assert traj.extract_archetype_from_steps() == "researcher"

    def test_metrics_json_extraction(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "metricsJson": json.dumps({"finalTrustScore": 0.85}),
        }
        traj = TrajectorySchema.from_dict(data)
        assert traj.final_trust_score == 0.85

    def test_metadata_json_extraction(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "metadataJson": json.dumps({"scenarioProfile": "trust_mixed"}),
        }
        traj = TrajectorySchema.from_dict(data)
        assert traj.scenario_profile == "trust_mixed"


# =============================================================================
# Validation Function Tests
# =============================================================================


class TestValidateTrajectory:
    def test_valid_trajectory(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "stepsJson": json.dumps(
                [
                    {
                        "stepNumber": 0,
                        "action": {"actionType": "buy"},
                        "environmentState": {"agentBalance": 10000},
                    },
                ]
            ),
            "finalPnL": 500.0,
            "episodeLength": 1,
        }
        is_valid, errors = validate_trajectory(data)
        assert is_valid, f"Unexpected errors: {errors}"

    def test_missing_required_fields(self):
        is_valid, errors = validate_trajectory({})
        assert not is_valid
        assert len(errors) >= 3  # trajectoryId, agentId, windowId

    def test_invalid_steps_json(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "stepsJson": "not json",
        }
        is_valid, errors = validate_trajectory(data)
        assert not is_valid
        assert any("JSON" in e for e in errors)

    def test_empty_steps(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "stepsJson": "[]",
        }
        is_valid, errors = validate_trajectory(data)
        assert not is_valid
        assert any("empty" in e for e in errors)

    def test_step_missing_action(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "stepsJson": json.dumps([{"stepNumber": 0, "environmentState": {}}]),
        }
        is_valid, _errors = validate_trajectory(data)
        assert not is_valid

    def test_step_missing_environment_state(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "stepsJson": json.dumps([{"stepNumber": 0, "action": {"actionType": "buy"}}]),
        }
        is_valid, _errors = validate_trajectory(data)
        assert not is_valid

    def test_invalid_pnl_type(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "finalPnL": "not a number",
        }
        is_valid, _errors = validate_trajectory(data)
        assert not is_valid

    def test_negative_episode_length(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "episodeLength": -5,
        }
        is_valid, _errors = validate_trajectory(data)
        assert not is_valid


class TestValidateStep:
    def test_valid_step(self):
        data = {
            "stepNumber": 0,
            "action": {"actionType": "buy"},
            "environmentState": {"agentBalance": 10000},
        }
        is_valid, _errors = validate_step(data)
        assert is_valid

    def test_missing_step_number(self):
        data = {"action": {"actionType": "buy"}, "environmentState": {}}
        is_valid, _errors = validate_step(data)
        assert not is_valid

    def test_missing_action(self):
        data = {"stepNumber": 0, "environmentState": {}}
        is_valid, _errors = validate_step(data)
        assert not is_valid


class TestValidateLLMCall:
    def test_valid_call(self):
        data = {"model": "qwen-2.5-72b", "response": "test"}
        is_valid, _errors = validate_llm_call(data)
        assert is_valid

    def test_missing_model(self):
        data = {"response": "test"}
        is_valid, _errors = validate_llm_call(data)
        assert not is_valid


# =============================================================================
# Format Comparison Tests
# =============================================================================


class TestCompareTrajectoryFormats:
    def test_identical_data(self):
        data = {
            "trajectoryId": "t1",
            "agentId": "a1",
            "windowId": "w1",
            "finalPnL": 500.0,
        }
        are_same, _diffs = compare_trajectory_formats(data, data)
        assert are_same

    def test_numeric_close_enough(self):
        json_data = {"trajectoryId": "t1", "agentId": "a1", "windowId": "w1", "finalPnL": 500.001}
        db_data = {"trajectoryId": "t1", "agentId": "a1", "windowId": "w1", "finalPnL": 500.0}
        are_same, _diffs = compare_trajectory_formats(json_data, db_data)
        assert are_same

    def test_different_values(self):
        json_data = {"trajectoryId": "t1", "agentId": "a1", "windowId": "w1", "finalPnL": 500.0}
        db_data = {"trajectoryId": "t1", "agentId": "a1", "windowId": "w1", "finalPnL": 600.0}
        are_same, diffs = compare_trajectory_formats(json_data, db_data)
        assert not are_same
        assert len(diffs) == 1


# =============================================================================
# ValidationResult Tests
# =============================================================================


class TestValidationResult:
    def test_valid_result_is_truthy(self):
        result = ValidationResult(is_valid=True, errors=[])
        assert bool(result) is True

    def test_invalid_result_is_falsy(self):
        result = ValidationResult(is_valid=False, errors=["something wrong"])
        assert bool(result) is False
