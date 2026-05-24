"""bsuite helper tests that do not require bsuite to be installed."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

from benchmarks.bsuite._bsuite_path import (
    add_bsuite_to_path,
    candidate_bsuite_paths,
    import_root_for_bsuite_checkout,
)
from benchmarks.bsuite.analysis import (
    compare_sarsa_vs_q,
    compare_sarsa_vs_q_preferred_metric,
    compare_step4_control,
    format_sarsa_q_report,
    format_step4_control_report,
    load_results,
)
from benchmarks.bsuite.run_sweep import (
    build_sweep_jobs,
    experiment_names_from_bsuite_ids,
    get_bsuite_ids_for_experiment,
    resolve_bsuite_ids,
    seeded_agent_name,
)


def test_bsuite_path_bootstrap_prefers_env_checkout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checkout = tmp_path / "deepmind_bsuite"
    package = checkout / "bsuite"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    monkeypatch.setenv("BSUITE_PATH", str(checkout))

    candidates = candidate_bsuite_paths(project_root=tmp_path / "repo")
    assert candidates[0] == checkout
    assert import_root_for_bsuite_checkout(checkout) == checkout

    inserted = add_bsuite_to_path(project_root=tmp_path / "repo")
    assert inserted == checkout
    assert sys.path[0] == str(checkout)


def test_bsuite_path_bootstrap_accepts_package_directory(tmp_path: Path) -> None:
    package = tmp_path / "bsuite"
    package.mkdir()
    (package / "__init__.py").write_text("")

    assert import_root_for_bsuite_checkout(package) == tmp_path


def test_sweep_job_helpers_are_bsuite_free() -> None:
    assert seeded_agent_name("sarsa", 2, include_seed=True) == "sarsa_seed2"
    assert seeded_agent_name("sarsa", 2, include_seed=False) == "sarsa"

    jobs = build_sweep_jobs(
        agent_names=["autostep", "sarsa"],
        bsuite_ids=["catch/0", "cartpole/0"],
        seeds=[0, 1],
        include_seed_in_name=True,
    )
    assert len(jobs) == 8
    assert jobs[0].output_agent_name == "autostep_seed0"
    assert jobs[-1].output_agent_name == "sarsa_seed1"

    ids = get_bsuite_ids_for_experiment(
        "catch",
        sweep_ids=["catch/0", "cartpole/0", "catch_noise/0"],
    )
    assert ids == ["catch/0"]


def test_resolve_explicit_bsuite_ids_preserves_order_without_bsuite() -> None:
    ids = ["bandit/0", "memory_len/0", "bandit/0", "umbrella_length/1"]

    assert experiment_names_from_bsuite_ids(ids) == [
        "bandit",
        "memory_len",
        "umbrella_length",
    ]
    assert resolve_bsuite_ids(["catch"], explicit_bsuite_ids=ids) == [
        "bandit/0",
        "memory_len/0",
        "umbrella_length/1",
    ]


def test_resolve_bsuite_ids_can_cap_each_experiment_without_bsuite() -> None:
    sweep_ids = [
        "bandit/0",
        "bandit/1",
        "cartpole/0",
        "memory_len/0",
        "memory_len/1",
    ]

    ids = resolve_bsuite_ids(
        ["bandit", "memory_len"],
        max_ids_per_experiment=1,
        sweep_ids=sweep_ids,
    )

    assert ids == ["bandit/0", "memory_len/0"]


def test_sarsa_vs_q_report_pairs_by_seed_and_bsuite_id() -> None:
    results = {
        "autostep_seed0": pd.DataFrame(
            {"bsuite_id": ["catch/0", "catch/0"], "total_regret": [5.0, 4.0]}
        ),
        "sarsa_seed0": pd.DataFrame(
            {"bsuite_id": ["catch/0", "catch/0"], "total_regret": [6.0, 3.0]}
        ),
        "autostep_seed1": pd.DataFrame(
            {"bsuite_id": ["catch/0"], "total_regret": [2.0]}
        ),
        "sarsa_seed1": pd.DataFrame(
            {"bsuite_id": ["catch/0"], "total_regret": [3.0]}
        ),
    }

    pairs = compare_sarsa_vs_q(results, experiments=["catch"])
    assert list(pairs["seed"]) == [0, 1]
    assert list(pairs["improvement_vs_q"]) == [1.0, -1.0]

    report = format_sarsa_q_report(results, experiments=["catch"])
    assert "SARSA vs Q-learning" in report
    assert "overall" in report


def test_load_results_ignores_internal_directories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_dir = tmp_path / "autostep_seed0"
    logs_dir = tmp_path / "_logs"
    hidden_dir = tmp_path / ".cache"
    agent_dir.mkdir()
    logs_dir.mkdir()
    hidden_dir.mkdir()

    loaded: list[str] = []

    def fake_load_bsuite(path: str) -> tuple[pd.DataFrame, dict[str, object]]:
        loaded.append(Path(path).name)
        return pd.DataFrame({"bsuite_id": ["catch/0"], "total_regret": [1.0]}), {}

    monkeypatch.setattr(
        "benchmarks.bsuite.analysis.csv_load.load_bsuite",
        fake_load_bsuite,
    )

    results = load_results(str(tmp_path))

    assert loaded == ["autostep_seed0"]
    assert list(results) == ["autostep_seed0"]


def test_sarsa_vs_q_auto_report_includes_return_tasks() -> None:
    results = {
        "autostep_seed0": pd.DataFrame(
            {
                "bsuite_id": ["cartpole/0", "cartpole/0"],
                "total_regret": [float("nan"), float("nan")],
                "episode_return": [10.0, 20.0],
            }
        ),
        "sarsa_seed0": pd.DataFrame(
            {
                "bsuite_id": ["cartpole/0", "cartpole/0"],
                "total_regret": [float("nan"), float("nan")],
                "episode_return": [15.0, 25.0],
            }
        ),
    }

    pairs = compare_sarsa_vs_q_preferred_metric(results, experiments=["cartpole"])
    assert list(pairs["metric"]) == ["episode_return"]
    assert list(pairs["improvement_vs_q"]) == [5.0]

    report = format_sarsa_q_report(results, experiments=["cartpole"], metric="auto")
    assert "cartpole" in report
    assert "episode_return" in report


def test_step4_auto_report_uses_task_specific_metric_direction() -> None:
    results = {
        "autostep_seed0": pd.DataFrame(
            {
                "bsuite_id": ["catch/0", "cartpole/0"],
                "total_regret": [4.0, float("nan")],
                "episode_return": [float("nan"), 10.0],
            }
        ),
        "sarsa_seed0": pd.DataFrame(
            {
                "bsuite_id": ["catch/0", "cartpole/0"],
                "total_regret": [3.0, float("nan")],
                "episode_return": [float("nan"), 12.0],
            }
        ),
        "actor_critic_seed0": pd.DataFrame(
            {
                "bsuite_id": ["catch/0", "cartpole/0"],
                "total_regret": [5.0, float("nan")],
                "episode_return": [float("nan"), 8.0],
            }
        ),
    }

    pairs = compare_step4_control(results, metric="auto")
    assert list(pairs["metric"]) == ["episode_return", "total_regret"]
    assert list(pairs["sarsa_improvement_vs_autostep"]) == [2.0, 1.0]
    assert list(pairs["actor_critic_improvement_vs_autostep"]) == [-2.0, -1.0]

    report = format_step4_control_report(results, metric="auto")
    assert "Metric: `auto`" in report
    assert "episode_return" in report
    assert "total_regret" in report
