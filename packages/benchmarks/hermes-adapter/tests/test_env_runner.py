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
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
import hermes_adapter.env_runner as env_runner

from hermes_adapter.env_runner import (
    ENV_MODULES,
    HermesEnvResult,
    build_evaluate_command,
    parse_hermes_env_result,
    run_hermes_env,
)


@pytest.fixture
def fake_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
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
    monkeypatch.setattr(
        env_runner,
        "_verify_source_checkout",
        lambda repo, env_id, venv_python: env_runner.PINNED_HERMES_ENV_REVISION,
    )
    monkeypatch.setattr(
        env_runner,
        "_verify_pinned_dataset",
        lambda source, venv_python: {
            "name": source.dataset,
            "revision": source.revision,
            "actual_count": source.expected_count,
        },
    )
    monkeypatch.setattr(
        env_runner,
        "_git_revision",
        lambda repo: env_runner.PINNED_YC_BENCH_REVISION,
    )
    monkeypatch.setattr(env_runner, "_verify_yc_presets", lambda yc_path: None)
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


def test_env_runner_rejects_summary_without_a_score(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "yc_bench"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(json.dumps({"metrics": {"weird_key": 1}}))
    (evals_root / "samples.jsonl").write_text("")
    with pytest.raises(RuntimeError, match="no recognized score"):
        parse_hermes_env_result(
            env_id="yc_bench", evals_root=evals_root, duration_s=0.1
        )


def test_env_runner_rejects_placeholder_metric(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "hermes_swe_env"
    evals_root.mkdir(parents=True)
    (evals_root / "metrics.json").write_text(json.dumps({"placeholder": 0.0}))
    (evals_root / "samples.jsonl").write_text("")
    with pytest.raises(RuntimeError, match="no recognized score"):
        parse_hermes_env_result(
            env_id="hermes_swe_env",
            evals_root=evals_root,
            duration_s=0.1,
        )


def test_env_runner_counts_incomplete_rollouts(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"metrics": {"pass_rate": 0.0}})
    )
    (evals_root / "samples.jsonl").write_text(
        json.dumps(
            {
                "passed": False,
                "messages": [
                    {"role": "user", "content": "fix it"},
                    {"role": "assistant", "tool_calls": []},
                    {"role": "tool", "content": "ok"},
                ],
            }
        )
        + "\n"
    )

    result = parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=0.1)

    assert result.metrics["sample_rows"] == 1
    assert result.metrics["incomplete_rollouts"] == 1


def test_env_runner_worked_rollout_ending_on_tool_is_complete(tmp_path: Path) -> None:
    """A rollout with real agent turns that ends on a tool result is a
    resource-bounded failure (scoreable); only zero-work rollouts stay
    incomplete. The campaign runs without an artificial turn budget, so hard
    tasks routinely terminate exactly this way."""
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"metrics": {"pass_rate": 0.0}})
    )
    (evals_root / "samples.jsonl").write_text(
        json.dumps(
            {
                "passed": False,
                "turns_used": 37,
                "messages": [
                    {"role": "user", "content": "fix it"},
                    {"role": "assistant", "tool_calls": []},
                    {"role": "tool", "content": "wall clock ended here"},
                ],
            }
        )
        + "\n"
        + json.dumps(
            {
                "passed": False,
                "turns_used": 0,
                "messages": [
                    {"role": "user", "content": "fix it"},
                    {"role": "assistant", "tool_calls": []},
                    {"role": "tool", "content": "died before any turn"},
                ],
            }
        )
        + "\n"
    )

    result = parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=0.1)

    assert result.metrics["sample_rows"] == 2
    assert result.metrics["incomplete_rollouts"] == 1


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


def test_env_runner_raises_when_summary_has_no_samples(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"metrics": {"accuracy": 0.5}})
    )
    with pytest.raises(FileNotFoundError, match="no samples.jsonl"):
        parse_hermes_env_result(env_id="tblite", evals_root=evals_root, duration_s=1.0)


