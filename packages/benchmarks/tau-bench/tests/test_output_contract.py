from __future__ import annotations

import json

import pytest

from elizaos_tau_bench import runner as runner_module
from elizaos_tau_bench.dataset import iter_sample_tasks
from elizaos_tau_bench.runner import TauBenchRunner
from elizaos_tau_bench.types import TauBenchConfig


def test_report_and_trajectories_json_contract(tmp_path):
    out_dir = tmp_path / "out"
    cfg = TauBenchConfig(
        domains=["retail"],
        use_sample_tasks=True,
        use_mock=True,
        num_trials=1,
        pass_k_values=[1],
        use_llm_judge=False,
        output_dir=str(out_dir),
    )

    TauBenchRunner(cfg).run()

    report = json.loads((out_dir / "report.json").read_text(encoding="utf-8"))
    assert report["data_provenance"]["mode"] == "smoke"
    assert report["scenario_counts"] == {
        "base": 2,
        "edge": 0,
        "total": 2,
        "edge_multiplier": 10,
    }
    trajectories = json.loads((out_dir / "trajectories.json").read_text(encoding="utf-8"))

    assert set(report) == {
        "config",
        "num_tasks",
        "num_trials_per_task",
        "avg_reward",
        "pass_k",
        "domain_results",
        "data_provenance",
        "scenario_counts",
        "complete",
        "expected_rollouts",
        "completed_rollouts",
        "workload_sha256",
    }
    assert report["config"]["domains"] == ["retail"]
    assert report["num_tasks"] == 2
    assert report["num_trials_per_task"] == 1
    assert report["complete"] is True
    assert report["expected_rollouts"] == 2
    assert report["completed_rollouts"] == 2
    assert len(report["workload_sha256"]) == 64
    assert report["pass_k"]["1"] == {"k": 1, "num_tasks": 2, "pass_hat_k": 1.0}
    assert set(report["domain_results"]) == {"retail"}
    assert {
        "task_id",
        "trial",
        "scenario_id",
        "scenario_note",
        "reward",
        "success",
        "judge_passed",
        "judge_explanation",
        "r_actions",
        "r_outputs",
        "num_turns",
        "num_tool_calls",
        "user_cost",
        "agent_cost",
        "error",
    } <= set(report["domain_results"]["retail"][0])

    assert len(trajectories) == 2
    assert {
        "domain",
        "task_id",
        "trial",
        "scenario_id",
        "scenario_note",
        "reward",
        "success",
        "messages",
    } == set(trajectories[0])
    assert trajectories[0]["domain"] == "retail"
    assert isinstance(trajectories[0]["messages"], list)


def test_environment_failure_does_not_publish_partial_report(
    tmp_path,
    monkeypatch,
) -> None:
    out_dir = tmp_path / "failed-out"
    cfg = TauBenchConfig(
        domains=["retail"],
        use_sample_tasks=True,
        use_mock=True,
        num_trials=1,
        pass_k_values=[1],
        use_llm_judge=False,
        output_dir=str(out_dir),
    )
    runner = TauBenchRunner(cfg)

    def fail_env(_domain, _task_index):
        raise OSError("fixture unavailable")

    monkeypatch.setattr(runner, "_make_env", fail_env)

    with pytest.raises(RuntimeError, match="failed to construct tau-bench env"):
        runner.run()
    assert not out_dir.exists()


def test_full_official_selection_rejects_truncated_corpus(
    tmp_path,
    monkeypatch,
) -> None:
    one_task = next(iter(iter_sample_tasks(["retail"], "test")))
    monkeypatch.setattr(
        runner_module,
        "iter_tasks",
        lambda **_kwargs: iter([one_task]),
    )
    out_dir = tmp_path / "truncated-out"
    cfg = TauBenchConfig(
        domains=["retail"],
        use_mock=True,
        num_trials=1,
        pass_k_values=[1],
        use_llm_judge=False,
        output_dir=str(out_dir),
    )

    with pytest.raises(RuntimeError, match="official tau-bench test corpus count mismatch"):
        TauBenchRunner(cfg).run()
    assert not out_dir.exists()
