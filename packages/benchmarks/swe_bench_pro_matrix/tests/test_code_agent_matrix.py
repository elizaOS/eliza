from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from benchmarks.swe_bench_pro_matrix.agent_command import build_prompt
from benchmarks.swe_bench_pro_matrix.code_agent_matrix import (
    DATASET_VERSION,
    _evaluator_command,
    _patch_from_workspace,
    _write_evaluator_raw_sample,
    agent_command_template,
    build_result,
    load_tasks,
    main,
)


def test_load_tasks_uses_vendored_public_split() -> None:
    tasks = load_tasks(max_tasks=2)

    assert len(tasks) == 2
    assert tasks[0]["instance_id"].startswith("instance_")
    assert tasks[0]["repo"]
    assert tasks[0]["base_commit"]
    assert tasks[0]["problem_statement"]


def test_builtin_agent_command_template_targets_helper(monkeypatch) -> None:
    monkeypatch.delenv("SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE", raising=False)
    monkeypatch.delenv("SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE_ELIZAOS", raising=False)
    monkeypatch.delenv("SWE_BENCH_PRO_DISABLE_BUILTIN_AGENT_COMMAND", raising=False)

    template = agent_command_template(
        "elizaos",
        provider="cerebras",
        model="gpt-oss-120b",
        timeout_seconds=123,
    )

    assert "swe_bench_pro_matrix/agent_command.py" in template
    assert "--adapter elizaos" in template
    assert "--workspace" in template
    assert "{workspace}" in template
    assert "--result-json" in template
    assert "{result_json}" in template


def test_mock_mode_writes_normalized_result(tmp_path: Path, capsys) -> None:
    exit_code = main(
        [
            "--task-agent",
            "opencode",
            "--model-provider",
            "cerebras",
            "--model",
            "gpt-oss-120b",
            "--output",
            str(tmp_path),
            "--max-tasks",
            "1",
            "--mock",
            "--json",
        ]
    )

    assert exit_code == 0
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert json.loads(capsys.readouterr().out)["benchmark"] == "swe_bench_pro"
    assert result["benchmark"] == "swe_bench_pro"
    assert result["dataset_version"] == DATASET_VERSION
    assert result["summary"]["total"] == 1
    assert result["summary"]["passed"] == 1
    assert result["summary"]["failed"] == 0
    assert result["summary"]["llm_call_count"] == 0


def test_live_no_docker_generates_patch_and_token_metrics(tmp_path: Path) -> None:
    helper = tmp_path / "write_agent_result.py"
    helper.write_text(
        "\n".join(
            [
                "import json, pathlib, sys",
                "path = pathlib.Path(sys.argv[1])",
                "path.parent.mkdir(parents=True, exist_ok=True)",
                "path.write_text(json.dumps({",
                "  'status': 'completed',",
                "  'patch': 'diff --git a/README.md b/README.md\\n--- a/README.md\\n+++ b/README.md\\n@@ -1 +1 @@\\n-old\\n+new\\n',",
                "  'actions': [{'name': 'edit'}],",
                "  'usage': {'input_tokens': 10, 'output_tokens': 5, 'cached_tokens': 4, 'total_tokens': 15, 'llm_call_count': 1}",
                "}))",
            ]
        ),
        encoding="utf-8",
    )

    exit_code = main(
        [
            "--task-agent",
            "elizaos",
            "--model-provider",
            "cerebras",
            "--model",
            "gpt-oss-120b",
            "--output",
            str(tmp_path / "out"),
            "--trajectory-dir",
            str(tmp_path / "trajectories"),
            "--max-tasks",
            "1",
            "--agent-command-template",
            f"{sys.executable} {helper} {{result_json}}",
            "--no-docker",
            "--skip-clone",
            "--json",
        ]
    )

    assert exit_code == 0
    result = json.loads((tmp_path / "out" / "result.json").read_text(encoding="utf-8"))
    assert result["mode"] == "live_no_docker"
    assert result["summary"]["total"] == 1
    assert result["summary"]["passed"] == 0
    assert result["summary"]["failed"] == 1
    assert result["summary"]["input_tokens"] == 10
    assert result["summary"]["output_tokens"] == 5
    assert result["summary"]["cached_tokens"] == 4
    assert result["summary"]["cached_token_percent"] == 40.0
    assert result["summary"]["llm_call_count"] == 1
    row = result["results"][0]
    assert row["evaluation_skipped"] is True
    assert Path(row["patch_path"]).read_text(encoding="utf-8").startswith("diff --git")
    assert Path(row["trajectory_path"]).exists()


