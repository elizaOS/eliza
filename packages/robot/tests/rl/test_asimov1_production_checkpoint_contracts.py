from __future__ import annotations

from scripts.validate_asimov1_production_checkpoint import (
    _metric_rewards_finite,
    _metric_steps,
    _observation_delay_contract,
)


def test_asimov1_production_checkpoint_helpers_reject_boolean_rewards() -> None:
    assert _metric_rewards_finite([{"steps": 10, "reward": 1.0}]) is True
    assert _metric_rewards_finite([{"steps": 10, "reward": True}]) is False


def test_asimov1_production_checkpoint_helpers_reject_boolean_delay_steps() -> None:
    assert _observation_delay_contract({"left_leg": 1, "right_leg": 2}) is True
    assert _observation_delay_contract({"left_leg": True, "right_leg": 2}) is False


def test_asimov1_production_checkpoint_helper_ignores_boolean_metric_steps() -> None:
    assert _metric_steps([{"steps": True}, {"steps": 7}]) == 7