def test_env_runner_rejects_incomplete_sample_count(tmp_path: Path) -> None:
    evals_root = tmp_path / "evals" / "tblite"
    evals_root.mkdir(parents=True)
    (evals_root / "eval-summary.json").write_text(
        json.dumps({"metrics": {"accuracy": 0.5}})
    )
    (evals_root / "samples.jsonl").write_text("{}\n")
    with pytest.raises(RuntimeError, match="produced 1 samples; expected 100"):
        parse_hermes_env_result(
            env_id="tblite",
            evals_root=evals_root,
            duration_s=1.0,
            expected_samples=100,
        )


def test_env_modules_table_has_all_four_envs() -> None:
    assert set(ENV_MODULES) == {"tblite", "terminalbench_2", "yc_bench", "hermes_swe_env"}


def test_pinned_dataset_preflight_rejects_fingerprint_drift(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = env_runner.ENV_SOURCES["tblite"]

    def fake_run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        check_env = kwargs.get("env")
        assert isinstance(check_env, dict)
        assert check_env["HF_HUB_OFFLINE"] == "1"
        assert check_env["HF_DATASETS_OFFLINE"] == "1"
        return subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps({"count": source.expected_count, "fingerprint": "drifted"})
            + "\n",
            stderr="",
        )

    monkeypatch.setattr(env_runner, "_subprocess_run", fake_run)

    with pytest.raises(RuntimeError, match="fingerprint"):
        env_runner._verify_pinned_dataset(source, venv_python=tmp_path / "python")


def test_env_runner_max_tasks_uses_supported_smoke_filter(fake_repo: Path, tmp_path: Path) -> None:
    """run_hermes_env(max_tasks=N) must use a supported env-specific smoke cap."""
    captured_cmd: list[str] = []

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_cmd.extend(cmd)
        # Write a minimal eval-summary + samples so parse_hermes_env_result succeeds.
        save_dir = tmp_path / "out" / "evals" / "tblite"
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.9}}))
        (save_dir / "samples.jsonl").write_text("{}\n")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run):
        result = run_hermes_env(
            "tblite",
            output_dir=tmp_path / "out",
            repo_path=fake_repo,
            max_tasks=1,
            model="m",
            api_key="key",
            base_url="https://x",
        )

    assert "--env.task_filter=broken-python" in captured_cmd
    assert result.score == pytest.approx(0.9)


def test_env_runner_task_filter_flag_present_when_set(fake_repo: Path, tmp_path: Path) -> None:
    captured_cmd: list[str] = []

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_cmd.extend(cmd)
        save_dir = tmp_path / "out" / "evals" / "tblite"
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.5}}))
        (save_dir / "samples.jsonl").write_text("{}\n{}\n")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run):
        run_hermes_env(
            "tblite",
            output_dir=tmp_path / "out",
            repo_path=fake_repo,
            task_filter="broken-python,pandas-etl",
            model="m",
            api_key="key",
        )
    assert "--env.task_filter=broken-python,pandas-etl" in captured_cmd


def test_env_runner_sets_terminal_env_docker_when_available(fake_repo: Path, tmp_path: Path) -> None:
    """TERMINAL_ENV defaults to Docker when a local Docker daemon is available."""
    captured_env: dict[str, str] = {}
    captured_cmd: list[str] = []

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_cmd.extend(cmd)
        captured_env.update(kwargs.get("env") or {})
        save_dir = tmp_path / "out" / "evals" / "tblite"
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.1}}))
        (save_dir / "samples.jsonl").write_text("{}\n")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner._docker_daemon_available", return_value=True), patch(
        "hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run
    ):
        run_hermes_env(
            "tblite",
            output_dir=tmp_path / "out",
            repo_path=fake_repo,
            model="m",
            api_key="key",
            base_url="https://b",
            max_tasks=1,
        )
    assert captured_env.get("TERMINAL_ENV") == "docker"
    assert captured_env.get("OPENAI_API_KEY") == "key"
    assert captured_env.get("OPENAI_BASE_URL") == "https://b"
    assert captured_env.get("OPENAI_MODEL") == "m"
    assert "--env.terminal_backend=docker" in captured_cmd


