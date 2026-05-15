from __future__ import annotations

import json
import shlex
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .adapters import discover_adapters
from .env_utils import merged_environment
from .runner import _default_env, _effective_request, _is_harness_compatible
from .types import BenchmarkAdapter, ExecutionContext, RunRequest

REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
PROPAGATED_ENV_KEYS: tuple[str, ...] = (
    "BENCHMARK_MODEL_PROVIDER",
    "BENCHMARK_MODEL_NAME",
    "BENCHMARK_HARNESS",
    "ELIZA_BENCH_HARNESS",
    "BENCHMARK_AGENT",
)
DEFAULT_RESULT_PATTERNS: tuple[str, ...] = ("**/*.json", "**/*.jsonl")
DEFAULT_TRAJECTORY_EXPECTATIONS: tuple[str, ...] = (
    "stdout.log",
    "stderr.log",
    "telemetry.jsonl",
)


@dataclass(frozen=True)
class CrossMatrixCell:
    benchmark_id: str
    benchmark_directory: str
    harness: str
    compatible: bool
    reason: str | None
    command: tuple[str, ...]
    command_display: str
    effective_extra_config: dict[str, Any] | None
    result_locator_patterns: tuple[str, ...]
    trajectory_expectations: tuple[str, ...]
    propagated_env: dict[str, str]
    env_overrides: dict[str, str]
    error: str | None = None


@dataclass(frozen=True)
class CrossMatrixReport:
    adapter_count: int
    harnesses: tuple[str, ...]
    cells: tuple[CrossMatrixCell, ...]

    @property
    def compatible_cell_count(self) -> int:
        return sum(1 for cell in self.cells if cell.compatible)

    @property
    def incompatible_cell_count(self) -> int:
        return sum(1 for cell in self.cells if not cell.compatible)

    @property
    def error_count(self) -> int:
        return sum(1 for cell in self.cells if cell.error)


def _packages_root(root: Path) -> Path:
    root = root.resolve()
    if (root / "benchmarks" / "orchestrator").exists():
        return root
    if (root / "packages" / "benchmarks" / "orchestrator").exists():
        return root / "packages"
    return root


def _command_display(command: tuple[str, ...]) -> str:
    return " ".join(shlex.quote(part) for part in command)


def _result_patterns(adapter: BenchmarkAdapter) -> tuple[str, ...]:
    patterns = getattr(adapter, "result_patterns", ())
    return tuple(patterns) if patterns else DEFAULT_RESULT_PATTERNS


def _matrix_context(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
    harness: str,
    provider: str,
    model: str,
    extra_config: dict[str, Any],
) -> tuple[ExecutionContext, dict[str, str], RunRequest]:
    request = RunRequest(
        benchmarks=(adapter.id,),
        agent=harness,
        provider=provider,
        model=model,
        extra_config=dict(extra_config),
        force=True,
    )
    effective_request = _effective_request(adapter, request)
    base_env = _default_env(workspace_root, effective_request)
    run_root = (
        workspace_root
        / "benchmarks"
        / "benchmark_results"
        / "_matrix_validation"
        / adapter.id
        / harness
    )
    ctx = ExecutionContext(
        workspace_root=workspace_root,
        benchmarks_root=workspace_root / "benchmarks",
        output_root=run_root / "output",
        run_root=run_root,
        request=effective_request,
        run_group_id="matrix_validation",
        env=base_env,
        repo_meta={},
    )
    env_overrides = {key: str(value) for key, value in adapter.env_overrides.items()}
    if adapter.env_builder is not None:
        env_overrides.update({key: str(value) for key, value in adapter.env_builder(ctx, adapter).items()})
    return ctx, env_overrides, effective_request


def _incompatible_cell(adapter: BenchmarkAdapter, harness: str) -> CrossMatrixCell:
    supported = ", ".join(adapter.agent_compatibility) or "none"
    return CrossMatrixCell(
        benchmark_id=adapter.id,
        benchmark_directory=adapter.directory,
        harness=harness,
        compatible=False,
        reason=f"harness_not_supported: supported={supported}",
        command=(),
        command_display="",
        effective_extra_config=None,
        result_locator_patterns=_result_patterns(adapter),
        trajectory_expectations=DEFAULT_TRAJECTORY_EXPECTATIONS,
        propagated_env={},
        env_overrides={},
    )


