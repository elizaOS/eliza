"""Smoke the continual-benchmark harness (Alberta arm) end to end.

Runs a tiny sequential benchmark and checks the performance matrix + metrics are
well-formed and that retention is non-trivial. Kept small (2 tasks, short
phases) to stay CPU-cheap; the full multi-seed Alberta-vs-PPO comparison is run
out-of-band via ``python -m eliza_robot.rl.alberta.benchmark``.
"""

from __future__ import annotations

import json
import os

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import numpy as np

from eliza_robot.rl.alberta.baselines import AlbertaSequentialLearner
from eliza_robot.rl.alberta.benchmark import (
    BenchmarkConfig,
    _alberta_controller_config,
    _build_env,
    run_learner,
)
from eliza_robot.rl.alberta.metrics import compute_continual_metrics
from scripts.validate_alberta_benchmark_artifacts import (
    validate_alberta_benchmark_artifacts,
)


class _TinySequentialLearner:
    def __init__(self, env, config=None, seed=0):
        self.env = env
        self.seed = seed
        self.trained_phase = -1

    def train_phase(self, task_id: int, steps: int) -> None:
        self.trained_phase = max(self.trained_phase, task_id)

    def eval_task(self, task_id: int, episodes: int) -> float:
        base = -10.0 + task_id
        if task_id <= self.trained_phase:
            return base + 5.0
        return base


def _motion_eval(
    *,
    forward_progress: float = 1.5,
    passed_obstacle: float = 1.0,
    collision_rate: float = 0.0,
    success_rate: float = 1.0,
) -> dict[str, float | int]:
    return {
        "episodes": 2,
        "success_rate": success_rate,
        "collision_rate": collision_rate,
        "passed_obstacle_rate": passed_obstacle,
        "mean_forward_progress_m": forward_progress,
        "mean_final_x": forward_progress,
        "mean_final_y": 0.0,
        "mean_goal_dist": 0.1,
        "min_obstacle_clearance_m": 0.05,
        "mean_return": 1.0,
        "mean_length": 8.0,
    }


def _motion_baseline(n_tasks: int = 2) -> list[dict[str, float | int]]:
    return [
        _motion_eval(forward_progress=0.0, passed_obstacle=0.0, success_rate=0.0)
        for _ in range(n_tasks)
    ]


def _motion_matrix(n_tasks: int = 2) -> list[list[dict[str, float | int]]]:
    return [[_motion_eval() for _ in range(n_tasks)] for _ in range(n_tasks)]


def _trajectory_trace() -> dict:
    return {
        "task_id": 0,
        "lane_y": 0.75,
        "goal": [1.2, 0.75],
        "obstacle": {"x": 0.0, "y": 0.0, "radius": 0.28},
        "steps": [
            {
                "step": 0,
                "x": -1.2,
                "y": 0.0,
                "forward_progress_m": 0.0,
                "passed_obstacle": False,
                "collision": False,
                "goal_reached": False,
                "obstacle_clearance_m": 0.92,
            },
            {
                "step": 1,
                "x": 0.3,
                "y": 0.75,
                "forward_progress_m": 1.5,
                "passed_obstacle": True,
                "collision": False,
                "goal_reached": True,
                "obstacle_clearance_m": 0.05,
            },
        ],
        "summary": _motion_eval(),
    }


def _failed_trajectory_trace() -> dict:
    trace = _trajectory_trace()
    trace["steps"][-1].update(
        {
            "x": -0.2,
            "y": 0.2,
            "forward_progress_m": 1.0,
            "passed_obstacle": False,
            "goal_reached": False,
            "obstacle_clearance_m": 0.1,
        }
    )
    trace["summary"] = {
        "success_rate": 0.0,
        "collision_rate": 0.0,
        "passed_obstacle_rate": 0.0,
        "mean_forward_progress_m": 1.0,
        "min_obstacle_clearance_m": 0.1,
    }
    return trace


