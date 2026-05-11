"""Tests for ``hermes_adapter.env_runner``.

Every subprocess call is mocked. The tests assert that:

  - ``build_evaluate_command`` produces the canonical
    ``python <env_module> evaluate --openai.model_name=<m> --env.data_dir_to_save_evals=<d>``
    invocation for each of the four supported env_ids.
  - ``parse_hermes_env_result`` consumes a fake ``eval-summary.json`` +
    ``samples.jsonl`` and emits a well-formed ``HermesEnvResult``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hermes_adapter.env_runner import (
    ENV_MODULES,
    HermesEnvResult,
    build_evaluate_command,
    parse_hermes_env_result,
)


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "hermes-agent-src"
    repo.mkdir()
    venv_python = repo / ".venv" / "bin" / "python"
    venv_python.parent.mkdir(parents=True)
    venv_python.write_text("# fake")
    venv_python.chmod(0o755)
    # Create dummy module files so callers that ever check for existence pass.
    for module_path in ENV_MODULES.values():
        target = repo / module_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# fake")
    return repo


@pytest.mark.parametrize(
    "env_id, expected_module",
    [
        ("tblite", "environments/benchmarks/tblite/tblite_env.py"),
        ("terminalbench_2", "environments/benchmarks/terminalbench_2/terminalbench2_env.py"),
        ("yc_bench", "environments/benchmarks/yc_bench/yc_bench_env.py"),
        ("hermes_swe_env", "environments/hermes_swe_env/hermes_swe_env.py"),
    ],
)
def test_env_runner_builds_command(
    fake_repo: Path,
    tmp_path: Path,
    env_id: str,
    expected_module: str,
) -> None:
    """For each env_id, build_evaluate_command must reference the right module."""
    out_dir = tmp_path / "out"
    venv_python = fake_repo / ".venv" / "bin" / "python"
    cmd = build_evaluate_command(
        env_id,
        venv_python=venv_python,
        repo_path=fake_repo,
        output_dir=out_dir,
        model="gpt-oss-120b",
    )
    # Interpreter is the venv python.
    assert cmd[0] == str(venv_python)
    assert "-u" in cmd[:3]
    # The script argument points at the right env module.
    assert str(fake_repo / expected_module) in cmd
    # The CLI verb is `evaluate`.
    assert "evaluate" in cmd
    assert cmd.index("evaluate") > cmd.index(str(fake_repo / expected_module))
    # Required flags must be present.
    joined = " ".join(cmd)
    assert "--openai.model_name=gpt-oss-120b" in joined
    save_dir = out_dir / "evals" / env_id
    assert f"--env.data_dir_to_save_evals={save_dir}" in joined
    assert "--env.use_wandb=false" in joined


def test_env_runner_rejects_unknown_env_id(fake_repo: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Unknown"):
        build_evaluate_command(
            "not-a-real-env",
            venv_python=fake_repo / ".venv" / "bin" / "python",
            repo_path=fake_repo,
            output_dir=tmp_path,
            model="m",
        )


def test_env_runner_forwards_extra_args(fake_repo: Path, tmp_path: Path) -> None:
    cmd = build_evaluate_command(
        "tblite",
        venv_python=fake_repo / ".venv" / "bin" / "python",
        repo_path=fake_repo,
        output_dir=tmp_path,
        model="m",
        extra_args=["--env.task_filter=broken-python,pandas-etl"],
    )
    assert "--env.task_filter=broken-python,pandas-etl" in cmd


def test_env_runner_parses_summary(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"metrics": {"accuracy": 0.42, "tasks_evaluated": 100}})
    )
    (evals_root / "samples.jsonl").write_text(
        json.dumps({"task_name": "broken-python", "passed": True}) + "\n"
    )
    result = parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=12.5)
    assert isinstance(result, HermesEnvResult)
    assert result.env_id == "tblite"
    assert result.score == pytest.approx(0.42)
    assert result.higher_is_better is True
    assert result.duration_s == pytest.approx(12.5)
    assert result.samples_path == evals_root / "samples.jsonl"
    assert result.summary_path == evals_root / "eval-summary.json"
    assert result.metrics["tasks_evaluated"] == 100


def test_env_runner_parses_summary_top_level_metrics(tmp_path: Path) -> None:
    """Some envs write metrics at the top level rather than nested."""
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"pass_rate": 0.73, "n": 50})
    )
    (evals_root / "samples.jsonl").write_text("{}\n")
    result = parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=1.0)
    assert result.score == pytest.approx(0.73)
    assert result.metrics["n"] == 50


def test_env_runner_parses_summary_falls_back_to_zero(tmp_path: Path) -> None:
    """If no recognised score key is present, score=0.0 (still higher-is-better)."""
    evals_root = tmp_path / "evals" / "yc_bench"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(json.dumps({"metrics": {"weird_key": 1}}))
    (evals_root / "samples.jsonl").write_text("")
    result = parse_hermes_env_result(env_id="yc_bench", evals_root=evals_root, duration_s=0.1)
    assert result.score == 0.0
    assert result.higher_is_better is True


def test_env_runner_finds_artifacts_in_subdir(tmp_path: Path) -> None:
    """atroposlib writes under a timestamped subdir — make sure rglob() finds it."""
    evals_root = tmp_path / "evals" / "tblite"
    nested = evals_root / "2026-05-11_00-00-00"
    nested.mkdir(parents=True)
    (nested / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.5}}))
    (nested / "samples.jsonl").write_text("{}\n")
    result = parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=1.0)
    assert result.summary_path == nested / "eval-summary.json"
    assert result.samples_path == nested / "samples.jsonl"


def test_env_runner_raises_when_artifacts_missing(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    with pytest.raises(FileNotFoundError, match="did not produce"):
        parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=1.0)


def test_env_modules_table_has_all_four_envs() -> None:
    assert set(ENV_MODULES) == {"tblite", "terminalbench_2", "yc_bench", "hermes_swe_env"}
