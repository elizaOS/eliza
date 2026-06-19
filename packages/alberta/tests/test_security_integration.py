"""Tests for security-gym / rlsecd integration contracts."""

import pytest

from alberta_framework import (
    N_SECURITY_ACTIONS,
    SECURITY_ACTION_NAMES,
    SECURITY_GYM_ACTION_NAMES,
    SecurityAction,
    SecurityFeatureSchema,
    SecurityRewardWeights,
    SecurityRolloutStep,
    ThroughputMeter,
    coerce_security_action,
    security_gym_action_name,
    security_gym_action_reward,
    security_reward,
    to_security_gym_action,
    validate_security_rollout,
)


def test_security_action_indices_are_stable() -> None:
    assert N_SECURITY_ACTIONS == 6
    assert SECURITY_ACTION_NAMES == (
        "pass",
        "alert",
        "throttle",
        "block",
        "unblock",
        "isolate",
    )
    assert [int(action) for action in SecurityAction] == list(range(6))
    assert coerce_security_action("block") == SecurityAction.BLOCK
    assert coerce_security_action("block_source") == SecurityAction.BLOCK
    assert coerce_security_action(5) == SecurityAction.ISOLATE


def test_security_gym_action_adapter_matches_sibling_contract() -> None:
    assert SECURITY_GYM_ACTION_NAMES == (
        "pass",
        "alert",
        "throttle",
        "block_source",
        "unblock",
        "isolate",
    )
    assert security_gym_action_name(SecurityAction.BLOCK) == "block_source"
    assert to_security_gym_action("block_source", risk_score=11.0) == {
        "action": 3,
        "risk_score": (10.0,),
    }
    assert security_gym_action_reward(SecurityAction.BLOCK, is_malicious=True) == pytest.approx(
        1.0
    )
    assert security_gym_action_reward(SecurityAction.BLOCK, is_malicious=False) == pytest.approx(
        -1.0
    )


def test_security_reward_uses_named_components() -> None:
    weights = SecurityRewardWeights(
        threat_blocked=2.0,
        false_positive=-1.0,
        service_disruption=-0.25,
        alert_cost=-0.1,
        latency_cost=0.0,
        compromise_cost=-3.0,
        recovery=0.5,
    )
    reward = security_reward(
        {
            "threat_blocked": 1.0,
            "false_positive": 0.0,
            "alert_cost": 1.0,
            "unknown_diagnostic": 100.0,
        },
        weights,
    )
    assert reward == pytest.approx(1.9)


def test_feature_schema_roundtrip_and_validation() -> None:
    schema = SecurityFeatureSchema(names=("src_reputation", "dst_port_risk"))
    assert schema.feature_dim == 2
    schema.validate_observation((0.1, 0.2))

    restored = SecurityFeatureSchema.from_dict(schema.to_dict())
    assert restored == schema

    with pytest.raises(ValueError, match="observation length"):
        schema.validate_observation((0.1,))


def test_rollout_step_roundtrip_and_validation() -> None:
    schema = SecurityFeatureSchema(names=("x0", "x1"))
    step = SecurityRolloutStep(
        state=(0.0, 1.0),
        action=SecurityAction.THROTTLE,
        reward=-0.2,
        next_state=(0.5, 1.0),
        terminated=False,
        policy_metadata={"epsilon": 0.05, "q_values": [0.0, 0.1, 0.2, 0.0, 0.0, 0.0]},
    )

    restored = SecurityRolloutStep.from_dict(step.to_dict())
    assert restored == step
    validate_security_rollout([restored], schema)

    invalid = SecurityRolloutStep(
        state=(0.0,),
        action=SecurityAction.PASS,
        reward=0.0,
        next_state=(0.0, 1.0),
        terminated=False,
    )
    with pytest.raises(ValueError, match="invalid rollout step 0"):
        validate_security_rollout([invalid], schema)


def test_throughput_meter_records_events() -> None:
    meter = ThroughputMeter()
    meter.tick(3)
    measurement = meter.measure()

    assert measurement.n_events == 3
    assert measurement.elapsed_s >= 0.0
    assert measurement.events_per_second > 0.0
    assert measurement.to_dict()["n_events"] == 3
