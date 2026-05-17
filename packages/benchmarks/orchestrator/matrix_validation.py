from __future__ import annotations

import json
import shlex
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .adapters import discover_adapters
from .runner import (
    _default_env,
    _effective_request,
    _is_harness_compatible,
    _required_env_for_request,
)
from .types import ExecutionContext, RunRequest

CANONICAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")
DEFAULT_PROVIDER = "cerebras"
DEFAULT_MODEL = "gpt-oss-120b"
COMMON_ENV_KEYS: tuple[str, ...] = (
    "BENCHMARK_AGENT",
    "BENCHMARK_CAPTURE_TRAJECTORIES",
    "BENCHMARK_HARNESS",
    "BENCHMARK_MODEL_NAME",
    "BENCHMARK_MODEL_PROVIDER",
    "CEREBRAS_BASE_URL",
    "CEREBRAS_LARGE_MODEL",
    "CEREBRAS_MODEL",
    "CEREBRAS_REASONING_EFFORT",
    "CEREBRAS_SMALL_MODEL",
    "ELIZA_BENCH_HARNESS",
    "ELIZA_PROVIDER",
    "MODEL_NAME",
    "OPENAI_BASE_URL",
    "OPENAI_LARGE_MODEL",
    "OPENAI_MODEL",
    "OPENAI_REASONING_EFFORT",
    "OPENAI_SMALL_MODEL",
    "PYTHONPATH",
)
SECRET_KEY_MARKERS: tuple[str, ...] = (
    "API_KEY",
    "AUTH",
    "BEARER",
    "CREDENTIAL",
    "PASSWORD",
    "SECRET",
    "TOKEN",
)
REDACTED_VALUE = "<redacted>"


@dataclass(frozen=True)
class MatrixCell:
    benchmark_id: str
    directory: str
    harness: str
    compatible: bool
    reason: str | None
    cwd: str
    command: list[str] | None
    command_display: str | None
    default_extra_config: dict[str, Any]
    effective_extra_config: dict[str, Any] | None
    required_env: list[str]
    env_overrides: dict[str, str]
    propagated_env: dict[str, str]
    result_locator_patterns: list[str]
    trajectory_expectations: list[str]
    error: str | None = None


@dataclass(frozen=True)
class MatrixReport:
    provider: str
    model: str
    harnesses: tuple[str, ...]
    adapter_count: int
    compatible_cell_count: int
    incompatible_cell_count: int
    error_count: int
    cells: list[MatrixCell]


def _workspace_root_from_repo(repo_root: Path) -> Path:
    packages_root = repo_root / "packages"
    return packages_root if (packages_root / "benchmarks").is_dir() else repo_root


def _result_patterns_for(adapter_id: str, patterns: tuple[str, ...]) -> list[str]:
    if patterns:
        return list(patterns)
    if adapter_id == "trajectory_replay":
        return ["trajectory-replay-results.json", "**/*.json"]
    return ["registry locate_result(output_dir)", "**/*.json fallback"]


def _trajectory_expectations(adapter_id: str) -> list[str]:
    expectations = [
        "BENCHMARK_CAPTURE_TRAJECTORIES=1",
        "runner scans run_root recursively for trajectory-like JSON artifacts",
    ]
    if adapter_id == "trajectory_replay":
        expectations.append("requires extra.traj_set pointing at existing trajectory JSONs")
    if adapter_id in {"loca_bench", "webshop"}:
        expectations.append("adapter has explicit trajectory capture/reporting controls")
    return expectations


def _is_secret_key(key: str) -> bool:
    key_upper = key.upper()
    return any(marker in key_upper for marker in SECRET_KEY_MARKERS)


