from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from benchmarks.registry import get_benchmark_registry

from .adapters import discover_adapters
from .matrix_validation import _result_patterns_for, _trajectory_expectations


@dataclass(frozen=True)
class BenchmarkInventoryRow:
    benchmark_id: str
    directory: str
    source: str
    display_name: str | None
    description: str
    harnesses: tuple[str, ...]
    required_env: tuple[str, ...]
    result_locator_patterns: tuple[str, ...]
    trajectory_expectations: tuple[str, ...]
    default_timeout_seconds: int
    default_extra_config: dict[str, Any]
    command_cwd: str
    has_adapter: bool
    has_registry_entry: bool


@dataclass(frozen=True)
class BenchmarkInventoryReport:
    adapter_count: int
    registry_entry_count: int
    benchmark_directory_count: int
    checklist_count: int
    registry_entries_without_adapters: tuple[str, ...]
    adapters_without_registry_entries: tuple[str, ...]
    benchmark_directories_without_adapters: tuple[str, ...]
    rows: list[BenchmarkInventoryRow]

    @property
    def has_gaps(self) -> bool:
        return bool(
            self.registry_entries_without_adapters
            or self.benchmark_directories_without_adapters
        )


def _workspace_root_from_repo(repo_root: Path) -> Path:
    packages_root = repo_root / "packages"
    return packages_root if (packages_root / "benchmarks").is_dir() else repo_root


def build_inventory_report(repo_root: Path) -> BenchmarkInventoryReport:
    workspace_root = _workspace_root_from_repo(repo_root.resolve())
    discovery = discover_adapters(workspace_root)
    registry_entries = get_benchmark_registry(workspace_root)
    registry_by_id = {entry.id: entry for entry in registry_entries}

    rows: list[BenchmarkInventoryRow] = []
    for benchmark_id in sorted(discovery.adapters):
        adapter = discovery.adapters[benchmark_id]
        registry_entry = registry_by_id.get(benchmark_id)
        source = "registry" if registry_entry is not None else "adapter-only"
        rows.append(
            BenchmarkInventoryRow(
                benchmark_id=benchmark_id,
                directory=adapter.directory,
                source=source,
                display_name=registry_entry.display_name if registry_entry else None,
                description=adapter.description,
                harnesses=tuple(adapter.agent_compatibility),
                required_env=tuple(adapter.required_env),
                result_locator_patterns=tuple(
                    _result_patterns_for(adapter.id, adapter.result_patterns)
                ),
                trajectory_expectations=tuple(_trajectory_expectations(adapter.id)),
                default_timeout_seconds=adapter.default_timeout_seconds,
                default_extra_config=dict(adapter.default_extra_config),
                command_cwd=adapter.cwd,
                has_adapter=True,
                has_registry_entry=registry_entry is not None,
            )
        )

    adapter_ids = set(discovery.adapters)
    covered_dirs = {adapter.directory for adapter in discovery.adapters.values()}
    registry_missing_adapters = tuple(
        sorted(entry.id for entry in registry_entries if entry.id not in adapter_ids)
    )
    adapter_only = tuple(
        sorted(benchmark_id for benchmark_id in adapter_ids if benchmark_id not in registry_by_id)
    )
    directory_gaps = tuple(
        sorted(directory for directory in discovery.all_directories if directory not in covered_dirs)
    )

    return BenchmarkInventoryReport(
        adapter_count=len(discovery.adapters),
        registry_entry_count=len(registry_entries),
        benchmark_directory_count=len(discovery.all_directories),
        checklist_count=len(rows),
        registry_entries_without_adapters=registry_missing_adapters,
        adapters_without_registry_entries=adapter_only,
        benchmark_directories_without_adapters=directory_gaps,
        rows=rows,
    )


def report_to_json(report: BenchmarkInventoryReport) -> str:
    return json.dumps(asdict(report), indent=2, sort_keys=True, ensure_ascii=True)


def _csv(values: tuple[str, ...]) -> str:
    return ", ".join(values) if values else "-"


def report_to_markdown(report: BenchmarkInventoryReport) -> str:
    lines = [
        "# Benchmark Inventory Checklist",
        "",
        f"- adapters: `{report.adapter_count}`",
        f"- registry entries: `{report.registry_entry_count}`",
        f"- benchmark directories: `{report.benchmark_directory_count}`",
        f"- checklist rows: `{report.checklist_count}`",
        f"- registry entries without adapters: `{len(report.registry_entries_without_adapters)}`",
        f"- adapter-only entries: `{len(report.adapters_without_registry_entries)}`",
        f"- benchmark directories without adapters: `{len(report.benchmark_directories_without_adapters)}`",
        "",
    ]

    if report.registry_entries_without_adapters:
        lines.extend(
            [
                "## Registry Entries Without Adapters",
                "",
                ", ".join(report.registry_entries_without_adapters),
                "",
            ]
        )
    if report.benchmark_directories_without_adapters:
        lines.extend(
            [
                "## Benchmark Directories Without Adapters",
                "",
                ", ".join(report.benchmark_directories_without_adapters),
                "",
            ]
        )

    lines.extend(
        [
            "| benchmark | source | directory | harnesses | required env | result locators | trajectories |",
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for row in report.rows:
        lines.append(
            "| "
            + " | ".join(
                [
                    row.benchmark_id,
                    row.source,
                    row.directory,
                    _csv(row.harnesses),
                    _csv(row.required_env),
                    _csv(row.result_locator_patterns),
                    _csv(row.trajectory_expectations),
                ]
            )
            + " |"
        )
    return "\n".join(lines)
