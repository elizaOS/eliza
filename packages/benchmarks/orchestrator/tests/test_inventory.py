from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from benchmarks.orchestrator import inventory
from benchmarks.orchestrator.inventory import (
    build_inventory_report,
    report_to_json,
    report_to_markdown,
)
from benchmarks.orchestrator.types import AdapterDiscovery, BenchmarkAdapter, ExecutionContext


def _workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_inventory_report_lists_real_adapters_and_operator_contracts() -> None:
    report = build_inventory_report(_workspace_root().parent)

    assert report.adapter_count == len(report.rows)
    assert report.registry_entry_count > 0
    assert report.benchmark_directory_count > 0
    assert isinstance(report.benchmark_directories_without_adapters, tuple)
    assert isinstance(report.registry_entries_without_adapters, tuple)

    bfcl = next(row for row in report.rows if row.benchmark_id == "bfcl")
    assert bfcl.source == "registry"
    assert bfcl.has_adapter is True
    assert bfcl.has_registry_entry is True
    assert "eliza" in bfcl.harnesses
    assert bfcl.result_locator_patterns
    assert bfcl.trajectory_expectations

    payload = report_to_json(report)
    assert '"benchmark_id": "bfcl"' in payload

    markdown = report_to_markdown(report)
    assert "# Benchmark Inventory Checklist" in markdown
    assert "| bfcl | registry | bfcl |" in markdown


def test_inventory_report_surfaces_registry_adapter_and_directory_gaps(monkeypatch) -> None:
    def command_builder(ctx: ExecutionContext, adapter: BenchmarkAdapter) -> list[str]:
        return ["python", "-m", adapter.id]

    adapter = BenchmarkAdapter(
        id="registered",
        directory="registered-dir",
        description="registered adapter",
        cwd="/tmp/registered",
        command_builder=command_builder,
        result_locator=lambda _ctx, _adapter, _root: None,
        score_extractor=lambda _path: SimpleNamespace(
            score=None,
            unit=None,
            higher_is_better=None,
            metrics={},
        ),
        required_env=("MODEL_API_KEY",),
        result_patterns=("summary.json",),
        agent_compatibility=("eliza", "hermes"),
    )
    adapter_only = BenchmarkAdapter(
        id="adapter_only",
        directory="adapter-only-dir",
        description="adapter-only benchmark",
        cwd="/tmp/adapter-only",
        command_builder=command_builder,
        result_locator=lambda _ctx, _adapter, _root: None,
        score_extractor=lambda _path: SimpleNamespace(
            score=None,
            unit=None,
            higher_is_better=None,
            metrics={},
        ),
    )
    discovery = AdapterDiscovery(
        adapters={"registered": adapter, "adapter_only": adapter_only},
        all_directories=("registered-dir", "adapter-only-dir", "uncovered-dir"),
    )
    registry_entries = (
        SimpleNamespace(id="registered", display_name="Registered"),
        SimpleNamespace(id="registry_only", display_name="Registry Only"),
    )

    monkeypatch.setattr(inventory, "discover_adapters", lambda _workspace_root: discovery)
    monkeypatch.setattr(inventory, "get_benchmark_registry", lambda _workspace_root: registry_entries)

    report = build_inventory_report(Path("/repo"))

    assert report.has_gaps is True
    assert report.registry_entries_without_adapters == ("registry_only",)
    assert report.adapters_without_registry_entries == ("adapter_only",)
    assert report.benchmark_directories_without_adapters == ("uncovered-dir",)

    registered = next(row for row in report.rows if row.benchmark_id == "registered")
    assert registered.source == "registry"
    assert registered.required_env == ("MODEL_API_KEY",)
    assert registered.result_locator_patterns == ("summary.json",)

    adapter_only_row = next(row for row in report.rows if row.benchmark_id == "adapter_only")
    assert adapter_only_row.source == "adapter-only"
    assert adapter_only_row.has_registry_entry is False

    markdown = report_to_markdown(report)
    assert "registry_only" in markdown
    assert "uncovered-dir" in markdown
