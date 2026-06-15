from __future__ import annotations

import pytest

from eliza_robot.rl.alberta.train_robot import (
    _bounded_step_walk_final_residual_gate_passed,
    _effective_locomotion_prior_residual_scale,
    _starts_final_bounded_walk_with_zero_residual,
    _uses_staged_biped_prior,
)


@pytest.mark.parametrize(
    "task_id",
    (
        "weight_shift_left",
        "weight_shift_right",
        "lift_left_foot",
        "lift_right_foot",
        "step_in_place",
        "step_forward",
    ),
)
def test_staged_biped_prereqs_have_zero_effective_residual_scale(
    task_id: str,
) -> None:
    assert _uses_staged_biped_prior(task_id, "hiwonder_staged_biped") is True
    assert (
        _effective_locomotion_prior_residual_scale(
            task_id=task_id,
            staged_biped_action_prior="hiwonder_staged_biped",
            current_scale=0.25,
        )
        == pytest.approx(0.0)
    )


def test_walk_phase_keeps_configured_locomotion_residual_scale() -> None:
    assert _uses_staged_biped_prior("walk_forward", "hiwonder_staged_biped") is False
    assert (
        _effective_locomotion_prior_residual_scale(
            task_id="walk_forward",
            staged_biped_action_prior="hiwonder_staged_biped",
            locomotion_action_prior="hiwonder_bounded_step_walk",
            current_scale=0.25,
        )
        == pytest.approx(0.25)
    )


def test_bounded_bridge_phase_has_zero_effective_residual_scale() -> None:
    for task_id in ("walk_forward_bridge", "walk_forward_mid_bridge"):
        assert _uses_staged_biped_prior(task_id, "hiwonder_staged_biped") is False
        assert (
            _effective_locomotion_prior_residual_scale(
                task_id=task_id,
                staged_biped_action_prior="hiwonder_staged_biped",
                locomotion_action_prior="hiwonder_bounded_step_walk",
                current_scale=0.25,
            )
            == pytest.approx(0.0)
        )


def test_final_bounded_walk_starts_with_zero_residual_warmup() -> None:
    assert (
        _starts_final_bounded_walk_with_zero_residual(
            task_id="walk_forward",
            locomotion_action_prior="hiwonder_bounded_step_walk",
        )
        is True
    )
    assert (
        _starts_final_bounded_walk_with_zero_residual(
            task_id="walk_forward",
            locomotion_action_prior="hiwonder_sine",
        )
        is False
    )
    assert (
        _starts_final_bounded_walk_with_zero_residual(
            task_id="walk_forward_mid_bridge",
            locomotion_action_prior="hiwonder_bounded_step_walk",
        )
        is False
    )


def _walk_promotion_eval(
    *,
    max_dx: float,
    failure_rate: float = 0.0,
    physical_fall_rate: float = 0.0,
    support_contract_failure_rate: float = 0.0,
) -> dict:
    return {
        "failure_rate": failure_rate,
        "physical_fall_rate": physical_fall_rate,
        "support_contract_failure_rate": support_contract_failure_rate,
        "movement_summary": {
            "tracked_delta_x_m": {
                "min": 0.0,
                "max": max_dx,
                "mean": max_dx,
                "final": max_dx,
            },
        },
        "physical_checks": {
            "tracked_height_present": True,
            "no_fall": physical_fall_rate <= 0.0,
            "tracked_lateral_drift_bound": True,
            "yaw_drift_bound": True,
            "min_alternating_foot_contacts": True,
            "min_swing_foot_clearance_m": True,
            "max_foot_slip_m_s": True,
            "max_self_collision_count": True,
        },
    }


def test_bounded_final_walk_residual_gate_rejects_near_target_fall() -> None:
    assert (
        _bounded_step_walk_final_residual_gate_passed(
            _walk_promotion_eval(
                max_dx=0.27,
                failure_rate=1.0,
                physical_fall_rate=1.0,
            ),
            task_id="walk_forward",
        )
        is False
    )


def test_bounded_final_walk_residual_gate_allows_stable_near_target_prior() -> None:
    assert (
        _bounded_step_walk_final_residual_gate_passed(
            _walk_promotion_eval(max_dx=0.27),
            task_id="walk_forward",
        )
        is True
    )