def _trajectory_matrix(n_tasks: int = 2) -> list[list[dict]]:
    return [[_trajectory_trace() for _ in range(n_tasks)] for _ in range(n_tasks)]


def _failed_trajectory_matrix(n_tasks: int = 2) -> list[list[dict]]:
    return [[_failed_trajectory_trace() for _ in range(n_tasks)] for _ in range(n_tasks)]


def _motion_summary() -> dict[str, dict[str, float | int]]:
    return {
        learner: {
            "seeds": 1,
            "final_success_rate_mean": 1.0,
            "final_collision_rate_mean": 0.0,
            "final_passed_obstacle_rate_mean": 1.0,
            "final_forward_progress_m_mean": 1.5,
            "final_min_obstacle_clearance_m_min": 0.05,
        }
        for learner in ("alberta", "ppo")
    }


def test_alberta_learner_builds_valid_matrix_and_retains():
    cfg = BenchmarkConfig(
        n_tasks=2,
        n_joints=4,
        steps_per_task=4000,
        eval_episodes=4,
        seeds=1,
        embed_dim=16,
    )
    env = _build_env(cfg, seed=1234)
    learner = AlbertaSequentialLearner(env, _alberta_controller_config(cfg, env, seed=1234))
    R, baseline, baseline_motion, motion_matrix, trajectory_matrix = run_learner(learner, cfg)

    assert R.shape == (2, 2)
    assert baseline.shape == (2,)
    assert baseline_motion == [{}, {}]
    assert motion_matrix == [[{}, {}], [{}, {}]]
    assert trajectory_matrix == [[{}, {}], [{}, {}]]
    assert np.all(np.isfinite(R))

    m = compute_continual_metrics(R, baseline)
    # Sparse-gated blocks are disjoint per task, so training task 1 must not
    # crater task 0: forgetting should be small relative to what task 0 reached.
    task0_peak = max(R[0, 0], R[1, 0])
    assert R[1, 0] >= 0.6 * task0_peak  # retains >=60% of its best
    assert m.forgetting <= 0.5 * max(task0_peak, 1.0)


def test_benchmark_writes_json_markdown_and_png_artifacts(monkeypatch, tmp_path):
    import eliza_robot.rl.alberta.benchmark as benchmark

    monkeypatch.setattr(benchmark, "AlbertaSequentialLearner", _TinySequentialLearner)
    monkeypatch.setattr(benchmark, "PPOSequentialLearner", _TinySequentialLearner)

    cfg = BenchmarkConfig(
        n_tasks=2,
        n_joints=2,
        steps_per_task=2,
        eval_episodes=1,
        seeds=1,
        embed_dim=8,
        n_prototypes=16,
        proprio_random_dim=8,
    )
    bundle = benchmark.run_benchmark(cfg, tmp_path)

    assert bundle["config"]["env_kind"] == "joint_reach"
    assert bundle["config"]["steps_per_task"] == 2
    assert set(bundle["summary"]) == {"alberta", "ppo"}
    assert set(bundle["adaptation"]) == {"alberta", "ppo"}
    assert bundle["adaptation"]["alberta"]["tasks_with_positive_gain"] == 2.0
    assert bundle["adaptation"]["alberta"]["task_count"] == 2.0
    assert bundle["adaptation"]["alberta"]["mean_new_task_gain"] == 5.0
    assert {r["name"] for r in bundle["results"]} == {"alberta", "ppo"}
    assert all(len(r["matrix"]) == 2 for r in bundle["results"])
    assert all(len(r["baseline"]) == 2 for r in bundle["results"])
    assert (tmp_path / "continual_benchmark.json").is_file()
    assert (tmp_path / "continual_benchmark.md").is_file()
    assert (tmp_path / "continual_benchmark.png").is_file()
    loaded = json.loads((tmp_path / "continual_benchmark.json").read_text())
    assert loaded["config"] == bundle["config"]

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="joint_reach",
        min_seeds=1,
        min_steps_per_task=2,
        min_tasks=2,
        require_alberta_acc_gte_ppo=True,
        require_alberta_forgetting_lte_ppo=True,
    )
    assert validation["ok"] is True
    assert validation["checks"]["result_count"] is True
    assert validation["checks"]["learner_seed_pairs"] is True
    assert validation["checks"]["learner_seed_coverage"] is True
    assert validation["seed_coverage"] == {"alberta": [1000], "ppo": [1000]}
    assert validation["deltas"]["alberta_acc_minus_ppo"] == 0.0
    assert validation["deltas"]["alberta_forgetting_minus_ppo"] == 0.0


