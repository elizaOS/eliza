"""Comparative coding-agent benchmark harness.

This module wraps the existing SWE-bench, Terminal-Bench, browser/web, and
computer-use CLIs and writes one artifact directory per ``(benchmark, adapter)``
cell. It is intentionally thin: the benchmark CLIs remain the source of truth,
while this layer handles matrix construction, resume/dry-run flow, redacted
logs, and summary classification.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .analyze_trajectory import summarize as summarize_trajectory
from .code_agent_coverage import CODE_AGENT_COVERAGE, included_benchmark_ids

DEFAULT_ADAPTERS = ("elizaos", "opencode")
DEFAULT_BENCHMARKS = included_benchmark_ids()
DEFAULT_TARGET_ADAPTER = "elizaos"
DEFAULT_BASELINE_ADAPTER = "opencode"
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
CODE_CAPABILITIES = "code.read,code.write,code.edit,code.search,code.shell"
DEFAULT_LOG_LIMIT_BYTES = 16 * 1024 * 1024
REPORT_ROW_FIELDS = (
    "generated_at",
    "run_root",
    "mode",
    "provider",
    "model",
    "benchmark",
    "status",
    "target_adapter",
    "baseline_adapter",
    "target_right",
    "target_wrong",
    "target_total",
    "target_accuracy",
    "baseline_right",
    "baseline_wrong",
    "baseline_total",
    "baseline_accuracy",
    "accuracy_delta",
    "target_input_tokens",
    "target_output_tokens",
    "target_total_tokens",
    "target_cached_token_percent",
    "target_llm_call_count",
    "baseline_input_tokens",
    "baseline_output_tokens",
    "baseline_total_tokens",
    "baseline_cached_token_percent",
    "baseline_llm_call_count",
    "input_token_delta",
    "output_token_delta",
    "total_token_delta",
    "cached_token_percent_delta",
    "llm_call_delta",
    "coverage_gate_ok",
    "benchmark_gate_ok",
    "required_stats_gate_ok",
    "efficiency_gate_ok",
    "no_regression_gate_ok",
    "quality_guardrail_gate_ok",
    "trajectory_review_gate_ok",
    "live_report_gate_ok",
    "report_gate_ok",
)
EXIT_OK = 0
EXIT_PREFLIGHT_FAILED = 2
EXIT_COMPARABLE_GATE_FAILED = 3
EXIT_TOKEN_EVIDENCE_FAILED = 4
EXIT_REQUIRED_STATS_FAILED = 5
EXIT_COVERAGE_GATE_FAILED = 6
EXIT_REPORT_GATE_FAILED = 7
EXIT_EFFICIENCY_GATE_FAILED = 8
EXIT_NO_REGRESSION_FAILED = 9
EXIT_QUALITY_GUARDRAIL_FAILED = 10
EXIT_TRAJECTORY_REVIEW_FAILED = 11
EXIT_LIVE_REPORT_FAILED = 12
EXIT_CODE_SPECS = (
    (EXIT_OK, "ok", "run completed without an enforced gate failure"),
    (EXIT_PREFLIGHT_FAILED, "preflight_failed", "preflight checks failed"),
    (
        EXIT_COMPARABLE_GATE_FAILED,
        "comparable_gate_failed",
        "ElizaOS was not comparable-or-better than OpenCode on every selected benchmark",
    ),
    (
        EXIT_TOKEN_EVIDENCE_FAILED,
        "token_evidence_failed",
        "one or more selected cells lacked usable LLM token telemetry",
    ),
    (
        EXIT_REQUIRED_STATS_FAILED,
        "required_stats_failed",
        "one or more selected benchmarks lacked required outcome or token stats",
    ),
    (
        EXIT_COVERAGE_GATE_FAILED,
        "coverage_gate_failed",
        "the run did not cover every included code-agent benchmark",
    ),
    (
        EXIT_REPORT_GATE_FAILED,
        "report_gate_failed",
        "the combined release-readiness report gate failed",
    ),
    (
        EXIT_EFFICIENCY_GATE_FAILED,
        "efficiency_gate_failed",
        "ElizaOS used more tokens, made more LLM calls, or had lower cached-token percentage than OpenCode",
    ),
    (
        EXIT_NO_REGRESSION_FAILED,
        "no_regression_failed",
        "ElizaOS regressed against the previous comparison summary",
    ),
    (
        EXIT_QUALITY_GUARDRAIL_FAILED,
        "quality_guardrail_failed",
        "the broader non-code benchmark readiness guardrail failed",
    ),
    (
        EXIT_TRAJECTORY_REVIEW_FAILED,
        "trajectory_review_failed",
        "one or more selected cells lacked reviewable trajectory telemetry",
    ),
    (
        EXIT_LIVE_REPORT_FAILED,
        "live_report_failed",
        "the report was not generated from live benchmark execution",
    ),
)

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
    outcome_metrics: dict[str, int | float | None] = field(default_factory=dict)
    token_metrics: dict[str, int | float | None] = field(default_factory=dict)
    resumed: bool = False


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[3]


def benchmarks_root(root: Path) -> Path:
    return root / "packages" / "benchmarks"


def sanitize(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip("-").lower() or "run"


def now_id() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def default_swe_bench_repo_cache_dir() -> Path:
    return Path(tempfile.gettempdir()) / "eliza-swe-bench-repo-cache"


def provider_key_name(provider: str) -> str | None:
    return {
        "anthropic": "ANTHROPIC_API_KEY",
        "cerebras": "CEREBRAS_API_KEY",
        "groq": "GROQ_API_KEY",
        "openai": "OPENAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
    }.get(provider.lower())


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
        b_root / "webshop",
        b_root / "OSWorld",
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


def _opencode_bin(root: Path, env: dict[str, str]) -> str | None:
    configured = env.get("OPENCODE_BIN")
    if configured:
        return configured if Path(configured).exists() or shutil.which(configured) else None
    opencode_shim = root / "plugins" / "plugin-agent-orchestrator" / "bin" / "opencode"
    if opencode_shim.exists():
        return str(opencode_shim)
    return shutil.which("opencode")


def _nl2repo_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"NL2REPO_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _nl2repo_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_nl2repo_command_env_name(adapter), "")
        or env.get("NL2REPO_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("NL2REPO_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "nl2repo" / "agent_command.py"
    if not agent_command.exists():
        return ""
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(agent_command),
            "--adapter",
            adapter,
            "--workspace",
            "{workspace}",
            "--instruction",
            "{instruction}",
            "--prompt",
            "{prompt}",
            "--task",
            "{task}",
            "--result-json",
            "{result_json}",
            "--provider",
            "{model_provider}",
            "--model",
            "{model}",
        )
    )


def preflight_matrix(
    *,
    root: Path,
    cells: list[MatrixCell],
    provider: str,
    require_provider_key: bool = True,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env = dict(os.environ if env is None else env)
    issues: list[dict[str, str]] = []
    key_name = provider_key_name(provider)
    if require_provider_key and key_name and not env.get(key_name):
        issues.append(
            {
                "severity": "error",
                "kind": "missing_provider_key",
                "message": f"{key_name} is required for provider {provider}",
            }
        )

    opencode_bin = _opencode_bin(root, env)
    if any(cell.adapter == "opencode" for cell in cells) and not opencode_bin:
        issues.append(
            {
                "severity": "error",
                "kind": "missing_opencode_cli",
                "message": "opencode adapter selected but OPENCODE_BIN or opencode CLI was not found",
            }
        )

    cell_checks: list[dict[str, Any]] = []
    nl2repo_docker_checked = False
    for cell in cells:
        executable = cell.command[0] if cell.command else ""
        executable_ok = bool(executable and (Path(executable).exists() or shutil.which(executable)))
        cwd_ok = Path(cell.cwd).exists()
        if not executable_ok:
            issues.append(
                {
                    "severity": "error",
                    "kind": "missing_executable",
                    "message": f"{cell.benchmark}/{cell.adapter} executable not found: {executable}",
                }
            )
        if not cwd_ok:
            issues.append(
                {
                    "severity": "error",
                    "kind": "missing_cwd",
                    "message": f"{cell.benchmark}/{cell.adapter} cwd not found: {cell.cwd}",
                }
            )
        if cell.benchmark == "nl2repo" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_nl2repo_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            f"NL2REPO_AGENT_COMMAND_TEMPLATE or {_nl2repo_command_env_name(cell.adapter)}"
                        ),
                    }
                )
            if "--no-docker" not in cell.command and not nl2repo_docker_checked:
                nl2repo_docker_checked = True
                docker = shutil.which("docker")
                if not docker:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "missing_docker_cli",
                            "message": "nl2repo live scoring requires the Docker CLI",
                        }
                    )
                else:
                    completed = subprocess.run(
                        [docker, "version"],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    if completed.returncode != 0:
                        detail = (completed.stderr or completed.stdout or "").strip()
                        issues.append(
                            {
                                "severity": "error",
                                "kind": "docker_daemon_unavailable",
                                "message": (
                                    "nl2repo live scoring requires a running Docker daemon"
                                    + (f": {detail}" if detail else "")
                                ),
                            }
                        )
        cell_checks.append(
            {
                "benchmark": cell.benchmark,
                "adapter": cell.adapter,
                "executable": executable,
                "executable_ok": executable_ok,
                "cwd": cell.cwd,
                "cwd_ok": cwd_ok,
                "output_dir": cell.output_dir,
                "trajectory_dir": cell.trajectory_dir,
            }
        )

    return {
        "ok": not any(issue["severity"] == "error" for issue in issues),
        "provider": provider,
        "provider_key": key_name,
        "provider_key_present": bool(key_name and env.get(key_name)),
        "provider_key_required": bool(require_provider_key and key_name),
        "opencode_bin": opencode_bin,
        "issues": issues,
        "cells": cell_checks,
    }


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
    if benchmark in {"swe_bench", "swe_bench_multilingual"}:
        swe_variant = "multilingual" if benchmark == "swe_bench_multilingual" else "lite"
        cmd = [
            python,
            "-m",
            "benchmarks.swe_bench.cli",
            "--variant",
            swe_variant,
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
        elif no_docker:
            cmd.append("--local-sandbox")
        return cmd, b_root / "terminal-bench"

    if benchmark == "mind2web":
        cmd = [
            python,
            "-m",
            "benchmarks.mind2web",
            "--sample",
            "--provider",
            "eliza",
            "--model",
            model,
            "--output",
            str(output_dir),
            "--json",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        if smoke:
            cmd.append("--mock")
        return cmd, root

    if benchmark == "visualwebbench":
        cmd = [
            python,
            "-m",
            "benchmarks.visualwebbench",
            "--provider",
            "eliza",
            "--model",
            model,
            "--output",
            str(output_dir),
            "--json",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        if smoke:
            cmd.extend(["--use-sample-tasks", "--mock"])
        return cmd, root

    if benchmark == "webshop":
        cmd = [
            python,
            "-m",
            "elizaos_webshop",
            "--model-provider",
            provider,
            "--model",
            model,
            "--output",
            str(output_dir),
            "--json",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        if smoke:
            cmd.extend(["--use-sample-tasks", "--mock"])
        else:
            cmd.append("--bridge")
        return cmd, b_root / "webshop"

    if benchmark == "osworld":
        cmd = [
            python,
            "scripts/python/run_multienv_eliza.py",
            "--model",
            model,
            "--result_dir",
            str(output_dir),
        ]
        if max_tasks is not None:
            cmd.extend(["--max_tasks", str(max_tasks)])
        if smoke:
            cmd.append("--dry_run")
        return cmd, b_root / "OSWorld"

    if benchmark == "nl2repo":
        cmd = [
            python,
            "-m",
            "benchmarks.nl2repo.adapter_matrix",
            "--agent-harness",
            "eliza",
            "--task-agent",
            adapter,
            "--model-provider",
            provider,
            "--model",
            model,
            "--output",
            str(output_dir),
            "--trajectory-dir",
            str(trajectory_dir),
            "--json",
        ]
        if max_tasks is not None:
            cmd.extend(["--max-tasks", str(max_tasks)])
        command_template = _nl2repo_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

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
    env_overrides["BENCHMARK_RUN_DIR"] = str(trajectory_dir)
    env_overrides["BENCHMARK_TELEMETRY_JSONL"] = str(trajectory_dir / "telemetry.jsonl")
    if benchmark in {"swe_bench", "swe_bench_multilingual"}:
        env_overrides["SWE_BENCH_REPO_CACHE_DIR"] = os.environ.get(
            "SWE_BENCH_REPO_CACHE_DIR",
            str(default_swe_bench_repo_cache_dir()),
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
    if benchmark == "webshop" and smoke:
        env_overrides["WEBSHOP_ALLOW_SPACY_STUB"] = "1"
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
    nested_matches = [
        p
        for p in output_dir.rglob("results.json")
        if p.is_file() and p.parent.name == "summary"
    ]
    if nested_matches:
        return max(nested_matches, key=lambda p: p.stat().st_mtime)

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
    if exit_code == 0 and score is not None and score >= 1.0:
        return "pass", notes
    outcome = collect_outcome_metrics(result_payload)
    accuracy = outcome.get("accuracy")
    if exit_code == 0 and isinstance(accuracy, (int, float)) and accuracy >= 1.0:
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
    if _text_has(errors, "harness did not produce a report.json", "swe-bench harness evaluation failed"):
        notes.append("harness report failure reported")
        return "harness_error", notes
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


def _metric_number(payload: dict[str, Any], *keys: str) -> int | float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return value
    return None


def collect_outcome_metrics(payload: Any) -> dict[str, int | float | None]:
    metrics: dict[str, int | float | None] = {
        "right": None,
        "wrong": None,
        "total": None,
        "accuracy": None,
    }
    if isinstance(payload, list):
        scores = [
            item.get("score")
            for item in payload
            if isinstance(item, dict)
            and isinstance(item.get("score"), (int, float))
            and not isinstance(item.get("score"), bool)
        ]
        if scores:
            right = sum(float(score) for score in scores)
            total = len(scores)
            metrics.update(
                {
                    "right": right,
                    "wrong": total - right,
                    "total": total,
                    "accuracy": right / total,
                }
            )
        return metrics
    if not isinstance(payload, dict):
        return metrics

    metrics_payload = payload.get("metrics")
    if isinstance(metrics_payload, dict):
        accuracy = _metric_number(
            metrics_payload,
            "overall_score",
            "accuracy",
            "score",
            "success_rate",
        )
        if accuracy is not None:
            metrics["accuracy"] = accuracy

    summary = payload.get("summary")
    if isinstance(summary, dict):
        total = _metric_number(summary, "total_instances", "total_tasks", "total")
        right = _metric_number(summary, "resolved", "passed_tasks", "passed", "successes")
        wrong = _metric_number(summary, "unresolved", "failed_tasks", "failed", "failures")
        accuracy = _metric_number(summary, "resolve_rate", "accuracy", "score")
        if total is not None or right is not None or wrong is not None or accuracy is not None:
            metrics.update(
                {
                    "right": right,
                    "wrong": wrong,
                    "total": total,
                    "accuracy": accuracy if accuracy is not None else metrics.get("accuracy"),
                }
            )
            return _complete_outcome_metrics(metrics)

    total = _metric_number(payload, "total_tasks", "total_trials", "total_instances", "total")
    right = _metric_number(payload, "passed_tasks", "successes", "resolved", "passed")
    wrong = _metric_number(payload, "failed_tasks", "failures", "unresolved", "failed")
    accuracy = _metric_number(
        payload,
        "overall_accuracy",
        "success_rate",
        "overall_task_success_rate",
        "overall_step_accuracy",
        "average_reward",
        "mean_reward",
        "accuracy",
        "resolve_rate",
        "score",
    )
    if total is not None or right is not None or wrong is not None or accuracy is not None:
        metrics.update(
            {
                "right": right,
                "wrong": wrong,
                "total": total,
                "accuracy": accuracy if accuracy is not None else metrics.get("accuracy"),
            }
        )
        return _complete_outcome_metrics(metrics)

    items = _collect_result_items(payload)
    if items:
        right_count = 0
        wrong_count = 0
        scored = 0
        for item in items:
            score = _metric_number(item, "score", "reward", "accuracy")
            if score is not None:
                bounded_score = max(0.0, min(1.0, float(score)))
                scored += 1
                right_count += bounded_score
                wrong_count += 1.0 - bounded_score
                continue
            success = item.get("success")
            if isinstance(success, bool):
                scored += 1
                if success:
                    right_count += 1
                else:
                    wrong_count += 1
                continue
        if scored:
            metrics.update(
                {
                    "right": right_count,
                    "wrong": wrong_count,
                    "total": scored,
                    "accuracy": right_count / scored,
                }
            )
    return _complete_outcome_metrics(metrics)


def _complete_outcome_metrics(
    metrics: dict[str, int | float | None]
) -> dict[str, int | float | None]:
    right = metrics.get("right")
    wrong = metrics.get("wrong")
    total = metrics.get("total")
    accuracy = metrics.get("accuracy")
    if total is None and isinstance(right, (int, float)) and isinstance(wrong, (int, float)):
        total = int(right + wrong)
        metrics["total"] = total
    if wrong is None and isinstance(total, (int, float)) and isinstance(right, (int, float)):
        metrics["wrong"] = int(total - right)
    if right is None and isinstance(total, (int, float)) and isinstance(wrong, (int, float)):
        metrics["right"] = int(total - wrong)
    if accuracy is None and isinstance(total, (int, float)) and total > 0 and isinstance(right, (int, float)):
        metrics["accuracy"] = float(right) / float(total)
    if right is None and isinstance(total, (int, float)) and isinstance(accuracy, (int, float)):
        metrics["right"] = float(total) * float(accuracy)
    if wrong is None and isinstance(total, (int, float)) and isinstance(metrics.get("right"), (int, float)):
        metrics["wrong"] = float(total) - float(metrics["right"])
    return metrics


def collect_token_metrics(trajectory_dir: Path) -> dict[str, int | float | None]:
    summary, records = summarize_trajectory(trajectory_dir)
    cached_percent: float | None = None
    if summary.prompt_tokens:
        cached_percent = (summary.cached_tokens / summary.prompt_tokens) * 100.0
    return {
        "input_tokens": summary.prompt_tokens,
        "output_tokens": summary.completion_tokens,
        "total_tokens": summary.total_tokens,
        "cached_tokens": summary.cached_tokens,
        "cache_creation_tokens": summary.cache_creation_tokens,
        "cached_token_percent": cached_percent,
        "llm_call_count": summary.llm_call_count,
        "trajectory_turn_count": summary.turns,
        "trajectory_file_count": summary.files,
    }


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


def log_limit_bytes() -> int:
    raw = os.environ.get("CODE_AGENT_MATRIX_LOG_LIMIT_BYTES", "").strip()
    if not raw:
        return DEFAULT_LOG_LIMIT_BYTES
    try:
        return max(1024, int(raw))
    except ValueError:
        return DEFAULT_LOG_LIMIT_BYTES


def truncate_log_text(text: str, *, limit_bytes: int | None = None) -> str:
    limit = log_limit_bytes() if limit_bytes is None else limit_bytes
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return text
    marker = (
        f"\n[code-agent-matrix: log truncated to last {limit} bytes "
        f"from {len(encoded)} bytes]\n"
    )
    keep = max(0, limit - len(marker.encode("utf-8")))
    tail = encoded[-keep:].decode("utf-8", errors="replace") if keep else ""
    return marker + tail


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
            outcome_metrics=dict(payload.get("outcome_metrics") or {}),
            token_metrics=dict(payload.get("token_metrics") or {}),
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
    outcome_metrics: dict[str, int | float | None] | None = None,
    token_metrics: dict[str, int | float | None] | None = None,
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
        outcome_metrics=outcome_metrics or {},
        token_metrics=token_metrics or {},
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
            outcome_metrics=collect_outcome_metrics(None),
            token_metrics=collect_token_metrics(Path(cell.trajectory_dir)),
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
    stdout_path.write_text(
        truncate_log_text(redact_text(stdout, env)),
        encoding="utf-8",
    )
    stderr_path.write_text(
        truncate_log_text(redact_text(stderr, env)),
        encoding="utf-8",
    )
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
    outcome_metrics = collect_outcome_metrics(payload)
    token_metrics = collect_token_metrics(Path(cell.trajectory_dir))
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
        outcome_metrics=outcome_metrics,
        token_metrics=token_metrics,
    )
    write_json(cell_root / "cell-result.json", asdict(result))
    return result


def _sum_metric(
    results: list[CellResult],
    field: str,
    metric: str,
) -> int | float | None:
    total: int | float = 0
    seen = False
    for result in results:
        source = result.outcome_metrics if field == "outcome" else result.token_metrics
        value = source.get(metric)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        total += value
        seen = True
    return total if seen else None


def _aggregate_by_adapter(results: list[CellResult], field: str) -> dict[str, dict[str, int | float | None]]:
    by_adapter: dict[str, list[CellResult]] = {}
    for result in results:
        by_adapter.setdefault(result.adapter, []).append(result)
    metric_names = (
        ("right", "wrong", "total", "accuracy")
        if field == "outcome"
        else (
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cached_tokens",
            "cache_creation_tokens",
            "cached_token_percent",
            "llm_call_count",
            "trajectory_turn_count",
            "trajectory_file_count",
        )
    )
    output: dict[str, dict[str, int | float | None]] = {}
    for adapter, adapter_results in by_adapter.items():
        row: dict[str, int | float | None] = {}
        for metric in metric_names:
            if metric in {"accuracy", "cached_token_percent"}:
                continue
            row[metric] = _sum_metric(adapter_results, field, metric)
        if field == "outcome":
            right = row.get("right")
            total = row.get("total")
            row["accuracy"] = (
                float(right) / float(total)
                if isinstance(right, (int, float)) and isinstance(total, (int, float)) and total > 0
                else None
            )
        else:
            cached = row.get("cached_tokens")
            input_tokens = row.get("input_tokens")
            row["cached_token_percent"] = (
                (float(cached) / float(input_tokens)) * 100.0
                if isinstance(cached, (int, float))
                and isinstance(input_tokens, (int, float))
                and input_tokens > 0
                else None
            )
        output[adapter] = row
    return output


def build_token_evidence(results: list[CellResult]) -> dict[str, Any]:
    """Summarize whether each cell produced usable LLM/token telemetry."""
    cells: list[dict[str, Any]] = []
    counts = {
        "present": 0,
        "empty": 0,
        "missing": 0,
    }
    for result in results:
        metrics = result.token_metrics
        files = metrics.get("trajectory_file_count")
        calls = metrics.get("llm_call_count")
        total_tokens = metrics.get("total_tokens")
        input_tokens = metrics.get("input_tokens")
        output_tokens = metrics.get("output_tokens")
        has_files = isinstance(files, (int, float)) and not isinstance(files, bool) and files > 0
        has_calls = isinstance(calls, (int, float)) and not isinstance(calls, bool) and calls > 0
        has_tokens = any(
            isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
            for value in (total_tokens, input_tokens, output_tokens)
        )
        if has_calls and has_tokens:
            status = "present"
            note = "LLM call and token telemetry found"
        elif has_files:
            status = "empty"
            note = "trajectory artifacts found but no LLM token usage was extracted"
        else:
            status = "missing"
            note = "no trajectory artifacts or token usage found"
        counts[status] += 1
        cells.append(
            {
                "benchmark": result.benchmark,
                "adapter": result.adapter,
                "status": status,
                "note": note,
                "trajectory_file_count": files,
                "llm_call_count": calls,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "cached_token_percent": metrics.get("cached_token_percent"),
                "trajectory_dir": str(Path(result.output_dir).parent / "trajectories"),
            }
        )
    return {
        "ok": counts["missing"] == 0 and counts["empty"] == 0,
        "status_counts": counts,
        "cells": cells,
        "message": (
            "all cells produced LLM token telemetry"
            if counts["missing"] == 0 and counts["empty"] == 0
            else "some cells did not produce usable LLM token telemetry"
        ),
    }


def build_coverage_summary(selected_benchmarks: list[str]) -> dict[str, Any]:
    selected = set(selected_benchmarks)
    included = [
        {
            "benchmark": item.benchmark_id,
            "domains": list(item.domains),
            "selected": item.benchmark_id in selected,
            "reason": item.reason,
        }
        for item in CODE_AGENT_COVERAGE
        if item.status == "included"
    ]
    deferred = [
        {
            "benchmark": item.benchmark_id,
            "domains": list(item.domains),
            "reason": item.reason,
        }
        for item in CODE_AGENT_COVERAGE
        if item.status == "deferred"
    ]
    unselected_included = [
        item["benchmark"] for item in included if not item["selected"]
    ]
    return {
        "selected_benchmarks": selected_benchmarks,
        "included_benchmarks": included,
        "deferred_benchmarks": deferred,
        "selection_complete": not unselected_included,
        "unselected_included_benchmarks": unselected_included,
        "status_counts": {
            "included": len(included),
            "included_selected": len(included) - len(unselected_included),
            "included_unselected": len(unselected_included),
            "deferred": len(deferred),
        },
        "message": (
            "all included code-agent benchmarks are selected"
            if not unselected_included
            else "some included code-agent benchmarks were not selected for this run"
        ),
    }


def build_coverage_gate(summary: dict[str, Any]) -> dict[str, Any]:
    coverage = summary.get("coverage")
    if not isinstance(coverage, dict):
        return {
            "ok": False,
            "blocking_benchmarks": [],
            "message": "benchmark coverage summary is missing",
        }
    blocking = list(coverage.get("unselected_included_benchmarks") or [])
    return {
        "ok": bool(coverage.get("selection_complete")),
        "required": "all included code-agent benchmarks selected",
        "blocking_benchmarks": sorted(str(item) for item in blocking),
        "deferred_benchmarks": [
            item.get("benchmark")
            for item in coverage.get("deferred_benchmarks", [])
            if isinstance(item, dict)
        ],
        "message": (
            "all included code-agent benchmarks are selected"
            if coverage.get("selection_complete")
            else "not all included code-agent benchmarks are selected"
        ),
    }


def _has_positive_total(outcome: dict[str, int | float | None]) -> bool:
    total = outcome.get("total")
    return isinstance(total, (int, float)) and not isinstance(total, bool) and total > 0


def _is_zero_score(outcome: dict[str, int | float | None]) -> bool:
    accuracy = outcome.get("accuracy")
    return (
        _has_positive_total(outcome)
        and isinstance(accuracy, (int, float))
        and not isinstance(accuracy, bool)
        and accuracy <= 0
    )


def _comparison_status(
    target_accuracy: Any,
    baseline_accuracy: Any,
    target_outcome: dict[str, int | float | None],
    baseline_outcome: dict[str, int | float | None],
) -> str:
    if not isinstance(target_accuracy, (int, float)) or not isinstance(baseline_accuracy, (int, float)):
        return "missing"
    if not _has_positive_total(target_outcome) or not _has_positive_total(baseline_outcome):
        return "missing"
    if _is_zero_score(target_outcome) and _is_zero_score(baseline_outcome):
        return "weak"
    if target_accuracy + 1e-9 < baseline_accuracy:
        return "inferior"
    if target_accuracy > baseline_accuracy + 1e-9:
        return "superior"
    return "comparable"


def _delta(target: Any, baseline: Any) -> int | float | None:
    if isinstance(target, bool) or isinstance(baseline, bool):
        return None
    if isinstance(target, (int, float)) and isinstance(baseline, (int, float)):
        return target - baseline
    return None


def build_head_to_head(
    results: list[CellResult],
    *,
    target_adapter: str = DEFAULT_TARGET_ADAPTER,
    baseline_adapter: str = DEFAULT_BASELINE_ADAPTER,
) -> dict[str, Any]:
    by_benchmark: dict[str, dict[str, CellResult]] = {}
    for result in results:
        by_benchmark.setdefault(result.benchmark, {})[result.adapter] = result

    comparisons: list[dict[str, Any]] = []
    for benchmark, adapter_results in sorted(by_benchmark.items()):
        target = adapter_results.get(target_adapter)
        baseline = adapter_results.get(baseline_adapter)
        target_outcome = target.outcome_metrics if target else {}
        baseline_outcome = baseline.outcome_metrics if baseline else {}
        target_tokens = target.token_metrics if target else {}
        baseline_tokens = baseline.token_metrics if baseline else {}
        target_accuracy = target_outcome.get("accuracy")
        baseline_accuracy = baseline_outcome.get("accuracy")
        status = _comparison_status(
            target_accuracy,
            baseline_accuracy,
            target_outcome,
            baseline_outcome,
        )
        comparisons.append(
            {
                "benchmark": benchmark,
                "status": status,
                "target_adapter": target_adapter,
                "baseline_adapter": baseline_adapter,
                "target_accuracy": target_accuracy,
                "baseline_accuracy": baseline_accuracy,
                "accuracy_delta": _delta(target_accuracy, baseline_accuracy),
                "target_right": target_outcome.get("right"),
                "baseline_right": baseline_outcome.get("right"),
                "right_delta": _delta(target_outcome.get("right"), baseline_outcome.get("right")),
                "target_wrong": target_outcome.get("wrong"),
                "baseline_wrong": baseline_outcome.get("wrong"),
                "wrong_delta": _delta(target_outcome.get("wrong"), baseline_outcome.get("wrong")),
                "target_total": target_outcome.get("total"),
                "baseline_total": baseline_outcome.get("total"),
                "target_input_tokens": target_tokens.get("input_tokens"),
                "baseline_input_tokens": baseline_tokens.get("input_tokens"),
                "input_token_delta": _delta(
                    target_tokens.get("input_tokens"),
                    baseline_tokens.get("input_tokens"),
                ),
                "target_output_tokens": target_tokens.get("output_tokens"),
                "baseline_output_tokens": baseline_tokens.get("output_tokens"),
                "output_token_delta": _delta(
                    target_tokens.get("output_tokens"),
                    baseline_tokens.get("output_tokens"),
                ),
                "target_total_tokens": target_tokens.get("total_tokens"),
                "baseline_total_tokens": baseline_tokens.get("total_tokens"),
                "total_token_delta": _delta(
                    target_tokens.get("total_tokens"),
                    baseline_tokens.get("total_tokens"),
                ),
                "target_cached_token_percent": target_tokens.get("cached_token_percent"),
                "baseline_cached_token_percent": baseline_tokens.get("cached_token_percent"),
                "cached_token_percent_delta": _delta(
                    target_tokens.get("cached_token_percent"),
                    baseline_tokens.get("cached_token_percent"),
                ),
                "target_llm_call_count": target_tokens.get("llm_call_count"),
                "baseline_llm_call_count": baseline_tokens.get("llm_call_count"),
                "llm_call_delta": _delta(
                    target_tokens.get("llm_call_count"),
                    baseline_tokens.get("llm_call_count"),
                ),
            }
        )
    return {
        "target_adapter": target_adapter,
        "baseline_adapter": baseline_adapter,
        "status_counts": {
            status: sum(1 for row in comparisons if row["status"] == status)
            for status in ("superior", "comparable", "inferior", "weak", "missing")
        },
        "inferior_benchmarks": [
            row["benchmark"] for row in comparisons if row["status"] == "inferior"
        ],
        "comparisons": comparisons,
    }


def build_efficiency_queue(head_to_head: dict[str, Any]) -> list[dict[str, Any]]:
    queue: list[dict[str, Any]] = []
    for row in head_to_head.get("comparisons", []):
        if not isinstance(row, dict):
            continue
        reasons: list[str] = []
        total_token_delta = row.get("total_token_delta")
        llm_call_delta = row.get("llm_call_delta")
        cached_delta = row.get("cached_token_percent_delta")
        if isinstance(total_token_delta, (int, float)) and total_token_delta > 0:
            reasons.append("target used more total tokens than baseline")
        if isinstance(llm_call_delta, (int, float)) and llm_call_delta > 0:
            reasons.append("target made more LLM calls than baseline")
        if isinstance(cached_delta, (int, float)) and cached_delta < 0:
            reasons.append("target cached-token percentage is below baseline")
        if not reasons:
            continue
        queue.append(
            {
                "benchmark": row.get("benchmark"),
                "status": row.get("status"),
                "reasons": reasons,
                "accuracy_delta": row.get("accuracy_delta"),
                "total_token_delta": total_token_delta,
                "llm_call_delta": llm_call_delta,
                "cached_token_percent_delta": cached_delta,
                "target_total_tokens": row.get("target_total_tokens"),
                "baseline_total_tokens": row.get("baseline_total_tokens"),
                "target_llm_call_count": row.get("target_llm_call_count"),
                "baseline_llm_call_count": row.get("baseline_llm_call_count"),
                "target_cached_token_percent": row.get("target_cached_token_percent"),
                "baseline_cached_token_percent": row.get("baseline_cached_token_percent"),
            }
        )
    queue.sort(
        key=lambda item: (
            0 if item.get("status") in {"superior", "comparable"} else 1,
            str(item.get("benchmark") or ""),
        )
    )
    return queue


def build_efficiency_gate(summary: dict[str, Any]) -> dict[str, Any]:
    queue = summary.get("efficiency_queue")
    queue = queue if isinstance(queue, list) else []
    run_config = summary.get("run_config")
    enforced = bool(isinstance(run_config, dict) and run_config.get("enforce_efficiency"))
    regressions = [
        {
            "benchmark": item.get("benchmark"),
            "status": item.get("status"),
            "reasons": item.get("reasons") or [],
            "total_token_delta": item.get("total_token_delta"),
            "cached_token_percent_delta": item.get("cached_token_percent_delta"),
            "llm_call_delta": item.get("llm_call_delta"),
        }
        for item in queue
        if isinstance(item, dict)
    ]
    return {
        "ok": not regressions,
        "enforced": enforced,
        "blocking_benchmarks": [
            str(item.get("benchmark"))
            for item in regressions
            if item.get("benchmark")
        ],
        "regressions": regressions,
        "message": (
            "ElizaOS has no token, LLM-call, or cached-token regressions versus OpenCode"
            if not regressions
            else "ElizaOS has efficiency regressions versus OpenCode"
        ),
    }


def _artifact_links(result: CellResult | None) -> dict[str, str | None]:
    if result is None:
        return {
            "output_dir": None,
            "result_path": None,
            "stdout_path": None,
            "stderr_path": None,
            "trajectory_dir": None,
        }
    output_dir = Path(result.output_dir)
    return {
        "output_dir": result.output_dir,
        "result_path": result.result_path,
        "stdout_path": result.stdout_path,
        "stderr_path": result.stderr_path,
        "trajectory_dir": str(output_dir.parent / "trajectories"),
    }


def _trajectory_review(trajectory_dir: str | None) -> dict[str, Any]:
    if not trajectory_dir:
        return {
            "trajectory_dir": None,
            "trajectory_files": 0,
            "turns": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cached_token_percent": None,
            "mean_latency_ms": None,
            "p95_latency_ms": None,
            "repeated_prefix_count": 0,
            "top_repeated_prefixes": [],
            "review_notes": ["no trajectory directory recorded"],
        }
    summary, _records = summarize_trajectory(Path(trajectory_dir))
    cached_percent: float | None = None
    if summary.prompt_tokens:
        cached_percent = (summary.cached_tokens / summary.prompt_tokens) * 100.0
    notes: list[str] = []
    if summary.files == 0:
        notes.append("no trajectory files found")
    if summary.turns == 0:
        notes.append("no trajectory turns found")
    if summary.repeated_prefixes:
        notes.append("repeated prompt prefixes detected")
    if cached_percent is None:
        notes.append("no cached-token telemetry found")
    return {
        "trajectory_dir": trajectory_dir,
        "trajectory_files": summary.files,
        "turns": summary.turns,
        "input_tokens": summary.prompt_tokens,
        "output_tokens": summary.completion_tokens,
        "total_tokens": summary.total_tokens,
        "cached_token_percent": cached_percent,
        "mean_latency_ms": summary.mean_latency_ms,
        "p95_latency_ms": summary.p95_latency_ms,
        "repeated_prefix_count": len(summary.repeated_prefixes),
        "top_repeated_prefixes": [
            {"count": count, "snippet": snippet[:160]}
            for snippet, count in summary.repeated_prefixes[:3]
        ],
        "review_notes": notes,
    }


def _queue_diagnosis(
    *,
    status: str,
    row: dict[str, Any],
    target: CellResult | None,
    baseline: CellResult | None,
    target_review: dict[str, Any],
    baseline_review: dict[str, Any],
) -> list[str]:
    diagnosis: list[str] = []
    if status == "inferior":
        diagnosis.append("target accuracy is below baseline")
    elif status == "weak":
        diagnosis.append("both adapters have measured zero accuracy")
    elif status == "missing":
        diagnosis.append("missing comparable outcome evidence")

    if target is None:
        diagnosis.append("target cell result is missing")
    elif target.failure_class != "pass":
        diagnosis.append(f"target failure class: {target.failure_class}")
    if baseline is None:
        diagnosis.append("baseline cell result is missing")
    elif baseline.failure_class != "pass":
        diagnosis.append(f"baseline failure class: {baseline.failure_class}")

    target_total = row.get("target_total")
    baseline_total = row.get("baseline_total")
    if not isinstance(target_total, (int, float)) or target_total <= 0:
        diagnosis.append("target right/wrong/total evidence is incomplete")
    if not isinstance(baseline_total, (int, float)) or baseline_total <= 0:
        diagnosis.append("baseline right/wrong/total evidence is incomplete")

    if target_review.get("trajectory_files") == 0 or target_review.get("turns") == 0:
        diagnosis.append("target trajectory telemetry is missing")
    if baseline_review.get("trajectory_files") == 0 or baseline_review.get("turns") == 0:
        diagnosis.append("baseline trajectory telemetry is missing")
    if target_review.get("repeated_prefix_count", 0):
        diagnosis.append("target repeated prompt prefixes need review")

    total_token_delta = row.get("total_token_delta")
    if isinstance(total_token_delta, (int, float)) and total_token_delta > 0:
        diagnosis.append("target used more total tokens than baseline")
    llm_call_delta = row.get("llm_call_delta")
    if isinstance(llm_call_delta, (int, float)) and llm_call_delta > 0:
        diagnosis.append("target made more LLM calls than baseline")
    cached_delta = row.get("cached_token_percent_delta")
    if isinstance(cached_delta, (int, float)) and cached_delta < 0:
        diagnosis.append("target cached-token percentage is below baseline")

    return diagnosis


def build_improvement_queue(
    results: list[CellResult],
    head_to_head: dict[str, Any],
    *,
    target_adapter: str = DEFAULT_TARGET_ADAPTER,
    baseline_adapter: str = DEFAULT_BASELINE_ADAPTER,
    run_config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    by_benchmark: dict[str, dict[str, CellResult]] = {}
    for result in results:
        by_benchmark.setdefault(result.benchmark, {})[result.adapter] = result

    queue: list[dict[str, Any]] = []
    for row in head_to_head.get("comparisons", []):
        if not isinstance(row, dict):
            continue
        status = row.get("status")
        if status not in {"inferior", "weak", "missing"}:
            continue
        benchmark = str(row.get("benchmark") or "")
        adapter_results = by_benchmark.get(benchmark, {})
        target = adapter_results.get(target_adapter)
        baseline = adapter_results.get(baseline_adapter)
        target_artifacts = _artifact_links(target)
        baseline_artifacts = _artifact_links(baseline)
        target_review = _trajectory_review(target_artifacts.get("trajectory_dir"))
        baseline_review = _trajectory_review(baseline_artifacts.get("trajectory_dir"))
        diagnosis = _queue_diagnosis(
            status=str(status),
            row=row,
            target=target,
            baseline=baseline,
            target_review=target_review,
            baseline_review=baseline_review,
        )
        priority = "p0" if status in {"inferior", "weak"} else "p1"
        queue.append(
            {
                "benchmark": benchmark,
                "status": status,
                "priority": priority,
                "diagnosis": diagnosis,
                "primary_diagnosis": diagnosis[0] if diagnosis else "",
                "rerun_command_template": _queue_rerun_command_template(
                    priority=priority,
                    status=str(status),
                    run_config=run_config,
                ),
                "next_action": (
                    "review target and baseline trajectories, then improve elizaos"
                    if status == "inferior"
                    else "review benchmark evidence because both adapters scored zero"
                    if status == "weak"
                    else "run live benchmark cell until both adapters have comparable outcome metrics"
                ),
                "accuracy_delta": row.get("accuracy_delta"),
                "right_delta": row.get("right_delta"),
                "total_token_delta": row.get("total_token_delta"),
                "cached_token_percent_delta": row.get("cached_token_percent_delta"),
                "llm_call_delta": row.get("llm_call_delta"),
                "target_failure_class": target.failure_class if target else None,
                "baseline_failure_class": baseline.failure_class if baseline else None,
                "target_notes": target.notes if target else [],
                "baseline_notes": baseline.notes if baseline else [],
                "target_artifacts": target_artifacts,
                "baseline_artifacts": baseline_artifacts,
                "target_trajectory_review": target_review,
                "baseline_trajectory_review": baseline_review,
            }
        )
    queue.sort(key=lambda item: (item["priority"], item["benchmark"]))
    return queue


def _append_config_args(parts: list[str], run_config: dict[str, Any] | None) -> None:
    if not isinstance(run_config, dict):
        return
    provider = run_config.get("provider")
    if provider:
        parts.extend(["--provider", str(provider)])
    model = run_config.get("model")
    if model:
        parts.extend(["--model", str(model)])
    max_tasks = run_config.get("max_tasks")
    if max_tasks is not None:
        parts.extend(["--max-tasks", str(max_tasks)])
    timeout_seconds = run_config.get("timeout_seconds")
    if timeout_seconds is not None:
        parts.extend(["--timeout-seconds", str(timeout_seconds)])
    mode = run_config.get("mode")
    if mode == "smoke" or run_config.get("smoke") is True:
        parts.append("--smoke")
    elif mode == "dry_run" or run_config.get("dry_run") is True:
        parts.append("--dry-run")
    if run_config.get("no_docker") is True:
        parts.append("--no-docker")
    if run_config.get("enforce_comparable") is True:
        parts.append("--enforce-comparable")
    if run_config.get("enforce_token_evidence") is True:
        parts.append("--enforce-token-evidence")


def _command_template(parts: list[str]) -> str:
    return " ".join(part if part == "{summary_json}" else shlex.quote(part) for part in parts)


def _selected_scope_args(cell_pairs: tuple[tuple[str, str], ...]) -> list[str]:
    benchmarks = ",".join(sorted({benchmark for benchmark, _adapter in cell_pairs}))
    adapters = ",".join(sorted({adapter for _benchmark, adapter in cell_pairs}))
    return ["--benchmarks", benchmarks, "--adapters", adapters]


def _preflight_next_commands(
    *,
    args: argparse.Namespace,
    run_root: Path,
    cell_pairs: tuple[tuple[str, str], ...],
) -> dict[str, str]:
    base = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        *_selected_scope_args(cell_pairs),
        "--provider",
        str(args.provider),
        "--model",
        str(args.model),
        "--max-tasks",
        str(args.max_tasks),
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--run-root",
        str(run_root),
    ]
    preflight = [*base, "--preflight"]
    live = [
        *base,
        "--force",
        "--enforce-live-report",
        "--enforce-trajectory-reviews",
        "--enforce-report",
        "--enforce-coverage",
        "--enforce-comparable",
        "--enforce-required-stats",
        "--enforce-efficiency",
    ]
    if args.no_docker:
        preflight.append("--no-docker")
        live.append("--no-docker")
    release = [part for part in live if part != "--no-docker"]
    return {
        "retry_preflight": _command_template(preflight),
        "live_evidence": _command_template(live),
        "release_comparable": _command_template(release),
    }


def _matrix_rerun_command_template(
    summary: dict[str, Any],
    *,
    benchmarks: list[str],
    adapters: list[str],
) -> str:
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        ",".join(benchmarks),
        "--adapters",
        ",".join(adapters),
    ]
    _append_config_args(parts, summary.get("run_config"))
    parts.extend(["--force", "--enforce-required-stats"])
    return _command_template(parts)


def _queue_rerun_command_template(
    *,
    priority: str,
    status: str,
    run_config: dict[str, Any] | None = None,
) -> str:
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--rerun-queue",
        "{summary_json}",
        "--queue-priorities",
        priority,
        "--queue-statuses",
        status,
        "--compare-summary",
        "{summary_json}",
    ]
    _append_config_args(parts, run_config)
    if isinstance(run_config, dict) and run_config.get("enforce_required_stats") is True:
        parts.append("--enforce-required-stats")
    parts.append("--force")
    return _command_template(parts)


def _head_to_head_rows(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    head_to_head = summary.get("head_to_head")
    if not isinstance(head_to_head, dict):
        return {}
    rows: dict[str, dict[str, Any]] = {}
    for row in head_to_head.get("comparisons", []):
        if isinstance(row, dict) and isinstance(row.get("benchmark"), str):
            rows[str(row["benchmark"])] = row
    return rows


def _trend_status(delta: int | float | None) -> str:
    if delta is None:
        return "missing"
    if delta > 0:
        return "improved"
    if delta < 0:
        return "regressed"
    return "unchanged"


def build_previous_summary_comparison(
    current_summary: dict[str, Any],
    previous_summary: dict[str, Any],
) -> dict[str, Any]:
    current_rows = _head_to_head_rows(current_summary)
    previous_rows = _head_to_head_rows(previous_summary)
    benchmarks = sorted(set(current_rows) | set(previous_rows))
    comparisons: list[dict[str, Any]] = []
    for benchmark in benchmarks:
        current = current_rows.get(benchmark, {})
        previous = previous_rows.get(benchmark, {})
        target_accuracy_delta = _delta(
            current.get("target_accuracy"),
            previous.get("target_accuracy"),
        )
        comparisons.append(
            {
                "benchmark": benchmark,
                "trend": _trend_status(target_accuracy_delta),
                "previous_status": previous.get("status"),
                "current_status": current.get("status"),
                "previous_target_accuracy": previous.get("target_accuracy"),
                "current_target_accuracy": current.get("target_accuracy"),
                "target_accuracy_delta": target_accuracy_delta,
                "previous_accuracy_delta": previous.get("accuracy_delta"),
                "current_accuracy_delta": current.get("accuracy_delta"),
                "accuracy_delta_change": _delta(
                    current.get("accuracy_delta"),
                    previous.get("accuracy_delta"),
                ),
                "target_total_token_delta": _delta(
                    current.get("target_total_tokens"),
                    previous.get("target_total_tokens"),
                ),
                "target_cached_token_percent_delta": _delta(
                    current.get("target_cached_token_percent"),
                    previous.get("target_cached_token_percent"),
                ),
                "target_llm_call_delta": _delta(
                    current.get("target_llm_call_count"),
                    previous.get("target_llm_call_count"),
                ),
            }
        )
    return {
        "previous_generated_at": previous_summary.get("generated_at"),
        "current_generated_at": current_summary.get("generated_at"),
        "trend_counts": {
            trend: sum(1 for row in comparisons if row["trend"] == trend)
            for trend in ("improved", "unchanged", "regressed", "missing")
        },
        "comparisons": comparisons,
    }


def build_no_regression_gate(summary: dict[str, Any]) -> dict[str, Any]:
    run_config = summary.get("run_config")
    enforced = bool(isinstance(run_config, dict) and run_config.get("enforce_no_regression"))
    comparison = summary.get("previous_summary_comparison")
    rows = (
        comparison.get("comparisons")
        if isinstance(comparison, dict)
        else None
    )
    if not isinstance(rows, list):
        return {
            "ok": not enforced,
            "enforced": enforced,
            "blocking_benchmarks": [] if not enforced else ["previous_summary_comparison"],
            "regressions": [],
            "message": (
                "previous-summary comparison is not attached"
                if enforced
                else "no-regression gate is advisory without a previous summary"
            ),
        }
    regressions: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        previous_accuracy = row.get("previous_target_accuracy")
        current_accuracy = row.get("current_target_accuracy")
        if row.get("trend") == "regressed" or (
            isinstance(previous_accuracy, (int, float))
            and not isinstance(previous_accuracy, bool)
            and not (
                isinstance(current_accuracy, (int, float))
                and not isinstance(current_accuracy, bool)
            )
        ):
            regressions.append(
                {
                    "benchmark": row.get("benchmark"),
                    "previous_target_accuracy": previous_accuracy,
                    "current_target_accuracy": current_accuracy,
                    "target_accuracy_delta": row.get("target_accuracy_delta"),
                    "previous_status": row.get("previous_status"),
                    "current_status": row.get("current_status"),
                }
            )
    return {
        "ok": not regressions,
        "enforced": enforced,
        "blocking_benchmarks": [
            str(item.get("benchmark"))
            for item in regressions
            if item.get("benchmark")
        ],
        "regressions": regressions,
        "message": (
            "ElizaOS did not regress against the previous summary"
            if not regressions
            else "ElizaOS regressed against the previous summary"
        ),
    }


def build_quality_guardrail_gate(
    guardrail_summary: dict[str, Any] | None,
    *,
    summary_path: str = "",
    enforced: bool = False,
) -> dict[str, Any]:
    if guardrail_summary is None:
        return {
            "ok": not enforced,
            "enforced": enforced,
            "summary_path": summary_path,
            "latest_dir": None,
            "tolerance": None,
            "findings": [],
            "message": (
                "quality guardrail summary is missing"
                if enforced
                else "quality guardrail is advisory without a summary"
            ),
        }
    findings = guardrail_summary.get("findings")
    findings = findings if isinstance(findings, list) else []
    ok_value = guardrail_summary.get("ok")
    ok = bool(ok_value) and not findings
    return {
        "ok": ok,
        "enforced": enforced,
        "summary_path": summary_path,
        "latest_dir": guardrail_summary.get("latest_dir"),
        "tolerance": guardrail_summary.get("tolerance"),
        "findings": [
            finding
            for finding in findings
            if isinstance(finding, dict)
        ],
        "message": (
            "broader benchmark readiness guardrail passed"
            if ok
            else "broader benchmark readiness guardrail failed"
        ),
    }


def build_trajectory_review_gate(
    summary: dict[str, Any],
    *,
    require_trajectory_reviews: bool = False,
) -> dict[str, Any]:
    cells = summary.get("cells")
    cells = cells if isinstance(cells, list) else []
    blocking: list[dict[str, Any]] = []
    reviewed = 0
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        tokens = cell.get("token_metrics")
        tokens = tokens if isinstance(tokens, dict) else {}
        files = tokens.get("trajectory_file_count")
        turns = tokens.get("trajectory_turn_count")
        cached_percent = tokens.get("cached_token_percent")
        has_files = isinstance(files, (int, float)) and not isinstance(files, bool) and files > 0
        has_turns = isinstance(turns, (int, float)) and not isinstance(turns, bool) and turns > 0
        has_cached = isinstance(cached_percent, (int, float)) and not isinstance(cached_percent, bool)
        if has_files and has_turns and has_cached:
            reviewed += 1
            continue
        notes: list[str] = []
        if not has_files:
            notes.append("no trajectory files found")
        if not has_turns:
            notes.append("no trajectory turns found")
        if not has_cached:
            notes.append("no cached-token telemetry found")
        output_dir = cell.get("output_dir")
        trajectory_dir = (
            str(Path(str(output_dir)).parent / "trajectories")
            if isinstance(output_dir, str) and output_dir
            else ""
        )
        blocking.append(
            {
                "benchmark": cell.get("benchmark"),
                "adapter": cell.get("adapter"),
                "trajectory_dir": trajectory_dir,
                "trajectory_file_count": files,
                "trajectory_turn_count": turns,
                "cached_token_percent": cached_percent,
                "review_notes": notes,
            }
        )
    return {
        "ok": not blocking,
        "enforced": bool(require_trajectory_reviews),
        "reviewed_cells": reviewed,
        "blocking_cells": blocking,
        "blocking_count": len(blocking),
        "message": (
            "all selected cells have reviewable trajectory telemetry"
            if not blocking
            else "some selected cells lack reviewable trajectory telemetry"
        ),
    }


def build_live_report_gate(
    summary: dict[str, Any],
    *,
    enforced: bool = False,
) -> dict[str, Any]:
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    mode = str(run_config.get("mode") or "")
    ok = mode == "live"
    return {
        "ok": ok,
        "enforced": bool(enforced),
        "mode": mode,
        "smoke": bool(run_config.get("smoke")),
        "dry_run": bool(run_config.get("dry_run")),
        "summarize": str(run_config.get("summarize") or ""),
        "message": (
            "report was generated from live benchmark execution"
            if ok
            else "report was not generated from live benchmark execution"
        ),
    }


def build_benchmark_gate(summary: dict[str, Any]) -> dict[str, Any]:
    head_to_head = summary.get("head_to_head")
    comparisons = []
    if isinstance(head_to_head, dict):
        comparisons = [
            row
            for row in head_to_head.get("comparisons", [])
            if isinstance(row, dict)
        ]
    blocking = [
        str(row.get("benchmark"))
        for row in comparisons
        if row.get("status") in {"inferior", "weak", "missing"}
    ]
    status_counts = (
        head_to_head.get("status_counts", {})
        if isinstance(head_to_head, dict)
        else {}
    )
    return {
        "ok": not blocking and bool(comparisons),
        "required_statuses": ["superior", "comparable"],
        "blocking_statuses": ["inferior", "weak", "missing"],
        "blocking_benchmarks": sorted(blocking),
        "status_counts": status_counts,
        "message": (
            "elizaos is comparable-or-better on all selected benchmarks"
            if not blocking and comparisons
            else "elizaos is not yet comparable-or-better on all selected benchmarks"
        ),
    }


def build_required_stats_gate(
    summary: dict[str, Any],
    *,
    mode: str | None = None,
    require_token_evidence: bool | None = None,
) -> dict[str, Any]:
    if require_token_evidence is None:
        require_token_evidence = mode not in {"smoke", "dry_run", "summarize"}
    benchmark_gate = summary.get("benchmark_gate")
    token_evidence = summary.get("token_evidence")
    outcome_ok = bool(
        isinstance(benchmark_gate, dict) and benchmark_gate.get("ok")
    )
    token_ok = bool(
        isinstance(token_evidence, dict) and token_evidence.get("ok")
    )
    outcome_blocking_benchmarks = (
        list(benchmark_gate.get("blocking_benchmarks") or [])
        if isinstance(benchmark_gate, dict)
        else []
    )
    head_to_head = summary.get("head_to_head")
    outcome_blocking_comparisons = (
        [
            {
                "benchmark": row.get("benchmark"),
                "status": row.get("status"),
                "target_accuracy": row.get("target_accuracy"),
                "baseline_accuracy": row.get("baseline_accuracy"),
                "target_total": row.get("target_total"),
                "baseline_total": row.get("baseline_total"),
                "rerun_command_template": _matrix_rerun_command_template(
                    summary,
                    benchmarks=[str(row.get("benchmark") or "")],
                    adapters=[DEFAULT_TARGET_ADAPTER, DEFAULT_BASELINE_ADAPTER],
                ),
            }
            for row in head_to_head.get("comparisons", [])
            if isinstance(row, dict) and row.get("status") in {"inferior", "weak", "missing"}
        ]
        if isinstance(head_to_head, dict)
        else []
    )
    token_blocking_cells = (
        [
            {
                "benchmark": cell.get("benchmark"),
                "adapter": cell.get("adapter"),
                "status": cell.get("status"),
                "trajectory_dir": cell.get("trajectory_dir"),
                "note": cell.get("note"),
                "rerun_command_template": _matrix_rerun_command_template(
                    summary,
                    benchmarks=[str(cell.get("benchmark") or "")],
                    adapters=[str(cell.get("adapter") or "")],
                ),
            }
            for cell in token_evidence.get("cells", [])
            if isinstance(cell, dict) and cell.get("status") != "present"
        ]
        if isinstance(token_evidence, dict)
        else []
    )
    blocking: list[str] = []
    if not outcome_ok:
        blocking.append("outcome_right_wrong_totals")
    if require_token_evidence and not token_ok:
        blocking.append("llm_token_telemetry")
    return {
        "ok": not blocking,
        "mode": mode,
        "outcome_evidence_required": True,
        "outcome_evidence_ok": outcome_ok,
        "token_evidence_required": bool(require_token_evidence),
        "token_evidence_ok": token_ok,
        "blocking_requirements": blocking,
        "outcome_blocking_benchmarks": outcome_blocking_benchmarks,
        "outcome_blocking_comparisons": outcome_blocking_comparisons,
        "token_blocking_cells": token_blocking_cells if require_token_evidence else [],
        "message": (
            "required benchmark stats are complete for this run mode"
            if not blocking
            else "required benchmark stats are incomplete for this run mode"
        ),
    }


def build_report_gate(summary: dict[str, Any]) -> dict[str, Any]:
    gate_specs: list[tuple[str, str]] = [
        ("coverage_gate", "benchmark coverage"),
        ("benchmark_gate", "comparable-or-better outcomes"),
        ("required_stats_gate", "required stats"),
    ]
    efficiency_gate = summary.get("efficiency_gate")
    if (
        isinstance(efficiency_gate, dict)
        and efficiency_gate.get("enforced") is True
    ):
        gate_specs.append(("efficiency_gate", "efficiency"))
    no_regression_gate = summary.get("no_regression_gate")
    if (
        isinstance(no_regression_gate, dict)
        and no_regression_gate.get("enforced") is True
    ):
        gate_specs.append(("no_regression_gate", "no regression"))
    quality_guardrail_gate = summary.get("quality_guardrail_gate")
    if (
        isinstance(quality_guardrail_gate, dict)
        and quality_guardrail_gate.get("enforced") is True
    ):
        gate_specs.append(("quality_guardrail_gate", "quality guardrail"))
    trajectory_review_gate = summary.get("trajectory_review_gate")
    if (
        isinstance(trajectory_review_gate, dict)
        and trajectory_review_gate.get("enforced") is True
    ):
        gate_specs.append(("trajectory_review_gate", "trajectory review"))
    live_report_gate = summary.get("live_report_gate")
    if (
        isinstance(live_report_gate, dict)
        and live_report_gate.get("enforced") is True
    ):
        gate_specs.append(("live_report_gate", "live report"))
    blocking: list[str] = []
    gate_status: dict[str, bool] = {}
    for key, label in gate_specs:
        gate = summary.get(key)
        ok = bool(isinstance(gate, dict) and gate.get("ok"))
        gate_status[key] = ok
        if not ok:
            blocking.append(label)
    return {
        "ok": not blocking,
        "blocking_gates": blocking,
        "gate_status": gate_status,
        "message": (
            "benchmark report satisfies coverage, comparability, and required stats"
            if not blocking
            else "benchmark report is not yet release-ready"
        ),
    }


def build_report_rows(summary: dict[str, Any]) -> list[dict[str, Any]]:
    """Build stable flat rows for longitudinal benchmark reporting."""
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    generated_at = summary.get("generated_at")
    rows: list[dict[str, Any]] = []
    comparisons = summary.get("head_to_head", {}).get("comparisons")
    for comparison in comparisons if isinstance(comparisons, list) else []:
        if not isinstance(comparison, dict):
            continue
        row = {
            "generated_at": generated_at,
            "run_root": run_config.get("run_root"),
            "mode": run_config.get("mode"),
            "provider": run_config.get("provider"),
            "model": run_config.get("model"),
            "benchmark": comparison.get("benchmark"),
            "status": comparison.get("status"),
            "target_adapter": comparison.get("target_adapter"),
            "baseline_adapter": comparison.get("baseline_adapter"),
            "target_right": comparison.get("target_right"),
            "target_wrong": comparison.get("target_wrong"),
            "target_total": comparison.get("target_total"),
            "target_accuracy": comparison.get("target_accuracy"),
            "baseline_right": comparison.get("baseline_right"),
            "baseline_wrong": comparison.get("baseline_wrong"),
            "baseline_total": comparison.get("baseline_total"),
            "baseline_accuracy": comparison.get("baseline_accuracy"),
            "accuracy_delta": comparison.get("accuracy_delta"),
            "target_input_tokens": comparison.get("target_input_tokens"),
            "target_output_tokens": comparison.get("target_output_tokens"),
            "target_total_tokens": comparison.get("target_total_tokens"),
            "target_cached_token_percent": comparison.get("target_cached_token_percent"),
            "target_llm_call_count": comparison.get("target_llm_call_count"),
            "baseline_input_tokens": comparison.get("baseline_input_tokens"),
            "baseline_output_tokens": comparison.get("baseline_output_tokens"),
            "baseline_total_tokens": comparison.get("baseline_total_tokens"),
            "baseline_cached_token_percent": comparison.get("baseline_cached_token_percent"),
            "baseline_llm_call_count": comparison.get("baseline_llm_call_count"),
            "input_token_delta": comparison.get("input_token_delta"),
            "output_token_delta": comparison.get("output_token_delta"),
            "total_token_delta": comparison.get("total_token_delta"),
            "cached_token_percent_delta": comparison.get("cached_token_percent_delta"),
            "llm_call_delta": comparison.get("llm_call_delta"),
            "coverage_gate_ok": _gate_ok(summary, "coverage_gate"),
            "benchmark_gate_ok": _gate_ok(summary, "benchmark_gate"),
            "required_stats_gate_ok": _gate_ok(summary, "required_stats_gate"),
            "efficiency_gate_ok": _gate_ok(summary, "efficiency_gate"),
            "no_regression_gate_ok": _gate_ok(summary, "no_regression_gate"),
            "quality_guardrail_gate_ok": _gate_ok(summary, "quality_guardrail_gate"),
            "trajectory_review_gate_ok": _gate_ok(summary, "trajectory_review_gate"),
            "live_report_gate_ok": _gate_ok(summary, "live_report_gate"),
            "report_gate_ok": _gate_ok(summary, "report_gate"),
        }
        rows.append({field: row.get(field) for field in REPORT_ROW_FIELDS})
    return rows


def _gate_ok(summary: dict[str, Any], key: str) -> bool | None:
    gate = summary.get(key)
    if isinstance(gate, dict):
        value = gate.get("ok")
        return bool(value) if isinstance(value, bool) else None
    return None


def write_report_rows(run_root: Path, rows: list[dict[str, Any]]) -> dict[str, str]:
    run_root.mkdir(parents=True, exist_ok=True)
    jsonl_path = run_root / "report-rows.jsonl"
    csv_path = run_root / "report-rows.csv"
    jsonl_path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
        encoding="utf-8",
    )
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(REPORT_ROW_FIELDS))
        writer.writeheader()
        writer.writerows(rows)
    return {
        "report_rows_jsonl": str(jsonl_path),
        "report_rows_csv": str(csv_path),
    }


def write_preflight_artifacts(
    *,
    run_root: Path,
    args: argparse.Namespace,
    cell_pairs: tuple[tuple[str, str], ...],
    preflight: dict[str, Any],
) -> dict[str, Any]:
    preflight_json = run_root / "preflight.json"
    preflight_md = run_root / "preflight.md"
    summary = {
        "generated_at": datetime.now(UTC).isoformat(),
        "total": len(cell_pairs),
        "run_config": build_run_config(args, run_root=run_root, cell_pairs=cell_pairs),
        "preflight": preflight,
        "next_commands": _preflight_next_commands(
            args=args,
            run_root=run_root,
            cell_pairs=cell_pairs,
        ),
        "exit_codes": build_exit_code_summary(),
        "artifact_paths": {
            "run_root": str(run_root),
            "preflight_json": str(preflight_json),
            "preflight_md": str(preflight_md),
        },
    }
    write_json(preflight_json, summary)
    preflight_md.write_text(render_markdown(summary), encoding="utf-8")
    return summary


def build_exit_code_summary() -> dict[str, dict[str, int | str]]:
    return {
        name: {"code": code, "message": message}
        for code, name, message in EXIT_CODE_SPECS
    }


def summarize_results(results: list[CellResult]) -> dict[str, Any]:
    by_adapter: dict[str, dict[str, int]] = {}
    by_benchmark: dict[str, dict[str, int]] = {}
    for result in results:
        by_adapter.setdefault(result.adapter, {})
        by_adapter[result.adapter][result.failure_class] = by_adapter[result.adapter].get(result.failure_class, 0) + 1
        by_benchmark.setdefault(result.benchmark, {})
        by_benchmark[result.benchmark][result.failure_class] = by_benchmark[result.benchmark].get(result.failure_class, 0) + 1

    head_to_head = build_head_to_head(results)
    selected_benchmarks = sorted({result.benchmark for result in results})
    summary = {
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
        "outcome_by_adapter": _aggregate_by_adapter(results, "outcome"),
        "token_by_adapter": _aggregate_by_adapter(results, "token"),
        "token_evidence": build_token_evidence(results),
        "coverage": build_coverage_summary(selected_benchmarks),
        "head_to_head": head_to_head,
        "exit_codes": build_exit_code_summary(),
        "efficiency_queue": build_efficiency_queue(head_to_head),
        "improvement_queue": build_improvement_queue(results, head_to_head),
        "cells": [asdict(result) for result in results],
    }
    summary["coverage_gate"] = build_coverage_gate(summary)
    summary["benchmark_gate"] = build_benchmark_gate(summary)
    return summary


def build_run_config(
    args: argparse.Namespace,
    *,
    run_root: Path,
    cell_pairs: tuple[tuple[str, str], ...],
) -> dict[str, Any]:
    adapters = sorted({adapter for _benchmark, adapter in cell_pairs})
    benchmarks = sorted({benchmark for benchmark, _adapter in cell_pairs})
    mode = "summarize" if args.summarize else "dry_run" if args.dry_run else "smoke" if args.smoke else "live"
    return {
        "mode": mode,
        "provider": args.provider,
        "model": args.model,
        "adapters": adapters,
        "benchmarks": benchmarks,
        "max_tasks": args.max_tasks,
        "timeout_seconds": args.timeout_seconds,
        "run_root": str(run_root),
        "smoke": bool(args.smoke),
        "dry_run": bool(args.dry_run),
        "no_docker": bool(args.no_docker),
        "resume": not bool(args.no_resume),
        "force": bool(args.force),
        "summarize": str(args.summarize or ""),
        "rerun_queue": str(args.rerun_queue or ""),
        "queue_priorities": str(args.queue_priorities or ""),
        "queue_statuses": str(args.queue_statuses or ""),
        "compare_summary": str(args.compare_summary or ""),
        "enforce_comparable": bool(args.enforce_comparable),
        "enforce_coverage": bool(args.enforce_coverage),
        "enforce_token_evidence": bool(args.enforce_token_evidence),
        "enforce_required_stats": bool(args.enforce_required_stats),
        "enforce_efficiency": bool(args.enforce_efficiency),
        "enforce_no_regression": bool(args.enforce_no_regression),
        "quality_guardrail_summary": str(args.quality_guardrail_summary or ""),
        "enforce_quality_guardrail": bool(args.enforce_quality_guardrail),
        "enforce_trajectory_reviews": bool(args.enforce_trajectory_reviews),
        "enforce_live_report": bool(args.enforce_live_report),
        "enforce_report": bool(args.enforce_report),
    }


def previous_run_mode(run_root: Path) -> str | None:
    previous_summary = read_json(run_root / "summary.json")
    if not isinstance(previous_summary, dict):
        return None
    run_config = previous_summary.get("run_config")
    if not isinstance(run_config, dict):
        return None
    mode = run_config.get("mode")
    return mode if isinstance(mode, str) and mode else None


def render_markdown(summary: dict[str, Any]) -> str:
    def fmt(value: Any, digits: int = 4) -> str:
        if value is None:
            return ""
        if isinstance(value, float):
            return f"{value:.{digits}f}"
        return str(value)

    lines = [
        "# Code Agent Matrix Summary",
        "",
        f"Generated: {summary.get('generated_at')}",
        f"Cells: {summary.get('total')}",
    ]
    run_config = summary.get("run_config")
    if isinstance(run_config, dict):
        lines.extend(
            [
                "",
                "## Run Config",
                "",
                f"Mode: {run_config.get('mode', '')}",
                f"Provider/model: {run_config.get('provider', '')}/{run_config.get('model', '')}",
                f"Benchmarks: {', '.join(run_config.get('benchmarks') or [])}",
                f"Adapters: {', '.join(run_config.get('adapters') or [])}",
                f"Max tasks: {run_config.get('max_tasks', '')}",
                f"Timeout seconds: {run_config.get('timeout_seconds', '')}",
                f"Enforce comparable: {run_config.get('enforce_comparable')}",
                f"Enforce coverage: {run_config.get('enforce_coverage')}",
                f"Enforce token evidence: {run_config.get('enforce_token_evidence')}",
                f"Enforce required stats: {run_config.get('enforce_required_stats')}",
                f"Enforce efficiency: {run_config.get('enforce_efficiency')}",
                f"Enforce no regression: {run_config.get('enforce_no_regression')}",
                f"Enforce quality guardrail: {run_config.get('enforce_quality_guardrail')}",
                f"Enforce trajectory reviews: {run_config.get('enforce_trajectory_reviews')}",
                f"Enforce live report: {run_config.get('enforce_live_report')}",
                f"Enforce report: {run_config.get('enforce_report')}",
            ]
        )
    exit_codes = summary.get("exit_codes")
    if isinstance(exit_codes, dict):
        rows = [
            (name, spec)
            for name, spec in exit_codes.items()
            if isinstance(spec, dict)
        ]
        rows.sort(
            key=lambda item: (
                item[1].get("code")
                if isinstance(item[1].get("code"), int)
                else 999
            )
        )
        if rows:
            lines.extend(
                [
                    "",
                    "## Exit Codes",
                    "",
                    "| code | name | meaning |",
                    "| --- | --- | --- |",
                ]
            )
            for name, spec in rows:
                lines.append(
                    "| {code} | {name} | {message} |".format(
                        code=spec.get("code", ""),
                        name=name,
                        message=spec.get("message", ""),
                    )
                )
    preflight = summary.get("preflight")
    if isinstance(preflight, dict):
        lines.extend(
            [
                "",
                "## Preflight",
                "",
                f"Status: {'ok' if preflight.get('ok') else 'blocked'}",
                f"Provider: {preflight.get('provider', '')}",
                f"Provider key: {preflight.get('provider_key', '')} ({'present' if preflight.get('provider_key_present') else 'missing'}, {'required' if preflight.get('provider_key_required') else 'not required'})",
                f"OpenCode: {preflight.get('opencode_bin') or 'missing'}",
            ]
        )
        issues = preflight.get("issues")
        if isinstance(issues, list) and issues:
            lines.extend(["", "| severity | kind | message |", "| --- | --- | --- |"])
            for issue in issues:
                if not isinstance(issue, dict):
                    continue
                lines.append(
                    "| {severity} | {kind} | {message} |".format(
                        severity=issue.get("severity", ""),
                        kind=issue.get("kind", ""),
                        message=issue.get("message", ""),
                    )
                )
    report_gate = summary.get("report_gate")
    if isinstance(report_gate, dict):
        lines.extend(
            [
                "",
                "## Report Gate",
                "",
                f"Status: {'ok' if report_gate.get('ok') else 'blocked'}",
                f"Message: {report_gate.get('message', '')}",
                f"Blocking gates: {', '.join(report_gate.get('blocking_gates') or []) or '(none)'}",
            ]
        )
    next_commands = summary.get("next_commands")
    if isinstance(next_commands, dict) and next_commands:
        lines.extend(["", "## Next Commands", ""])
        for label in ("retry_preflight", "live_evidence", "release_comparable"):
            command = next_commands.get(label)
            if not isinstance(command, str) or not command:
                continue
            lines.extend(
                [
                    f"### {label.replace('_', ' ').title()}",
                    "",
                    "```bash",
                    command,
                    "```",
                    "",
                ]
            )
    efficiency_gate = summary.get("efficiency_gate")
    if isinstance(efficiency_gate, dict):
        lines.extend(
            [
                "",
                "## Efficiency Gate",
                "",
                f"Status: {'ok' if efficiency_gate.get('ok') else 'blocked'}",
                f"Enforced: {efficiency_gate.get('enforced')}",
                f"Message: {efficiency_gate.get('message', '')}",
                f"Blocking benchmarks: {', '.join(efficiency_gate.get('blocking_benchmarks') or []) or '(none)'}",
            ]
        )
    no_regression_gate = summary.get("no_regression_gate")
    if isinstance(no_regression_gate, dict):
        lines.extend(
            [
                "",
                "## No Regression Gate",
                "",
                f"Status: {'ok' if no_regression_gate.get('ok') else 'blocked'}",
                f"Enforced: {no_regression_gate.get('enforced')}",
                f"Message: {no_regression_gate.get('message', '')}",
                f"Blocking benchmarks: {', '.join(no_regression_gate.get('blocking_benchmarks') or []) or '(none)'}",
            ]
        )
        regressions = no_regression_gate.get("regressions")
        if isinstance(regressions, list) and regressions:
            lines.extend(
                [
                    "",
                    "| benchmark | previous accuracy | current accuracy | delta | previous status | current status |",
                    "| --- | ---: | ---: | ---: | --- | --- |",
                ]
            )
            for row in regressions:
                if not isinstance(row, dict):
                    continue
                lines.append(
                    "| {benchmark} | {previous} | {current} | {delta} | {previous_status} | {current_status} |".format(
                        benchmark=row.get("benchmark", ""),
                        previous=fmt(row.get("previous_target_accuracy")),
                        current=fmt(row.get("current_target_accuracy")),
                        delta=fmt(row.get("target_accuracy_delta")),
                        previous_status=row.get("previous_status", ""),
                        current_status=row.get("current_status", ""),
                    )
                )
    quality_guardrail_gate = summary.get("quality_guardrail_gate")
    if isinstance(quality_guardrail_gate, dict):
        lines.extend(
            [
                "",
                "## Quality Guardrail Gate",
                "",
                f"Status: {'ok' if quality_guardrail_gate.get('ok') else 'blocked'}",
                f"Enforced: {quality_guardrail_gate.get('enforced')}",
                f"Summary: {quality_guardrail_gate.get('summary_path') or ''}",
                f"Latest dir: {quality_guardrail_gate.get('latest_dir') or ''}",
                f"Message: {quality_guardrail_gate.get('message', '')}",
            ]
        )
        findings = quality_guardrail_gate.get("findings")
        if isinstance(findings, list) and findings:
            lines.extend(
                [
                    "",
                    "| scope | reason | value |",
                    "| --- | --- | --- |",
                ]
            )
            for finding in findings:
                if not isinstance(finding, dict):
                    continue
                lines.append(
                    "| {scope} | {reason} | {value} |".format(
                        scope=finding.get("scope", ""),
                        reason=finding.get("reason", ""),
                        value=finding.get("value", ""),
                    )
                )
    trajectory_review_gate = summary.get("trajectory_review_gate")
    if isinstance(trajectory_review_gate, dict):
        lines.extend(
            [
                "",
                "## Trajectory Review Gate",
                "",
                f"Status: {'ok' if trajectory_review_gate.get('ok') else 'blocked'}",
                f"Enforced: {trajectory_review_gate.get('enforced')}",
                f"Reviewed cells: {trajectory_review_gate.get('reviewed_cells', 0)}",
                f"Blocking cells: {trajectory_review_gate.get('blocking_count', 0)}",
                f"Message: {trajectory_review_gate.get('message', '')}",
            ]
        )
        blocking_cells = trajectory_review_gate.get("blocking_cells")
        if isinstance(blocking_cells, list) and blocking_cells:
            lines.extend(
                [
                    "",
                    "| benchmark | adapter | trajectory dir | files | turns | cached % | notes |",
                    "| --- | --- | --- | ---: | ---: | ---: | --- |",
                ]
            )
            for cell in blocking_cells:
                if not isinstance(cell, dict):
                    continue
                lines.append(
                    "| {benchmark} | {adapter} | {trajectory_dir} | {files} | {turns} | {cached_percent} | {notes} |".format(
                        benchmark=cell.get("benchmark", ""),
                        adapter=cell.get("adapter", ""),
                        trajectory_dir=cell.get("trajectory_dir", ""),
                        files=fmt(cell.get("trajectory_file_count"), 0),
                        turns=fmt(cell.get("trajectory_turn_count"), 0),
                        cached_percent=fmt(cell.get("cached_token_percent"), 2),
                        notes=", ".join(str(note) for note in cell.get("review_notes") or []),
                    )
                )
    live_report_gate = summary.get("live_report_gate")
    if isinstance(live_report_gate, dict):
        lines.extend(
            [
                "",
                "## Live Report Gate",
                "",
                f"Status: {'ok' if live_report_gate.get('ok') else 'blocked'}",
                f"Enforced: {live_report_gate.get('enforced')}",
                f"Mode: {live_report_gate.get('mode') or ''}",
                f"Message: {live_report_gate.get('message', '')}",
            ]
        )
    coverage = summary.get("coverage")
    if isinstance(coverage, dict):
        raw_counts = coverage.get("status_counts")
        counts = raw_counts if isinstance(raw_counts, dict) else {}
        lines.extend(
            [
                "",
                "## Benchmark Coverage",
                "",
                f"Status: {'complete' if coverage.get('selection_complete') else 'partial'}",
                f"Message: {coverage.get('message', '')}",
                f"Included selected: {counts.get('included_selected', 0)}/{counts.get('included', 0)}",
                f"Deferred: {counts.get('deferred', 0)}",
            ]
        )
        unselected = coverage.get("unselected_included_benchmarks")
        if isinstance(unselected, list) and unselected:
            lines.append(f"Unselected included benchmarks: {', '.join(str(item) for item in unselected)}")
        included = coverage.get("included_benchmarks")
        if isinstance(included, list) and included:
            lines.extend(
                [
                    "",
                    "| benchmark | domains | selected | reason |",
                    "| --- | --- | --- | --- |",
                ]
            )
            for item in included:
                if not isinstance(item, dict):
                    continue
                lines.append(
                    "| {benchmark} | {domains} | {selected} | {reason} |".format(
                        benchmark=item.get("benchmark", ""),
                        domains=", ".join(str(domain) for domain in item.get("domains") or []),
                        selected=item.get("selected"),
                        reason=item.get("reason", ""),
                    )
                )
        deferred = coverage.get("deferred_benchmarks")
        if isinstance(deferred, list) and deferred:
            lines.extend(
                [
                    "",
                    "### Deferred Related Benchmarks",
                    "",
                    "| benchmark | domains | reason |",
                    "| --- | --- | --- |",
                ]
            )
            for item in deferred:
                if not isinstance(item, dict):
                    continue
                lines.append(
                    "| {benchmark} | {domains} | {reason} |".format(
                        benchmark=item.get("benchmark", ""),
                        domains=", ".join(str(domain) for domain in item.get("domains") or []),
                        reason=item.get("reason", ""),
                    )
                )
    coverage_gate = summary.get("coverage_gate")
    if isinstance(coverage_gate, dict):
        lines.extend(
            [
                "",
                "## Coverage Gate",
                "",
                f"Status: {'ok' if coverage_gate.get('ok') else 'blocked'}",
                f"Message: {coverage_gate.get('message', '')}",
                f"Blocking benchmarks: {', '.join(coverage_gate.get('blocking_benchmarks') or []) or '(none)'}",
            ]
        )
    lines.extend(
        [
            "",
            "## Benchmark Gate",
            "",
        ]
    )
    gate = summary.get("benchmark_gate")
    if isinstance(gate, dict):
        lines.extend(
            [
                f"Status: {'ok' if gate.get('ok') else 'blocked'}",
                f"Message: {gate.get('message', '')}",
                f"Blocking benchmarks: {', '.join(gate.get('blocking_benchmarks') or []) or '(none)'}",
                "",
            ]
        )
    required_stats_gate = summary.get("required_stats_gate")
    if isinstance(required_stats_gate, dict):
        lines.extend(
            [
                "## Required Stats Gate",
                "",
                f"Status: {'ok' if required_stats_gate.get('ok') else 'blocked'}",
                f"Message: {required_stats_gate.get('message', '')}",
                f"Token evidence required: {required_stats_gate.get('token_evidence_required')}",
                f"Blocking requirements: {', '.join(required_stats_gate.get('blocking_requirements') or []) or '(none)'}",
                "",
            ]
        )
        outcome_blocking_comparisons = required_stats_gate.get("outcome_blocking_comparisons")
        if isinstance(outcome_blocking_comparisons, list) and outcome_blocking_comparisons:
            lines.extend(
                [
                    "| benchmark | outcome status | target accuracy | baseline accuracy | target total | baseline total | rerun |",
                    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
                ]
            )
            for row in outcome_blocking_comparisons:
                if not isinstance(row, dict):
                    continue
                lines.append(
                    "| {benchmark} | {status} | {target_accuracy} | {baseline_accuracy} | {target_total} | {baseline_total} | `{rerun}` |".format(
                        benchmark=row.get("benchmark", ""),
                        status=row.get("status", ""),
                        target_accuracy=fmt(row.get("target_accuracy")),
                        baseline_accuracy=fmt(row.get("baseline_accuracy")),
                        target_total=fmt(row.get("target_total"), 0),
                        baseline_total=fmt(row.get("baseline_total"), 0),
                        rerun=row.get("rerun_command_template", ""),
                    )
                )
            lines.append("")
        token_blocking_cells = required_stats_gate.get("token_blocking_cells")
        if isinstance(token_blocking_cells, list) and token_blocking_cells:
            lines.extend(
                [
                    "| benchmark | adapter | token evidence | trajectory dir | note | rerun |",
                    "| --- | --- | --- | --- | --- | --- |",
                ]
            )
            for cell in token_blocking_cells:
                if not isinstance(cell, dict):
                    continue
                lines.append(
                    "| {benchmark} | {adapter} | {status} | {trajectory_dir} | {note} | `{rerun}` |".format(
                        benchmark=cell.get("benchmark", ""),
                        adapter=cell.get("adapter", ""),
                        status=cell.get("status", ""),
                        trajectory_dir=cell.get("trajectory_dir", ""),
                        note=cell.get("note", ""),
                        rerun=cell.get("rerun_command_template", ""),
                    )
                )
            lines.append("")
    lines.extend(
        [
            "## Cells",
            "",
            "| benchmark | adapter | status | score | right | wrong | total | cached % | input tokens | output tokens | LLM calls | failure_class | result |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
        ]
    )
    for cell in summary.get("cells", []):
        result_path = cell.get("result_path") or ""
        score = cell.get("score")
        score_text = "" if score is None else f"{float(score):.4f}"
        outcome = cell.get("outcome_metrics") if isinstance(cell.get("outcome_metrics"), dict) else {}
        tokens = cell.get("token_metrics") if isinstance(cell.get("token_metrics"), dict) else {}
        lines.append(
            "| {benchmark} | {adapter} | {status} | {score} | {right} | {wrong} | {total} | {cached} | {input_tokens} | {output_tokens} | {llm_calls} | {failure_class} | {result} |".format(
                benchmark=cell.get("benchmark", ""),
                adapter=cell.get("adapter", ""),
                status=cell.get("status", ""),
                score=score_text,
                right=fmt(outcome.get("right"), 0),
                wrong=fmt(outcome.get("wrong"), 0),
                total=fmt(outcome.get("total"), 0),
                cached=fmt(tokens.get("cached_token_percent"), 2),
                input_tokens=fmt(tokens.get("input_tokens"), 0),
                output_tokens=fmt(tokens.get("output_tokens"), 0),
                llm_calls=fmt(tokens.get("llm_call_count"), 0),
                failure_class=cell.get("failure_class", ""),
                result=result_path,
            )
        )
    head_to_head = summary.get("head_to_head")
    if isinstance(head_to_head, dict):
        lines.extend(
            [
                "",
                "## ElizaOS vs OpenCode",
                "",
                "| benchmark | status | target accuracy | baseline accuracy | accuracy delta | target right/wrong | baseline right/wrong | target input | baseline input | target output | baseline output | target total tokens | baseline total tokens | total token delta | target cached % | baseline cached % | cached % delta | target LLM calls | baseline LLM calls | LLM call delta |",
                "| --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for row in head_to_head.get("comparisons", []):
            if not isinstance(row, dict):
                continue
            lines.append(
                "| {benchmark} | {status} | {target_accuracy} | {baseline_accuracy} | {accuracy_delta} | {target_rw} | {baseline_rw} | {target_input} | {baseline_input} | {target_output} | {baseline_output} | {target_total_tokens} | {baseline_total_tokens} | {token_delta} | {target_cached} | {baseline_cached} | {cached_delta} | {target_llm_calls} | {baseline_llm_calls} | {llm_delta} |".format(
                    benchmark=row.get("benchmark", ""),
                    status=row.get("status", ""),
                    target_accuracy=fmt(row.get("target_accuracy")),
                    baseline_accuracy=fmt(row.get("baseline_accuracy")),
                    accuracy_delta=fmt(row.get("accuracy_delta")),
                    target_rw=f"{fmt(row.get('target_right'), 0)}/{fmt(row.get('target_wrong'), 0)}",
                    baseline_rw=f"{fmt(row.get('baseline_right'), 0)}/{fmt(row.get('baseline_wrong'), 0)}",
                    target_input=fmt(row.get("target_input_tokens"), 0),
                    baseline_input=fmt(row.get("baseline_input_tokens"), 0),
                    target_output=fmt(row.get("target_output_tokens"), 0),
                    baseline_output=fmt(row.get("baseline_output_tokens"), 0),
                    target_total_tokens=fmt(row.get("target_total_tokens"), 0),
                    baseline_total_tokens=fmt(row.get("baseline_total_tokens"), 0),
                    token_delta=fmt(row.get("total_token_delta"), 0),
                    target_cached=fmt(row.get("target_cached_token_percent"), 2),
                    baseline_cached=fmt(row.get("baseline_cached_token_percent"), 2),
                    cached_delta=fmt(row.get("cached_token_percent_delta"), 2),
                    target_llm_calls=fmt(row.get("target_llm_call_count"), 0),
                    baseline_llm_calls=fmt(row.get("baseline_llm_call_count"), 0),
                    llm_delta=fmt(row.get("llm_call_delta"), 0),
                )
            )
    efficiency_queue = summary.get("efficiency_queue")
    if isinstance(efficiency_queue, list) and efficiency_queue:
        lines.extend(
            [
                "",
                "## Efficiency Queue",
                "",
                "| benchmark | status | reasons | accuracy delta | total token delta | cached % delta | LLM call delta |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        for item in efficiency_queue:
            if not isinstance(item, dict):
                continue
            lines.append(
                "| {benchmark} | {status} | {reasons} | {accuracy_delta} | {token_delta} | {cached_delta} | {llm_delta} |".format(
                    benchmark=item.get("benchmark", ""),
                    status=item.get("status", ""),
                    reasons="; ".join(str(reason) for reason in item.get("reasons") or []),
                    accuracy_delta=fmt(item.get("accuracy_delta")),
                    token_delta=fmt(item.get("total_token_delta"), 0),
                    cached_delta=fmt(item.get("cached_token_percent_delta"), 2),
                    llm_delta=fmt(item.get("llm_call_delta"), 0),
                )
            )
    token_by_adapter = summary.get("token_by_adapter")
    if isinstance(token_by_adapter, dict):
        lines.extend(["", "## Token Totals By Adapter", ""])
        lines.append("| adapter | input | output | total | cached | cached % | LLM calls |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for adapter, metrics in sorted(token_by_adapter.items()):
            if not isinstance(metrics, dict):
                continue
            lines.append(
                "| {adapter} | {input_tokens} | {output_tokens} | {total_tokens} | {cached_tokens} | {cached_percent} | {llm_calls} |".format(
                    adapter=adapter,
                    input_tokens=fmt(metrics.get("input_tokens"), 0),
                    output_tokens=fmt(metrics.get("output_tokens"), 0),
                    total_tokens=fmt(metrics.get("total_tokens"), 0),
                    cached_tokens=fmt(metrics.get("cached_tokens"), 0),
                    cached_percent=fmt(metrics.get("cached_token_percent"), 2),
                    llm_calls=fmt(metrics.get("llm_call_count"), 0),
                )
            )
    token_evidence = summary.get("token_evidence")
    if isinstance(token_evidence, dict):
        lines.extend(
            [
                "",
                "## Token Evidence",
                "",
                f"Status: {'ok' if token_evidence.get('ok') else 'incomplete'}",
                f"Message: {token_evidence.get('message', '')}",
                "",
                "| benchmark | adapter | evidence | LLM calls | input | output | total | cached % | note |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
            ]
        )
        for cell in token_evidence.get("cells", []):
            if not isinstance(cell, dict):
                continue
            lines.append(
                "| {benchmark} | {adapter} | {status} | {llm_calls} | {input_tokens} | {output_tokens} | {total_tokens} | {cached_percent} | {note} |".format(
                    benchmark=cell.get("benchmark", ""),
                    adapter=cell.get("adapter", ""),
                    status=cell.get("status", ""),
                    llm_calls=fmt(cell.get("llm_call_count"), 0),
                    input_tokens=fmt(cell.get("input_tokens"), 0),
                    output_tokens=fmt(cell.get("output_tokens"), 0),
                    total_tokens=fmt(cell.get("total_tokens"), 0),
                    cached_percent=fmt(cell.get("cached_token_percent"), 2),
                    note=cell.get("note", ""),
                )
            )
    previous_comparison = summary.get("previous_summary_comparison")
    if isinstance(previous_comparison, dict):
        lines.extend(
            [
                "",
                "## Previous Summary Comparison",
                "",
                "| benchmark | trend | previous status | current status | target accuracy delta | accuracy gap change | target token delta | cached % delta | LLM call delta |",
                "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for row in previous_comparison.get("comparisons", []):
            if not isinstance(row, dict):
                continue
            lines.append(
                "| {benchmark} | {trend} | {previous_status} | {current_status} | {target_accuracy_delta} | {gap_change} | {token_delta} | {cached_delta} | {llm_delta} |".format(
                    benchmark=row.get("benchmark", ""),
                    trend=row.get("trend", ""),
                    previous_status=row.get("previous_status") or "",
                    current_status=row.get("current_status") or "",
                    target_accuracy_delta=fmt(row.get("target_accuracy_delta")),
                    gap_change=fmt(row.get("accuracy_delta_change")),
                    token_delta=fmt(row.get("target_total_token_delta"), 0),
                    cached_delta=fmt(row.get("target_cached_token_percent_delta"), 2),
                    llm_delta=fmt(row.get("target_llm_call_delta"), 0),
                )
            )
    improvement_queue = summary.get("improvement_queue")
    if isinstance(improvement_queue, list) and improvement_queue:
        lines.extend(
            [
                "",
                "## Improvement Queue",
                "",
                "| priority | benchmark | status | diagnosis | next action | accuracy delta | target failure | baseline failure | target trajectories | baseline trajectories |",
                "| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
            ]
        )
        for item in improvement_queue:
            if not isinstance(item, dict):
                continue
            target_artifacts = item.get("target_artifacts")
            baseline_artifacts = item.get("baseline_artifacts")
            target_trajectory = (
                target_artifacts.get("trajectory_dir")
                if isinstance(target_artifacts, dict)
                else ""
            )
            baseline_trajectory = (
                baseline_artifacts.get("trajectory_dir")
                if isinstance(baseline_artifacts, dict)
                else ""
            )
            lines.append(
                "| {priority} | {benchmark} | {status} | {diagnosis} | {next_action} | {accuracy_delta} | {target_failure} | {baseline_failure} | {target_trajectory} | {baseline_trajectory} |".format(
                    priority=item.get("priority", ""),
                    benchmark=item.get("benchmark", ""),
                    status=item.get("status", ""),
                    diagnosis=item.get("primary_diagnosis") or "",
                    next_action=item.get("next_action", ""),
                    accuracy_delta=fmt(item.get("accuracy_delta")),
                    target_failure=item.get("target_failure_class") or "",
                    baseline_failure=item.get("baseline_failure_class") or "",
                    target_trajectory=target_trajectory or "",
                    baseline_trajectory=baseline_trajectory or "",
                )
            )
        command_templates = []
        seen_commands: set[str] = set()
        for item in improvement_queue:
            if not isinstance(item, dict):
                continue
            command = item.get("rerun_command_template")
            if isinstance(command, str) and command and command not in seen_commands:
                command_templates.append(command)
                seen_commands.add(command)
        if command_templates:
            lines.extend(["", "### Queue Rerun Commands", ""])
            for command in command_templates:
                lines.extend(["```bash", command, "```", ""])
        lines.extend(
            [
                "",
                "### Trajectory Review Briefs",
                "",
                "| benchmark | adapter | files | turns | input | output | cached % | repeated prefixes | notes |",
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
            ]
        )
        for item in improvement_queue:
            if not isinstance(item, dict):
                continue
            for adapter_key, review_key in (
                ("target", "target_trajectory_review"),
                ("baseline", "baseline_trajectory_review"),
            ):
                review = item.get(review_key)
                if not isinstance(review, dict):
                    continue
                notes = ", ".join(str(note) for note in review.get("review_notes") or [])
                lines.append(
                    "| {benchmark} | {adapter} | {files} | {turns} | {input_tokens} | {output_tokens} | {cached_percent} | {repeats} | {notes} |".format(
                        benchmark=item.get("benchmark", ""),
                        adapter=adapter_key,
                        files=fmt(review.get("trajectory_files"), 0),
                        turns=fmt(review.get("turns"), 0),
                        input_tokens=fmt(review.get("input_tokens"), 0),
                        output_tokens=fmt(review.get("output_tokens"), 0),
                        cached_percent=fmt(review.get("cached_token_percent"), 2),
                        repeats=fmt(review.get("repeated_prefix_count"), 0),
                        notes=notes,
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
                outcome_metrics=collect_outcome_metrics(payload),
                token_metrics=collect_token_metrics(Path(str(meta.get("trajectory_dir") or (cell_dir / "trajectories")))),
                resumed=True,
            )
        )
    return results


def queue_cell_pairs(
    summary: dict[str, Any],
    *,
    priorities: set[str] | None = None,
    statuses: set[str] | None = None,
) -> tuple[tuple[str, str], ...]:
    pairs: set[tuple[str, str]] = set()
    queue = summary.get("improvement_queue")
    if not isinstance(queue, list):
        return ()
    for item in queue:
        if not isinstance(item, dict):
            continue
        priority = str(item.get("priority") or "")
        status = str(item.get("status") or "")
        if priorities is not None and priority not in priorities:
            continue
        if statuses is not None and status not in statuses:
            continue
        benchmark = str(item.get("benchmark") or "")
        if not benchmark:
            continue
        for artifacts_key in ("target_artifacts", "baseline_artifacts"):
            artifacts = item.get(artifacts_key)
            if not isinstance(artifacts, dict):
                continue
            output_dir = artifacts.get("output_dir")
            if not isinstance(output_dir, str) or not output_dir:
                continue
            adapter = Path(output_dir).parent.name
            if adapter:
                pairs.add((benchmark, adapter))
    return tuple(sorted(pairs))


def parse_csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if not value:
        return default
    return tuple(item.strip() for item in value.split(",") if item.strip())


def parse_optional_csv_set(value: str | None) -> set[str] | None:
    if not value:
        return None
    items = {item.strip() for item in value.split(",") if item.strip()}
    return items or None


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
    parser.add_argument("--preflight", action="store_true", help="Print readiness checks and exit.")
    parser.add_argument(
        "--enforce-comparable",
        action="store_true",
        help="Exit nonzero unless elizaos is comparable-or-better on every selected benchmark.",
    )
    parser.add_argument(
        "--enforce-coverage",
        action="store_true",
        help="Exit nonzero unless every included code-agent benchmark is selected.",
    )
    parser.add_argument(
        "--enforce-token-evidence",
        action="store_true",
        help="Exit nonzero unless every selected cell produced usable LLM token telemetry.",
    )
    parser.add_argument(
        "--enforce-required-stats",
        action="store_true",
        help="Exit nonzero unless required right/wrong and token stats are complete for the run mode.",
    )
    parser.add_argument(
        "--enforce-efficiency",
        action="store_true",
        help="Exit nonzero if ElizaOS uses more tokens/calls or has lower cached-token percentage than OpenCode.",
    )
    parser.add_argument(
        "--enforce-no-regression",
        action="store_true",
        help="Exit nonzero if ElizaOS target accuracy regressed against --compare-summary.",
    )
    parser.add_argument(
        "--quality-guardrail-summary",
        default="",
        help="Path to validate-latest-readiness --json output for broader benchmark quality guardrail.",
    )
    parser.add_argument(
        "--enforce-quality-guardrail",
        action="store_true",
        help="Exit nonzero unless --quality-guardrail-summary is present and clean.",
    )
    parser.add_argument(
        "--enforce-trajectory-reviews",
        action="store_true",
        help="Exit nonzero unless every selected cell has reviewable trajectory telemetry.",
    )
    parser.add_argument(
        "--enforce-live-report",
        action="store_true",
        help="Exit nonzero unless the report was generated from live benchmark execution.",
    )
    parser.add_argument(
        "--enforce-report",
        action="store_true",
        help="Exit nonzero unless coverage, comparability, and required stats gates all pass.",
    )
    parser.add_argument("--force", action="store_true", help="Re-run cells even when cell-result.json exists.")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing cell-result.json files.")
    parser.add_argument("--summarize", default="", help="Summarize an existing run root instead of executing.")
    parser.add_argument(
        "--compare-summary",
        default="",
        help="Attach trend deltas against a previous summary.json.",
    )
    parser.add_argument(
        "--rerun-queue",
        default="",
        help="Read a previous summary.json and run only queued target/baseline cells.",
    )
    parser.add_argument(
        "--queue-priorities",
        default="",
        help="Comma-separated queue priorities to rerun, for example p0,p1.",
    )
    parser.add_argument(
        "--queue-statuses",
        default="",
        help="Comma-separated queue statuses to rerun, for example inferior,missing.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = workspace_root()
    default_run_root = root / "benchmark_results" / "code-agent-matrix" / now_id()
    queue_summary_path = Path(args.rerun_queue).expanduser().resolve() if args.rerun_queue else None
    run_root = Path(
        args.summarize
        or args.run_root
        or (queue_summary_path.parent if queue_summary_path is not None else default_run_root)
    ).expanduser().resolve()
    summarized_previous_mode = previous_run_mode(run_root) if args.summarize else None

    if args.summarize:
        results = summarize_existing(run_root)
        preflight = None
        cell_pairs = tuple(
            sorted({(result.benchmark, result.adapter) for result in results})
        )
    else:
        if queue_summary_path is not None:
            queue_summary = read_json(queue_summary_path)
            if not isinstance(queue_summary, dict):
                raise SystemExit(f"Could not read queue summary: {queue_summary_path}")
            cell_pairs = queue_cell_pairs(
                queue_summary,
                priorities=parse_optional_csv_set(args.queue_priorities),
                statuses=parse_optional_csv_set(args.queue_statuses),
            )
        else:
            adapters = parse_csv(args.adapters, DEFAULT_ADAPTERS)
            benchmarks = parse_csv(args.benchmarks, DEFAULT_BENCHMARKS)
            cell_pairs = tuple((benchmark, adapter) for benchmark in benchmarks for adapter in adapters)
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
            for benchmark, adapter in cell_pairs
        ]
        preflight = preflight_matrix(
            root=root,
            cells=cells,
            provider=args.provider,
            require_provider_key=not (args.smoke or args.dry_run),
        )
        if args.preflight:
            write_preflight_artifacts(
                run_root=run_root,
                args=args,
                cell_pairs=cell_pairs,
                preflight=preflight,
            )
            print(json.dumps(preflight, indent=2, sort_keys=True))
            return EXIT_OK if preflight["ok"] else EXIT_PREFLIGHT_FAILED
        if not preflight["ok"]:
            print(json.dumps(preflight, indent=2, sort_keys=True))
            return EXIT_PREFLIGHT_FAILED
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
    summary["run_config"] = build_run_config(
        args,
        run_root=run_root,
        cell_pairs=cell_pairs,
    )
    if args.summarize and summarized_previous_mode:
        summary["run_config"]["mode"] = summarized_previous_mode
        summary["run_config"]["summarized_existing"] = True
    summary["improvement_queue"] = build_improvement_queue(
        results,
        summary["head_to_head"],
        run_config=summary["run_config"],
    )
    summary["required_stats_gate"] = build_required_stats_gate(
        summary,
        mode=summary["run_config"].get("mode"),
        require_token_evidence=(
            True
            if args.enforce_token_evidence
            else None
        ),
    )
    summary["efficiency_gate"] = build_efficiency_gate(summary)
    if preflight is not None:
        summary["preflight"] = preflight
    if args.compare_summary:
        previous_summary = read_json(Path(args.compare_summary).expanduser().resolve())
        if not isinstance(previous_summary, dict):
            raise SystemExit(f"Could not read comparison summary: {args.compare_summary}")
        summary["previous_summary_comparison"] = build_previous_summary_comparison(
            summary,
            previous_summary,
        )
    summary["no_regression_gate"] = build_no_regression_gate(summary)
    guardrail_summary: dict[str, Any] | None = None
    if args.quality_guardrail_summary:
        raw_guardrail_summary = read_json(Path(args.quality_guardrail_summary).expanduser().resolve())
        if not isinstance(raw_guardrail_summary, dict):
            raise SystemExit(f"Could not read quality guardrail summary: {args.quality_guardrail_summary}")
        guardrail_summary = raw_guardrail_summary
    summary["quality_guardrail_gate"] = build_quality_guardrail_gate(
        guardrail_summary,
        summary_path=str(args.quality_guardrail_summary or ""),
        enforced=bool(args.enforce_quality_guardrail),
    )
    summary["trajectory_review_gate"] = build_trajectory_review_gate(
        summary,
        require_trajectory_reviews=bool(args.enforce_trajectory_reviews),
    )
    summary["live_report_gate"] = build_live_report_gate(
        summary,
        enforced=bool(args.enforce_live_report),
    )
    summary["report_gate"] = build_report_gate(summary)
    summary["report_rows"] = build_report_rows(summary)
    summary["artifact_paths"] = {
        "run_root": str(run_root),
        "summary_json": str(run_root / "summary.json"),
        "summary_md": str(run_root / "summary.md"),
        **write_report_rows(run_root, summary["report_rows"]),
    }
    write_json(run_root / "summary.json", summary)
    (run_root / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print(json.dumps({"run_root": str(run_root), "summary": str(run_root / "summary.json")}, indent=2))
    report_gate = summary.get("report_gate")
    if (
        args.enforce_report
        and isinstance(report_gate, dict)
        and not report_gate.get("ok")
    ):
        return EXIT_REPORT_GATE_FAILED
    if args.enforce_comparable and not summary["benchmark_gate"]["ok"]:
        return EXIT_COMPARABLE_GATE_FAILED
    coverage_gate = summary.get("coverage_gate")
    if (
        args.enforce_coverage
        and isinstance(coverage_gate, dict)
        and not coverage_gate.get("ok")
    ):
        return EXIT_COVERAGE_GATE_FAILED
    token_evidence = summary.get("token_evidence")
    if (
        args.enforce_token_evidence
        and isinstance(token_evidence, dict)
        and not token_evidence.get("ok")
    ):
        return EXIT_TOKEN_EVIDENCE_FAILED
    required_stats_gate = summary.get("required_stats_gate")
    if (
        args.enforce_required_stats
        and isinstance(required_stats_gate, dict)
        and not required_stats_gate.get("ok")
    ):
        return EXIT_REQUIRED_STATS_FAILED
    efficiency_gate = summary.get("efficiency_gate")
    if (
        args.enforce_efficiency
        and isinstance(efficiency_gate, dict)
        and not efficiency_gate.get("ok")
    ):
        return EXIT_EFFICIENCY_GATE_FAILED
    no_regression_gate = summary.get("no_regression_gate")
    if (
        args.enforce_no_regression
        and isinstance(no_regression_gate, dict)
        and not no_regression_gate.get("ok")
    ):
        return EXIT_NO_REGRESSION_FAILED
    quality_guardrail_gate = summary.get("quality_guardrail_gate")
    if (
        args.enforce_quality_guardrail
        and isinstance(quality_guardrail_gate, dict)
        and not quality_guardrail_gate.get("ok")
    ):
        return EXIT_QUALITY_GUARDRAIL_FAILED
    trajectory_review_gate = summary.get("trajectory_review_gate")
    if (
        args.enforce_trajectory_reviews
        and isinstance(trajectory_review_gate, dict)
        and not trajectory_review_gate.get("ok")
    ):
        return EXIT_TRAJECTORY_REVIEW_FAILED
    live_report_gate = summary.get("live_report_gate")
    if (
        args.enforce_live_report
        and isinstance(live_report_gate, dict)
        and not live_report_gate.get("ok")
    ):
        return EXIT_LIVE_REPORT_FAILED
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