def test_env_runner_writes_terminal_prompt_and_temperature(
    fake_repo: Path, tmp_path: Path
) -> None:
    captured_config = {"text": ""}

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        config_index = cmd.index("--config") + 1
        captured_config["text"] = Path(cmd[config_index]).read_text(encoding="utf-8")
        save_dir = tmp_path / "out" / "evals" / "tblite"
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.1}}))
        (save_dir / "samples.jsonl").write_text("{}\n")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner._docker_daemon_available", return_value=True), patch(
        "hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run
    ):
        run_hermes_env(
            "tblite",
            output_dir=tmp_path / "out",
            repo_path=fake_repo,
            model="m",
            max_tasks=1,
        )

    config_text = captured_config["text"]
    assert "agent_temperature: 0.0" in config_text
    assert "system_prompt:" in config_text
    assert "Use the available terminal and file tools" in config_text


def test_env_runner_refuses_local_fallback_when_docker_is_unavailable(
    fake_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing Docker daemon is incompatibility, not permission to run on host."""
    monkeypatch.setenv("TERMINAL_ENV", "modal")
    captured_env: dict[str, str] = {}

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured_env.update(kwargs.get("env") or {})
        save_dir = tmp_path / "out" / "evals" / "tblite"
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.0}}))
        (save_dir / "samples.jsonl").write_text("{}\n")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner._docker_daemon_available", return_value=False):
        with pytest.raises(RuntimeError, match="requires Docker"):
            run_hermes_env(
                "tblite",
                output_dir=tmp_path / "out",
                repo_path=fake_repo,
                model="m",
                max_tasks=1,
            )
    assert not captured_env


def test_env_runner_invokes_correct_env_script_for_each_env(
    fake_repo: Path, tmp_path: Path
) -> None:
    """Smoke: for each of the 4 supported env_ids, the spawned argv references the
    canonical env script path."""
    for env_id, expected_module in ENV_MODULES.items():
        if env_id == "hermes_swe_env":
            with pytest.raises(RuntimeError, match="placeholder"):
                run_hermes_env(
                    env_id,
                    output_dir=tmp_path / env_id,
                    repo_path=fake_repo,
                    model="m",
                )
            continue
        captured: list[str] = []
        out = tmp_path / env_id
        save_dir = out / "evals" / env_id
        save_dir.mkdir(parents=True)
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.0}}))
        (save_dir / "samples.jsonl").write_text("{}\n")

        def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            captured.extend(cmd)
            return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

        with patch("hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run):
            run_hermes_env(
                env_id,
                output_dir=out,
                repo_path=fake_repo,
                model="m",
                max_tasks=1,
                force=True,
            )
        assert str(fake_repo / expected_module) in captured, env_id
        assert "evaluate" in captured, env_id


def test_env_runner_rejects_unprovenanced_cached_result(
    fake_repo: Path, tmp_path: Path
) -> None:
    out = tmp_path / "out"
    save_dir = out / "evals" / "tblite"
    save_dir.mkdir(parents=True)
    (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.71}}))
    (save_dir / "samples.jsonl").write_text("{}\n")

    with patch(
        "hermes_adapter.env_runner.subprocess.run",
        side_effect=AssertionError("must not spawn subprocess"),
    ):
        with pytest.raises(RuntimeError, match="no run provenance"):
            run_hermes_env(
                "tblite",
                output_dir=out,
                repo_path=fake_repo,
                model="m",
                max_tasks=1,
            )


def test_env_runner_force_reruns_even_when_cached(fake_repo: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    save_dir = out / "evals" / "tblite"
    save_dir.mkdir(parents=True)
    (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.1}}))
    (save_dir / "samples.jsonl").write_text("{}\n")

    spawn_count = {"n": 0}

    def _fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        spawn_count["n"] += 1
        # Re-write with a different score to confirm the rerun result is what's returned.
        (save_dir / "eval-summary.json").write_text(json.dumps({"metrics": {"accuracy": 0.99}}))
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")

    with patch("hermes_adapter.env_runner.subprocess.run", side_effect=_fake_run):
        result = run_hermes_env(
            "tblite",
            output_dir=out,
            repo_path=fake_repo,
            model="m",
            max_tasks=1,
            force=True,
        )
    assert spawn_count["n"] == 1
    assert result.score == pytest.approx(0.99)
