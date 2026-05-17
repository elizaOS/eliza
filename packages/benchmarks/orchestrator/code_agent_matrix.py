"""Comparative coding-agent benchmark harness.

This module wraps the existing SWE-bench and Terminal-Bench CLIs and writes one
artifact directory per ``(benchmark, adapter)`` cell. It is intentionally thin:
the benchmark CLIs remain the source of truth, while this layer handles matrix
construction, resume/dry-run flow, redacted logs, and summary classification.
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
DEFAULT_BENCHMARKS = ("swe_bench",)
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
CODE_CAPABILITIES = "code.read,code.write,code.edit,code.search,code.shell"

FAILURE_CLASSES = (
    "pass",
    "auth_or_provider",
    "missing_cli",
    "timeout",
    "patch_apply_failed",
    "no_patch",
    "tests_failed",
    "harness_error",
    "stopped_early",
    "no_trajectory",
    "unknown_failure",
)

SECRET_ENV_RE = re.compile(
    r"(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTH|BEARER|SESSION|COOKIE)",
    re.IGNORECASE,
)
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)(api[_-]?key|token|secret|password|authorization|bearer)([=:]\s*)([^\s'\"`]+)"
)
LONG_SECRET_RE = re.compile(r"\b(?:sk|sess|pk|org|key|tok|eyJ)[A-Za-z0-9_\-]{16,}\b")


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
    score: float | None = None
    resumed: bool = False


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
    overrides = {
        "BENCHMARK_TASK_AGENT": adapter,
        "BENCHMARK_MODEL_PROVIDER": provider,
        "BENCHMARK_MODEL_NAME": model,
        "CEREBRAS_BASE_URL": DEFAULT_CEREBRAS_BASE_URL,
        "CODE_AGENT_MATRIX_BENCHMARK": benchmark,
        "CODE_AGENT_MATRIX_ADAPTER": adapter,
    }
    if provider == "cerebras":
        overrides.setdefault("OPENAI_API_BASE", DEFAULT_CEREBRAS_BASE_URL)
    return overrides


def _safe_pythonpath(root: Path) -> str:
    b_root = benchmarks_root(root)
    paths = [
        root / "packages",
        b_root / "terminal-bench",
        b_root / "eliza-adapter",
        b_root / "hermes-adapter",
        b_root / "openclaw-adapter",
    ]
    existing = os.environ.get("PYTHONPATH", "")
    values = [str(path) for path in paths if path.exists()]
    if existing:
        values.append(existing)
    return os.pathsep.join(values)


def child_env(cell: MatrixCell) -> dict[str, str]:
    env = dict(os.environ)
    env.update(cell.env_overrides)
    root = workspace_root()
    env["PYTHONPATH"] = _safe_pythonpath(root)
    env.setdefault("PYTHONUNBUFFERED", "1")
    model = env.get("BENCHMARK_MODEL_NAME", DEFAULT_MODEL)
    for key in (
        "OPENAI_LARGE_MODEL",
        "OPENAI_SMALL_MODEL",
        "CEREBRAS_MODEL",
        "CEREBRAS_LARGE_MODEL",
        "CEREBRAS_SMALL_MODEL",
    ):
        env.setdefault(key, model)
    opencode_shim = root / "plugins" / "plugin-agent-orchestrator" / "bin" / "opencode"
    if opencode_shim.exists():
        env.setdefault("OPENCODE_BIN", str(opencode_shim))
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
            CODE_CAPABILITIES,
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
            "--agent-harness",
            "eliza",
            "--task-agent",
            adapter,
            "--model-provider",
            provider,
            "--model",
            model,
            "--output-dir",
            str(output_dir),
            "--no-leaderboard",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        if smoke:
            cmd.extend(["--use-sample-tasks", "--local-sandbox", "--mock"])
        return cmd, b_root / "terminal-bench"

    raise ValueError(f"unsupported benchmark for code-agent matrix: {benchmark}")


def expand_template(template: str, values: dict[str, str]) -> list[str]:
    return [part.format(**values) for part in shlex.split(template)]


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
    cell_root = run_root / sanitize(benchmark) / sanitize(adapter)
    output_dir = cell_root / "output"
    trajectory_dir = cell_root / "trajectories"
    env_overrides = visible_env_overrides(
        adapter=adapter,
        benchmark=benchmark,
        provider=provider,
        model=model,
    )
    values = {
        "root": str(root),
        "benchmarks_root": str(benchmarks_root(root)),
        "benchmark": benchmark,
        "adapter": adapter,
        "provider": provider,
        "model": model,
        "output_dir": str(output_dir),
        "trajectory_dir": str(trajectory_dir),
        "max_tasks": "" if max_tasks is None else str(max_tasks),
    }
    template = os.environ.get(env_name(adapter, benchmark), "").strip()
    if template:
        command = expand_template(template, values)
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


def _cell_root(cell: MatrixCell) -> Path:
    return Path(cell.output_dir).parent


def find_latest_result(output_dir: Path) -> Path | None:
    patterns = [
        "orchestrated-*.json",
        "swe-bench-*.json",
        "terminal-bench-*.json",
        "*.json",
    ]
    matches: list[Path] = []
    for pattern in patterns:
        matches.extend(p for p in output_dir.glob(pattern) if p.is_file())
    matches = [p for p in matches if p.name not in {"cell-result.json", "command.json"}]
    if not matches:
        return None
    return max(matches, key=lambda p: p.stat().st_mtime)


def read_json(path: Path | None) -> Any:
    if path is None or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _text_has(text: str, *needles: str) -> bool:
    lowered = text.lower()
    return any(needle in lowered for needle in needles)


def _collect_result_items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    candidates: list[Any] = []
    if isinstance(payload.get("results"), list):
        candidates.append(payload["results"])
    orchestrated = payload.get("orchestrated")
    if isinstance(orchestrated, dict):
        for provider_payload in orchestrated.values():
            if isinstance(provider_payload, dict) and isinstance(provider_payload.get("results"), list):
                candidates.append(provider_payload["results"])
    items: list[dict[str, Any]] = []
    for candidate in candidates:
        for item in candidate:
            if isinstance(item, dict):
                items.append(item)
    return items


def classify_failure(
    *,
    exit_code: int | None,
    result_payload: Any,
    stdout: str,
    stderr: str,
) -> tuple[str, list[str]]:
    notes: list[str] = []
    combined = "\n".join([stdout, stderr])
    score = score_from_payload(result_payload)
    if exit_code == 0 and score is not None and score > 0:
        return "pass", notes

    if _text_has(
        combined,
        "unauthorized",
        "forbidden",
        "invalid api key",
        "missing api key",
        "authentication",
        "no provider registered",
        "provider not found",
        "quota",
        "rate limit",
    ):
        notes.append("provider authentication/routing text found in logs")
        return "auth_or_provider", notes

    if exit_code == 124 or _text_has(combined, "timed out", "timeout after", "timeout expired"):
        notes.append("timeout marker found")
        return "timeout", notes

    if exit_code == 127 or _text_has(combined, "command not found", "executable not found", "no such file or directory"):
        notes.append("missing executable marker found")
        return "missing_cli", notes

    if isinstance(result_payload, dict):
        error_text = str(result_payload.get("error") or "")
        if error_text and _text_has(error_text, "missing required capabilities", "no provider registered"):
            return "auth_or_provider", [error_text]
        matrix = result_payload.get("matrix")
        if isinstance(matrix, dict) and matrix.get("strict_capabilities") and error_text:
            return "auth_or_provider", [error_text]

    items = _collect_result_items(result_payload)
    statuses = " ".join(str(item.get("patch_status") or item.get("status") or "") for item in items).lower()
    errors = " ".join(str(item.get("error") or item.get("error_message") or "") for item in items).lower()
    if "not_generated" in statuses or "not generated" in statuses or _text_has(errors, "no patch", "did not contain an applicable unified diff"):
        notes.append("no generated patch reported")
        return "no_patch", notes
    if "apply_failed" in statuses or _text_has(errors, "git apply", "patch does not apply", "apply failed", "patch failed"):
        notes.append("patch apply failure reported")
        return "patch_apply_failed", notes
    if any(item.get("success") is False for item in items) or _text_has(statuses, "failed"):
        notes.append("benchmark item failures reported")
        return "tests_failed", notes

    if exit_code not in (0, None):
        notes.append(f"nonzero exit code {exit_code}")
        return "harness_error", notes

    if result_payload is None:
        return "stopped_early", ["no result JSON found"]

    return "unknown_failure", notes


def score_from_payload(payload: Any) -> float | None:
    if not isinstance(payload, dict):
        return None
    metrics = payload.get("metrics")
    if isinstance(metrics, dict):
        for key in ("overall_score", "accuracy", "score"):
            value = metrics.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    summary = payload.get("summary")
    if isinstance(summary, dict):
        for key in ("resolve_rate", "accuracy", "score"):
            value = summary.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    for key in ("accuracy", "resolve_rate", "score"):
        value = payload.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _secret_values(env: dict[str, str]) -> list[str]:
    values: list[str] = []
    for key, value in env.items():
        if value and len(value) >= 8 and SECRET_ENV_RE.search(key):
            values.append(value)
    return sorted(values, key=len, reverse=True)


def redact_text(text: str, env: dict[str, str]) -> str:
    redacted = text
    for value in _secret_values(env):
        redacted = redacted.replace(value, "[REDACTED]")
    redacted = SECRET_ASSIGNMENT_RE.sub(r"\1\2[REDACTED]", redacted)
    redacted = LONG_SECRET_RE.sub("[REDACTED]", redacted)
    return redacted


def _write_cell_metadata(cell: MatrixCell) -> None:
    cell_root = _cell_root(cell)
    cell_root.mkdir(parents=True, exist_ok=True)
    Path(cell.output_dir).mkdir(parents=True, exist_ok=True)
    Path(cell.trajectory_dir).mkdir(parents=True, exist_ok=True)
    redaction_env = dict(os.environ)
    redaction_env.update(cell.env_overrides)
    write_json(
        cell_root / "command.json",
        {
            "benchmark": cell.benchmark,
            "adapter": cell.adapter,
            "cwd": redact_text(cell.cwd, redaction_env),
            "command": [redact_text(part, redaction_env) for part in cell.command],
            "output_dir": cell.output_dir,
            "trajectory_dir": cell.trajectory_dir,
            "env_overrides": cell.env_overrides,
            "secret_policy": "real process env is inherited, metadata/logs redact secret-looking values",
        },
    )


def _redact_artifact_tree(root: Path, env: dict[str, str]) -> None:
    suffixes = {".json", ".jsonl", ".log", ".md", ".txt", ".out", ".err"}
    if not root.exists():
        return
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        redacted = redact_text(text, env)
        if redacted != text:
            path.write_text(redacted, encoding="utf-8")


def _load_existing_result(cell: MatrixCell) -> CellResult | None:
    path = _cell_root(cell) / "cell-result.json"
    payload = read_json(path)
    if not isinstance(payload, dict):
        return None
    try:
        return CellResult(
            benchmark=str(payload["benchmark"]),
            adapter=str(payload["adapter"]),
            status=str(payload["status"]),
            exit_code=payload.get("exit_code"),
            duration_seconds=float(payload.get("duration_seconds") or 0.0),
            output_dir=str(payload["output_dir"]),
            stdout_path=str(payload["stdout_path"]),
            stderr_path=str(payload["stderr_path"]),
            result_path=payload.get("result_path"),
            failure_class=str(payload.get("failure_class") or "unknown_failure"),
            notes=list(payload.get("notes") or []),
            score=payload.get("score"),
            resumed=True,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _result_from_cell_payload(
    *,
    cell: MatrixCell,
    status: str,
    exit_code: int | None,
    duration_seconds: float,
    stdout_path: Path,
    stderr_path: Path,
    result_path: Path | None,
    failure_class: str,
    notes: list[str],
    score: float | None,
    resumed: bool = False,
) -> CellResult:
    return CellResult(
        benchmark=cell.benchmark,
        adapter=cell.adapter,
        status=status,
        exit_code=exit_code,
        duration_seconds=duration_seconds,
        output_dir=cell.output_dir,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        result_path=str(result_path) if result_path else None,
        failure_class=failure_class,
        notes=notes,
        score=score,
        resumed=resumed,
    )


def run_cell(
    cell: MatrixCell,
    *,
    dry_run: bool,
    timeout_seconds: int,
    resume: bool = True,
    force: bool = False,
) -> CellResult:
    _write_cell_metadata(cell)
    cell_root = _cell_root(cell)
    stdout_path = cell_root / "stdout.log"
    stderr_path = cell_root / "stderr.log"

    if resume and not force:
        existing = _load_existing_result(cell)
        if existing is not None and existing.status in {"succeeded", "failed", "dry_run"}:
            return existing

    if dry_run:
        stdout_path.write_text("Dry run: command was not executed.\n", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        result = _result_from_cell_payload(
            cell=cell,
            status="dry_run",
            exit_code=None,
            duration_seconds=0.0,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            result_path=None,
            failure_class="stopped_early",
            notes=["dry run only"],
            score=None,
        )
        write_json(cell_root / "cell-result.json", asdict(result))
        return result

    env = child_env(cell)
    started = time.time()
    try:
        completed = subprocess.run(
            cell.command,
            cwd=cell.cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
        exit_code = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        stderr = (stderr + f"\nCommand timed out after {timeout_seconds}s\n").strip() + "\n"
    except OSError as exc:
        exit_code = 127
        stdout = ""
        stderr = f"Command execution failed: {exc}\n"

    duration = time.time() - started
    stdout_path.write_text(redact_text(stdout, env), encoding="utf-8")
    stderr_path.write_text(redact_text(stderr, env), encoding="utf-8")
    _redact_artifact_tree(cell_root, env)

    result_path = find_latest_result(Path(cell.output_dir))
    payload = read_json(result_path)
    failure_class, notes = classify_failure(
        exit_code=exit_code,
        result_payload=payload,
        stdout=stdout_path.read_text(encoding="utf-8", errors="replace"),
        stderr=stderr_path.read_text(encoding="utf-8", errors="replace"),
    )
    score = score_from_payload(payload)
    status = "succeeded" if exit_code == 0 and result_path is not None else "failed"
    result = _result_from_cell_payload(
        cell=cell,
        status=status,
        exit_code=exit_code,
        duration_seconds=duration,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        result_path=result_path,
        failure_class=failure_class,
        notes=notes,
        score=score,
    )
    write_json(cell_root / "cell-result.json", asdict(result))
    return result


def summarize_results(results: list[CellResult]) -> dict[str, Any]:
    by_adapter: dict[str, dict[str, int]] = {}
    by_benchmark: dict[str, dict[str, int]] = {}
    for result in results:
        by_adapter.setdefault(result.adapter, {})
        by_adapter[result.adapter][result.failure_class] = by_adapter[result.adapter].get(result.failure_class, 0) + 1
        by_benchmark.setdefault(result.benchmark, {})
        by_benchmark[result.benchmark][result.failure_class] = by_benchmark[result.benchmark].get(result.failure_class, 0) + 1

    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "total": len(results),
        "status_counts": {
            status: sum(1 for result in results if result.status == status)
            for status in sorted({result.status for result in results})
        },
        "failure_classes": {
            klass: sum(1 for result in results if result.failure_class == klass)
            for klass in FAILURE_CLASSES
        },
        "by_adapter": by_adapter,
        "by_benchmark": by_benchmark,
        "cells": [asdict(result) for result in results],
    }


def render_markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# Code Agent Matrix Summary",
        "",
        f"Generated: {summary.get('generated_at')}",
        f"Cells: {summary.get('total')}",
        "",
        "## Cells",
        "",
        "| benchmark | adapter | status | score | failure_class | result |",
        "| --- | --- | --- | ---: | --- | --- |",
    ]
    for cell in summary.get("cells", []):
        result_path = cell.get("result_path") or ""
        score = cell.get("score")
        score_text = "" if score is None else f"{float(score):.4f}"
        lines.append(
            "| {benchmark} | {adapter} | {status} | {score} | {failure_class} | {result} |".format(
                benchmark=cell.get("benchmark", ""),
                adapter=cell.get("adapter", ""),
                status=cell.get("status", ""),
                score=score_text,
                failure_class=cell.get("failure_class", ""),
                result=result_path,
            )
        )
    lines.extend(["", "## Failure Classes", ""])
    for klass, count in sorted((summary.get("failure_classes") or {}).items()):
        if count:
            lines.append(f"- `{klass}`: {count}")
    return "\n".join(lines) + "\n"


def summarize_existing(run_root: Path) -> list[CellResult]:
    results: list[CellResult] = []
    for command_path in sorted(run_root.glob("*/*/command.json")):
        cell_dir = command_path.parent
        meta = read_json(command_path)
        if not isinstance(meta, dict):
            continue
        stdout_path = cell_dir / "stdout.log"
        stderr_path = cell_dir / "stderr.log"
        stdout = stdout_path.read_text(encoding="utf-8", errors="replace") if stdout_path.exists() else ""
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
        output_dir = Path(str(meta.get("output_dir") or (cell_dir / "output")))
        result_path = find_latest_result(output_dir)
        payload = read_json(result_path)
        cell_result_payload = read_json(cell_dir / "cell-result.json")
        exit_code = None
        duration = 0.0
        status = "summarized"
        if isinstance(cell_result_payload, dict):
            raw_exit = cell_result_payload.get("exit_code")
            exit_code = raw_exit if isinstance(raw_exit, int) else None
            duration = float(cell_result_payload.get("duration_seconds") or 0.0)
            status = str(cell_result_payload.get("status") or status)
        failure_class, notes = classify_failure(
            exit_code=exit_code if exit_code is not None else (0 if result_path else None),
            result_payload=payload,
            stdout=stdout,
            stderr=stderr,
        )
        results.append(
            CellResult(
                benchmark=str(meta.get("benchmark") or cell_dir.parent.name),
                adapter=str(meta.get("adapter") or cell_dir.name),
                status=status,
                exit_code=exit_code,
                duration_seconds=duration,
                output_dir=str(output_dir),
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
                result_path=str(result_path) if result_path else None,
                failure_class=failure_class,
                notes=notes,
                score=score_from_payload(payload),
                resumed=True,
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
    parser.add_argument("--force", action="store_true", help="Re-run cells even when cell-result.json exists.")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing cell-result.json files.")
    parser.add_argument("--summarize", default="", help="Summarize an existing run root instead of executing.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = workspace_root()
    default_run_root = root / "benchmark_results" / "code-agent-matrix" / now_id()
    run_root = Path(args.summarize or args.run_root or default_run_root).expanduser().resolve()

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
            run_cell(
                cell,
                dry_run=args.dry_run,
                timeout_seconds=args.timeout_seconds,
                resume=not args.no_resume,
                force=args.force,
            )
            for cell in cells
        ]

    summary = summarize_results(results)
    write_json(run_root / "summary.json", summary)
    (run_root / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print(json.dumps({"run_root": str(run_root), "summary": str(run_root / "summary.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