def test_benchmark_can_include_optional_sac_baseline(monkeypatch, tmp_path):
    import eliza_robot.rl.alberta.benchmark as benchmark

    monkeypatch.setattr(benchmark, "AlbertaSequentialLearner", _TinySequentialLearner)
    monkeypatch.setattr(benchmark, "PPOSequentialLearner", _TinySequentialLearner)
    monkeypatch.setattr(benchmark, "SACSequentialLearner", _TinySequentialLearner)

    cfg = BenchmarkConfig(
        n_tasks=2,
        n_joints=2,
        steps_per_task=2,
        eval_episodes=1,
        seeds=1,
        embed_dim=8,
        n_prototypes=16,
        proprio_random_dim=8,
        learners=("alberta", "ppo", "sac"),
    )
    bundle = benchmark.run_benchmark(cfg, tmp_path)

    assert set(bundle["summary"]) == {"alberta", "ppo", "sac"}
    assert set(bundle["adaptation"]) == {"alberta", "ppo", "sac"}
    assert {r["name"] for r in bundle["results"]} == {"alberta", "ppo", "sac"}
    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="joint_reach",
        min_seeds=1,
        min_steps_per_task=2,
        min_tasks=2,
    )
    assert validation["ok"] is True
    assert validation["configured_learners"] == ["alberta", "ppo", "sac"]
    assert validation["seed_coverage"] == {
        "alberta": [1000],
        "ppo": [1000],
        "sac": [1000],
    }


def test_benchmark_artifact_validator_rejects_missing_ppo_summary(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "joint_reach",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": {
                    "alberta": {
                        metric: {"mean": 1.0, "std": 0.0}
                        for metric in ("acc", "bwt", "forgetting", "fwt")
                    }
                },
                "results": [
                    {"name": "alberta", "matrix": [[1.0, 0.0], [1.0, 1.0]], "baseline": [0.0, 0.0]}
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="joint_reach",
        min_seeds=1,
        min_steps_per_task=8,
    )

    assert validation["ok"] is False
    assert validation["checks"]["summary_learners"] is False
    assert validation["checks"]["result_learners"] is False


