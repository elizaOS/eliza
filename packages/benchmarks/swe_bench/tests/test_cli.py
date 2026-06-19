"""Tests for SWE-bench CLI reporting helpers."""

import pytest
import subprocess
import sys
from pathlib import Path

import benchmarks.swe_bench.cli as swe_cli
from benchmarks.swe_bench.cli import (
    _BaselineClient,
    _build_client_for_harness,
    _build_prompt,
    _build_repair_prompt,
    _build_report,
    _candidate_context_paths,
    _capability_report,
    _default_task_agent_provider,
    _expand_instances,
    _harness_turn_cost_usd,
    _mock_instance,
    _opencode_config_content,
    _parse_required_capabilities,
    _report_to_dict,
    _run_eliza_worktree_instance,
    _run_instance,
    _run_opencode_patchfile_instance,
    _run_subtask_provider_instance,
    _scenario_counts,
    _subtask_provider_command,
    _validate_instances,
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


def test_build_report_counts_no_docker_pass_as_applied() -> None:
    report = _build_report(
        SWEBenchConfig(),
        [
            SWEBenchResult(
                instance_id="repo__project-1",
                generated_patch="diff --git a/file.py b/file.py",
                patch_status=PatchStatus.PASS,
                tests_passed=[],
                tests_failed=[],
                success=True,
                duration_seconds=1.0,
                tokens_used=None,
                status="smoke_validated",
            )
        ],
    )

    assert report.apply_rate == 1.0


def test_scenario_expansion_adds_ten_edge_prompts_per_instance() -> None:
    instances = [_mock_instance()]

    expanded = _expand_instances(instances, expand_scenarios=True)

    assert _scenario_counts(instances, expand_scenarios=True) == {
        "base": 1,
        "edge": 10,
        "total": 11,
    }
    assert len(expanded) == 11
    assert expanded[0].instance_id == instances[0].instance_id
    assert expanded[1].instance_id == instances[0].instance_id
    assert "Additional benchmark edge condition 01" in expanded[1].problem_statement
    assert _validate_instances(instances, expand_scenarios=True)["valid"] is True


def test_capability_report_flags_unknown_provider_missing_caps() -> None:
    report = _capability_report("unknown-provider", ["code.read"])

    assert report["satisfied"] is False
    assert report["missing"] == ["code.read"]


def test_default_task_agent_provider_prefers_elizaos_without_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for key in (
        "BENCHMARK_TASK_AGENT",
        "CEREBRAS_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDE_CODE_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)

    assert _default_task_agent_provider() == "elizaos"


def test_default_task_agent_provider_uses_codex_for_openai_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCHMARK_TASK_AGENT", raising=False)
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    assert _default_task_agent_provider() == "codex"


def test_default_task_agent_provider_uses_claude_for_anthropic_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCHMARK_TASK_AGENT", raising=False)
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
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


def test_build_prompt_includes_test_targets_and_narrow_patch_guidance() -> None:
    prompt = _build_prompt(_mock_instance())

    assert "Fail-to-pass tests named by SWE-bench:" in prompt
    assert "- test_hello" in prompt
    assert "Prefer the smallest local edit" in prompt
    assert "Do not replace whole classes" in prompt
    assert "@@ -12,7 +12,9 @@" in prompt
    assert "do not use bare `@@`" in prompt


def test_candidate_context_paths_infer_source_from_test_path() -> None:
    instance = _mock_instance()
    instance.repo = "astropy/astropy"
    instance.problem_statement = (
        "Traceback references astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows"
    )

    candidates = _candidate_context_paths(instance)

    assert "astropy/io/ascii/tests/test_rst.py" in candidates
    assert "astropy/io/ascii/rst.py" in candidates


def test_candidate_context_paths_scan_swe_test_targets() -> None:
    instance = _mock_instance()
    instance.repo = "astropy/astropy"
    instance.problem_statement = "Header rows fail for RST writer."
    instance.fail_to_pass = [
        "astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows"
    ]

    candidates = _candidate_context_paths(instance)

    assert "astropy/io/ascii/tests/test_rst.py" in candidates
    assert "astropy/io/ascii/rst.py" in candidates


def test_extract_patch_rejects_bare_hunk_headers() -> None:
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
    )

    assert swe_cli._extract_patch(response) == ""


def test_extract_patch_strips_model_end_of_file_marker() -> None:
    response = (
        "```diff\n"
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ -1 +1 @@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
        "*** End of File ***\n"
        "```\n"
    )

    patch = swe_cli._extract_patch(response)

    assert patch.startswith("diff --git a/hello.py b/hello.py")
    assert "*** End of File ***" not in patch
    assert "+print('fixed')" in patch


def test_extract_patch_recovers_diff_header_embedded_after_prose() -> None:
    response = (
        "We need to write diff."
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ -1 +1 @@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
    )

    patch = swe_cli._extract_patch(response)

    assert patch.startswith("diff --git a/hello.py b/hello.py")
    assert "+print('fixed')" in patch


def test_extract_patch_for_repo_repairs_bare_hunk_headers(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text("print('hello')\nprint('bye')\n", encoding="utf-8")
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
        " print('bye')\n"
        "*** End of File ***\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "@@ -1,2 +1,2 @@" in patch
    assert "*** End of File ***" not in patch
    assert "+print('fixed')" in patch


def test_extract_patch_for_repo_adds_missing_file_headers(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text("print('hello')\n", encoding="utf-8")
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "index 1111111..2222222 100644\n"
        "@@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "--- a/hello.py" in patch
    assert "+++ b/hello.py" in patch
    assert "@@ -1 +1 @@" in patch


def test_extract_patch_for_repo_drops_context_only_bare_hunks(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "def greet():\n"
        "    print('hello')\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        " def greet():\n"
        "@@\n"
        "-    print('hello')\n"
        "+    print('fixed')\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "@@ -1,2 +1,2 @@" in patch
    assert " def greet()" in patch
    assert "+    print('fixed')" in patch


def test_extract_patch_for_repo_repairs_bare_hunk_headers_with_sections(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "def greet():\n"
        "    print('hello')\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ def greet():\n"
        "-    print('hello')\n"
        "+    print('fixed')\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "@@ -1,2 +1,2 @@ def greet():" in patch
    assert " def greet()" in patch
    assert "+    print('fixed')" in patch


def test_extract_patch_for_repo_drops_noop_bare_hunks(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "def greet():\n"
        "    print('hello')\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-def greet():\n"
        "+def greet():\n"
        "@@\n"
        "-    print('hello')\n"
        "+    print('fixed')\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "-def greet()" not in patch
    assert "+def greet()" not in patch
    assert "@@ -1,2 +1,2 @@" in patch
    assert " def greet()" in patch
    assert "+    print('fixed')" in patch


def test_extract_patch_for_repo_expands_zero_context_hunks(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "before\n"
        "bug\n"
        "after\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-bug\n"
        "+fixed\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "@@ -1,3 +1,3 @@" in patch
    assert " before" in patch
    assert " after" in patch
    assert "+fixed" in patch


def test_extract_patch_for_repo_preserves_blank_context_lines(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "before\n"
        "bug\n"
        "\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-bug\n"
        "+fixed\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "\n \n" in patch


def test_extract_patch_for_repo_adds_trailing_context_for_terminal_change(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "hello.py").write_text(
        "def greet():\n"
        "    before()\n"
        "    bug()\n"
        "\n"
        "def later():\n"
        "    pass\n",
        encoding="utf-8",
    )
    response = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        " def greet():\n"
        "     before()\n"
        "-    bug()\n"
        "+    fixed()\n"
    )

    patch = swe_cli._extract_patch_for_repo(response, repo)

    assert "\n \n" in patch
    assert "+    fixed()" in patch


def test_build_repair_prompt_includes_evaluator_feedback() -> None:
    result = SWEBenchResult(
        instance_id="mock__swe-bench-1",
        generated_patch="diff --git a/hello.py b/hello.py",
        patch_status=PatchStatus.TESTS_FAILED,
        tests_passed=["test_existing"],
        tests_failed=["test_hello"],
        success=False,
        duration_seconds=1.0,
        tokens_used=None,
        error="assertion failed",
    )

    prompt = _build_repair_prompt(_mock_instance(), result.generated_patch, result)

    assert "Failed tests from the previous official evaluation:" in prompt
    assert "- test_hello" in prompt
    assert "assertion failed" in prompt
    assert "Previous patch:" in prompt


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
    assert cmd[cmd.index("--model") + 1] == "cerebras-bench/gpt-oss-120b"
    assert "--dangerously-skip-permissions" in cmd


def test_opencode_config_registers_cerebras_openai_compatible() -> None:
    config = _opencode_config_content("cerebras-bench/gpt-oss-120b")
    parsed = __import__("json").loads(config)

    provider = parsed["provider"]["cerebras-bench"]
    assert provider["npm"] == "@ai-sdk/openai-compatible"
    assert provider["options"]["baseURL"] == "https://api.cerebras.ai/v1"
    assert provider["models"]["gpt-oss-120b"]["reasoning"] is False
    assert parsed["model"] == "cerebras-bench/gpt-oss-120b"


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


@pytest.mark.asyncio
async def test_opencode_patchfile_flow_does_not_score_patchfile_itself(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "sample.py").write_text("print('bug')\n", encoding="utf-8")
    subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True)

    fake = tmp_path / "opencode"
    fake.write_text("#!/usr/bin/env bash\ncat >/dev/null\nexit 1\n", encoding="utf-8")
    fake.chmod(0o755)
    monkeypatch.setenv("OPENCODE_BIN", str(fake))

    async def fake_setup(self, instance):
        self.current_repo = repo
        self._current_repo_resolved = repo.resolve()
        self.current_instance = instance
        return repo

    monkeypatch.setattr(swe_cli.RepositoryManager, "setup_repo", fake_setup)

    class FakeClient:
        def reset(self, *, task_id, benchmark):
            pass

        def send_message(self, *, text, context):
            patch = (
                "diff --git a/sample.py b/sample.py\n"
                "--- a/sample.py\n"
                "+++ b/sample.py\n"
                "@@\n"
                "-print('bug')\n"
                "+print('fixed')\n"
            )
            return type("Response", (), {"text": patch, "params": {}})()

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

    result = await _run_opencode_patchfile_instance(
        FakeClient(),
        instance,
        FakeEvaluator(),
        SWEBenchConfig(workspace_dir=str(tmp_path / "workspace"), timeout_seconds=30),
        "gpt-oss-120b",
    )

    assert ".swe-bench-opencode.patch" not in result.generated_patch
    assert "+print('fixed')" in result.generated_patch


@pytest.mark.asyncio
async def test_elizaos_run_instance_repairs_failed_patch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SWE_BENCH_REPAIR_ATTEMPTS", raising=False)

    first_patch = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ -1 +1 @@\n"
        "-print('hello')\n"
        "+print('still broken')\n"
    )
    repaired_patch = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ -1 +1 @@\n"
        "-print('hello')\n"
        "+print('hello swe-bench')\n"
    )

    class FakeClient:
        def __init__(self):
            self.calls = []

        def reset(self, *, task_id, benchmark):
            self.calls.append(("reset", task_id, benchmark))

        def send_message(self, *, text, context):
            self.calls.append(("send", text, context))
            patch = repaired_patch if context.get("phase") == "patch_repair" else first_patch
            return type("Response", (), {"text": patch, "params": {}})()

    class FakeEvaluator:
        def __init__(self):
            self.seen_patches = []

        async def evaluate_patch(self, instance, patch):
            self.seen_patches.append(patch)
            if "still broken" in patch:
                return SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch=patch,
                    patch_status=PatchStatus.TESTS_FAILED,
                    tests_passed=[],
                    tests_failed=["test_hello"],
                    success=False,
                    duration_seconds=0.0,
                    tokens_used=None,
                    error="expected greeting",
                )
            return SWEBenchResult(
                instance_id=instance.instance_id,
                generated_patch=patch,
                patch_status=PatchStatus.TESTS_PASSED,
                tests_passed=["test_hello"],
                tests_failed=[],
                success=True,
                duration_seconds=0.0,
                tokens_used=None,
            )

    client = FakeClient()
    evaluator = FakeEvaluator()
    result = await _run_instance(
        client,
        _mock_instance(),
        evaluator,
        provider_label="elizaos",
        model_name="gpt-oss-120b",
    )

    assert result.success is True
    assert result.generated_patch == repaired_patch
    assert len(evaluator.seen_patches) == 2
    repair_calls = [
        call for call in client.calls
        if call[0] == "send" and call[2].get("phase") == "patch_repair"
    ]
    assert len(repair_calls) == 1
    assert "expected greeting" in repair_calls[0][1]


@pytest.mark.asyncio
async def test_generate_patch_retries_malformed_unified_diff() -> None:
    malformed_patch = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@\n"
        "-print('hello')\n"
        "+print('broken')\n"
    )
    valid_patch = (
        "diff --git a/hello.py b/hello.py\n"
        "--- a/hello.py\n"
        "+++ b/hello.py\n"
        "@@ -1 +1 @@\n"
        "-print('hello')\n"
        "+print('fixed')\n"
    )

    class FakeClient:
        def __init__(self):
            self.calls = []

        def reset(self, *, task_id, benchmark):
            self.calls.append(("reset", task_id, benchmark))

        def send_message(self, *, text, context):
            self.calls.append(("send", text, context))
            patch = (
                valid_patch
                if context.get("phase") == "patch_generation_retry"
                else malformed_patch
            )
            return type("Response", (), {"text": patch, "params": {}})()

    client = FakeClient()

    patch, error = await swe_cli._generate_patch_with_client(
        client,
        _mock_instance(),
        "elizaos",
        "gpt-oss-120b",
    )

    assert error is None
    assert patch == valid_patch
    retry_calls = [
        call for call in client.calls
        if call[0] == "send" and call[2].get("phase") == "patch_generation_retry"
    ]
    assert len(retry_calls) == 1
    assert "never use bare `@@`" in retry_calls[0][1]


@pytest.mark.asyncio
async def test_eliza_worktree_applies_and_scores_worktree_diff(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "sample.py").write_text("print('bug')\n", encoding="utf-8")
    subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True)

    async def fake_setup(self, instance):
        self.current_repo = repo
        self._current_repo_resolved = repo.resolve()
        self.current_instance = instance
        return repo

    monkeypatch.setattr(swe_cli.RepositoryManager, "setup_repo", fake_setup)

    class FakeClient:
        def reset(self, *, task_id, benchmark):
            pass

        def send_message(self, *, text, context):
            patch = (
                "diff --git a/sample.py b/sample.py\n"
                "--- a/sample.py\n"
                "+++ b/sample.py\n"
                "@@ -1 +1 @@\n"
                "-print('bug')\n"
                "+print('fixed')\n"
            )
            return type("Response", (), {"text": patch, "params": {}})()

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

    result = await _run_eliza_worktree_instance(
        FakeClient(),
        instance,
        FakeEvaluator(),
        SWEBenchConfig(workspace_dir=str(tmp_path / "workspace"), timeout_seconds=30),
        "gpt-oss-120b",
        "elizaos",
    )

    assert result.success is True
    assert "native_worktree provider=elizaos" in result.status
    assert "@@ -1 +1 @@" in result.generated_patch
    assert "+print('fixed')" in result.generated_patch


@pytest.mark.asyncio
async def test_eliza_worktree_records_repair_status(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / "sample.py").write_text("print('bug')\n", encoding="utf-8")
    subprocess.run(["git", "add", "sample.py"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=repo, check=True)

    async def fake_setup(self, instance):
        self.current_repo = repo
        self._current_repo_resolved = repo.resolve()
        self.current_instance = instance
        return repo

    monkeypatch.setattr(swe_cli.RepositoryManager, "setup_repo", fake_setup)

    class FakeClient:
        def __init__(self):
            self.calls = []

        def reset(self, *, task_id, benchmark):
            pass

        def send_message(self, *, text, context):
            self.calls.append((text, context))
            if context.get("phase") == "native_worktree_patch_repair":
                patch = (
                    "diff --git a/sample.py b/sample.py\n"
                    "--- a/sample.py\n"
                    "+++ b/sample.py\n"
                    "@@\n"
                    "-print('bug')\n"
                    "+print('fixed')\n"
                )
            else:
                patch = (
                    "diff --git a/sample.py b/sample.py\n"
                    "--- a/sample.py\n"
                    "+++ b/sample.py\n"
                    "@@ -1 +1 @@\n"
                    "-print('bug')\n"
                    "+print('still broken')\n"
                )
            return type("Response", (), {"text": patch, "params": {}})()

    class FakeEvaluator:
        async def evaluate_patch(self, instance, patch):
            if "still broken" in patch:
                return SWEBenchResult(
                    instance_id=instance.instance_id,
                    generated_patch=patch,
                    patch_status=PatchStatus.TESTS_FAILED,
                    tests_passed=[],
                    tests_failed=["test_sample"],
                    success=False,
                    duration_seconds=0.0,
                    tokens_used=None,
                    error="sample failed",
                )
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
    client = FakeClient()

    result = await _run_eliza_worktree_instance(
        client,
        instance,
        FakeEvaluator(),
        SWEBenchConfig(workspace_dir=str(tmp_path / "workspace"), timeout_seconds=30),
        "gpt-oss-120b",
        "elizaos",
    )

    assert result.success is True
    assert "repaired_from=tests_failed" in result.status
    assert "repair_attempts=1" in result.status
    assert any(
        context.get("phase") == "native_worktree_patch_repair"
        for _, context in client.calls
    )
