from __future__ import annotations

import json
from pathlib import Path

from scripts.render_alberta_obstacle_demo import render_demo


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
                    },
                    {
                        "name": "ppo",
                        "seed": 1000,
                        "baseline": [0.1, 0.2],
                        "matrix": [[0.8, 0.2], [0.4, 1.0]],
                        "metrics": {"acc": 0.7, "forgetting": 0.4},
                    },
                    {
                        "name": "sac",
                        "seed": 1000,
                        "baseline": [0.1, 0.2],
                        "matrix": [[0.3, 0.2], [0.3, 0.6]],
                        "metrics": {"acc": 0.45, "forgetting": 0.0},
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
    assert report["n_tasks"] == 2
    assert report["frames"] == 2
    assert report["alberta"]["metrics"]["forgetting"] == 0.0
    assert report["ppo"]["metrics"]["forgetting"] == 0.4
    assert report["learners"] == ["alberta", "ppo"]
    assert report["adaptation"]["alberta"]["mean_new_task_gain"] == 1.35
    assert (benchmark / "obstacle_course_demo.mp4").stat().st_size > 0
    assert (benchmark / "obstacle_course_demo.json").is_file()


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
