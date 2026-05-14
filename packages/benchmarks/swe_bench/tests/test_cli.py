"""Tests for SWE-bench CLI reporting helpers."""

from benchmarks.swe_bench.cli import (
    _build_report,
    _capability_report,
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


def test_parse_required_capabilities_accepts_comma_joined_string() -> None:
    required = _parse_required_capabilities(
        "code.read, code.write,code.read, code.shell"
    )

    assert required == ["code.read", "code.write", "code.shell"]


def test_capability_report_flags_unknown_provider_missing_caps() -> None:
    report = _capability_report("unknown-provider", ["code.read"])

    assert report["satisfied"] is False
    assert report["missing"] == ["code.read"]
