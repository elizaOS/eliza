from __future__ import annotations

import json
from pathlib import Path

from scripts.render_alberta_obstacle_demo import render_demo


def _trace(task_id: int) -> dict:
    return {
        "task_id": task_id,
        "lane_y": 0.75,
        "goal": [1.2, 0.75],
        "obstacle": {"x": 0.0, "y": 0.0, "radius": 0.28},
        "steps": [
            {"step": 0, "x": -1.2, "y": 0.0},
            {"step": 1, "x": 0.5, "y": 0.75},
        ],
        "summary": {
            "mean_forward_progress_m": 1.7,
            "passed_obstacle_rate": 1.0,
            "collision_rate": 0.0,
        },
    }


def _trajectory_matrix() -> list[list[dict]]:
    return [[_trace(0), _trace(1)], [_trace(0), _trace(1)]]


def _write_benchmark(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "continual_benchmark.json").write_text(
        json.dumps(
            {
                "config": {
                    "env_kind": "obstacle_course",
                    "n_tasks": 2,
                    "steps_per_task": 4,
                },
                "results": [
                    {
                        "name": "alberta",
                        "seed": 1000,
                        "baseline": [0.1, 0.2],
                        "matrix": [[1.0, 0.2], [1.0, 2.0]],
                        "metrics": {"acc": 1.5, "forgetting": 0.0},
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "baseline": [0.1, 0.2],
                        "matrix": [[0.8, 0.2], [0.4, 1.0]],
                        "metrics": {"acc": 0.7, "forgetting": 0.4},
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                    {
                        "name": "sac",
                        "seed": 1000,
                        "baseline": [0.1, 0.2],
                        "matrix": [[0.3, 0.2], [0.3, 0.6]],
                        "metrics": {"acc": 0.45, "forgetting": 0.0},
                        "trajectory_matrix": _trajectory_matrix(),
                    },
                ],
                "summary": {
                    "alberta": {"acc": {"mean": 1.5}, "forgetting": {"mean": 0.0}},
                    "ppo": {"acc": {"mean": 0.7}, "forgetting": {"mean": 0.4}},
                    "sac": {"acc": {"mean": 0.45}, "forgetting": {"mean": 0.0}},
                },
                "adaptation": {
                    "alberta": {"mean_new_task_gain": 1.35},
                    "ppo": {"mean_new_task_gain": 0.75},
                    "sac": {"mean_new_task_gain": 0.3},
                },
            }
        ),
        encoding="utf-8",
    )


def test_render_alberta_obstacle_demo_writes_video_and_summary(tmp_path: Path) -> None:
    benchmark = tmp_path / "benchmark"
    _write_benchmark(benchmark)

    report = render_demo(benchmark, hold_frames=1, fps=1)

    assert report["ok"] is True
    assert report["required_trace_coverage"] is True
    assert report["n_tasks"] == 2
    assert report["frames"] == 2
    assert report["alberta"]["metrics"]["forgetting"] == 0.0
    assert report["ppo"]["metrics"]["forgetting"] == 0.4
    assert report["learners"] == ["alberta", "ppo"]
    assert report["adaptation"]["alberta"]["mean_new_task_gain"] == 1.35
    assert report["learner_results"]["alberta"]["has_trajectory_traces"] is True
    assert (benchmark / "obstacle_course_demo.mp4").stat().st_size > 0
    assert (benchmark / "obstacle_course_demo.json").is_file()


def test_render_alberta_obstacle_demo_fails_without_all_trajectory_traces(
    tmp_path: Path,
) -> None:
    benchmark = tmp_path / "benchmark"
    _write_benchmark(benchmark)
    bundle = json.loads((benchmark / "continual_benchmark.json").read_text())
    for result in bundle["results"]:
        if result["name"] == "ppo":
            result.pop("trajectory_matrix")
    (benchmark / "continual_benchmark.json").write_text(json.dumps(bundle), encoding="utf-8")

    report = render_demo(benchmark, hold_frames=1, fps=1)

    assert report["ok"] is False
    assert report["required_trace_coverage"] is False
    assert report["learner_results"]["alberta"]["has_trajectory_traces"] is True
    assert report["learner_results"]["ppo"]["has_trajectory_traces"] is False
    assert (benchmark / "obstacle_course_demo.mp4").stat().st_size > 0


def test_render_alberta_obstacle_demo_can_include_sac(tmp_path: Path) -> None:
    benchmark = tmp_path / "benchmark"
    _write_benchmark(benchmark)
    bundle = json.loads((benchmark / "continual_benchmark.json").read_text())
    bundle["config"]["learners"] = ["alberta", "ppo", "sac"]
    (benchmark / "continual_benchmark.json").write_text(json.dumps(bundle), encoding="utf-8")

    report = render_demo(benchmark, hold_frames=1, fps=1)

    assert report["ok"] is True
    assert report["learners"] == ["alberta", "ppo", "sac"]
    assert report["sac"]["metrics"]["acc"] == 0.45
    assert report["learner_results"]["sac"]["matrix"][1][1] == 0.6
    assert report["adaptation"]["sac"]["mean_new_task_gain"] == 0.3