def test_workspace_diff_is_used_when_agent_edits_files_without_returning_patch(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    workspace.mkdir()
    subprocess.run(["git", "init"], cwd=workspace, check=True, stdout=subprocess.PIPE)
    readme = workspace / "README.md"
    readme.write_text("old\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=workspace, check=True)
    readme.write_text("new\n", encoding="utf-8")

    patch = _patch_from_workspace(workspace)

    assert "diff --git a/README.md b/README.md" in patch
    assert "-old" in patch
    assert "+new" in patch


def test_agent_prompt_tells_code_agents_workspace_diff_is_captured(tmp_path: Path) -> None:
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text("Fix the bug.", encoding="utf-8")

    prompt = build_prompt(
        prompt_path=prompt_path,
        workspace=tmp_path / "repo",
        repo="owner/repo",
        base_commit="abc123",
    )

    assert "leave the final changes in the working tree" in prompt
    assert "harness can capture git diff" in prompt


def test_evaluator_raw_sample_normalizes_test_lists_as_eval_strings(tmp_path: Path) -> None:
    path = _write_evaluator_raw_sample(
        [
            {
                "instance_id": "instance_example",
                "repo": "owner/repo",
                "FAIL_TO_PASS": ["test_a"],
                "PASS_TO_PASS": ["test_b"],
            }
        ],
        tmp_path,
    )

    row = json.loads(path.read_text(encoding="utf-8"))
    assert row["fail_to_pass"] == "['test_a']"
    assert row["pass_to_pass"] == "['test_b']"
    assert eval(row["fail_to_pass"]) == ["test_a"]
    assert eval(row["pass_to_pass"]) == ["test_b"]


def test_evaluator_command_supports_local_docker_and_modal(tmp_path: Path) -> None:
    local = _evaluator_command(
        patches_json=tmp_path / "patches.json",
        raw_sample_path=tmp_path / "raw.jsonl",
        output_dir=tmp_path / "out",
        evaluator_backend="local-docker",
        num_workers=3,
    )
    modal = _evaluator_command(
        patches_json=tmp_path / "patches.json",
        raw_sample_path=tmp_path / "raw.jsonl",
        output_dir=tmp_path / "out",
        evaluator_backend="modal",
        num_workers=7,
    )

    assert "--use_local_docker" in local
    assert "--use_local_docker" not in modal
    assert local[local.index("--num_workers") + 1] == "3"
    assert modal[modal.index("--num_workers") + 1] == "7"
    assert "--raw_sample_path" in local
    assert "--patch_path" in local


def test_build_result_aggregates_right_wrong_and_usage() -> None:
    result = build_result(
        results=[
            {
                "total": 1,
                "passed": 1,
                "failed": 0,
                "token_metrics": {
                    "input_tokens": 20,
                    "output_tokens": 3,
                    "total_tokens": 23,
                    "cached_tokens": 5,
                    "llm_call_count": 2,
                },
            },
            {
                "total": 1,
                "passed": 0,
                "failed": 1,
                "token_metrics": {
                    "input_tokens": 5,
                    "output_tokens": 7,
                    "total_tokens": 12,
                    "cached_tokens": 0,
                    "llm_call_count": 1,
                },
            },
        ],
        task_agent="elizaos",
        model_provider="cerebras",
        model="gpt-oss-120b",
        mode="live",
    )

    assert result["summary"]["total"] == 2
    assert result["summary"]["passed"] == 1
    assert result["summary"]["failed"] == 1
    assert result["summary"]["score"] == 0.5
    assert result["summary"]["input_tokens"] == 25
    assert result["summary"]["output_tokens"] == 10
    assert result["summary"]["total_tokens"] == 35
    assert result["summary"]["cached_token_percent"] == 20.0
    assert result["summary"]["llm_call_count"] == 3