def test_benchmark_artifact_validator_can_require_alberta_delta_gates(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": {
                    "alberta": {
                        "acc": {"mean": 1.0, "std": 0.0},
                        "bwt": {"mean": 0.0, "std": 0.0},
                        "forgetting": {"mean": 0.5, "std": 0.0},
                        "fwt": {"mean": 0.0, "std": 0.0},
                    },
                    "ppo": {
                        "acc": {"mean": 2.0, "std": 0.0},
                        "bwt": {"mean": 0.0, "std": 0.0},
                        "forgetting": {"mean": 0.1, "std": 0.0},
                        "fwt": {"mean": 0.0, "std": 0.0},
                    },
                },
                "results": [
                    {"name": "alberta", "matrix": [[1.0, 0.0], [1.0, 1.0]], "baseline": [0.0, 0.0]},
                    {"name": "ppo", "matrix": [[2.0, 0.0], [2.0, 2.0]], "baseline": [0.0, 0.0]},
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        require_alberta_acc_gte_ppo=True,
        require_alberta_forgetting_lte_ppo=True,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_acc_gte_ppo"] is False
    assert validation["checks"]["alberta_forgetting_lte_ppo"] is False
    assert validation["deltas"]["alberta_acc_minus_ppo"] == -1.0
    assert validation["deltas"]["alberta_forgetting_minus_ppo"] == 0.4
    assert validation["observed_comparisons"]["alberta_acc_gte_ppo"] is False
    assert validation["enforced_delta_gates"]["alberta_acc_gte_ppo"] is False


def test_benchmark_artifact_validator_separates_observed_and_waived_gates(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "joint_reach",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": {
                    "alberta": {
                        "acc": {"mean": 1.0, "std": 0.0},
                        "bwt": {"mean": 0.0, "std": 0.0},
                        "forgetting": {"mean": 0.1, "std": 0.0},
                        "fwt": {"mean": 0.0, "std": 0.0},
                    },
                    "ppo": {
                        "acc": {"mean": 2.0, "std": 0.0},
                        "bwt": {"mean": 0.0, "std": 0.0},
                        "forgetting": {"mean": 0.2, "std": 0.0},
                        "fwt": {"mean": 0.0, "std": 0.0},
                    },
                },
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[2.0, 0.0], [2.0, 2.0]],
                        "baseline": [0.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="joint_reach",
        min_seeds=1,
        min_steps_per_task=8,
        require_alberta_acc_gte_ppo=False,
        require_alberta_forgetting_lte_ppo=True,
    )

    assert validation["ok"] is True
    assert validation["deltas"]["alberta_acc_minus_ppo"] == -1.0
    assert validation["observed_comparisons"]["alberta_acc_gte_ppo"] is False
    assert validation["required_deltas"]["require_alberta_acc_gte_ppo"] is False
    assert validation["enforced_delta_gates"]["alberta_acc_gte_ppo"] is True


def test_benchmark_artifact_validator_can_require_demo_video(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    matrix = [[1.0, 0.0], [1.0, 1.0]]
    baseline = [0.0, 0.0]
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "motion": _motion_summary(),
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": _failed_trajectory_matrix(),
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    missing = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
        require_demo_video=True,
    )
    assert missing["ok"] is False
    assert missing["checks"]["demo_json"] is False
    assert missing["checks"]["demo_video"] is False

    (tmp_path / "obstacle_course_demo.mp4").write_bytes(b"video")
    (tmp_path / "obstacle_course_demo.json").write_text(
        json.dumps(
            {
                "schema": "robot-alberta-obstacle-demo-v1",
                "ok": True,
                "frames": 2,
                "video_bytes": 5,
                "learner_results": {
                    "alberta": {"has_trajectory_traces": True},
                    "ppo": {"has_trajectory_traces": False},
                },
            }
        ),
        encoding="utf-8",
    )
    partial = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
        require_demo_video=True,
    )
    assert partial["ok"] is False
    assert partial["checks"]["demo_json"] is False

    (tmp_path / "obstacle_course_demo.json").write_text(
        json.dumps(
            {
                "schema": "robot-alberta-obstacle-demo-v1",
                "ok": True,
                "frames": 2,
                "video_bytes": 5,
                "learner_results": {
                    "alberta": {"has_trajectory_traces": True},
                    "ppo": {"has_trajectory_traces": True},
                },
            }
        ),
        encoding="utf-8",
    )
    present = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
        require_demo_video=True,
    )
    assert present["ok"] is True
    assert present["checks"]["demo_json"] is True
    assert present["checks"]["demo_video"] is True
    assert present["checks"]["obstacle_trace_rollouts"] is True
    assert present["obstacle_trace_rollouts"]["alberta_successful_final_clear"] is True
    assert present["obstacle_trace_rollouts"]["alberta_majority_final_clear"] is True
    assert present["obstacle_trace_rollouts"]["alberta_successful_final_clear_rate"] == 1.0
    assert present["obstacle_trace_rollouts"]["alberta_final_clear_advantage"] is True
    assert (
        present["obstacle_trace_rollouts"]["by_learner"]["alberta"][
            "has_successful_final_clear"
        ]
        is True
    )


