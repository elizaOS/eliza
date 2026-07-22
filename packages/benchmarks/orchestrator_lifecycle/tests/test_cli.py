"""CLI defaults keep documented real runs on the publishable strict path."""

from __future__ import annotations

import sys

import pytest

import benchmarks.orchestrator_lifecycle.cli as lifecycle_cli
from benchmarks.orchestrator_lifecycle.cli import parse_args
from benchmarks.orchestrator_lifecycle.types import LifecycleMetrics


def test_strict_publication_contract_is_the_safe_default() -> None:
    assert parse_args([]).strict is True
    assert parse_args(["--strict"]).strict is True
    assert parse_args(["--no-strict"]).strict is False


def test_no_strict_bridge_cli_labels_report_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class DiagnosticRunner:
        def __init__(self, _config: object) -> None:
            pass

        def __enter__(self) -> "DiagnosticRunner":
            return self

        def __exit__(self, *_exc_info: object) -> None:
            pass

        def run(self) -> tuple[list[object], LifecycleMetrics, str]:
            return (
                [],
                LifecycleMetrics(1.0, 1.0, 0, 0, 1.0, 1.0, 1.0, 1.0),
                "/tmp/diagnostic.json",
            )

    monkeypatch.setattr(lifecycle_cli, "LifecycleRunner", DiagnosticRunner)
    monkeypatch.setattr(
        sys,
        "argv",
        ["orchestrator-lifecycle", "--no-strict", "--mode", "bridge"],
    )

    lifecycle_cli.main()

    output = capsys.readouterr().out
    assert "DIAGNOSTIC ONLY" in output
    assert "Diagnostic pass rate" in output
    assert "Overall score" not in output
