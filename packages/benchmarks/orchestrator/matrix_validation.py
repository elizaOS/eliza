from __future__ import annotations

import json
import shlex
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .adapters import discover_adapters
from .env_utils import merged_environment
from .runner import _default_env, _effective_request, _is_harness_compatible
from .types import ExecutionContext, RunRequest


REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")


@dataclass(frozen=True)
class MatrixCell:
    benchmark_id: str
    harness: str
    compatible: bool
    reason: str | None
    command: list[str] | None
    command_display: str | None
    cwd: str
    effective_extra_config: dict[str, Any] | None
    env_overrides: dict[str, str]
    propagated_env: dict[str, str]
    result_locator_patterns: tuple[str, ...]
    trajectory_expectations: tuple[str, ...]
    error: str | None = None


@dataclass(frozen=True)
class MatrixReport:
    adapter_count: int
    compatible_cell_count: int
    incompatible_cell_count: int
    error_count: int
    cells: tuple[MatrixCell, ...]


def _packages_root(root: Path) -> Path:
    root = root.resolve()
    if (root / "benchmarks" / "orchestrator").exists():
        return root
    if (root / "packages" / "benchmarks" / "orchestrator").exists():
        return root / "packages"
    return root


def _compatibility_reason(harness: str, supported: tuple[str, ...]) -> str:
    supported_display = ", ".join(supported) if supported else "none"
    return f"harness '{harness}' not in adapter compatibility ({supported_display})"


def _filtered_env(env: dict[str, str]) -> dict[str, str]:
    prefixes = (
        "BENCHMARK_",
        "ELIZA_BENCH_",
        "OPENCLAW_",
        "HERMES_",
        "CEREBRAS_",
        "OPENAI_",
        "GROQ_",
        "OPENROUTER_",
    )
    keys = {
        "MODEL_NAME",
        "ELIZA_PROVIDER",
        "BENCHMARK_AGENT",
        "PYTHONPATH",
    }
    return {
        key: value
        for key, value in sorted(env.items())
        if key in keys or key.startswith(prefixes)
    }


def _trajectory_expectations() -> tuple[str, ...]:
    return (
        "BENCHMARK_TELEMETRY_JSONL",
        "BENCHMARK_RUN_DIR/**/*.jsonl",
        "result artifact JSON",
    )


def build_cross_matrix_report(
    workspace_root: Path,
    *,
    provider: str = "cerebras",
    model: str = "gpt-oss-120b",
    extra_config: dict[str, Any] | None = None,
) -> MatrixReport:
    packages_root = _packages_root(workspace_root)
    benchmarks_root = packages_root / "benchmarks"
    discovery = discover_adapters(packages_root)
    tmp_root = Path(tempfile.gettempdir()) / "eliza-benchmark-matrix-validation"
    cells: list[MatrixCell] = []

    for benchmark_id in sorted(discovery.adapters):
        adapter = discovery.adapters[benchmark_id]
        for harness in REAL_HARNESSES:
            request = RunRequest(
                benchmarks=(benchmark_id,),
                agent=harness,
                provider=provider,
                model=model,
                extra_config=dict(extra_config or {}),
            )
            effective_request = _effective_request(adapter, request)
            compatible = _is_harness_compatible(adapter, harness)
            result_patterns = adapter.result_patterns or ("**/*.json",)

            if not compatible:
                cells.append(
                    MatrixCell(
                        benchmark_id=benchmark_id,
                        harness=harness,
                        compatible=False,
                        reason=_compatibility_reason(harness, adapter.agent_compatibility),
                        command=None,
                        command_display=None,
                        cwd=adapter.cwd,
                        effective_extra_config=dict(effective_request.extra_config),
                        env_overrides={},
                        propagated_env={},
                        result_locator_patterns=result_patterns,
                        trajectory_expectations=_trajectory_expectations(),
                    )
                )
                continue

            output_root = tmp_root / benchmark_id / harness / "output"
            run_root = tmp_root / benchmark_id / harness
            base_env = _default_env(packages_root, effective_request)
            ctx = ExecutionContext(
                workspace_root=packages_root,
                benchmarks_root=benchmarks_root,
                output_root=output_root,
                run_root=run_root,
                request=effective_request,
                run_group_id="matrix_validation",
                env=base_env,
                repo_meta={},
            )
            env_overrides = dict(adapter.env_overrides)
            command: list[str] | None = None
            command_display: str | None = None
            error: str | None = None
            try:
                command = list(adapter.command_builder(ctx, adapter))
                if adapter.env_builder is not None:
                    env_overrides.update(
                        {k: str(v) for k, v in adapter.env_builder(ctx, adapter).items()}
                    )
                run_env = merged_environment(base_env, env_overrides)
                command_display = shlex.join(command)
            except Exception as exc:
                run_env = merged_environment(base_env, env_overrides)
                error = str(exc)

            cells.append(
                MatrixCell(
                    benchmark_id=benchmark_id,
                    harness=harness,
                    compatible=True,
                    reason=None,
                    command=command,
                    command_display=command_display,
                    cwd=adapter.cwd,
                    effective_extra_config=dict(effective_request.extra_config),
                    env_overrides={k: str(v) for k, v in env_overrides.items()},
                    propagated_env=_filtered_env(run_env),
                    result_locator_patterns=result_patterns,
                    trajectory_expectations=_trajectory_expectations(),
                    error=error,
                )
            )

    compatible_count = sum(1 for cell in cells if cell.compatible)
    incompatible_count = sum(1 for cell in cells if not cell.compatible)
    error_count = sum(1 for cell in cells if cell.error)
    return MatrixReport(
        adapter_count=len(discovery.adapters),
        compatible_cell_count=compatible_count,
        incompatible_cell_count=incompatible_count,
        error_count=error_count,
        cells=tuple(cells),
    )


def report_to_json(report: MatrixReport) -> str:
    return json.dumps(asdict(report), indent=2, ensure_ascii=True)


def report_to_markdown(report: MatrixReport) -> str:
    lines = [
        "# Benchmark Harness Matrix",
        "",
        f"- Adapters: {report.adapter_count}",
        f"- Compatible cells: {report.compatible_cell_count}",
        f"- Incompatible cells: {report.incompatible_cell_count}",
        f"- Errors: {report.error_count}",
        "",
        "| Benchmark | Harness | Status | Command / Reason |",
        "|---|---|---|---|",
    ]
    for cell in report.cells:
        status = "compatible" if cell.compatible and not cell.error else "error" if cell.error else "incompatible"
        detail = cell.command_display if cell.compatible else cell.reason
        if cell.error:
            detail = cell.error
        escaped_detail = (detail or "").replace("|", "\\|")
        lines.append(
            f"| {cell.benchmark_id} | {cell.harness} | {status} | "
            f"{escaped_detail} |"
        )
    return "\n".join(lines)