def test_obstacle_validator_rejects_trace_metrics_not_backed_by_steps(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    matrix = [[1.0, 0.0], [1.0, 1.0]]
    baseline = [0.0, 0.0]
    fake_trace = _trajectory_trace()
    fake_trace["steps"][-1].update(
        {
            "x": -0.2,
            "forward_progress_m": 1.0,
            "passed_obstacle": False,
            "goal_reached": False,
        }
    )
    fake_trace["summary"].update(
        {
            "success_rate": 1.0,
            "passed_obstacle_rate": 1.0,
            "mean_forward_progress_m": 1.5,
        }
    )
    fake_trajectory_matrix = [[fake_trace for _ in range(2)] for _ in range(2)]
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "motion": _motion_summary(),
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": fake_trajectory_matrix,
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": fake_trajectory_matrix,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["obstacle_trace_rollouts"] is False
    assert validation["obstacle_trace_rollouts"]["all_trace_summaries_consistent"] is False
    assert validation["obstacle_trace_rollouts"]["alberta_successful_final_clear"] is False
    assert validation["obstacle_trace_rollouts"]["alberta_majority_final_clear"] is False
    assert validation["obstacle_trace_rollouts"]["alberta_final_clear_advantage"] is False
    assert (
        validation["obstacle_trace_rollouts"]["any_required_learner_successful_final_clear"]
        is False
    )


def test_obstacle_validator_rejects_clearance_summary_not_backed_by_steps(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    matrix = [[1.0, 0.0], [1.0, 1.0]]
    baseline = [0.0, 0.0]
    fake_trace = _trajectory_trace()
    fake_trace["steps"][-1]["obstacle_clearance_m"] = -0.03
    fake_trace["steps"][-1]["collision"] = False
    fake_trace["summary"]["min_obstacle_clearance_m"] = 0.05
    fake_trajectory_matrix = [[fake_trace for _ in range(2)] for _ in range(2)]
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "motion": _motion_summary(),
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": fake_trajectory_matrix,
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": fake_trajectory_matrix,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["obstacle_trace_rollouts"] is False
    assert validation["obstacle_trace_rollouts"]["all_trace_summaries_consistent"] is False


def test_obstacle_validator_rejects_passive_baseline_that_already_solves_course(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    matrix = [[1.0, 0.0], [1.0, 1.0]]
    baseline = [0.0, 0.0]
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "motion": _motion_summary(),
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": [_motion_eval(), _motion_eval()],
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": matrix,
                        "baseline": baseline,
                        "motion_baseline": [_motion_eval(), _motion_eval()],
                        "motion_matrix": _motion_matrix(),
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["obstacle_passive_baseline_control"] is False
    assert validation["checks"]["obstacle_beats_passive_baseline"] is False


def test_obstacle_validator_rejects_learners_that_do_not_beat_passive_baseline(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    weak_motion = _motion_matrix()
    for row in weak_motion:
        for item in row:
            item.update(
                _motion_eval(
                    forward_progress=0.2,
                    passed_obstacle=0.0,
                    success_rate=0.0,
                )
            )
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "motion": _motion_summary(),
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": weak_motion,
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                        "motion_baseline": _motion_baseline(),
                        "motion_matrix": weak_motion,
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["obstacle_passive_baseline_control"] is True
    assert validation["checks"]["obstacle_beats_passive_baseline"] is False


def test_benchmark_artifact_validator_rejects_single_task_or_bad_matrix(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 1,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "results": [
                    {"name": "alberta", "matrix": [[1.0]], "baseline": [0.0]},
                    {"name": "ppo", "matrix": [[1.0, 2.0]], "baseline": [0.0]},
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["tasks"] is False
    assert validation["checks"]["matrix_shapes"] is False


def test_benchmark_artifact_validator_rejects_nan_metrics_and_matrix(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    summary["alberta"]["acc"]["mean"] = float("nan")
    summary["ppo"]["forgetting"]["std"] = float("inf")
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": [[1.0, float("nan")], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["metrics"] is False
    assert validation["checks"]["matrix_shapes"] is False


def test_benchmark_artifact_validator_rejects_boolean_numeric_fields(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    summary["alberta"]["acc"]["mean"] = True
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": [[True, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["metrics"] is False
    assert validation["checks"]["matrix_shapes"] is False


def test_benchmark_artifact_validator_rejects_missing_seed_coverage(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 2,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "alberta",
                        "seed": 1001,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "matrix": [[1.0, 0.0], [1.0, 1.0]],
                        "baseline": [0.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=2,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["result_count"] is True
    assert validation["checks"]["learner_seed_pairs"] is False
    assert validation["checks"]["learner_seed_coverage"] is False
    assert validation["seed_coverage"] == {"alberta": [1000, 1001], "ppo": [1000]}


def test_benchmark_artifact_validator_rejects_extra_duplicate_result_rows(tmp_path):
    (tmp_path / "continual_benchmark.md").write_text("# report\n", encoding="utf-8")
    (tmp_path / "continual_benchmark.png").write_bytes(b"png")
    summary = {
        learner: {
            metric: {"mean": 1.0, "std": 0.0}
            for metric in ("acc", "bwt", "forgetting", "fwt")
        }
        for learner in ("alberta", "ppo")
    }
    matrix = [[1.0, 0.0], [1.0, 1.0]]
    baseline = [0.0, 0.0]
    (tmp_path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "seeds": 1,
                    "steps_per_task": 8,
                },
                "summary": summary,
                "results": [
                    {"name": "alberta", "seed": 1000, "matrix": matrix, "baseline": baseline},
                    {"name": "ppo", "seed": 1000, "matrix": matrix, "baseline": baseline},
                    {"name": "ppo", "seed": 1000, "matrix": matrix, "baseline": baseline},
                ],
            }
        ),
        encoding="utf-8",
    )

    validation = validate_alberta_benchmark_artifacts(
        tmp_path,
        expected_env="obstacle_course",
        min_seeds=1,
        min_steps_per_task=8,
        min_tasks=2,
    )

    assert validation["ok"] is False
    assert validation["checks"]["result_count"] is False
    assert validation["checks"]["learner_seed_pairs"] is False
    assert validation["checks"]["learner_seed_coverage"] is True


def test_benchmark_cli_preserves_independent_actor_and_critic_knobs(
    monkeypatch, tmp_path, capsys
):
    import eliza_robot.rl.alberta.benchmark as benchmark

    captured = {}

    def fake_run_benchmark(cfg, out_dir):
        captured["cfg"] = cfg
        captured["out_dir"] = out_dir
        return {
            "summary": {
                "alberta": {
                    "acc": {"mean": 1.0},
                    "bwt": {"mean": 0.0},
                    "forgetting": {"mean": 0.0},
                    "fwt": {"mean": 0.0},
                }
            }
        }

    monkeypatch.setattr(benchmark, "run_benchmark", fake_run_benchmark)

    benchmark.main(
        [
            "--actor-step-size",
            "0.011",
            "--critic-step-size",
            "0.022",
            "--actor-lamda",
            "0.33",
            "--critic-lamda",
            "0.44",
            "--out-dir",
            str(tmp_path),
        ]
    )

    cfg = captured["cfg"]
    assert cfg.actor_step_size == 0.011
    assert cfg.critic_step_size == 0.022
    assert cfg.actor_lamda == 0.33
    assert cfg.critic_lamda == 0.44
    assert captured["out_dir"] == tmp_path
    assert "SUMMARY" in capsys.readouterr().out
