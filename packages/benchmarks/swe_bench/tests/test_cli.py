"""Tests for SWE-bench CLI reporting helpers."""

import pytest
import subprocess
import sys
from pathlib import Path

import benchmarks.swe_bench.cli as swe_cli
from benchmarks.swe_bench.cli import (
    _BaselineClient,
    _build_client_for_harness,
    _build_report,
    _capability_report,
    _default_task_agent_provider,
    _harness_turn_cost_usd,
    _mock_instance,
    _opencode_config_content,
    _parse_required_capabilities,
    _report_to_dict,
    _run_subtask_provider_instance,
    _subtask_provider_command,
)
from benchmarks.swe_bench.types import (
    PatchStatus,
    SWEBenchConfig,
    SWEBenchInstance,
    SWEBenchResult,
)


def test_build_report_ignores_unknown_token_counts_for_average() -> None:
    report = _build_report(
        SWEBenchConfig(),
        [
            SWEBenchResult(
                instance_id="repo__project-1",
                generated_patch="diff --git a/file.py b/file.py",
                patch_status=PatchStatus.GENERATED,
                tests_passed=[],
                tests_failed=[],
                success=False,
                duration_seconds=1.0,
                tokens_used=None,
                status="incompatible",
            ),
            SWEBenchResult(
                instance_id="repo__project-2",
                generated_patch="diff --git a/file.py b/file.py",
                patch_status=PatchStatus.TESTS_PASSED,
                tests_passed=["test_fix"],
                tests_failed=[],
                success=True,
                duration_seconds=3.0,
                tokens_used=12,
            ),
        ],
    )

    assert report.average_tokens == 12.0
    payload = _report_to_dict(report)
    assert payload["results"][0]["status"] == "incompatible"
    assert payload["results"][0]["tokens_used"] is None


def test_parse_required_capabilities_accepts_comma_joined_string() -> None:
    required = _parse_required_capabilities(
        "code.read, code.write,code.read, code.shell"
    )

    assert required == ["code.read", "code.write", "code.shell"]


def test_capability_report_flags_unknown_provider_missing_caps() -> None:
    report = _capability_report("unknown-provider", ["code.read"])

    assert report["satisfied"] is False
    assert report["missing"] == ["code.read"]


def test_default_task_agent_provider_prefers_opencode_without_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in (
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDE_CODE_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    assert _default_task_agent_provider() == "opencode"


def test_default_task_agent_provider_uses_codex_for_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    assert _default_task_agent_provider() == "codex"


def test_default_task_agent_provider_uses_claude_for_anthropic_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CODEX_API_KEY", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")

    assert _default_task_agent_provider() == "claude-code"


def test_openclaw_harness_uses_configured_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENCLAW_DIRECT_OPENAI_COMPAT", "1")

    client, server = _build_client_for_harness("openclaw", model_name="gpt-oss-120b")

    assert server is None
    assert client.model == "gpt-oss-120b"


def test_hermes_harness_uses_configured_cerebras_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hermes_adapter.client import HermesClient

    monkeypatch.setattr(HermesClient, "wait_until_ready", lambda self, timeout: None)

    client, server = _build_client_for_harness(
        "hermes",
        model_name="cerebras/gpt-oss-120b",
    )

    assert server is None
    assert client.model == "gpt-oss-120b"


def test_cerebras_cost_accepts_provider_prefixed_model() -> None:
    cost = _harness_turn_cost_usd(
        "cerebras/gpt-oss-120b",
        {"prompt_tokens": 1_000_000, "completion_tokens": 1_000_000},
    )

    assert cost == pytest.approx(1.10)


def test_baseline_client_supports_always_right_and_wrong() -> None:
    instance = _mock_instance()

    right = _BaselineClient([instance], mode="always-right")
    wrong = _BaselineClient([instance], mode="always-wrong")

    context = {"instance_id": instance.instance_id}
    assert right.send_message(text="", context=context).text == instance.patch
    assert wrong.send_message(text="", context=context).text == ""


def test_baseline_client_random_is_seeded() -> None:
    instance = _mock_instance()
    first = _BaselineClient([instance], mode="random", seed="fixed")
    second = _BaselineClient([instance], mode="random", seed="fixed")

    context = {"instance_id": instance.instance_id}
    assert first.send_message(text="", context=context).text == second.send_message(
        text="", context=context
    ).text


def test_config_validates_baseline_name() -> None:
    with pytest.raises(ValueError, match="baseline must be one of"):
        SWEBenchConfig(baseline="sometimes-right")


def test_opencode_command_uses_stdin_and_cerebras_model(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake = tmp_path / "opencode"
    fake.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    fake.chmod(0o755)
    monkeypatch.setenv("OPENCODE_BIN", str(fake))

    cmd = _subtask_provider_command("opencode", "gpt-oss-120b")

    assert cmd[:2] == [str(fake), "run"]
    assert cmd[cmd.index("--model") + 1] == "cerebras/gpt-oss-120b"
    assert "--dangerously-skip-permissions" in cmd


def test_opencode_config_registers_cerebras_openai_compatible() -> None:
    config = _opencode_config_content("cerebras/gpt-oss-120b")
    parsed = __import__("json").loads(config)

    provider = parsed["provider"]["cerebras"]
    assert provider["npm"] == "@ai-sdk/openai-compatible"
    assert provider["options"]["baseURL"] == "https://api.cerebras.ai/v1"
    assert provider["models"]["gpt-oss-120b"]["reasoning"] is False
    assert provider["models"]["gpt-oss-120b"]["interleaved"] is False
    assert parsed["model"] == "cerebras/gpt-oss-120b"


@pytest.mark.asyncio
async def test_subtask_provider_uses_worktree_diff(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=repo,
        check=True,
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "sample.py").write_text("print('bug')\n", encoding="utf-8")
    subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True)

    fake = tmp_path / "opencode"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "cat >/dev/null\n"
        f"{sys.executable} - <<'PY'\n"
        "from pathlib import Path\n"
        "Path('sample.py').write_text(\"print('fixed')\\n\", encoding='utf-8')\n"
        "PY\n",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    monkeypatch.setenv("OPENCODE_BIN", str(fake))

    async def fake_setup(self, instance):
        self.current_repo = repo
        self._current_repo_resolved = repo.resolve()
        self.current_instance = instance
        return repo

    monkeypatch.setattr(swe_cli.RepositoryManager, "setup_repo", fake_setup)

    class FakeEvaluator:
        async def evaluate_patch(self, instance, patch):
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.TESTS_PASSED,
                tests_passed=["test_sample"],
                tests_failed=[],
                success=True,
                duration_seconds=0.0,
                tokens_used=None,
            )

    instance = SWEBenchInstance(
        instance_id="mock__repo-1",
        repo="mock/repo",
        base_commit="abc123",
        problem_statement="Fix sample.py",
        hints_text="",
        created_at="",
        patch="",
        test_patch="",
        fail_to_pass=[],
        pass_to_pass=[],
    )

    result = await _run_subtask_provider_instance(
        "opencode",
        instance,
        FakeEvaluator(),
        SWEBenchConfig(workspace_dir=str(tmp_path / "workspace"), timeout_seconds=30),
        "gpt-oss-120b",
    )

    assert result.success is True
    assert "subtask_provider=opencode" in result.status
    assert "+print('fixed')" in result.generated_patch
