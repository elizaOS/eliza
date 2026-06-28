from __future__ import annotations

import json
from pathlib import Path

from scripts import prepare_end_to_end_full_training as prepare
from scripts.plan_nebius_training_relaunch import plan_nebius_training_relaunch

CURRICULUM_EVAL_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "bundle"
    prepare.prepare(
        out_dir=bundle,
        profile_id="asimov-1",
        tasks=CURRICULUM_EVAL_TASKS,
        alberta_steps=100,
        alberta_episode_steps=11,
        alberta_eval_episodes=2,
        backend_compare_steps=20,
        brax_steps=100,
        brax_num_envs=16,
        brax_num_evals=1,
        benchmark_steps_per_task=8,
        benchmark_seeds=1,
        run_multi_readiness=False,
    )
    return bundle


def test_relaunch_plan_blocks_parallel_active_run(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(
        run / "runtime_watch.json",
        {
            "stale": True,
            "hard_cap_exceeded": False,
            "elapsed_hours": 7.0,
            "hours_until_hard_cap": 5.0,
        },
    )
    _write_json(run / "cleanup_plan.json", {"cleanup_allowed": False})

    report = plan_nebius_training_relaunch(
        run_root=run,
        bundle_dir=_bundle(tmp_path),
        current_run_id="robot-full-test",
        current_instance_id="computeinstance-test",
    )

    assert report["ok"] is False
    assert report["recommendation"] == "do_not_launch_parallel_run"
    assert "active_run_still_running_without_parallel_override" in report["blockers"]
    assert "active_run_before_hard_cap_without_override" in report["blockers"]
    assert report["preflight"]["ok"] is True
    assert report["preflight"]["launch_hygiene"]["ok"] is True


def test_relaunch_plan_allows_explicit_parallel_before_hard_cap(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(
        run / "runtime_watch.json",
        {
            "stale": True,
            "hard_cap_exceeded": False,
            "elapsed_hours": 7.0,
            "hours_until_hard_cap": 5.0,
        },
    )

    report = plan_nebius_training_relaunch(
        run_root=run,
        bundle_dir=_bundle(tmp_path),
        allow_parallel=True,
        allow_before_hard_cap=True,
    )

    assert report["ok"] is True
    assert report["recommendation"] == "ready_to_launch_clean_run"
    assert report["blockers"] == []


def test_relaunch_plan_allows_clean_run_after_hard_cap(
    tmp_path: Path,
) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": False, "state": "running"})
    _write_json(
        run / "runtime_watch.json",
        {
            "stale": True,
            "hard_cap_exceeded": True,
            "elapsed_hours": 13.0,
            "hours_until_hard_cap": -1.0,
        },
    )

    report = plan_nebius_training_relaunch(
        run_root=run,
        bundle_dir=_bundle(tmp_path),
        current_instance_id="computeinstance-test",
    )

    assert report["ok"] is True
    assert report["recommendation"] == "ready_to_launch_clean_run"
    assert report["blockers"] == []
    assert "Stop or replace hard-cap-exceeded active instance" in report["next_actions"][0]


def test_relaunch_plan_rejects_unsafe_preflight_template(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write_json(run / "closeout_status.json", {"ok": False, "state": "invalid"})
    _write_json(run / "runtime_watch.json", {"hard_cap_exceeded": True})
    bundle = _bundle(tmp_path)
    template = bundle / "nebius_instance_launch_template.json"
    template.write_text(
        template.read_text(encoding="utf-8").replace(
            "NEBIUS_TRAINING_S3_URI",
            "OLD_RUN_PREFIX",
        ),
        encoding="utf-8",
    )

    report = plan_nebius_training_relaunch(run_root=run, bundle_dir=bundle)

    assert report["ok"] is False
    assert "preflight_bundle_not_ready" in report["blockers"]
    assert "launch_template_hygiene_not_ready" in report["blockers"]
