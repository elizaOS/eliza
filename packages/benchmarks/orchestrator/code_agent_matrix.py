"""Comparative coding-agent benchmark harness.

This module is intentionally thin: it wraps the existing SWE-bench and
Terminal-Bench runners, pins the model/provider defaults requested for the
elizaOS coding-agent grind, and writes one artifact directory per
``(benchmark, adapter)`` cell. Unit tests exercise command construction and
failure classification only; real runs require credentials, datasets, and
optional Docker.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


DEFAULT_ADAPTERS = ("elizaos", "opencode")
DEFAULT_BENCHMARKS = ("swe_bench", "terminal_bench")
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"

FAILURE_CLASSES = (
    "pass",
    "auth_or_provider",
    "timeout",
    "patch_apply_failed",
    "no_patch",
    "tests_failed",
    "harness_error",
    "stopped_early",
    "no_trajectory",
    "unknown_failure",
)


@dataclass(frozen=True)
class MatrixCell:
    benchmark: str
    adapter: str
    command: list[str]
    cwd: str
    output_dir: str
    trajectory_dir: str
    env_overrides: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CellResult:
    benchmark: str
    adapter: str
    status: str
    exit_code: int | None
    duration_seconds: float
    output_dir: str
    stdout_path: str
    stderr_path: str
    result_path: str | None
    failure_class: str
    notes: list[str] = field(default_factory=list)


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def benchmarks_root(root: Path) -> Path:
    return root / "packages" / "benchmarks"


def sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-").lower() or "run"


def now_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def env_name(adapter: str, benchmark: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    benchmark_key = sanitize(benchmark).replace("-", "_").upper()
    return f"CODE_AGENT_BENCH_{adapter_key}_{benchmark_key}_CMD"


def visible_env_overrides(
    *,
    adapter: str,
    benchmark: str,
    provider: str,
    model: str,
) -> dict[str, str]:
    return {
        "BENCHMARK_TASK_AGENT": adapter,
        "BENCHMARK_MODEL_PROVIDER": provider,
        "BENCHMARK_MODEL_NAME": model,
        "CEREBRAS_BASE_URL": DEFAULT_CEREBRAS_BASE_URL,
    }


def child_env(cell: MatrixCell) -> dict[str, str]:
    env = dict(os.environ)
    env.update(cell.env_overrides)
    root = workspace_root()
    python_paths = [
        str(root / "packages"),
        str(root / "packages" / "benchmarks"),
        str(root / "packages" / "benchmarks" / "eliza-adapter"),
        str(root / "packages" / "benchmarks" / "hermes-adapter"),
        str(root / "packages" / "benchmarks" / "openclaw-adapter"),
    ]
    existing_python_path = env.get("PYTHONPATH", "")
    if existing_python_path:
        python_paths.append(existing_python_path)
    env["PYTHONPATH"] = os.pathsep.join(python_paths)
    env.setdefault("OPENAI_LARGE_MODEL", env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL))
    env.setdefault("OPENAI_SMALL_MODEL", env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL))
    env.setdefault("CEREBRAS_MODEL", env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL))
    env.setdefault("CEREBRAS_LARGE_MODEL", env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL))
    env.setdefault("CEREBRAS_SMALL_MODEL", env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL))
    return env


def default_command(
    *,
    root: Path,
    benchmark: str,
    adapter: str,
    provider: str,
    model: str,
    output_dir: Path,
    trajectory_dir: Path,
    max_tasks: int | None,
    smoke: bool,
    no_docker: bool,
) -> tuple[list[str], Path]:
    python = sys.executable
    b_root = benchmarks_root(root)
    if benchmark == "swe_bench":
        cmd = [
            python,
            "-m",
            "benchmarks.swe_bench.cli",
            "--orchestrated",
            "--harness",
            "eliza",
            "--providers",
            adapter,
            "--provider",
            provider,
            "--model",
            model,
            "--output",
            str(output_dir),
            "--workspace",
            str(output_dir / "workspace"),
            "--trace-dir",
            str(trajectory_dir),
            "--required-capabilities",
            "code.read,code.write,code.edit,code.search,code.shell",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-instances", str(max_tasks)])
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "terminal_bench":
        cmd = [
            python,
            "-m",
            "elizaos_terminal_bench.cli",
            "--model-provider",
            provider,
            "--model",
            model,
            "--agent-harness",
            "eliza",
            "--task-agent",
            adapter,
            "--output-dir",
            str(output_dir),
            "--no-leaderboard",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        if smoke:
            cmd.extend(["--use-sample-tasks", "--local-sandbox", "--mock"])
        return cmd, b_root / "terminal-bench"

    raise ValueError(f"unsupported benchmark: {benchmark}")


def expand_template(template: str, values: dict[str, str]) -> list[str]:
    expanded = template
    for key, value in values.items():
        expanded = expanded.replace("{" + key + "}", value)
    return shlex.split(expanded)


def build_cell(
    *,
    root: Path,
    run_root: Path,
    benchmark: str,
    adapter: str,
    provider: str,
    model: str,
    max_tasks: int | None,
    smoke: bool,
    no_docker: bool,
) -> MatrixCell:
    output_dir = run_root / benchmark / adapter
    trajectory_dir = output_dir / "trajectories"
    env_overrides = visible_env_overrides(
        adapter=adapter,
        benchmark=benchmark,
        provider=provider,
        model=model,
    )
    template = os.environ.get(env_name(adapter, benchmark), "").strip()
    if template:
        command = expand_template(
            template,
            {
                "adapter": adapter,
                "benchmark": benchmark,
                "provider": provider,
                "model": model,
                "outputDir": str(output_dir),
                "trajectoryDir": str(trajectory_dir),
                "workspaceRoot": str(root),
            },
        )
        cwd = root
    else:
        command, cwd = default_command(
            root=root,
            benchmark=benchmark,
            adapter=adapter,
            provider=provider,
            model=model,
            output_dir=output_dir,
            trajectory_dir=trajectory_dir,
            max_tasks=max_tasks,
            smoke=smoke,
            no_docker=no_docker,
        )

    return MatrixCell(
        benchmark=benchmark,
        adapter=adapter,
        command=command,
        cwd=str(cwd),
        output_dir=str(output_dir),
        trajectory_dir=str(trajectory_dir),
        env_overrides=env_overrides,
    )


def find_latest_result(output_dir: Path) -> Path | None:
    patterns = ("orchestrated-*.json", "swe-bench-*.json", "results.json", "report.json", "*.json")
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(path for path in output_dir.glob(pattern) if path.is_file())
        matches.extend(path for path in output_dir.glob(f"**/{pattern}") if path.is_file())
    if not matches:
        return None
    return max(set(matches), key=lambda p: p.stat().st_mtime)


def read_json(path: Path | None) -> Any:
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def classify_failure(
    *,
    exit_code: int | None,
    result_payload: Any,
    stdout: str = "",
    stderr: str = "",
) -> tuple[str, list[str]]:
    text = "\n".join([stdout, stderr, json.dumps(result_payload, default=str)[:40_000]]).lower()
    notes: list[str] = []

    if result_payload is not None:
        score = score_from_payload(result_payload)
        if score is not None and score > 0:
            return "pass", [f"score={score:.4f}"]

    if (
        "api key" in text
        or "unauthorized" in text
        or "authentication" in text
        or "401" in text
        or "no provider registered" in text
        or "no usable key" in text
        or "text_large / text_small handlers will be missing" in text
    ):
        return "auth_or_provider", ["provider credential or auth failure"]
    if exit_code == 124 or "timed out" in text or "timeout" in text:
        return "timeout", ["run exceeded timeout or reported timeout"]
    if "patch_apply_failed" in text or "git apply" in text and "fail" in text:
        return "patch_apply_failed", ["patch did not apply cleanly"]
    if "not_generated" in text or "no patch" in text or "produced no working-tree diff" in text:
        return "no_patch", ["agent did not produce a usable patch/diff"]
    if "tests_failed" in text or "test_exit_code" in text or "assertionerror" in text:
        return "tests_failed", ["tests or grader failed after agent work"]
    if "stopped early" in text or "end_turn" in text and "unfinished" in text:
        return "stopped_early", ["agent stopped before a verified finish"]
    if result_payload is None and exit_code == 0:
        return "no_trajectory", ["process succeeded but no result JSON was found"]
    if exit_code not in (None, 0):
        return "harness_error", [f"process exited {exit_code}"]
    return "unknown_failure", ["score was zero or no pass signal was found"]


def score_from_payload(payload: Any) -> float | None:
    if not isinstance(payload, dict):
        return None
    metrics = payload.get("metrics")
    if isinstance(metrics, dict):
        score = metrics.get("overall_score")
        if isinstance(score, (int, float)):
            return float(score)
        provider_scores = metrics.get("provider_scores")
        if isinstance(provider_scores, dict) and provider_scores:
            values = [float(v) for v in provider_scores.values() if isinstance(v, (int, float))]
            if values:
                return sum(values) / len(values)
    summary = payload.get("summary")
    if isinstance(summary, dict):
        for key in ("resolve_rate", "accuracy", "score"):
            value = summary.get(key)
            if isinstance(value, (int, float)):
                return float(value)
    return None


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run_cell(cell: MatrixCell, *, dry_run: bool, timeout_seconds: int) -> CellResult:
    output_dir = Path(cell.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = output_dir / "stdout.log"
    stderr_path = output_dir / "stderr.log"
    command_path = output_dir / "command.json"
    write_json(
        command_path,
        {
            "benchmark": cell.benchmark,
            "adapter": cell.adapter,
            "cwd": cell.cwd,
            "command": cell.command,
            "env_overrides": cell.env_overrides,
            "sensitive_env_names": ["CEREBRAS_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
        },
    )

    if dry_run:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        return CellResult(
            benchmark=cell.benchmark,
            adapter=cell.adapter,
            status="planned",
            exit_code=None,
            duration_seconds=0.0,
            output_dir=cell.output_dir,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            result_path=None,
            failure_class="unknown_failure",
            notes=["dry run; command was not executed"],
        )

    started = time.monotonic()
    try:
        completed = subprocess.run(
            cell.command,
            cwd=cell.cwd,
            env=child_env(cell),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        exit_code: int | None = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        stderr += f"\nTimed out after {timeout_seconds}s\n"

    duration = time.monotonic() - started
    stdout_path.write_text(stdout, encoding="utf-8")
    stderr_path.write_text(stderr, encoding="utf-8")
    result_path = find_latest_result(output_dir)
    payload = read_json(result_path)
    failure_class, notes = classify_failure(
        exit_code=exit_code,
        result_payload=payload,
        stdout=stdout,
        stderr=stderr,
    )
    status = "succeeded" if exit_code == 0 else "failed"
    if failure_class != "pass" and exit_code == 0:
        status = "completed_with_failures"

    return CellResult(
        benchmark=cell.benchmark,
        adapter=cell.adapter,
        status=status,
        exit_code=exit_code,
        duration_seconds=duration,
        output_dir=cell.output_dir,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        result_path=str(result_path) if result_path else None,
        failure_class=failure_class,
        notes=notes,
    )


def summarize_results(results: list[CellResult]) -> dict[str, Any]:
    by_class: dict[str, int] = {key: 0 for key in FAILURE_CLASSES}
    by_adapter: dict[str, dict[str, int]] = {}
    by_benchmark: dict[str, dict[str, int]] = {}
    for result in results:
        by_class[result.failure_class] = by_class.get(result.failure_class, 0) + 1
        by_adapter.setdefault(result.adapter, {}).setdefault(result.failure_class, 0)
        by_adapter[result.adapter][result.failure_class] += 1
        by_benchmark.setdefault(result.benchmark, {}).setdefault(result.failure_class, 0)
        by_benchmark[result.benchmark][result.failure_class] += 1
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "total_cells": len(results),
        "by_failure_class": by_class,
        "by_adapter": by_adapter,
        "by_benchmark": by_benchmark,
        "results": [asdict(result) for result in results],
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = ["# Coding Agent Matrix Summary", ""]
    lines.append(f"Generated: {summary['generated_at']}")
    lines.append("")
    lines.append("## Failure Classes")
    lines.append("")
    lines.append("| class | count |")
    lines.append("| --- | ---: |")
    for key, count in summary["by_failure_class"].items():
        if count:
            lines.append(f"| {key} | {count} |")
    lines.append("")
    lines.append("## Cells")
    lines.append("")
    lines.append("| benchmark | adapter | status | class | result |")
    lines.append("| --- | --- | --- | --- | --- |")
    for result in summary["results"]:
        result_path = result.get("result_path") or ""
        lines.append(
            f"| {result['benchmark']} | {result['adapter']} | {result['status']} | "
            f"{result['failure_class']} | {result_path} |"
        )
    lines.append("")
    return "\n".join(lines)


def summarize_existing(run_root: Path) -> list[CellResult]:
    results: list[CellResult] = []
    for command_path in sorted(run_root.glob("*/*/command.json")):
        meta = read_json(command_path)
        if not isinstance(meta, dict):
            continue
        cell_dir = command_path.parent
        stdout_path = cell_dir / "stdout.log"
        stderr_path = cell_dir / "stderr.log"
        stdout = stdout_path.read_text(encoding="utf-8") if stdout_path.exists() else ""
        stderr = stderr_path.read_text(encoding="utf-8") if stderr_path.exists() else ""
        result_path = find_latest_result(cell_dir)
        payload = read_json(result_path)
        failure_class, notes = classify_failure(
            exit_code=0 if result_path else None,
            result_payload=payload,
            stdout=stdout,
            stderr=stderr,
        )
        results.append(
            CellResult(
                benchmark=str(meta.get("benchmark") or cell_dir.parent.name),
                adapter=str(meta.get("adapter") or cell_dir.name),
                status="summarized",
                exit_code=None,
                duration_seconds=0.0,
                output_dir=str(cell_dir),
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
                result_path=str(result_path) if result_path else None,
                failure_class=failure_class,
                notes=notes,
            )
        )
    return results


def parse_csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if not value:
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run elizaOS coding-agent adapter matrix.")
    parser.add_argument("--adapters", default=",".join(DEFAULT_ADAPTERS))
    parser.add_argument("--benchmarks", default=",".join(DEFAULT_BENCHMARKS))
    parser.add_argument("--provider", default=DEFAULT_PROVIDER)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--run-root", default="")
    parser.add_argument("--max-tasks", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--no-docker", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--summarize",
        default="",
        help="Summarize an existing run root instead of executing.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = workspace_root()
    default_run_root = root / "benchmark_results" / "code-agent-matrix" / now_id()
    run_root = Path(args.summarize or args.run_root or default_run_root)
    run_root = run_root.expanduser().resolve()

    if args.summarize:
        results = summarize_existing(run_root)
    else:
        adapters = parse_csv(args.adapters, DEFAULT_ADAPTERS)
        benchmarks = parse_csv(args.benchmarks, DEFAULT_BENCHMARKS)
        cells = [
            build_cell(
                root=root,
                run_root=run_root,
                benchmark=benchmark,
                adapter=adapter,
                provider=args.provider,
                model=args.model,
                max_tasks=args.max_tasks,
                smoke=args.smoke,
                no_docker=args.no_docker,
            )
            for benchmark in benchmarks
            for adapter in adapters
        ]
        results = [
            run_cell(cell, dry_run=args.dry_run, timeout_seconds=args.timeout_seconds)
            for cell in cells
        ]

    summary = summarize_results(results)
    write_json(run_root / "summary.json", summary)
    (run_root / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print(
        json.dumps(
            {"run_root": str(run_root), "summary": str(run_root / "summary.json")},
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