def _compatible_cell(
    *,
    workspace_root: Path,
    adapter: BenchmarkAdapter,
    harness: str,
    provider: str,
    model: str,
    extra_config: dict[str, Any],
) -> CrossMatrixCell:
    try:
        ctx, env_overrides, effective_request = _matrix_context(
            workspace_root=workspace_root,
            adapter=adapter,
            harness=harness,
            provider=provider,
            model=model,
            extra_config=extra_config,
        )
        command = tuple(str(part) for part in adapter.command_builder(ctx, adapter))
        final_env = merged_environment(ctx.env, env_overrides)
        propagated_env = {
            key: final_env[key]
            for key in PROPAGATED_ENV_KEYS
            if key in final_env
        }
        error = None if command else "command_builder_returned_empty_command"
        return CrossMatrixCell(
            benchmark_id=adapter.id,
            benchmark_directory=adapter.directory,
            harness=harness,
            compatible=True,
            reason=None,
            command=command,
            command_display=_command_display(command),
            effective_extra_config=dict(effective_request.extra_config),
            result_locator_patterns=_result_patterns(adapter),
            trajectory_expectations=DEFAULT_TRAJECTORY_EXPECTATIONS,
            propagated_env=propagated_env,
            env_overrides=env_overrides,
            error=error,
        )
    except Exception as exc:
        return CrossMatrixCell(
            benchmark_id=adapter.id,
            benchmark_directory=adapter.directory,
            harness=harness,
            compatible=True,
            reason=None,
            command=(),
            command_display="",
            effective_extra_config={},
            result_locator_patterns=_result_patterns(adapter),
            trajectory_expectations=DEFAULT_TRAJECTORY_EXPECTATIONS,
            propagated_env={},
            env_overrides={},
            error=f"{type(exc).__name__}: {exc}",
        )


def build_cross_matrix_report(
    workspace_or_repo_root: Path,
    *,
    provider: str,
    model: str,
    extra_config: dict[str, Any] | None = None,
    harnesses: tuple[str, ...] = REAL_HARNESSES,
) -> CrossMatrixReport:
    workspace_root = _packages_root(workspace_or_repo_root)
    discovery = discover_adapters(workspace_root)
    cells: list[CrossMatrixCell] = []
    for benchmark_id in sorted(discovery.adapters):
        adapter = discovery.adapters[benchmark_id]
        for harness in harnesses:
            if not _is_harness_compatible(adapter, harness):
                cells.append(_incompatible_cell(adapter, harness))
                continue
            cells.append(
                _compatible_cell(
                    workspace_root=workspace_root,
                    adapter=adapter,
                    harness=harness,
                    provider=provider,
                    model=model,
                    extra_config=dict(extra_config or {}),
                )
            )
    return CrossMatrixReport(
        adapter_count=len(discovery.adapters),
        harnesses=tuple(harnesses),
        cells=tuple(cells),
    )


def report_to_json(report: CrossMatrixReport) -> str:
    payload = {
        "adapter_count": report.adapter_count,
        "harnesses": list(report.harnesses),
        "compatible_cell_count": report.compatible_cell_count,
        "incompatible_cell_count": report.incompatible_cell_count,
        "error_count": report.error_count,
        "cells": [asdict(cell) for cell in report.cells],
    }
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True)


def report_to_markdown(report: CrossMatrixReport) -> str:
    lines = [
        "# Benchmark Orchestrator Matrix",
        "",
        f"- adapters: {report.adapter_count}",
        f"- compatible cells: {report.compatible_cell_count}",
        f"- incompatible cells: {report.incompatible_cell_count}",
        f"- errors: {report.error_count}",
        "",
        "| benchmark | harness | status | command |",
        "| --- | --- | --- | --- |",
    ]
    for cell in report.cells:
        status = "compatible" if cell.compatible else "incompatible"
        if cell.error:
            status = "error"
        command = cell.command_display or cell.reason or cell.error or ""
        lines.append(f"| {cell.benchmark_id} | {cell.harness} | {status} | `{command}` |")
    return "\n".join(lines)


__all__ = [
    "CrossMatrixCell",
    "CrossMatrixReport",
    "build_cross_matrix_report",
    "report_to_json",
    "report_to_markdown",
]
