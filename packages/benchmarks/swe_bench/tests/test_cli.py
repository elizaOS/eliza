"""Tests for SWE-bench CLI reporting helpers."""

import pytest

from benchmarks.swe_bench.cli import (
    _BaselineClient,
    _build_client_for_harness,
    _build_report,
    _capability_report,
    _default_task_agent_provider,
    _extract_patch,
    _harness_turn_cost_usd,
    _mock_instance,
    _parse_required_capabilities,
    _report_to_dict,
)
from benchmarks.swe_bench.types import (
    PatchStatus,
    SWEBenchConfig,
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
                tokens_used=1,
            )
        ],
    )

    assert report.apply_rate == 1.0


def test_extract_patch_accepts_fence_without_newline_after_language() -> None:
    patch = _extract_patch(
        "```diff --git a/file.py b/file.py\n"
        "--- a/file.py\n"
        "+++ b/file.py\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
        "```"
    )

    assert patch.startswith("diff --git a/file.py b/file.py")


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
