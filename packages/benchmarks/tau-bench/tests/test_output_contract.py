from __future__ import annotations

import json

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
    trajectories = json.loads((out_dir / "trajectories.json").read_text(encoding="utf-8"))

    assert set(report) == {
        "config",
        "num_tasks",
        "num_trials_per_task",
        "avg_reward",
        "pass_k",
        "domain_results",
    }
    assert report["config"]["domains"] == ["retail"]
    assert report["num_tasks"] == 2
    assert report["num_trials_per_task"] == 1
    assert report["pass_k"]["1"] == {"k": 1, "num_tasks": 2, "pass_hat_k": 1.0}
    assert set(report["domain_results"]) == {"retail"}
    assert {
        "task_id",
        "trial",
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
        "reward",
        "success",
        "messages",
    } == set(trajectories[0])
    assert trajectories[0]["domain"] == "retail"
    assert isinstance(trajectories[0]["messages"], list)
