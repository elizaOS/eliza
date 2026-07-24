"""App Eval bridge tests keep the full local corpus and deterministic rubrics authoritative."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from eliza_adapter.app_eval import (
    _load_evaluate_result,
    _load_tasks,
    _run_task,
    _task_provenance,
)


APP_EVAL_DIR = Path(__file__).resolve().parents[2] / "app-eval"
TASKS_DIR = APP_EVAL_DIR / "tasks"
REPO_ROOT = Path(__file__).resolve().parents[4]


def test_full_task_manifests_are_complete_and_provenanced() -> None:
    tasks = _load_tasks(TASKS_DIR, task_type=None, task_id=None)
    provenance = _task_provenance(TASKS_DIR, task_type=None)

    assert len(tasks) == 20
    assert {task["type"] for task in tasks} == {"research", "coding"}
    assert [manifest["task_count"] for manifest in provenance["manifests"]] == [
        10,
        10,
    ]
    assert all(len(manifest["sha256"]) == 64 for manifest in provenance["manifests"])


def test_task_loader_fails_when_a_selected_manifest_is_incomplete(
    tmp_path: Path,
) -> None:
    tasks = [
        {"id": f"research-{index}", "type": "research", "prompt": "Research"}
        for index in range(9)
    ]
    (tmp_path / "research-tasks.json").write_text(
        json.dumps(tasks),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="exactly 10 tasks"):
        _load_tasks(tmp_path, task_type="research", task_id=None)


def test_nonempty_response_uses_authored_rubric_instead_of_receiving_ten(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "eliza")
    task = _load_tasks(TASKS_DIR, task_type="research", task_id="research-001")[0]
    evaluator = _load_evaluate_result(TASKS_DIR)

    class Client:
        context: dict[str, object] | None = None

        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **kwargs: object) -> SimpleNamespace:
            context = kwargs.get("context")
            assert isinstance(context, dict)
            self.context = context
            return SimpleNamespace(
                text="A short generic answer.",
                actions=[],
                params={"usage": {"total_tokens": 7}},
                metadata={
                    "agent_label": "eliza",
                    "native_runtime_class": "@elizaos/core.AgentRuntime",
                    "native_runtime_api": "messageService.handleMessage",
                    "transport": "eliza_benchmark_http",
                    "tool_bridge": "native_action_capture",
                    "release_evidence": True,
                    "direct_model_bypass": False,
                    "stand_in": False,
                },
            )

    client = Client()
    result = _run_task(client, task, 1_000, evaluator)  # type: ignore[arg-type]

    assert result["success"] is True
    assert 0 <= result["score"] < 10
    assert result["evaluation"]["task_id"] == "research-001"
    assert client.context is not None
    assert "expected" not in client.context
    assert "evaluation" not in client.context
    assert result["runtime_provenance"]["metadata"]["agent_label"] == "eliza"
    assert result["usage"] == {"total_tokens": 7}


def test_research_task_rejects_missing_native_runtime_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ELIZA_BENCH_HARNESS", "eliza")
    task = _load_tasks(TASKS_DIR, task_type="research", task_id="research-001")[0]
    evaluator = _load_evaluate_result(TASKS_DIR)

    class Client:
        def reset(self, **_kwargs: object) -> None:
            return None

        def send_message(self, **_kwargs: object) -> SimpleNamespace:
            return SimpleNamespace(
                text="A plausible answer from an unknown path.",
                actions=[],
                params={},
                metadata={},
            )

    result = _run_task(Client(), task, 1_000, evaluator)  # type: ignore[arg-type]

    assert result["success"] is False
    assert result["infrastructure_error"] is True
    assert "nonpublishable native runtime provenance" in result["error"]


def test_mixed_mock_cli_is_structurally_complete_but_nonpublishable(
    tmp_path: Path,
) -> None:
    output = tmp_path / "summary.json"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT / "packages" / "benchmarks" / "eliza-adapter")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "eliza_adapter.app_eval",
            "--tasks-dir",
            str(TASKS_DIR),
            "--output",
            str(output),
            "--mock",
        ],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode != 0
    summary = json.loads(output.read_text(encoding="utf-8"))
    assert summary["total_tasks"] == 20
    assert summary["mode"] == "mock-nonpublishable"
    assert summary["publishable"] is False
    assert summary["scores"]["research"]["total"] == 10
    assert summary["scores"]["coding"]["total"] == 10
    assert summary["scores"]["coding"]["completed"] == 0
    assert all(
        "workspace" in str(item["error"])
        for item in summary["results"]
        if item["type"] == "coding"
    )


def test_research_cli_runs_all_ten_authored_tasks(tmp_path: Path) -> None:
    output = tmp_path / "summary.json"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT / "packages" / "benchmarks" / "eliza-adapter")
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "eliza_adapter.app_eval",
            "--tasks-dir",
            str(TASKS_DIR),
            "--output",
            str(output),
            "--type",
            "research",
            "--mock",
        ],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    summary = json.loads(output.read_text(encoding="utf-8"))
    assert summary["total_tasks"] == 10
    assert [item["type"] for item in summary["results"]] == ["research"] * 10


def test_publishable_run_with_imperfect_score_exits_zero() -> None:
    """A real run that measured the model (infrastructure OK) exits 0 even when
    the model scored low — e.g. gemma failed 10/20 coding tasks. Regression for
    the campaign marking app-eval a cohort failure on a valid low score."""
    from eliza_adapter.app_eval import app_eval_exit_code

    # Publishable measurement, imperfect score → success.
    assert app_eval_exit_code(publishable=True, structural_mock_ok=False) == 0
    # Infrastructure failure (not publishable, not a structural mock) → failure.
    assert app_eval_exit_code(publishable=False, structural_mock_ok=False) == 1
    # Mock research (no coding) is a structural pass.
    assert app_eval_exit_code(publishable=False, structural_mock_ok=True) == 0
