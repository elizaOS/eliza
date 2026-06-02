from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from scripts import validate_robot_training_inputs as validator


class _Verbs:
    def __init__(self, variants: list[str]) -> None:
        self._variants = variants

    def all_variants(self) -> list[str]:
        return self._variants


def _task(
    task_id: str,
    *,
    variants: list[str] | None = None,
    requires_target: bool = False,
    init_state: str | None = "stand",
    reward: dict | None = None,
    success: dict | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=task_id,
        tier="base",
        requires_target=requires_target,
        reward=reward or {"target_velocity_x_m_s": 1.0},
        success=success or {"no_fall": True},
        init_state=init_state,
        verbs=_Verbs(variants or [task_id.replace("_", " ")]),
    )


def _patch_lightweight_inputs(monkeypatch, *, tasks: list[SimpleNamespace]) -> None:
    curriculum = SimpleNamespace(
        version="test",
        tasks=tasks,
        all_ids=lambda: [task.id for task in tasks],
    )
    monkeypatch.setattr(validator, "load_curriculum", lambda: curriculum)
    monkeypatch.setattr(validator, "curriculum_content_sha256", lambda _: "abc123")
    monkeypatch.setattr(validator, "list_profiles", lambda: ["unit-test-bot"])
    monkeypatch.setattr(
        validator,
        "_profile_report",
        lambda profile_id, *, launch_tasks: {
            "profile_id": profile_id,
            "ok": True,
            "env_action_dim": 2,
            "env_obs_dim": 34,
            "missing_assets": [],
            "mujoco_compile_ok": True,
        },
    )
    monkeypatch.setattr(
        validator,
        "_dataset_report",
        lambda: {
            "offline_datasets_present": False,
            "offline_dataset_files": [],
            "rl_from_sim_ready": True,
            "imitation_training_ready": False,
            "offline_datasets_block_current_plan": False,
            "trajectory_db_tooling_present": True,
        },
    )


def test_training_inputs_report_accepts_supported_launch_tasks(monkeypatch) -> None:
    _patch_lightweight_inputs(
        monkeypatch,
        tasks=[_task("stand_up"), _task("walk_forward"), _task("future_task", requires_target=True)],
    )

    report = validator.build_report(launch_tasks=("stand_up", "walk_forward"))

    assert report["ok"] is True
    assert report["launch_tasks"] == ["stand_up", "walk_forward"]
    assert report["blockers"] == []
    assert report["curriculum"]["content_sha256"] == "abc123"
    assert report["datasets"]["rl_from_sim_ready"] is True
    assert report["datasets"]["imitation_training_ready"] is False
    assert report["datasets"]["offline_datasets_block_current_plan"] is False
    assert [warning["kind"] for warning in report["warnings"]] == [
        "unsupported_future_curriculum_tasks",
        "no_offline_policy_datasets",
    ]


def test_training_inputs_report_blocks_missing_and_unsupported_launch_tasks(monkeypatch) -> None:
    _patch_lightweight_inputs(
        monkeypatch,
        tasks=[_task("stand_up"), _task("walk_forward", requires_target=True)],
    )

    report = validator.build_report(
        launch_tasks=("stand_up", "walk_forward", "turn_left")
    )

    assert report["ok"] is False
    assert [blocker["kind"] for blocker in report["blockers"]] == [
        "missing_launch_tasks",
        "unsupported_launch_tasks",
    ]


def test_training_inputs_report_accepts_prone_reset_tasks(monkeypatch) -> None:
    _patch_lightweight_inputs(
        monkeypatch,
        tasks=[_task("get_up", init_state="prone")],
    )

    report = validator.build_report(launch_tasks=("get_up",))

    assert report["ok"] is True
    assert report["blockers"] == []
    assert report["tasks"][0]["supported_by_profile_env"] is True


def test_training_inputs_report_accepts_contact_reward_keys(monkeypatch) -> None:
    _patch_lightweight_inputs(
        monkeypatch,
        tasks=[
            _task(
                "walk_forward",
                reward={
                    "target_velocity_x_m_s": 0.1,
                    "height_track_weight": 0.5,
                    "stance_contact_weight": 0.4,
                    "foot_clearance_weight": 0.4,
                    "alternating_contact_weight": 4.0,
                    "locomotion_no_progress_penalty": 5.0,
                    "late_hold_progress_start": 0.95,
                    "goal_hold_progress_start": 1.0,
                    "no_support_weight": 3.0,
                    "double_support_weight": 2.0,
                    "foot_slip_weight": -2.0,
                    "max_foot_slip_margin_weight": 25.0,
                    "foot_spacing_weight": 1.0,
                    "self_collision_weight": 2.0,
                },
            )
        ],
    )

    report = validator.build_report(launch_tasks=("walk_forward",))

    assert report["ok"] is True
    assert report["tasks"][0]["reasons"] == []


def test_training_inputs_report_accepts_staged_foot_contact_success_keys(
    monkeypatch,
) -> None:
    _patch_lightweight_inputs(
        monkeypatch,
        tasks=[
            _task(
                "lift_left_foot",
                reward={"stance_contact_weight": 1.0, "foot_clearance_weight": 1.0},
                success={
                    "torso_z_min_ratio": 0.75,
                    "left_foot_contact_required": False,
                    "right_foot_contact_required": True,
                    "min_swing_foot_clearance_m": 0.01,
                    "no_fall": True,
                },
            )
        ],
    )

    report = validator.build_report(launch_tasks=("lift_left_foot",))

    assert report["ok"] is True
    assert report["tasks"][0]["reasons"] == []


def test_training_inputs_cli_writes_report_and_returns_status(
    monkeypatch, tmp_path: Path
) -> None:
    def fake_build_report(*, launch_tasks):
        return {
            "ok": launch_tasks == ("stand_up",),
            "launch_tasks": list(launch_tasks),
            "blockers": [] if launch_tasks == ("stand_up",) else [{"kind": "bad_task"}],
        }

    monkeypatch.setattr(validator, "build_report", fake_build_report)
    out = tmp_path / "report.json"

    assert validator.main(["--tasks", "stand_up", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["launch_tasks"] == ["stand_up"]
    assert validator.main(["--tasks", "bad_task"]) == 1


def test_hiwonder_launch_resets_have_declared_biped_support() -> None:
    report = validator._profile_report(  # noqa: SLF001
        "hiwonder-ainex",
        launch_tasks=(
            "stand_up",
            "walk_forward",
            "walk_backward",
            "sidestep_left",
            "sidestep_right",
            "turn_left",
            "turn_right",
        ),
    )

    assert report["ok"] is True
    launch_rows = [
        row for row in report["start_state_smoke"] if row["in_launch_tasks"]
    ]
    assert launch_rows
    assert all(row["biped_support"] is True for row in launch_rows)
    assert all(row["left_foot_support"] is True for row in launch_rows)
    assert all(row["right_foot_support"] is True for row in launch_rows)