def _redact_for_report(value: Any, *, key: str = "") -> Any:
    if key and _is_secret_key(key):
        return REDACTED_VALUE
    if isinstance(value, dict):
        return {
            str(k): _redact_for_report(v, key=str(k))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact_for_report(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_for_report(item) for item in value]
    return value


def _summarize_env(env: dict[str, str], keys: tuple[str, ...] = COMMON_ENV_KEYS) -> dict[str, str]:
    return {
        key: _redact_for_report(env[key], key=key)
        for key in keys
        if key in env
    }


def build_cross_matrix_report(
    repo_root: Path,
    *,
    provider: str = DEFAULT_PROVIDER,
    model: str = DEFAULT_MODEL,
    extra_config: dict[str, Any] | None = None,
    harnesses: tuple[str, ...] = CANONICAL_HARNESSES,
) -> MatrixReport:
    workspace_root = _workspace_root_from_repo(repo_root.resolve())
    discovery = discover_adapters(workspace_root)
    cells: list[MatrixCell] = []
    errors = 0

    for benchmark_id in sorted(discovery.adapters):
        adapter = discovery.adapters[benchmark_id]
        for harness in harnesses:
            base_request = RunRequest(
                benchmarks=(benchmark_id,),
                agent=harness,
                provider=provider,
                model=model,
                extra_config=dict(extra_config or {}),
            )
            compatible = _is_harness_compatible(adapter, harness)
            reason = None
            command: list[str] | None = None
            command_display: str | None = None
            effective_extra: dict[str, Any] | None = None
            required_env: list[str] = []
            env_overrides: dict[str, str] = {}
            propagated_env: dict[str, str] = {}
            error: str | None = None

            if not compatible:
                allowed = ", ".join(adapter.agent_compatibility) or "none"
                reason = f"harness '{harness}' not in adapter compatibility ({allowed})"
            else:
                try:
                    effective = _effective_request(adapter, base_request)
                    effective_extra = dict(effective.extra_config)
                    env = _default_env(workspace_root, effective)
                    output_root = (
                        workspace_root
                        / "benchmarks"
                        / "benchmark_results"
                        / "matrix-validation"
                        / benchmark_id
                        / harness
                    )
                    ctx = ExecutionContext(
                        workspace_root=workspace_root,
                        benchmarks_root=workspace_root / "benchmarks",
                        output_root=output_root,
                        run_root=output_root,
                        request=effective,
                        run_group_id="matrix-validation",
                        env=env,
                        repo_meta={},
                    )
                    if adapter.env_builder is not None:
                        env_overrides = dict(adapter.env_builder(ctx, adapter))
                        env.update(env_overrides)
                    command = adapter.command_builder(ctx, adapter)
                    command_display = shlex.join(command)
                    required_env = list(_required_env_for_request(adapter, effective))
                    propagated_env = _summarize_env(env)
                except Exception as exc:  # pragma: no cover - exercised by contract tests
                    errors += 1
                    error = f"{type(exc).__name__}: {exc}"

            cells.append(
                MatrixCell(
                    benchmark_id=benchmark_id,
                    directory=adapter.directory,
                    harness=harness,
                    compatible=compatible,
                    reason=reason,
                    cwd=adapter.cwd,
                    command=command,
                    command_display=command_display,
                    default_extra_config=_redact_for_report(dict(adapter.default_extra_config)),
                    effective_extra_config=_redact_for_report(effective_extra),
                    required_env=required_env,
                    env_overrides=_redact_for_report(env_overrides),
                    propagated_env=propagated_env,
                    result_locator_patterns=_result_patterns_for(
                        adapter.id,
                        adapter.result_patterns,
                    ),
                    trajectory_expectations=_trajectory_expectations(adapter.id),
                    error=error,
                )
            )

    compatible_count = sum(1 for cell in cells if cell.compatible)
    incompatible_count = sum(1 for cell in cells if not cell.compatible)
    return MatrixReport(
        provider=provider,
        model=model,
        harnesses=harnesses,
        adapter_count=len(discovery.adapters),
        compatible_cell_count=compatible_count,
        incompatible_cell_count=incompatible_count,
        error_count=errors,
        cells=cells,
    )


def report_to_json(report: MatrixReport) -> str:
    return json.dumps(asdict(report), indent=2, sort_keys=True, ensure_ascii=True)


def report_to_markdown(report: MatrixReport) -> str:
    lines = [
        f"# Orchestrator Cross-Matrix Validation",
        "",
        f"- provider: `{report.provider}`",
        f"- model: `{report.model}`",
        f"- adapters: `{report.adapter_count}`",
        f"- compatible cells: `{report.compatible_cell_count}`",
        f"- incompatible cells: `{report.incompatible_cell_count}`",
        f"- command construction errors: `{report.error_count}`",
        "",
        "| benchmark | directory | eliza | hermes | openclaw |",
        "| --- | --- | --- | --- | --- |",
    ]
    by_benchmark: dict[str, dict[str, MatrixCell]] = {}
    directory_by_benchmark: dict[str, str] = {}
    for cell in report.cells:
        by_benchmark.setdefault(cell.benchmark_id, {})[cell.harness] = cell
        directory_by_benchmark[cell.benchmark_id] = cell.directory
    for benchmark_id in sorted(by_benchmark):
        row = [benchmark_id, directory_by_benchmark[benchmark_id]]
        for harness in report.harnesses:
            cell = by_benchmark[benchmark_id][harness]
            if cell.error:
                row.append(f"error: {cell.error}")
            elif cell.compatible:
                row.append("compatible")
            else:
                row.append(cell.reason or "incompatible")
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)
