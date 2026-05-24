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
import importlib.util
import json
import math
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
from .code_agent_coverage import (
    CODE_AGENT_COVERAGE,
    coverage_status_by_id,
    included_benchmark_ids,
    repo_local_related_benchmark_dirs,
)
from .code_agent_latest_contract import (
    CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES,
    CODE_AGENT_LATEST_AGENT,
    CODE_AGENT_LATEST_REQUIRED_NUMERIC_FIELDS,
    CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS,
    CODE_AGENT_LATEST_REQUIRED_TRUE_FIELDS,
    expected_code_agent_comparison_status,
)

DEFAULT_ADAPTERS = ("elizaos", "opencode")
DEFAULT_BENCHMARKS = included_benchmark_ids()
DEFAULT_TARGET_ADAPTER = "elizaos"
DEFAULT_BASELINE_ADAPTER = "opencode"
DEFAULT_MODEL = "gpt-oss-120b"
DEFAULT_PROVIDER = "cerebras"
DEFAULT_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
CODE_CAPABILITIES = "code.read,code.write,code.edit,code.search,code.shell"
DEFAULT_LOG_LIMIT_BYTES = 16 * 1024 * 1024
RUNNABLE_DEFERRED_BENCHMARKS = frozenset({"swe_bench_pro", "vision_language"})
NON_CODE_GUARDRAIL_EXCLUDED_BENCHMARKS = tuple(
    sorted({item.benchmark_id for item in CODE_AGENT_COVERAGE})
)
NON_CODE_GUARDRAIL_COMMAND = (
    "PYTHONPATH=packages python -m benchmarks.orchestrator "
    "validate-latest-readiness --skip-runtime-gates "
    f"--exclude-benchmarks {','.join(NON_CODE_GUARDRAIL_EXCLUDED_BENCHMARKS)} "
    "--json > /path/to/non-code-quality-guardrail.json"
)
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
    "target_failure_class",
    "baseline_failure_class",
    "target_result_path",
    "baseline_result_path",
    "target_command_path",
    "baseline_command_path",
    "target_trajectory_dir",
    "baseline_trajectory_dir",
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
    "release_readiness_ok",
    "release_readiness_blocking_requirements",
    "release_readiness_unblock_command_ids",
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
EXIT_RELEASE_READINESS_FAILED = 13
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
    (
        EXIT_RELEASE_READINESS_FAILED,
        "release_readiness_failed",
        "the final release-readiness checklist failed",
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
    command_path: str | None = None
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


def _standard_humaneval_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _standard_humaneval_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_standard_humaneval_command_env_name(adapter), "")
        or env.get("STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("STANDARD_HUMANEVAL_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "standard" / "agent_command.py"
    if not agent_command.exists():
        return ""
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(agent_command),
            "--adapter",
            adapter,
            "--benchmark",
            "standard_humaneval",
            "--task",
            "{task}",
            "--prompt",
            "{prompt}",
            "--result-json",
            "{result_json}",
            "--provider",
            "{model_provider}",
            "--model",
            "{model}",
        )
    )


def _app_eval_coding_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _app_eval_coding_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_app_eval_coding_command_env_name(adapter), "")
        or env.get("APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "app-eval" / "agent_command.py"
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


def _qwen_claw_bench_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _qwen_claw_bench_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_qwen_claw_bench_command_env_name(adapter), "")
        or env.get("QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("QWEN_CLAW_BENCH_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "qwen_claw_bench_matrix" / "agent_command.py"
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
            "--task-path",
            "{task_path}",
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


def _claw_eval_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"CLAW_EVAL_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _claw_eval_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_claw_eval_command_env_name(adapter), "")
        or env.get("CLAW_EVAL_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("CLAW_EVAL_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "claw_eval_matrix" / "agent_command.py"
    if not agent_command.exists():
        return ""
    return " ".join(
        shlex.quote(part)
        for part in (
            sys.executable,
            str(agent_command),
            "--adapter",
            adapter,
            "--task-yaml",
            "{task_yaml}",
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


def _swe_bench_pro_command_env_name(adapter: str) -> str:
    adapter_key = sanitize(adapter).replace("-", "_").upper()
    return f"SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE_{adapter_key}"


def _swe_bench_pro_agent_command_template(adapter: str, env: dict[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    configured = (
        env.get(_swe_bench_pro_command_env_name(adapter), "")
        or env.get("SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE", "")
    ).strip()
    if configured:
        return configured
    disable_builtin = env.get("SWE_BENCH_PRO_DISABLE_BUILTIN_AGENT_COMMAND", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if disable_builtin:
        return ""
    agent_command = workspace_root() / "packages" / "benchmarks" / "swe_bench_pro_matrix" / "agent_command.py"
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
            "--prompt",
            "{prompt}",
            "--task",
            "{task}",
            "--repo",
            "{repo}",
            "--base-commit",
            "{base_commit}",
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
    require_quality_guardrail_summary: bool = False,
    quality_guardrail_summary: str = "",
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

    quality_guardrail_summary = str(quality_guardrail_summary or "")
    quality_guardrail_summary_present = False
    quality_guardrail_summary_ok: bool | None = None
    quality_guardrail_summary_findings = 0
    quality_guardrail_summary_blocking_findings: list[dict[str, str]] = []
    if quality_guardrail_summary:
        quality_guardrail_path = Path(quality_guardrail_summary).expanduser()
        quality_guardrail_summary_present = quality_guardrail_path.exists()
        if require_quality_guardrail_summary and not quality_guardrail_summary_present:
            issues.append(
                {
                    "severity": "error",
                    "kind": "missing_quality_guardrail_summary_file",
                    "message": f"quality guardrail summary was not found: {quality_guardrail_summary}",
                }
            )
        elif require_quality_guardrail_summary:
            guardrail_payload = read_json(quality_guardrail_path)
            if not isinstance(guardrail_payload, dict):
                quality_guardrail_summary_ok = False
                issues.append(
                    {
                        "severity": "error",
                        "kind": "invalid_quality_guardrail_summary",
                        "message": f"quality guardrail summary is not valid JSON: {quality_guardrail_summary}",
                    }
                )
            else:
                validation_issues = _quality_guardrail_summary_validation(guardrail_payload)
                findings = guardrail_payload.get("findings")
                findings = findings if isinstance(findings, list) else []
                quality_guardrail_summary_findings = len(findings)
                quality_guardrail_summary_blocking_findings = [
                    {
                        "scope": str(finding.get("scope", "")),
                        "reason": str(finding.get("reason", "")),
                        "value": str(finding.get("value", "")),
                        "next_action": _quality_guardrail_next_action(
                            str(finding.get("scope", "")),
                            str(finding.get("reason", "")),
                            str(finding.get("value", "")),
                        ),
                    }
                    for finding in findings
                    if isinstance(finding, dict)
                ]
                quality_guardrail_summary_ok = (
                    not validation_issues
                    and bool(guardrail_payload.get("ok"))
                    and not findings
                )
                if validation_issues:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "invalid_quality_guardrail_summary",
                            "message": (
                                "quality guardrail summary is not a readiness report"
                                f": {', '.join(validation_issues)}"
                            ),
                        }
                    )
                if not quality_guardrail_summary_ok:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "quality_guardrail_summary_failed",
                            "message": (
                                "quality guardrail summary is not clean"
                                f": ok={guardrail_payload.get('ok')}, findings={len(findings)}"
                            ),
                        }
                    )
    elif require_quality_guardrail_summary:
        issues.append(
            {
                "severity": "error",
                "kind": "missing_quality_guardrail_summary",
                "message": "release readiness requires --quality-guardrail-summary",
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
    docker_checked = False
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
            if "--no-docker" not in cell.command and not docker_checked:
                docker_checked = True
                docker = shutil.which("docker")
                if not docker:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "missing_docker_cli",
                            "message": f"{cell.benchmark} live scoring requires the Docker CLI",
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
                                    f"{cell.benchmark} live scoring requires a running Docker daemon"
                                    + (f": {detail}" if detail else "")
                                ),
                            }
                        )
        if cell.benchmark == "standard_humaneval" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_standard_humaneval_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            "STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE or "
                            f"{_standard_humaneval_command_env_name(cell.adapter)}"
                        ),
                    }
                )
        if cell.benchmark == "app_eval_coding" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_app_eval_coding_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            "APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE or "
                            f"{_app_eval_coding_command_env_name(cell.adapter)}"
                        ),
                    }
                )
        if cell.benchmark == "qwen_claw_bench" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_qwen_claw_bench_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            "QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE or "
                            f"{_qwen_claw_bench_command_env_name(cell.adapter)}"
                        ),
                    }
                )
        if cell.benchmark == "claw_eval" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_claw_eval_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            "CLAW_EVAL_AGENT_COMMAND_TEMPLATE or "
                            f"{_claw_eval_command_env_name(cell.adapter)}"
                        ),
                    }
                )
        if cell.benchmark == "swe_bench_pro" and "--mock" not in cell.command:
            if "--agent-command-template" not in cell.command:
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_swe_bench_pro_agent_command_template",
                        "message": (
                            f"{cell.benchmark}/{cell.adapter} requires "
                            "SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE or "
                            f"{_swe_bench_pro_command_env_name(cell.adapter)}"
                        ),
                    }
                )
            evaluator_backend = _swe_bench_pro_evaluator_backend(cell.command)
            if evaluator_backend == "modal":
                if importlib.util.find_spec("modal") is None:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "missing_modal_package",
                            "message": (
                                f"{cell.benchmark} Modal scoring requires the modal Python package"
                            ),
                        }
                    )
            elif "--no-docker" not in cell.command and not docker_checked:
                docker_checked = True
                docker = shutil.which("docker")
                if not docker:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "missing_docker_cli",
                            "message": f"{cell.benchmark} live scoring requires the Docker CLI",
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
                                    f"{cell.benchmark} live scoring requires a running Docker daemon"
                                    + (f": {detail}" if detail else "")
                                ),
                            }
                        )
        if cell.benchmark == "osworld" and "--dry_run" not in cell.command:
            provider_name = _command_option(cell.command, "--provider_name") or "docker"
            no_docker_requested = cell.env_overrides.get("OSWORLD_NO_DOCKER_REQUESTED") == "1"
            if no_docker_requested and provider_name == "docker":
                issues.append(
                    {
                        "severity": "error",
                        "kind": "osworld_no_docker_requires_provider",
                        "message": (
                            "osworld --no-docker requires OSWORLD_PROVIDER_NAME=vmware, "
                            "virtualbox, or aws plus the provider-specific disposable "
                            "environment configuration; otherwise the OSWorld runner "
                            "defaults to Docker."
                        ),
                    }
                )
            if provider_name == "vmware" and not _command_option(cell.command, "--path_to_vm"):
                issues.append(
                    {
                        "severity": "error",
                        "kind": "missing_osworld_vmware_path",
                        "message": "osworld VMware runs require OSWORLD_PATH_TO_VM or --path_to_vm",
                    }
                )
            if provider_name == "docker" and not no_docker_requested and not docker_checked:
                docker_checked = True
                docker = shutil.which("docker")
                if not docker:
                    issues.append(
                        {
                            "severity": "error",
                            "kind": "missing_docker_cli",
                            "message": "osworld live execution requires the Docker CLI by default",
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
                                    "osworld live execution requires a running Docker daemon"
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

    unblock_steps = build_preflight_unblock_steps(
        issues,
        provider=provider,
        provider_key=key_name,
    )
    return {
        "ok": not any(issue["severity"] == "error" for issue in issues),
        "provider": provider,
        "provider_key": key_name,
        "provider_key_present": bool(key_name and env.get(key_name)),
        "provider_key_required": bool(require_provider_key and key_name),
        "quality_guardrail_summary": quality_guardrail_summary,
        "quality_guardrail_summary_present": quality_guardrail_summary_present,
        "quality_guardrail_summary_required": bool(require_quality_guardrail_summary),
        "quality_guardrail_summary_ok": quality_guardrail_summary_ok,
        "quality_guardrail_summary_findings": quality_guardrail_summary_findings,
        "quality_guardrail_summary_blocking_findings": quality_guardrail_summary_blocking_findings,
        "opencode_bin": opencode_bin,
        "issues": issues,
        "unblock_steps": unblock_steps,
        "unblock_count": len(unblock_steps),
        "cells": cell_checks,
    }


def _swe_bench_pro_evaluator_backend(command: list[str]) -> str:
    try:
        index = command.index("--evaluator-backend")
    except ValueError:
        return "local-docker"
    if index + 1 >= len(command):
        return "local-docker"
    backend = str(command[index + 1]).strip()
    return backend or "local-docker"


def _command_option(command: list[str], option: str) -> str | None:
    try:
        index = command.index(option)
    except ValueError:
        return None
    if index + 1 >= len(command):
        return None
    value = str(command[index + 1]).strip()
    return value or None


def _quality_guardrail_next_action(scope: str, reason: str, value: str) -> str:
    if scope == "matrix_contract" or scope.startswith("matrix_contract."):
        return "Run the full benchmark matrix and publish a latest/index.json with a complete matrix_contract."
    if scope.startswith("publishability:"):
        return "Generate or restore packages/benchmarks/benchmark_results/latest before validating readiness."
    if scope == "runtime_gate:hyperliquid_live":
        return "Set HL_PRIVATE_KEY and rerun the Hyperliquid harness without demo mode."
    if scope in {
        "runtime_gate:terminal_bench_docker",
        "runtime_gate:swe_bench_docker",
    }:
        return "Start Docker Desktop or a compatible Docker daemon before running Docker-backed benchmarks."
    if scope == "runtime_gate:hermes_sandbox":
        return "Set MODAL_TOKEN_ID/MODAL_TOKEN_SECRET or start a reachable Docker daemon for Hermes sandbox execution."
    if scope == "runtime_gate:vision_language_real_inputs":
        return "Install or point the vision-language harness at the real eliza-1 VLM input bundle."
    if scope == "runtime_gate:vision_language_harness_runtime":
        return "Set VISION_LANGUAGE_MODEL and provider credentials for a multimodal OpenAI-compatible model."
    if reason:
        return f"Resolve readiness finding {reason}."
    if value:
        return value
    return "Resolve this readiness finding before enforcing release readiness."


def _quality_guardrail_summary_validation(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return ["summary is not a JSON object"]
    issues: list[str] = []
    latest_dir = payload.get("latest_dir")
    if not isinstance(latest_dir, str) or not latest_dir.strip():
        issues.append("missing latest_dir")
    elif not Path(latest_dir).expanduser().is_dir():
        issues.append(f"latest_dir does not exist: {latest_dir}")
    tolerance = payload.get("tolerance")
    if not isinstance(tolerance, (int, float)) or isinstance(tolerance, bool):
        issues.append("missing numeric tolerance")
    ok = payload.get("ok")
    if not isinstance(ok, bool):
        issues.append("missing boolean ok")
    findings = payload.get("findings")
    if not isinstance(findings, list):
        issues.append("missing findings list")
    return issues


def build_preflight_unblock_steps(
    issues: list[dict[str, str]],
    *,
    provider: str,
    provider_key: str | None,
) -> list[dict[str, str]]:
    steps_by_kind: dict[str, dict[str, str]] = {}
    for issue in issues:
        kind = issue.get("kind", "")
        if not kind or kind in steps_by_kind:
            continue
        if kind == "missing_provider_key":
            key = provider_key or provider_key_name(provider) or "<PROVIDER_API_KEY>"
            steps_by_kind[kind] = {
                "kind": kind,
                "title": f"Set {key}",
                "action": f"Export {key} in the shell before running live benchmarks.",
                "command": f"export {key}=<redacted>",
            }
        elif kind == "missing_opencode_cli":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Install or point to OpenCode",
                "action": "Install the opencode CLI or set OPENCODE_BIN to an executable path.",
                "command": "export OPENCODE_BIN=/path/to/opencode",
            }
        elif kind in {
            "missing_quality_guardrail_summary",
            "missing_quality_guardrail_summary_file",
            "invalid_quality_guardrail_summary",
            "quality_guardrail_summary_failed",
        }:
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Attach non-code quality guardrail",
                "action": (
                    "Generate the broader non-code readiness JSON and pass it with "
                    "--quality-guardrail-summary before enforcing release readiness."
                ),
                "command": NON_CODE_GUARDRAIL_COMMAND,
            }
        elif kind == "missing_executable":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Install benchmark runtime dependencies",
                "action": "Install the missing command executable reported by preflight.",
                "command": "python -m pip install -e packages/benchmarks/orchestrator",
            }
        elif kind == "missing_cwd":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Restore benchmark working directory",
                "action": "Restore or initialize the missing benchmark directory before running the matrix.",
                "command": "git submodule update --init --recursive",
            }
        elif kind == "missing_nl2repo_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure NL2Repo agent command",
                "action": (
                    "Unset NL2REPO_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide NL2REPO_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset NL2REPO_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_standard_humaneval_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure HumanEval agent command",
                "action": (
                    "Unset STANDARD_HUMANEVAL_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide STANDARD_HUMANEVAL_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset STANDARD_HUMANEVAL_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_app_eval_coding_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure App Eval coding agent command",
                "action": (
                    "Unset APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide APP_EVAL_CODING_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset APP_EVAL_CODING_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_qwen_claw_bench_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure QwenClawBench agent command",
                "action": (
                    "Unset QWEN_CLAW_BENCH_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide QWEN_CLAW_BENCH_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset QWEN_CLAW_BENCH_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_claw_eval_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure Claw-Eval agent command",
                "action": (
                    "Unset CLAW_EVAL_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide CLAW_EVAL_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset CLAW_EVAL_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_swe_bench_pro_agent_command_template":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Configure SWE-bench Pro agent command",
                "action": (
                    "Unset SWE_BENCH_PRO_DISABLE_BUILTIN_AGENT_COMMAND to use the repo helper, "
                    "or provide SWE_BENCH_PRO_AGENT_COMMAND_TEMPLATE for an external runner."
                ),
                "command": "unset SWE_BENCH_PRO_DISABLE_BUILTIN_AGENT_COMMAND",
            }
        elif kind == "missing_docker_cli":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Install Docker",
                "action": "Install Docker CLI/Desktop before Docker-backed benchmark scoring.",
                "command": "docker version",
            }
        elif kind == "docker_daemon_unavailable":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Start Docker daemon",
                "action": "Start Docker Desktop or the Docker daemon before release-comparable scoring.",
                "command": "docker version",
            }
        elif kind == "missing_modal_package":
            steps_by_kind[kind] = {
                "kind": kind,
                "title": "Install Modal",
                "action": "Install the modal Python package before SWE-bench Pro Modal scoring.",
                "command": "python -m pip install modal",
            }
    return list(steps_by_kind.values())


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
            "--sample" if smoke else "--hf",
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
            if max_tasks is not None and max_tasks > 1:
                cmd.extend(["--split", "train"])
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
        else:
            provider_name = os.environ.get("OSWORLD_PROVIDER_NAME", "").strip()
            path_to_vm = os.environ.get("OSWORLD_PATH_TO_VM", "").strip()
            if provider_name:
                cmd.extend(["--provider_name", provider_name])
            if path_to_vm:
                cmd.extend(["--path_to_vm", path_to_vm])
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

    if benchmark == "standard_humaneval":
        cmd = [
            python,
            "-m",
            "benchmarks.standard.code_agent_humaneval",
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
        command_template = _standard_humaneval_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        return cmd, root

    if benchmark == "app_eval_coding":
        cmd = [
            python,
            "-m",
            "benchmarks.app_eval.code_agent_coding",
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
        command_template = _app_eval_coding_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        return cmd, root

    if benchmark == "mint":
        cmd = [
            python,
            "-m",
            "benchmarks.mint.code_agent_matrix",
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
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "openclaw_benchmark":
        cmd = [
            python,
            "-m",
            "benchmarks.openclaw_benchmark.code_agent_matrix",
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
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "clawbench":
        cmd = [
            python,
            "-m",
            "benchmarks.clawbench_matrix.code_agent_matrix",
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
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "agentbench":
        cmd = [
            python,
            "-m",
            "benchmarks.agentbench_matrix.code_agent_matrix",
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
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "qwen_claw_bench":
        cmd = [
            python,
            "-m",
            "benchmarks.qwen_claw_bench_matrix.code_agent_matrix",
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
        command_template = _qwen_claw_bench_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "claw_eval":
        cmd = [
            python,
            "-m",
            "benchmarks.claw_eval_matrix.code_agent_matrix",
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
        command_template = _claw_eval_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.append("--no-docker")
        return cmd, root

    if benchmark == "swe_bench_pro":
        cmd = [
            python,
            "-m",
            "benchmarks.swe_bench_pro_matrix.code_agent_matrix",
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
        evaluator_backend = os.environ.get("SWE_BENCH_PRO_EVALUATOR_BACKEND", "").strip()
        if evaluator_backend:
            cmd.extend(["--evaluator-backend", evaluator_backend])
        eval_num_workers = os.environ.get("SWE_BENCH_PRO_EVAL_NUM_WORKERS", "").strip()
        if eval_num_workers:
            cmd.extend(["--eval-num-workers", eval_num_workers])
        command_template = _swe_bench_pro_agent_command_template(adapter)
        if command_template:
            cmd.extend(["--agent-command-template", command_template])
        if smoke:
            cmd.append("--mock")
        if no_docker:
            cmd.extend(["--no-docker", "--skip-clone"])
        return cmd, root

    if benchmark == "vision_language":
        bun = os.environ.get("BUN_BIN", "").strip() or shutil.which("bun") or "bun"
        vision_benchmark = os.environ.get("VISION_LANGUAGE_BENCHMARK", "").strip() or "screenspot"
        cmd = [
            bun,
            "run",
            "src/runner.ts",
            "--harness",
            adapter,
            "--model-provider",
            provider,
            "--model",
            model,
            "--benchmark",
            vision_benchmark,
            "--output",
            str(output_dir / "vision-language-results.json"),
        ]
        if max_tasks is not None:
            cmd.extend(["--samples", str(max_tasks)])
        if smoke:
            cmd.append("--smoke")
        return cmd, root / "packages" / "benchmarks" / "vision-language"

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
    if benchmark == "mind2web":
        env_overrides["ELIZA_BENCH_SKIP_CORE_PLUGINS"] = "true"
    if benchmark == "osworld" and no_docker and not smoke:
        env_overrides["OSWORLD_NO_DOCKER_REQUESTED"] = "1"
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
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
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

    has_item_failure = any(item.get("success") is False for item in items) or _text_has(statuses, "failed")
    total = outcome.get("total")
    wrong = outcome.get("wrong")
    has_partial_outcome = (
        exit_code == 0
        and (
            (isinstance(accuracy, (int, float)) and accuracy < 1.0)
            or (isinstance(wrong, (int, float)) and wrong > 0)
            or (
                isinstance(total, (int, float))
                and total > 0
                and isinstance(score, (int, float))
                and score < 1.0
            )
        )
    )
    if exit_code == 0 and (has_item_failure or has_partial_outcome):
        notes.append("benchmark item failures reported")
        return "tests_failed", notes

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
        total = _metric_number(summary, "total_instances", "total_tasks", "total", "sample_count")
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

    total = _metric_number(payload, "total_tasks", "total_trials", "total_instances", "total", "sample_count")
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


def collect_payload_token_metrics(payload: Any) -> dict[str, int | float | None]:
    if not isinstance(payload, dict):
        return {}
    source = payload.get("token_metrics")
    if not isinstance(source, dict):
        source = payload.get("summary") if isinstance(payload.get("summary"), dict) else payload
    if not isinstance(source, dict):
        return {}
    input_tokens = _metric_number(source, "input_tokens", "prompt_tokens", "promptTokens", "input")
    output_tokens = _metric_number(
        source,
        "output_tokens",
        "completion_tokens",
        "completionTokens",
        "output",
    )
    total_tokens = _metric_number(source, "total_tokens", "totalTokens", "total")
    cached_tokens = _metric_number(
        source,
        "cached_tokens",
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cachedTokens",
    )
    cache_creation_tokens = _metric_number(
        source,
        "cache_creation_tokens",
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
    )
    llm_call_count = _metric_number(source, "llm_call_count", "llmCallCount")
    if not any(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in (
            input_tokens,
            output_tokens,
            total_tokens,
            cached_tokens,
            cache_creation_tokens,
            llm_call_count,
        )
    ):
        return {}
    if total_tokens is None and isinstance(input_tokens, (int, float)) and isinstance(
        output_tokens, (int, float)
    ):
        total_tokens = input_tokens + output_tokens
    cached_percent = _metric_number(source, "cached_token_percent")
    if (
        cached_percent is None
        and isinstance(input_tokens, (int, float))
        and input_tokens
        and isinstance(cached_tokens, (int, float))
    ):
        cached_percent = cached_tokens / input_tokens * 100.0
    return {
        "input_tokens": input_tokens if input_tokens is not None else 0,
        "output_tokens": output_tokens if output_tokens is not None else 0,
        "total_tokens": total_tokens if total_tokens is not None else 0,
        "cached_tokens": cached_tokens if cached_tokens is not None else 0,
        "cache_creation_tokens": cache_creation_tokens if cache_creation_tokens is not None else 0,
        "cached_token_percent": cached_percent,
        "llm_call_count": llm_call_count if llm_call_count is not None else 0,
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
            "env_overrides": {
                key: redact_text(value, redaction_env)
                for key, value in cell.env_overrides.items()
            },
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
            command_path=payload.get("command_path") or str(_cell_root(cell) / "command.json"),
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
        command_path=str(_cell_root(cell) / "command.json"),
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
    payload_token_metrics = collect_payload_token_metrics(payload)
    if payload_token_metrics and not token_metrics.get("llm_call_count") and not token_metrics.get("total_tokens"):
        token_metrics.update(payload_token_metrics)
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
        cached_percent = metrics.get("cached_token_percent")
        has_files = isinstance(files, (int, float)) and not isinstance(files, bool) and files > 0
        has_calls = isinstance(calls, (int, float)) and not isinstance(calls, bool) and calls > 0
        has_tokens = any(
            isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
            for value in (total_tokens, input_tokens, output_tokens)
        )
        has_cached_percent = (
            isinstance(cached_percent, (int, float))
            and not isinstance(cached_percent, bool)
        )
        if has_calls and has_tokens and has_cached_percent:
            status = "present"
            note = "LLM call, token, and cache telemetry found"
        elif has_calls and has_tokens:
            status = "empty"
            note = "LLM token telemetry found but cached-token percentage is missing"
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
                "cached_token_percent": cached_percent,
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


def build_repo_local_coverage_audit(benchmarks_dir: Path | None = None) -> dict[str, Any]:
    if benchmarks_dir is None:
        benchmarks_dir = benchmarks_root(workspace_root())
    status_by_id = coverage_status_by_id()
    directories: list[dict[str, Any]] = []
    missing_manifest: list[dict[str, Any]] = []
    missing_directories: list[dict[str, Any]] = []
    for item in repo_local_related_benchmark_dirs():
        status = status_by_id.get(item.benchmark_id)
        path = benchmarks_dir / item.directory
        exists = path.exists()
        row = {
            "benchmark": item.benchmark_id,
            "directory": item.directory,
            "exists": exists,
            "domains": list(item.domains),
            "manifest_status": status.status if status else None,
        }
        directories.append(row)
        if exists and status is None:
            missing_manifest.append(row)
        if not exists and status is not None:
            missing_directories.append(row)
    return {
        "ok": not missing_manifest,
        "benchmarks_dir": str(benchmarks_dir),
        "directory_count": len(directories),
        "existing_directory_count": sum(1 for item in directories if item["exists"]),
        "manifest_complete": not missing_manifest,
        "missing_manifest_directories": missing_manifest,
        "missing_directory_entries": missing_directories,
        "directories": directories,
        "message": (
            "all audited repo-local related benchmark directories are represented in coverage"
            if not missing_manifest
            else "some audited repo-local related benchmark directories are missing coverage entries"
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
            "promotion_requirements": list(item.promotion_requirements),
            "promotion_priority": item.promotion_priority,
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
        "repo_local_audit": build_repo_local_coverage_audit(),
        "message": (
            "all included code-agent benchmarks are selected"
            if not unselected_included
            else "some included code-agent benchmarks were not selected for this run"
        ),
    }


def build_deferred_promotion_queue(summary: dict[str, Any]) -> list[dict[str, Any]]:
    coverage = summary.get("coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    deferred = coverage.get("deferred_benchmarks")
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    queue: list[dict[str, Any]] = []
    for item in deferred if isinstance(deferred, list) else []:
        if not isinstance(item, dict):
            continue
        benchmark = str(item.get("benchmark") or "")
        requirements = [
            str(requirement)
            for requirement in item.get("promotion_requirements") or []
            if str(requirement)
        ]
        queue.append(
            {
                "priority": str(item.get("promotion_priority") or "p2"),
                "benchmark": benchmark,
                "domains": item.get("domains") or [],
                "next_action": requirements[0] if requirements else item.get("reason", ""),
                "remaining_requirements": requirements,
                "remaining_count": len(requirements),
                "evidence_command_template": (
                    _deferred_promotion_evidence_command(
                        benchmark=benchmark,
                        run_config=run_config,
                    )
                    if benchmark in RUNNABLE_DEFERRED_BENCHMARKS
                    else ""
                ),
            }
        )
    queue.sort(
        key=lambda item: (
            str(item.get("priority") or "p2"),
            str(item.get("benchmark") or ""),
        )
    )
    return queue


def _deferred_promotion_evidence_command(
    *,
    benchmark: str,
    run_config: dict[str, Any] | None = None,
) -> str:
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        benchmark,
        "--adapters",
        ",".join(DEFAULT_ADAPTERS),
    ]
    if isinstance(run_config, dict):
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
        run_root = run_config.get("run_root")
        if run_root:
            parts.extend(["--run-root", str(run_root)])
        publish_latest_dir = run_config.get("publish_latest_dir")
        if publish_latest_dir:
            parts.extend(["--publish-latest-dir", str(publish_latest_dir)])
    parts.extend(
        [
            "--force",
            "--enforce-live-report",
            "--enforce-trajectory-reviews",
            "--enforce-report",
            "--enforce-comparable",
            "--enforce-required-stats",
            "--enforce-token-evidence",
            "--enforce-efficiency",
        ]
    )
    return _command_template(_with_swe_bench_pro_env(parts, run_config))


def build_coverage_gate(summary: dict[str, Any]) -> dict[str, Any]:
    coverage = summary.get("coverage")
    if not isinstance(coverage, dict):
        return {
            "ok": False,
            "blocking_benchmarks": [],
            "message": "benchmark coverage summary is missing",
        }
    blocking = list(coverage.get("unselected_included_benchmarks") or [])
    audit = coverage.get("repo_local_audit")
    audit = audit if isinstance(audit, dict) else {}
    missing_manifest = [
        str(item.get("directory") or item.get("benchmark") or "")
        for item in audit.get("missing_manifest_directories", [])
        if isinstance(item, dict)
    ]
    return {
        "ok": bool(coverage.get("selection_complete")) and not missing_manifest,
        "required": "all included code-agent benchmarks selected",
        "blocking_benchmarks": sorted(str(item) for item in blocking),
        "missing_manifest_directories": sorted(item for item in missing_manifest if item),
        "deferred_benchmarks": [
            item.get("benchmark")
            for item in coverage.get("deferred_benchmarks", [])
            if isinstance(item, dict)
        ],
        "message": (
            "repo-local related benchmark directories are missing coverage entries"
            if missing_manifest
            else (
                "all included code-agent benchmarks are selected"
                if coverage.get("selection_complete")
                else "not all included code-agent benchmarks are selected"
            )
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


def build_efficiency_queue(
    head_to_head: dict[str, Any],
    *,
    run_config: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
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
                "rerun_command_template": _efficiency_rerun_command_template(
                    benchmark=str(row.get("benchmark") or ""),
                    run_config=run_config,
                ),
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


def _numeric_delta(left: Any, right: Any) -> float | None:
    if (
        isinstance(left, (int, float))
        and not isinstance(left, bool)
        and isinstance(right, (int, float))
        and not isinstance(right, bool)
    ):
        return float(left) - float(right)
    return None


def _trajectory_delta(
    target_review: dict[str, Any],
    baseline_review: dict[str, Any],
) -> dict[str, float | None]:
    return {
        "turn_delta": _numeric_delta(target_review.get("turns"), baseline_review.get("turns")),
        "input_token_delta": _numeric_delta(
            target_review.get("input_tokens"),
            baseline_review.get("input_tokens"),
        ),
        "output_token_delta": _numeric_delta(
            target_review.get("output_tokens"),
            baseline_review.get("output_tokens"),
        ),
        "total_token_delta": _numeric_delta(
            target_review.get("total_tokens"),
            baseline_review.get("total_tokens"),
        ),
        "cached_token_percent_delta": _numeric_delta(
            target_review.get("cached_token_percent"),
            baseline_review.get("cached_token_percent"),
        ),
        "repeated_prefix_delta": _numeric_delta(
            target_review.get("repeated_prefix_count"),
            baseline_review.get("repeated_prefix_count"),
        ),
        "mean_latency_ms_delta": _numeric_delta(
            target_review.get("mean_latency_ms"),
            baseline_review.get("mean_latency_ms"),
        ),
        "p95_latency_ms_delta": _numeric_delta(
            target_review.get("p95_latency_ms"),
            baseline_review.get("p95_latency_ms"),
        ),
    }


def _improvement_focus(
    *,
    diagnosis: list[str],
    trajectory_delta: dict[str, float | None],
) -> list[str]:
    focus: list[str] = []
    if any("accuracy is below" in item for item in diagnosis):
        focus.append("inspect failed tasks and patch ElizaOS task strategy")
    if any("failure class" in item for item in diagnosis):
        focus.append("fix target harness/runtime failure before tuning prompts")
    if any("trajectory telemetry is missing" in item for item in diagnosis):
        focus.append("restore trajectory capture for comparable review evidence")
    if (trajectory_delta.get("repeated_prefix_delta") or 0) > 0:
        focus.append("remove repeated prompt-prefix churn")
    if (trajectory_delta.get("total_token_delta") or 0) > 0:
        focus.append("reduce trajectory token load versus baseline")
    if any("more total tokens" in item or "more LLM calls" in item for item in diagnosis):
        focus.append("reduce extra LLM calls/tokens")
    if any("cached-token percentage" in item for item in diagnosis):
        focus.append("improve cacheable prompt structure")
    return list(dict.fromkeys(focus))


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
        trajectory_delta = _trajectory_delta(target_review, baseline_review)
        priority = "p0" if status in {"inferior", "weak"} else "p1"
        queue.append(
            {
                "benchmark": benchmark,
                "status": status,
                "priority": priority,
                "diagnosis": diagnosis,
                "primary_diagnosis": diagnosis[0] if diagnosis else "",
                "suggested_focus": _improvement_focus(
                    diagnosis=diagnosis,
                    trajectory_delta=trajectory_delta,
                ),
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
                "trajectory_delta": trajectory_delta,
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
    run_root = run_config.get("run_root")
    if run_root:
        parts.extend(["--run-root", str(run_root)])
    publish_latest_dir = run_config.get("publish_latest_dir")
    if publish_latest_dir:
        parts.extend(["--publish-latest-dir", str(publish_latest_dir)])
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


def _swe_bench_pro_env_assignments(config: dict[str, Any] | None = None) -> list[str]:
    config = config if isinstance(config, dict) else {}
    backend = (
        config.get("swe_bench_pro_evaluator_backend")
        or config.get("SWE_BENCH_PRO_EVALUATOR_BACKEND")
        or ""
    )
    workers = (
        config.get("swe_bench_pro_eval_num_workers")
        or config.get("SWE_BENCH_PRO_EVAL_NUM_WORKERS")
        or ""
    )
    assignments: list[str] = []
    if str(backend).strip():
        assignments.append(f"SWE_BENCH_PRO_EVALUATOR_BACKEND={str(backend).strip()}")
    if str(workers).strip():
        assignments.append(f"SWE_BENCH_PRO_EVAL_NUM_WORKERS={str(workers).strip()}")
    return assignments


def _with_swe_bench_pro_env(
    parts: list[str],
    config: dict[str, Any] | None = None,
) -> list[str]:
    return [*_swe_bench_pro_env_assignments(config), *parts]


def _command_template(parts: list[str]) -> str:
    return " ".join(part if part == "{summary_json}" else shlex.quote(part) for part in parts)


def _selected_scope_args(cell_pairs: tuple[tuple[str, str], ...]) -> list[str]:
    benchmarks = ",".join(sorted({benchmark for benchmark, _adapter in cell_pairs}))
    adapters = ",".join(sorted({adapter for _benchmark, adapter in cell_pairs}))
    return ["--benchmarks", benchmarks, "--adapters", adapters]


def _release_scope_args(cell_pairs: tuple[tuple[str, str], ...]) -> list[str]:
    del cell_pairs
    adapters = ",".join(DEFAULT_ADAPTERS)
    return ["--benchmarks", ",".join(sorted(DEFAULT_BENCHMARKS)), "--adapters", adapters]


def _preflight_next_commands(
    *,
    args: argparse.Namespace,
    run_root: Path,
    cell_pairs: tuple[tuple[str, str], ...],
) -> dict[str, str]:
    swe_bench_pro_env = {
        "SWE_BENCH_PRO_EVALUATOR_BACKEND": os.environ.get("SWE_BENCH_PRO_EVALUATOR_BACKEND", ""),
        "SWE_BENCH_PRO_EVAL_NUM_WORKERS": os.environ.get("SWE_BENCH_PRO_EVAL_NUM_WORKERS", ""),
    }
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
    base = _with_swe_bench_pro_env(base, swe_bench_pro_env)
    if args.publish_latest_dir:
        base.extend(["--publish-latest-dir", str(args.publish_latest_dir)])
    preflight = [*base, "--preflight"]
    release_base = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        *_release_scope_args(cell_pairs),
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
    release_base = _with_swe_bench_pro_env(release_base, swe_bench_pro_env)
    if args.publish_latest_dir:
        release_base.extend(["--publish-latest-dir", str(args.publish_latest_dir)])
    quality_guardrail_summary = str(
        args.quality_guardrail_summary
        or "/path/to/non-code-quality-guardrail.json"
    )
    live = [
        *base,
        "--force",
        "--enforce-live-report",
        "--enforce-trajectory-reviews",
        "--enforce-report",
        "--enforce-coverage",
        "--enforce-comparable",
        "--enforce-required-stats",
        "--enforce-token-evidence",
        "--enforce-efficiency",
        "--enforce-release-readiness",
    ]
    if args.no_docker:
        preflight.append("--no-docker")
        live.append("--no-docker")
    release_preflight = [
        *release_base,
        "--quality-guardrail-summary",
        quality_guardrail_summary,
        "--preflight",
        "--enforce-release-readiness",
    ]
    release = [
        *release_base,
        "--force",
        "--enforce-live-report",
        "--enforce-trajectory-reviews",
        "--enforce-report",
        "--enforce-coverage",
        "--enforce-comparable",
        "--enforce-required-stats",
        "--enforce-token-evidence",
        "--enforce-efficiency",
        "--quality-guardrail-summary",
        quality_guardrail_summary,
        "--enforce-quality-guardrail",
        "--enforce-release-readiness",
    ]
    deferred_base = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        ",".join(sorted(RUNNABLE_DEFERRED_BENCHMARKS)),
        "--adapters",
        ",".join(DEFAULT_ADAPTERS),
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
    deferred_base = _with_swe_bench_pro_env(deferred_base, swe_bench_pro_env)
    if args.publish_latest_dir:
        deferred_base.extend(["--publish-latest-dir", str(args.publish_latest_dir)])
    deferred_live = [
        *deferred_base,
        "--force",
        "--enforce-live-report",
        "--enforce-trajectory-reviews",
        "--enforce-report",
        "--enforce-comparable",
        "--enforce-required-stats",
        "--enforce-token-evidence",
        "--enforce-efficiency",
    ]
    return {
        "retry_preflight": _command_template(preflight),
        "live_evidence": _command_template(live),
        "deferred_live_evidence": _command_template(deferred_live),
        "release_preflight": _command_template(release_preflight),
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
    return _command_template(_with_swe_bench_pro_env(parts, summary.get("run_config")))


def _efficiency_rerun_command_template(
    *,
    benchmark: str,
    run_config: dict[str, Any] | None = None,
) -> str:
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        benchmark,
        "--adapters",
        ",".join(DEFAULT_ADAPTERS),
    ]
    _append_config_args(parts, run_config)
    parts.extend(["--force", "--enforce-required-stats", "--enforce-efficiency"])
    return _command_template(_with_swe_bench_pro_env(parts, run_config))


def _trajectory_rerun_command_template(
    summary: dict[str, Any],
    *,
    benchmark: str,
    adapter: str,
) -> str:
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        benchmark,
        "--adapters",
        adapter,
    ]
    _append_config_args(parts, summary.get("run_config"))
    parts.extend(["--force", "--enforce-trajectory-reviews", "--enforce-required-stats"])
    return _command_template(_with_swe_bench_pro_env(parts, summary.get("run_config")))


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
    return _command_template(_with_swe_bench_pro_env(parts, run_config))


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
    validation_issues = _quality_guardrail_summary_validation(guardrail_summary)
    ok_value = guardrail_summary.get("ok")
    ok = not validation_issues and bool(ok_value) and not findings
    normalized_findings = [
        finding
        for finding in findings
        if isinstance(finding, dict)
    ]
    normalized_findings.extend(
        {
            "scope": "quality_guardrail_summary",
            "reason": "invalid_quality_guardrail_summary",
            "value": issue,
        }
        for issue in validation_issues
    )
    return {
        "ok": ok,
        "enforced": enforced,
        "summary_path": summary_path,
        "latest_dir": guardrail_summary.get("latest_dir"),
        "tolerance": guardrail_summary.get("tolerance"),
        "findings": normalized_findings,
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
                "rerun_command_template": _trajectory_rerun_command_template(
                    summary,
                    benchmark=str(cell.get("benchmark") or ""),
                    adapter=str(cell.get("adapter") or ""),
                ),
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


def _gate_value(summary: dict[str, Any], key: str) -> dict[str, Any]:
    gate = summary.get(key)
    return gate if isinstance(gate, dict) else {}


def _release_command_scope(summary: dict[str, Any]) -> tuple[list[str], list[str]]:
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    coverage = summary.get("coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    included = [
        str(item.get("benchmark"))
        for item in coverage.get("included_benchmarks", [])
        if isinstance(item, dict) and item.get("benchmark")
    ]
    benchmarks = sorted(set(included))
    if not benchmarks:
        benchmarks = sorted(str(item) for item in run_config.get("benchmarks") or [])
    if not benchmarks:
        benchmarks = list(DEFAULT_BENCHMARKS)

    adapters = list(DEFAULT_ADAPTERS)
    return benchmarks, adapters


def _release_base_command(summary: dict[str, Any]) -> list[str]:
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    benchmarks, adapters = _release_command_scope(summary)
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        ",".join(benchmarks),
        "--adapters",
        ",".join(adapters),
    ]
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
    run_root = run_config.get("run_root")
    if run_root:
        parts.extend(["--run-root", str(run_root)])
    publish_latest_dir = run_config.get("publish_latest_dir")
    if publish_latest_dir:
        parts.extend(["--publish-latest-dir", str(publish_latest_dir)])
    return _with_swe_bench_pro_env(parts, run_config)


def _deferred_benchmarks_from_summary(summary: dict[str, Any]) -> list[str]:
    queue = summary.get("deferred_promotion_queue")
    queue = queue if isinstance(queue, list) else []
    return [
        str(item.get("benchmark"))
        for item in queue
        if isinstance(item, dict) and item.get("benchmark")
    ]


def _release_base_command_for_benchmarks(
    summary: dict[str, Any],
    benchmarks: list[str],
) -> list[str]:
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    _, adapters = _release_command_scope(summary)
    parts = [
        "python",
        "-m",
        "benchmarks.orchestrator.code_agent_matrix",
        "--benchmarks",
        ",".join(benchmarks),
        "--adapters",
        ",".join(adapters),
    ]
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
    run_root = run_config.get("run_root")
    if run_root:
        parts.extend(["--run-root", str(run_root)])
    publish_latest_dir = run_config.get("publish_latest_dir")
    if publish_latest_dir:
        parts.extend(["--publish-latest-dir", str(publish_latest_dir)])
    return _with_swe_bench_pro_env(parts, run_config)


def build_release_unblock_commands(
    summary: dict[str, Any],
    blocking_requirements: list[str],
) -> list[dict[str, Any]]:
    """Build rerun templates for release-readiness blockers."""

    blocking = set(blocking_requirements)
    commands: list[dict[str, Any]] = []
    evidence_requirements = {
        "live_execution",
        "full_included_coverage",
        "comparable_or_better",
        "right_wrong_token_stats",
        "llm_token_telemetry",
        "trajectory_reviews",
        "efficiency_not_worse",
    }
    if blocking & evidence_requirements:
        parts = [
            *_release_base_command(summary),
            "--force",
            "--enforce-live-report",
            "--enforce-trajectory-reviews",
            "--enforce-report",
            "--enforce-coverage",
            "--enforce-comparable",
            "--enforce-required-stats",
            "--enforce-token-evidence",
            "--enforce-efficiency",
            "--enforce-release-readiness",
        ]
        commands.append(
            {
                "id": "run_full_live_evidence",
                "requirements": sorted(blocking & evidence_requirements),
                "command_template": _command_template(parts),
            }
        )

    if "all_related_benchmark_coverage" in blocking:
        runnable_deferred = [
            benchmark
            for benchmark in _deferred_benchmarks_from_summary(summary)
            if benchmark in RUNNABLE_DEFERRED_BENCHMARKS
        ]
        if runnable_deferred:
            commands.append(
                {
                    "id": "run_deferred_live_evidence",
                    "requirements": ["all_related_benchmark_coverage"],
                    "command_template": _command_template(
                        [
                            *_release_base_command_for_benchmarks(summary, runnable_deferred),
                            "--force",
                            "--enforce-live-report",
                            "--enforce-trajectory-reviews",
                            "--enforce-report",
                            "--enforce-comparable",
                            "--enforce-required-stats",
                            "--enforce-token-evidence",
                            "--enforce-efficiency",
                        ]
                    ),
                }
            )
        commands.append(
            {
                "id": "promote_deferred_benchmarks",
                "requirements": ["all_related_benchmark_coverage"],
                "command_template": _command_template(
                    [
                        "python",
                        "-m",
                        "benchmarks.orchestrator.code_agent_matrix",
                        "--summarize",
                        "{summary_json}",
                    ]
                ),
            }
        )

    if "non_code_quality_guardrail" in blocking:
        parts = [
            *_release_base_command(summary),
            "--force",
            "--quality-guardrail-summary",
            "/path/to/non-code-quality-guardrail.json",
            "--enforce-quality-guardrail",
            "--enforce-report",
            "--enforce-release-readiness",
        ]
        commands.append(
            {
                "id": "attach_non_code_quality_guardrail",
                "requirements": ["non_code_quality_guardrail"],
                "command_template": _command_template(parts),
            }
        )

    if "longitudinal_no_regression" in blocking:
        parts = [
            *_release_base_command(summary),
            "--force",
            "--compare-summary",
            "/path/to/previous/summary.json",
            "--enforce-no-regression",
            "--enforce-report",
            "--enforce-release-readiness",
        ]
        commands.append(
            {
                "id": "compare_previous_summary",
                "requirements": ["longitudinal_no_regression"],
                "command_template": _command_template(parts),
            }
        )
    return commands


def build_release_readiness(summary: dict[str, Any]) -> dict[str, Any]:
    """Translate matrix gates into the user-facing release checklist."""

    live_gate = _gate_value(summary, "live_report_gate")
    coverage_gate = _gate_value(summary, "coverage_gate")
    benchmark_gate = _gate_value(summary, "benchmark_gate")
    required_stats_gate = _gate_value(summary, "required_stats_gate")
    token_evidence = _gate_value(summary, "token_evidence")
    trajectory_gate = _gate_value(summary, "trajectory_review_gate")
    efficiency_gate = _gate_value(summary, "efficiency_gate")
    quality_gate = _gate_value(summary, "quality_guardrail_gate")
    no_regression_gate = _gate_value(summary, "no_regression_gate")
    previous_comparison = summary.get("previous_summary_comparison")
    deferred_queue = summary.get("deferred_promotion_queue")
    deferred_queue = deferred_queue if isinstance(deferred_queue, list) else []
    deferred_benchmarks = [
        str(item.get("benchmark") or "")
        for item in deferred_queue
        if isinstance(item, dict) and item.get("benchmark")
    ]
    has_quality_summary = bool(
        quality_gate.get("summary_path") or quality_gate.get("latest_dir")
    )
    has_previous_comparison = isinstance(previous_comparison, dict)

    checks = [
        {
            "id": "live_execution",
            "required": True,
            "ok": bool(live_gate.get("ok")),
            "evidence": live_gate.get("message", ""),
            "next_action": "run without --smoke/--dry-run and enforce --enforce-live-report",
        },
        {
            "id": "full_included_coverage",
            "required": True,
            "ok": bool(coverage_gate.get("ok")),
            "evidence": coverage_gate.get("message", ""),
            "next_action": "select every included code-agent benchmark",
        },
        {
            "id": "all_related_benchmark_coverage",
            "required": True,
            "ok": not deferred_benchmarks,
            "evidence": (
                "no deferred related benchmarks remain"
                if not deferred_benchmarks
                else f"deferred related benchmarks remain: {', '.join(deferred_benchmarks)}"
            ),
            "next_action": "promote deferred related benchmarks into the release-comparable matrix",
        },
        {
            "id": "comparable_or_better",
            "required": True,
            "ok": bool(benchmark_gate.get("ok")),
            "evidence": benchmark_gate.get("message", ""),
            "next_action": "review improvement_queue and improve ElizaOS on blocking benchmarks",
        },
        {
            "id": "right_wrong_token_stats",
            "required": True,
            "ok": bool(required_stats_gate.get("ok")),
            "evidence": required_stats_gate.get("message", ""),
            "next_action": "rerun blocking cells until right/wrong/total and token stats are present",
        },
        {
            "id": "llm_token_telemetry",
            "required": True,
            "ok": bool(token_evidence.get("ok")),
            "evidence": token_evidence.get("message", ""),
            "next_action": "enable trajectory/token capture for every selected cell",
        },
        {
            "id": "trajectory_reviews",
            "required": True,
            "ok": bool(trajectory_gate.get("ok")),
            "evidence": trajectory_gate.get("message", ""),
            "next_action": "run with --enforce-trajectory-reviews and inspect trajectory artifacts",
        },
        {
            "id": "efficiency_not_worse",
            "required": True,
            "ok": bool(efficiency_gate.get("ok")),
            "evidence": efficiency_gate.get("message", ""),
            "next_action": "reduce extra token/call cost or improve cache behavior versus OpenCode",
        },
        {
            "id": "non_code_quality_guardrail",
            "required": True,
            "ok": bool(quality_gate.get("ok")) and has_quality_summary,
            "evidence": quality_gate.get("message", ""),
            "next_action": (
                "generate non-code guardrail JSON with "
                "`{command}` and pass it with --quality-guardrail-summary"
            ).format(command=NON_CODE_GUARDRAIL_COMMAND),
        },
        {
            "id": "longitudinal_no_regression",
            "required": bool(has_previous_comparison or no_regression_gate.get("enforced")),
            "ok": bool(no_regression_gate.get("ok")) and (
                has_previous_comparison or not no_regression_gate.get("enforced")
            ),
            "evidence": no_regression_gate.get("message", ""),
            "next_action": "compare against the previous summary with --compare-summary",
        },
    ]
    required_checks = [check for check in checks if check["required"]]
    blocking = [
        str(check["id"])
        for check in required_checks
        if not check["ok"]
    ]
    unblock_commands = build_release_unblock_commands(summary, blocking)
    return {
        "ok": not blocking,
        "blocking_requirements": blocking,
        "required_count": len(required_checks),
        "passed_required_count": len(required_checks) - len(blocking),
        "checks": checks,
        "unblock_commands": unblock_commands,
        "message": (
            "release readiness checklist passed"
            if not blocking
            else "release readiness checklist is incomplete"
        ),
    }


def build_report_rows(summary: dict[str, Any]) -> list[dict[str, Any]]:
    """Build stable flat rows for longitudinal benchmark reporting."""
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    generated_at = summary.get("generated_at")
    cell_rows = summary.get("cells")
    cells_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for cell in cell_rows if isinstance(cell_rows, list) else []:
        if not isinstance(cell, dict):
            continue
        benchmark = cell.get("benchmark")
        adapter = cell.get("adapter")
        if isinstance(benchmark, str) and isinstance(adapter, str):
            cells_by_key[(benchmark, adapter)] = cell
    rows: list[dict[str, Any]] = []
    comparisons = summary.get("head_to_head", {}).get("comparisons")
    for comparison in comparisons if isinstance(comparisons, list) else []:
        if not isinstance(comparison, dict):
            continue
        benchmark = comparison.get("benchmark")
        target_adapter = comparison.get("target_adapter")
        baseline_adapter = comparison.get("baseline_adapter")
        target_cell = (
            cells_by_key.get((benchmark, target_adapter))
            if isinstance(benchmark, str) and isinstance(target_adapter, str)
            else None
        )
        baseline_cell = (
            cells_by_key.get((benchmark, baseline_adapter))
            if isinstance(benchmark, str) and isinstance(baseline_adapter, str)
            else None
        )
        row = {
            "generated_at": generated_at,
            "run_root": run_config.get("run_root"),
            "mode": run_config.get("mode"),
            "provider": run_config.get("provider"),
            "model": run_config.get("model"),
            "benchmark": benchmark,
            "status": comparison.get("status"),
            "target_adapter": target_adapter,
            "baseline_adapter": baseline_adapter,
            "target_failure_class": _cell_value(target_cell, "failure_class"),
            "baseline_failure_class": _cell_value(baseline_cell, "failure_class"),
            "target_result_path": _cell_value(target_cell, "result_path"),
            "baseline_result_path": _cell_value(baseline_cell, "result_path"),
            "target_command_path": _cell_value(target_cell, "command_path"),
            "baseline_command_path": _cell_value(baseline_cell, "command_path"),
            "target_trajectory_dir": _cell_trajectory_dir(target_cell),
            "baseline_trajectory_dir": _cell_trajectory_dir(baseline_cell),
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
            "release_readiness_ok": _gate_ok(summary, "release_readiness"),
            "release_readiness_blocking_requirements": _release_readiness_csv_value(
                summary,
                "blocking_requirements",
            ),
            "release_readiness_unblock_command_ids": _release_readiness_unblock_ids(
                summary
            ),
        }
        rows.append({field: row.get(field) for field in REPORT_ROW_FIELDS})
    return rows


def _cell_value(cell: dict[str, Any] | None, key: str) -> Any:
    if not isinstance(cell, dict):
        return None
    return cell.get(key)


def _cell_trajectory_dir(cell: dict[str, Any] | None) -> str | None:
    if not isinstance(cell, dict):
        return None
    output_dir = cell.get("output_dir")
    if not isinstance(output_dir, str) or not output_dir:
        return None
    return str(Path(output_dir).parent / "trajectories")


def _release_readiness_csv_value(summary: dict[str, Any], key: str) -> str:
    release_readiness = summary.get("release_readiness")
    if not isinstance(release_readiness, dict):
        return ""
    value = release_readiness.get(key)
    if not isinstance(value, list):
        return ""
    return ",".join(str(item) for item in value if str(item))


def _release_readiness_unblock_ids(summary: dict[str, Any]) -> str:
    release_readiness = summary.get("release_readiness")
    if not isinstance(release_readiness, dict):
        return ""
    commands = release_readiness.get("unblock_commands")
    if not isinstance(commands, list):
        return ""
    return ",".join(
        str(command.get("id"))
        for command in commands
        if isinstance(command, dict) and command.get("id")
    )


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


def _read_text_tail(path: Path | None, *, max_chars: int = 80_000) -> str:
    if path is None or not path.exists() or not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if len(text) <= max_chars:
        return text
    return f"[truncated to last {max_chars} chars]\n{text[-max_chars:]}"


def _load_json_artifact(path: Path | None) -> Any:
    if path is None or not path.exists() or not path.is_file():
        return None
    if path.suffix.lower() == ".jsonl":
        rows: list[Any] = []
        try:
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    rows.append({"_raw": line})
        except OSError:
            return None
        return rows
    return read_json(path)


def _relative_to_run_root(path: Path, run_root: Path) -> str:
    try:
        return str(path.relative_to(run_root))
    except ValueError:
        return str(path)


def _collect_viewer_trajectory_files(
    trajectory_dir: Path,
    *,
    run_root: Path,
) -> list[dict[str, Any]]:
    if not trajectory_dir.exists():
        return []
    files: list[dict[str, Any]] = []
    for path in sorted(trajectory_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".json", ".jsonl"}:
            continue
        payload = _load_json_artifact(path)
        files.append(
            {
                "path": _relative_to_run_root(path, run_root),
                "kind": "jsonl" if path.suffix.lower() == ".jsonl" else "json",
                "entries": payload if isinstance(payload, list) else None,
                "payload": payload if not isinstance(payload, list) else None,
            }
        )
    return files


def _collect_viewer_output_trajectory_files(
    output_dir: Path,
    *,
    run_root: Path,
    existing_paths: set[str],
) -> list[dict[str, Any]]:
    if not output_dir.exists():
        return []
    files: list[dict[str, Any]] = []
    for path in sorted(output_dir.rglob("*.jsonl")):
        relative_path = _relative_to_run_root(path, run_root)
        if relative_path in existing_paths:
            continue
        name = path.name.lower()
        if "traj" not in name and "telemetry" not in name:
            continue
        payload = _load_json_artifact(path)
        files.append(
            {
                "path": relative_path,
                "kind": "jsonl",
                "entries": payload if isinstance(payload, list) else None,
                "payload": payload if not isinstance(payload, list) else None,
            }
        )
    return files


def _collect_viewer_output_artifacts(
    output_dir: Path,
    *,
    run_root: Path,
    limit: int = 80,
) -> list[dict[str, Any]]:
    if not output_dir.exists():
        return []
    artifacts: list[dict[str, Any]] = []
    text_suffixes = {".json", ".jsonl", ".md", ".txt", ".log", ".patch", ".diff", ".html", ".csv", ".tsv"}
    binary_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".zip", ".tar", ".gz"}
    for path in sorted(output_dir.rglob("*")):
        if not path.is_file():
            continue
        suffix = path.suffix.lower()
        if suffix not in text_suffixes | binary_suffixes:
            continue
        row: dict[str, Any] = {
            "path": _relative_to_run_root(path, run_root),
            "size_bytes": path.stat().st_size,
        }
        if suffix in {".json", ".jsonl"}:
            row["payload"] = _load_json_artifact(path)
        else:
            row["text"] = _read_text_tail(path, max_chars=40_000)
        artifacts.append(row)
        if len(artifacts) >= limit:
            break
    return artifacts


def _first_string_value(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, int | float) and not isinstance(value, bool):
            return str(value)
    return ""


def _viewer_task_id(item: dict[str, Any], index: int) -> str:
    task_id = _first_string_value(
        item,
        "task_id",
        "taskId",
        "id",
        "instance_id",
        "instanceId",
        "sample_id",
        "sampleId",
        "problem_id",
        "problemId",
        "annotation_id",
        "name",
    )
    return task_id or f"task-{index + 1}"


def _viewer_task_status(item: dict[str, Any]) -> str:
    status = _first_string_value(item, "status", "patch_status", "result")
    if status:
        return status
    success = item.get("success")
    if isinstance(success, bool):
        return "passed" if success else "failed"
    passed = item.get("passed")
    if isinstance(passed, bool):
        return "passed" if passed else "failed"
    resolved = item.get("resolved")
    if isinstance(resolved, bool):
        return "passed" if resolved else "failed"
    score = _metric_number(item, "score", "reward", "accuracy", "step_accuracy")
    if score is not None:
        return "passed" if float(score) >= 1.0 else "failed"
    return ""


def _viewer_task_score(item: dict[str, Any]) -> int | float | None:
    return _metric_number(
        item,
        "score",
        "reward",
        "accuracy",
        "step_accuracy",
        "element_accuracy",
        "operation_accuracy",
    )


def _viewer_task_error(item: dict[str, Any]) -> str:
    return _first_string_value(
        item,
        "error",
        "error_message",
        "failure",
        "message",
        "reason",
    )


def _entry_matches_task(entry: Any, task_id: str) -> bool:
    if not task_id:
        return False
    needle = task_id.lower()
    try:
        haystack = json.dumps(entry, ensure_ascii=True, sort_keys=True).lower()
    except (TypeError, ValueError):
        haystack = str(entry).lower()
    return needle in haystack


def _trajectory_usage_totals(entries: list[Any]) -> dict[str, int]:
    totals = {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "cached_tokens": 0,
    }

    def number_from(payload: Any, *keys: str) -> int:
        if not isinstance(payload, dict):
            return 0
        for key in keys:
            value = payload.get(key)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return int(value)
        return 0

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        usage = entry.get("usage")
        if not isinstance(usage, dict):
            response = entry.get("response")
            usage = response.get("usage") if isinstance(response, dict) else {}
        if not isinstance(usage, dict):
            usage = {}
        totals["prompt_tokens"] += number_from(usage, "prompt_tokens", "promptTokens", "input_tokens", "inputTokens")
        totals["completion_tokens"] += number_from(usage, "completion_tokens", "completionTokens", "output_tokens", "outputTokens")
        totals["total_tokens"] += number_from(usage, "total_tokens", "totalTokens", "total")
        totals["cached_tokens"] += number_from(
            usage,
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_tokens",
            "cachedTokens",
        )
    return totals


def _build_viewer_task_diagnostics(
    result_payload: Any,
    trajectory_files: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    items = _collect_result_items(result_payload)
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        task_id = _viewer_task_id(item, index)
        matched_entries: list[Any] = []
        matched_files: list[str] = []
        for file in trajectory_files:
            entries = file.get("entries")
            if not isinstance(entries, list):
                continue
            file_matches = [entry for entry in entries if _entry_matches_task(entry, task_id)]
            if not file_matches:
                continue
            matched_entries.extend(file_matches)
            if file.get("path"):
                matched_files.append(str(file.get("path")))
        rows.append(
            {
                "task_id": task_id,
                "status": _viewer_task_status(item),
                "score": _viewer_task_score(item),
                "error": _viewer_task_error(item),
                "trajectory_match_count": len(matched_entries),
                "trajectory_files": sorted(set(matched_files)),
                "usage": _trajectory_usage_totals(matched_entries),
                "raw": item,
            }
        )
    return rows


def _diagnostic_payload_from_artifacts(
    result_payload: Any,
    output_artifacts: list[dict[str, Any]],
) -> Any:
    if _collect_result_items(result_payload):
        return result_payload
    for artifact in output_artifacts:
        payload = artifact.get("payload")
        if _collect_result_items(payload):
            return payload
    return result_payload


def build_code_agent_viewer_payload(
    run_root: Path,
    summary: dict[str, Any],
) -> dict[str, Any]:
    cells: list[dict[str, Any]] = []
    for raw_cell in summary.get("cells", []) if isinstance(summary.get("cells"), list) else []:
        if not isinstance(raw_cell, dict):
            continue
        cell = dict(raw_cell)
        output_dir = Path(str(cell.get("output_dir") or ""))
        trajectory_dir = Path(
            str(cell.get("trajectory_dir") or output_dir.parent / "trajectories")
        )
        command_path = Path(str(cell.get("command_path") or output_dir.parent / "command.json"))
        stdout_path = Path(str(cell.get("stdout_path") or output_dir.parent / "stdout.log"))
        stderr_path = Path(str(cell.get("stderr_path") or output_dir.parent / "stderr.log"))
        result_path_raw = cell.get("result_path")
        result_path = Path(str(result_path_raw)) if result_path_raw else None
        cell["command"] = _load_json_artifact(command_path)
        cell["stdout_tail"] = _read_text_tail(stdout_path)
        cell["stderr_tail"] = _read_text_tail(stderr_path)
        cell["result_payload"] = _load_json_artifact(result_path)
        trajectory_files = _collect_viewer_trajectory_files(
            trajectory_dir,
            run_root=run_root,
        )
        trajectory_files.extend(
            _collect_viewer_output_trajectory_files(
                output_dir,
                run_root=run_root,
                existing_paths={
                    str(item.get("path"))
                    for item in trajectory_files
                    if isinstance(item, dict) and item.get("path")
                },
            )
        )
        cell["trajectory_files"] = trajectory_files
        output_artifacts = _collect_viewer_output_artifacts(
            output_dir,
            run_root=run_root,
        )
        cell["output_artifacts"] = output_artifacts
        cell["task_diagnostics"] = _build_viewer_task_diagnostics(
            _diagnostic_payload_from_artifacts(
                cell["result_payload"],
                output_artifacts,
            ),
            trajectory_files,
        )
        cells.append(cell)

    cells.sort(key=lambda c: (str(c.get("benchmark")), str(c.get("adapter"))))
    return {
        "schema": "code_agent_matrix_viewer_v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "run_root": str(run_root),
        "summary": summary,
        "cells": cells,
    }


def _code_agent_viewer_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Code Agent Matrix Run Viewer</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#182018; --muted:#5d665c; --line:#d8ded2; --accent:#116b5b; --bad:#a12222; --ok:#17633a; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { padding:18px 22px 10px; border-bottom:1px solid var(--line); background:#fff; position:sticky; top:0; z-index:2; }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; padding:14px 22px; }
    .card, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; margin-top:3px; }
    .layout { display:grid; grid-template-columns:320px 1fr; gap:12px; padding:0 22px 22px; }
    aside, section { min-width:0; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .controls { display:grid; gap:8px; padding:10px; }
    input, select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    .bench-list { max-height:62vh; overflow:auto; }
    .bench-item { width:100%; text-align:left; border:0; border-bottom:1px solid var(--line); background:#fff; padding:10px; cursor:pointer; }
    .bench-item:hover, .bench-item.active { background:#eef6f2; }
    .pill { display:inline-block; padding:1px 6px; border:1px solid var(--line); border-radius:999px; margin:2px 3px 0 0; font-size:11px; color:var(--muted); }
    .status-succeeded, .pass { color:var(--ok); font-weight:600; }
    .status-failed, .fail { color:var(--bad); font-weight:600; }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:7px; text-align:left; vertical-align:top; }
    th { background:#f7faf4; position:sticky; top:65px; }
    details { border-top:1px solid var(--line); }
    summary { cursor:pointer; padding:9px 12px; background:#fff; }
    pre { margin:0; padding:10px 12px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; max-height:520px; }
    .trajectory-step { border-top:1px solid var(--line); padding:10px 12px; }
    .trajectory-step h3 { margin:0 0 6px; font-size:13px; }
    .split { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    @media (max-width: 900px) { .layout { grid-template-columns:1fr; } th { top:0; } .split { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Code Agent Matrix Run Viewer</h1>
    <div id="run-meta" class="muted"></div>
  </header>
  <div class="cards" id="cards"></div>
  <main class="layout">
    <aside class="panel">
      <h2>Benchmarks</h2>
      <div class="controls">
        <input id="search" type="search" placeholder="Search benchmark, adapter, status..." />
        <select id="status"><option value="">all statuses</option></select>
      </div>
      <div id="bench-list" class="bench-list"></div>
    </aside>
    <section>
      <div class="panel">
        <h2 id="detail-title">Run Detail</h2>
        <div id="detail"></div>
      </div>
    </section>
  </main>
  <script src="./data.js"></script>
  <script>
    const data = window.BENCHMARK_RUN_DATA || { cells: [], summary: {} };
    let activeBenchmark = "";
    const text = (v) => v === null || v === undefined ? "" : String(v);
    const esc = (v) => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const json = (v) => esc(JSON.stringify(v, null, 2));
    const pct = (v) => typeof v === "number" ? v.toFixed(2) + "%" : "";
    function grouped() {
      const q = document.getElementById("search").value.toLowerCase();
      const st = document.getElementById("status").value;
      const groups = new Map();
      for (const c of data.cells) {
        const hay = [c.benchmark, c.adapter, c.status, c.failure_class, c.notes?.join(" ")].map(text).join(" ").toLowerCase();
        if (q && !hay.includes(q)) continue;
        if (st && c.status !== st) continue;
        if (!groups.has(c.benchmark)) groups.set(c.benchmark, []);
        groups.get(c.benchmark).push(c);
      }
      return [...groups.entries()].sort((a,b) => a[0].localeCompare(b[0]));
    }
    function renderCards() {
      const s = data.summary || {};
      const token = s.token_by_adapter || {};
      document.getElementById("run-meta").textContent = `${data.run_root || ""} · generated ${data.generated_at || s.generated_at || ""}`;
      const items = [
        ["Cells", data.cells.length],
        ["Benchmarks", new Set(data.cells.map(c => c.benchmark)).size],
        ["Succeeded", data.cells.filter(c => c.status === "succeeded").length],
        ["Failed", data.cells.filter(c => c.status === "failed").length],
        ["Eliza tokens", token.elizaos?.total_tokens ?? ""],
        ["OpenCode tokens", token.opencode?.total_tokens ?? ""],
      ];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => `<div class="card"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    }
    function renderFilters() {
      const statuses = [...new Set(data.cells.map(c => c.status).filter(Boolean))].sort();
      document.getElementById("status").innerHTML = `<option value="">all statuses</option>` + statuses.map(s => `<option>${esc(s)}</option>`).join("");
    }
    function renderList() {
      const groups = grouped();
      if (!activeBenchmark && groups.length) activeBenchmark = groups[0][0];
      if (!groups.some(([b]) => b === activeBenchmark) && groups.length) activeBenchmark = groups[0][0];
      document.getElementById("bench-list").innerHTML = groups.map(([b,cells]) => {
        const status = cells.map(c => `<span class="pill ${c.status === "succeeded" ? "status-succeeded" : "status-failed"}">${esc(c.adapter)} ${esc(c.status)}</span>`).join("");
        return `<button class="bench-item ${b === activeBenchmark ? "active" : ""}" data-bench="${esc(b)}"><strong>${esc(b)}</strong><br>${status}</button>`;
      }).join("");
      renderDetail();
    }
    function metricTable(cells) {
      return `<table><thead><tr><th>adapter</th><th>status</th><th>right/wrong/total</th><th>accuracy</th><th>input</th><th>output</th><th>total</th><th>cached</th><th>cache %</th><th>calls</th></tr></thead><tbody>` +
        cells.map(c => {
          const o = c.outcome_metrics || {}, t = c.token_metrics || {};
          return `<tr><td>${esc(c.adapter)}</td><td class="status-${esc(c.status)}">${esc(c.status)}</td><td>${esc(o.right)}/${esc(o.wrong)}/${esc(o.total)}</td><td>${esc(o.accuracy)}</td><td>${esc(t.input_tokens)}</td><td>${esc(t.output_tokens)}</td><td>${esc(t.total_tokens)}</td><td>${esc(t.cached_tokens)}</td><td>${esc(pct(t.cached_token_percent))}</td><td>${esc(t.llm_call_count)}</td></tr>`;
        }).join("") + `</tbody></table>`;
    }
    function trajectoryHtml(file) {
      const entries = Array.isArray(file.entries) ? file.entries : [];
      if (!entries.length) return `<pre>${json(file.payload)}</pre>`;
      return entries.map((e, i) => {
        const req = e.request || e.prompt || e.prompt_text || e.input || e.input_text || e.messages || e.model_input || e;
        const res = e.response || e.response_text || e.output || e.output_text || e.completion || e.completion_text || e.result || {};
        const usage = e.usage || e.response?.usage || e.token_metrics || e.tokenMetrics || e.cacheStats || e.trajectoryTotals || {};
        return `<div class="trajectory-step"><h3>${esc(file.path)} · step ${i}</h3><div class="split"><div><strong>input/request</strong><pre>${json(req)}</pre></div><div><strong>output/response</strong><pre>${json(res)}</pre></div></div><details><summary>usage/cache/raw</summary><pre>${json({ usage, raw: e })}</pre></details></div>`;
      }).join("");
    }
    function taskDiagnosticsHtml(c) {
      const rows = c.task_diagnostics || [];
      if (!rows.length) return '<div class="trajectory-step muted">No per-task result rows found.</div>';
      return `<table><thead><tr><th>task</th><th>status</th><th>score</th><th>error</th><th>trajectory matches</th><th>usage</th><th>raw</th></tr></thead><tbody>` +
        rows.map(r => `<tr>
          <td>${esc(r.task_id)}</td>
          <td>${esc(r.status)}</td>
          <td>${esc(r.score)}</td>
          <td>${esc(r.error)}</td>
          <td>${esc(r.trajectory_match_count)}<br>${(r.trajectory_files || []).map(f => `<span class="pill">${esc(f)}</span>`).join("")}</td>
          <td>prompt ${esc(r.usage?.prompt_tokens)}<br>completion ${esc(r.usage?.completion_tokens)}<br>total ${esc(r.usage?.total_tokens)}<br>cached ${esc(r.usage?.cached_tokens)}</td>
          <td><details><summary>raw</summary><pre>${json(r.raw)}</pre></details></td>
        </tr>`).join("") + `</tbody></table>`;
    }
    function renderCell(c) {
      return `<details open><summary><strong>${esc(c.adapter)}</strong> <span class="status-${esc(c.status)}">${esc(c.status)}</span> ${esc(c.failure_class || "")}</summary>
        <details><summary>Command</summary><pre>${json(c.command)}</pre></details>
        <details open><summary>Task Diagnostics (${(c.task_diagnostics || []).length})</summary>${taskDiagnosticsHtml(c)}</details>
        <details><summary>Result JSON</summary><pre>${json(c.result_payload)}</pre></details>
        <details><summary>Trajectories (${(c.trajectory_files || []).length})</summary>${(c.trajectory_files || []).map(trajectoryHtml).join("") || '<div class="trajectory-step muted">No trajectory files found.</div>'}</details>
        <details><summary>Output Artifacts (${(c.output_artifacts || []).length})</summary>${(c.output_artifacts || []).map(a => `<details><summary>${esc(a.path)} (${esc(a.size_bytes)} bytes)</summary><pre>${a.payload !== undefined ? json(a.payload) : a.text !== undefined ? esc(a.text) : esc("[binary or unsupported preview]")}</pre></details>`).join("")}</details>
        <details><summary>stdout</summary><pre>${esc(c.stdout_tail)}</pre></details>
        <details><summary>stderr</summary><pre>${esc(c.stderr_tail)}</pre></details>
      </details>`;
    }
    function renderDetail() {
      const cells = data.cells.filter(c => c.benchmark === activeBenchmark);
      document.getElementById("detail-title").textContent = activeBenchmark || "Run Detail";
      document.getElementById("detail").innerHTML = cells.length ? metricTable(cells) + cells.map(renderCell).join("") : '<div class="trajectory-step muted">No matching cells.</div>';
    }
    document.addEventListener("click", e => {
      const btn = e.target.closest(".bench-item");
      if (btn) { activeBenchmark = btn.dataset.bench; renderList(); }
    });
    document.getElementById("search").addEventListener("input", renderList);
    document.getElementById("status").addEventListener("change", renderList);
    renderCards(); renderFilters(); renderList();
  </script>
</body>
</html>
"""


def write_code_agent_run_viewer(
    run_root: Path,
    summary: dict[str, Any],
) -> dict[str, str]:
    viewer_dir = run_root / "viewer"
    viewer_dir.mkdir(parents=True, exist_ok=True)
    payload = build_code_agent_viewer_payload(run_root, summary)
    data_path = viewer_dir / "data.js"
    index_path = viewer_dir / "index.html"
    data_path.write_text(
        "window.BENCHMARK_RUN_DATA = "
        + json.dumps(payload, ensure_ascii=True, sort_keys=True)
        + ";\n",
        encoding="utf-8",
    )
    index_path.write_text(_code_agent_viewer_html(), encoding="utf-8")
    return {
        "viewer_index": str(index_path),
        "viewer_data": str(data_path),
    }


def discover_code_agent_summary_paths(search_root: Path) -> list[Path]:
    if search_root.is_file():
        return [search_root] if search_root.name == "summary.json" else []
    if not search_root.exists():
        return []
    return sorted(
        {
            path
            for path in search_root.rglob("summary.json")
            if path.is_file() and "viewer" not in path.parts
        }
    )


def _summary_run_root(summary_path: Path, summary: dict[str, Any]) -> Path:
    artifact_paths = summary.get("artifact_paths")
    if isinstance(artifact_paths, dict):
        run_root = artifact_paths.get("run_root")
        if run_root:
            return Path(str(run_root)).expanduser().resolve()
    run_config = summary.get("run_config")
    if isinstance(run_config, dict):
        run_root = run_config.get("run_root")
        if run_root:
            return Path(str(run_root)).expanduser().resolve()
    return summary_path.parent.resolve()


def _index_href(path: str | Path | None, *, index_dir: Path) -> str:
    if not path:
        return ""
    target = Path(str(path)).expanduser()
    if not target.is_absolute():
        target = (index_dir / target).resolve()
    try:
        return target.relative_to(index_dir).as_posix()
    except ValueError:
        return target.as_uri()


def build_code_agent_run_index_payload(
    index_root: Path,
    summary_paths: list[Path] | None = None,
    *,
    scan_root: Path | None = None,
) -> dict[str, Any]:
    index_root = index_root.expanduser().resolve()
    search_root = (scan_root or index_root).expanduser().resolve()
    paths = (
        summary_paths
        if summary_paths is not None
        else discover_code_agent_summary_paths(search_root)
    )
    runs: list[dict[str, Any]] = []
    benchmark_rows: list[dict[str, Any]] = []
    for summary_path in sorted({path.expanduser().resolve() for path in paths}):
        summary = read_json(summary_path)
        if not isinstance(summary, dict):
            continue
        run_root = _summary_run_root(summary_path, summary)
        artifact_paths = summary.get("artifact_paths")
        artifact_paths = artifact_paths if isinstance(artifact_paths, dict) else {}
        cells = summary.get("cells")
        cells = cells if isinstance(cells, list) else []
        comparisons = (
            (summary.get("head_to_head") or {}).get("comparisons")
            if isinstance(summary.get("head_to_head"), dict)
            else []
        )
        comparisons = comparisons if isinstance(comparisons, list) else []
        report_rows = summary.get("report_rows")
        report_rows = report_rows if isinstance(report_rows, list) else []
        report_row_by_benchmark = {
            str(row.get("benchmark")): row
            for row in report_rows
            if isinstance(row, dict) and row.get("benchmark")
        }
        run_id = run_root.name or summary_path.parent.name
        gate_summary = _code_agent_index_gate_summary(summary)
        run_record = {
            "run_id": run_id,
            "run_root": str(run_root),
            "summary_json": str(summary_path),
            "summary_href": _index_href(summary_path, index_dir=index_root),
            "viewer_index": artifact_paths.get("viewer_index") or str(run_root / "viewer" / "index.html"),
            "viewer_href": _index_href(
                artifact_paths.get("viewer_index") or run_root / "viewer" / "index.html",
                index_dir=index_root,
            ),
            "generated_at": summary.get("generated_at"),
            "mode": (summary.get("run_config") or {}).get("mode")
            if isinstance(summary.get("run_config"), dict)
            else None,
            "provider": (summary.get("run_config") or {}).get("provider")
            if isinstance(summary.get("run_config"), dict)
            else None,
            "model": (summary.get("run_config") or {}).get("model")
            if isinstance(summary.get("run_config"), dict)
            else None,
            "cell_count": len(cells),
            "benchmark_count": len({str(cell.get("benchmark")) for cell in cells if isinstance(cell, dict)}),
            "succeeded_count": sum(1 for cell in cells if isinstance(cell, dict) and cell.get("status") == "succeeded"),
            "failed_count": sum(1 for cell in cells if isinstance(cell, dict) and cell.get("status") == "failed"),
            "head_to_head": summary.get("head_to_head"),
            "token_by_adapter": summary.get("token_by_adapter"),
            "outcome_by_adapter": summary.get("outcome_by_adapter"),
            "gates": gate_summary,
            "artifact_paths": artifact_paths,
        }
        runs.append(run_record)
        for comparison in comparisons:
            if not isinstance(comparison, dict):
                continue
            report_row = report_row_by_benchmark.get(str(comparison.get("benchmark") or ""))
            report_row = report_row if isinstance(report_row, dict) else {}
            target_limit = _code_agent_index_result_limit(report_row.get("target_result_path"))
            baseline_limit = _code_agent_index_result_limit(report_row.get("baseline_result_path"))
            benchmark_rows.append(
                {
                    "run_id": run_id,
                    "run_root": str(run_root),
                    "viewer_href": run_record["viewer_href"],
                    "generated_at": run_record["generated_at"],
                    "run_mode": run_record.get("mode"),
                    "release_evidence_mode": str(run_record.get("mode") or "").startswith("live"),
                    "gates": {
                        key.removesuffix("_ok"): report_row.get(key)
                        for key in REPORT_ROW_FIELDS
                        if key.endswith("_gate_ok") or key == "release_readiness_ok"
                    },
                    "release_readiness_blocking_requirements": report_row.get(
                        "release_readiness_blocking_requirements",
                    ),
                    "release_readiness_unblock_command_ids": report_row.get(
                        "release_readiness_unblock_command_ids",
                    ),
                    "target_result_path": report_row.get("target_result_path"),
                    "baseline_result_path": report_row.get("baseline_result_path"),
                    "target_dataset_limit": target_limit,
                    "baseline_dataset_limit": baseline_limit,
                    **comparison,
                }
            )

    runs.sort(key=lambda run: str(run.get("generated_at") or run.get("run_id") or ""))
    benchmark_rows.sort(
        key=lambda row: (
            str(row.get("benchmark") or ""),
            str(row.get("generated_at") or ""),
            str(row.get("run_id") or ""),
        )
    )

    def row_preference(row: dict[str, Any]) -> tuple[int, int, int, int, str, str]:
        mode = str(row.get("run_mode") or "")
        target_total = row.get("target_total")
        status = str(row.get("status") or "")
        release_mode = 1 if mode.startswith("live") else 0
        five_examples = 1 if isinstance(target_total, int | float) and target_total >= 5 else 0
        scored = 1 if isinstance(target_total, int | float) else 0
        non_missing = 1 if status != "missing" else 0
        return (
            release_mode,
            five_examples,
            scored,
            non_missing,
            str(row.get("generated_at") or ""),
            str(row.get("run_id") or ""),
        )

    latest_by_benchmark: dict[str, dict[str, Any]] = {}
    for row in benchmark_rows:
        benchmark = str(row.get("benchmark") or "")
        if not benchmark:
            continue
        current = latest_by_benchmark.get(benchmark)
        if current is None or row_preference(row) >= row_preference(current):
            latest_by_benchmark[benchmark] = row
    return {
        "schema": "code_agent_matrix_run_index_v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "index_root": str(index_root),
        "scan_root": str(search_root),
        "summary_paths": [str(path.expanduser().resolve()) for path in paths],
        "runs": runs,
        "benchmark_rows": benchmark_rows,
        "latest_by_benchmark": latest_by_benchmark,
    }


def _code_agent_index_gate_summary(summary: dict[str, Any]) -> dict[str, Any]:
    gates: dict[str, Any] = {}
    for key in (
        "coverage_gate",
        "benchmark_gate",
        "required_stats_gate",
        "efficiency_gate",
        "no_regression_gate",
        "quality_guardrail_gate",
        "trajectory_review_gate",
        "live_report_gate",
        "report_gate",
        "release_readiness",
    ):
        value = summary.get(key)
        if isinstance(value, dict):
            gates[key] = {
                "ok": value.get("ok"),
                "message": value.get("message"),
            }
            if key == "release_readiness":
                gates[key]["blocking_requirements"] = value.get("blocking_requirements")
                gates[key]["unblock_commands"] = value.get("unblock_commands")
    return gates


def _code_agent_index_result_limit(path: Any) -> dict[str, Any]:
    if not isinstance(path, str) or not path:
        return {}
    payload = read_json(Path(path))
    if not isinstance(payload, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("dataset_version", "dataset", "available_task_count", "coverage_note"):
        value = payload.get(key)
        if value not in (None, ""):
            out[key] = value
    return out


def _code_agent_run_index_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Code Agent Matrix Run Index</title>
  <style>
    :root { --bg:#f6f7f4; --panel:#fff; --ink:#182018; --muted:#5f685d; --line:#d9dfd2; --accent:#0e6b59; --bad:#a12222; --ok:#17633a; --warn:#8a5a00; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { padding:18px 22px 10px; border-bottom:1px solid var(--line); background:#fff; position:sticky; top:0; z-index:2; }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; padding:14px 22px; }
    .card, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; margin-top:3px; }
    main { padding:0 22px 24px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f1f4ed; }
    .controls { display:grid; grid-template-columns:minmax(220px,1fr) 220px 220px; gap:8px; padding:10px; border-bottom:1px solid var(--line); }
    input, select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    table { width:100%; border-collapse:collapse; }
    th, td { border-bottom:1px solid var(--line); padding:7px; text-align:left; vertical-align:top; }
    th { background:#f7faf4; position:sticky; top:64px; z-index:1; }
    th button { appearance:none; border:0; background:transparent; color:inherit; padding:0; font:inherit; font-weight:600; cursor:pointer; text-align:left; }
    th button:hover { color:var(--accent); }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .status-inferior, .status-missing, .bad { color:var(--bad); font-weight:600; }
    .status-superior, .status-comparable, .ok { color:var(--ok); font-weight:600; }
    .status-weak, .warn { color:var(--warn); font-weight:600; }
    .pill { display:inline-block; padding:1px 6px; border:1px solid var(--line); border-radius:999px; margin:1px 3px 1px 0; font-size:11px; color:var(--muted); }
    details { border-top:1px solid var(--line); }
    summary { cursor:pointer; padding:9px 12px; background:#fff; }
    pre { margin:0; padding:10px 12px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; max-height:420px; }
    @media (max-width: 900px) { .controls { grid-template-columns:1fr; } th { position:static; } }
  </style>
</head>
<body>
  <header>
    <h1>Code Agent Matrix Run Index</h1>
    <div id="meta" class="muted"></div>
  </header>
  <div class="cards" id="cards"></div>
  <main>
    <section class="panel">
      <h2>Benchmark Comparisons Across Runs</h2>
      <div class="controls">
        <input id="search" type="search" placeholder="Search benchmark, run, status..." />
        <select id="benchmark"><option value="">all benchmarks</option></select>
        <select id="status"><option value="">all statuses</option></select>
      </div>
      <div id="comparisons"></div>
    </section>
    <section class="panel">
      <h2>Runs</h2>
      <div id="runs"></div>
    </section>
  </main>
  <script src="./index-data.js"></script>
  <script>
    const data = window.BENCHMARK_RUN_INDEX || { runs: [], benchmark_rows: [] };
    let comparisonSort = { key: "benchmark", dir: "asc" };
    let runSort = { key: "generated_at", dir: "desc" };
    const text = v => v === null || v === undefined ? "" : String(v);
    const esc = v => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const pct = v => typeof v === "number" ? v.toFixed(2) + "%" : "";
    const num = v => typeof v === "number" ? v.toLocaleString() : esc(v);
    const json = v => esc(JSON.stringify(v, null, 2));
    const sortValue = (row, key) => {
      const value = key.split(".").reduce((acc, part) => acc && acc[part], row);
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      return text(value).toLowerCase();
    };
    const sorted = (rows, state) => [...rows].sort((a,b) => {
      const av = sortValue(a, state.key), bv = sortValue(b, state.key);
      if (av < bv) return state.dir === "asc" ? -1 : 1;
      if (av > bv) return state.dir === "asc" ? 1 : -1;
      return 0;
    });
    const th = (label, key, kind) => `<th><button data-sort-kind="${kind}" data-sort-key="${esc(key)}">${esc(label)}</button></th>`;
    const gateHtml = gates => {
      if (!gates || typeof gates !== "object") return "";
      return Object.entries(gates).map(([key,value]) => `<span class="pill ${value === true ? "ok" : value === false ? "bad" : ""}">${esc(key)} ${value === true ? "ok" : value === false ? "blocked" : "n/a"}</span>`).join("");
    };
    function renderCards() {
      const rows = data.benchmark_rows || [];
      const runs = data.runs || [];
      const latest = Object.keys(data.latest_by_benchmark || {}).length;
      const items = [
        ["Runs", runs.length],
        ["Benchmark rows", rows.length],
        ["Latest benchmarks", latest],
        ["Inferior", rows.filter(r => r.status === "inferior").length],
        ["Weak", rows.filter(r => r.status === "weak").length],
        ["Comparable+", rows.filter(r => ["comparable", "superior"].includes(r.status)).length],
      ];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => `<div class="card"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
      document.getElementById("meta").textContent = `${data.index_root || ""} · generated ${data.generated_at || ""}`;
    }
    function renderFilters() {
      const benchmarks = [...new Set((data.benchmark_rows || []).map(r => r.benchmark).filter(Boolean))].sort();
      const statuses = [...new Set((data.benchmark_rows || []).map(r => r.status).filter(Boolean))].sort();
      document.getElementById("benchmark").innerHTML = `<option value="">all benchmarks</option>` + benchmarks.map(v => `<option>${esc(v)}</option>`).join("");
      document.getElementById("status").innerHTML = `<option value="">all statuses</option>` + statuses.map(v => `<option>${esc(v)}</option>`).join("");
    }
    function filteredRows() {
      const q = document.getElementById("search").value.toLowerCase();
      const bench = document.getElementById("benchmark").value;
      const status = document.getElementById("status").value;
      return (data.benchmark_rows || []).filter(r => {
        const hay = [r.benchmark, r.run_id, r.status, r.run_root].map(text).join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!bench || r.benchmark === bench) && (!status || r.status === status);
      });
    }
    function renderComparisons() {
      const rows = sorted(filteredRows(), comparisonSort);
      document.getElementById("comparisons").innerHTML = `<table><thead><tr>${[
        th("benchmark", "benchmark", "comparison"),
        th("run", "run_id", "comparison"),
        th("mode", "run_mode", "comparison"),
        th("status", "status", "comparison"),
        th("target", "target_accuracy", "comparison"),
        th("baseline", "baseline_accuracy", "comparison"),
        th("delta", "accuracy_delta", "comparison"),
        th("tokens", "total_token_delta", "comparison"),
        th("cache", "cached_token_percent_delta", "comparison"),
        th("calls", "llm_call_delta", "comparison"),
        "<th>gates</th>",
        "<th>viewer</th>",
      ].join("")}</tr></thead><tbody>` +
        rows.map(r => `<tr>
          <td>${esc(r.benchmark)}</td>
          <td><span class="muted">${esc(r.generated_at || "")}</span><br>${esc(r.run_id)}</td>
          <td>${esc(r.run_mode || "")}</td>
          <td class="status-${esc(r.status)}">${esc(r.status)}</td>
          <td>${esc(r.target_adapter)}<br>${esc(r.target_right)}/${esc(r.target_total)} · ${esc(r.target_accuracy)}</td>
          <td>${esc(r.baseline_adapter)}<br>${esc(r.baseline_right)}/${esc(r.baseline_total)} · ${esc(r.baseline_accuracy)}</td>
          <td>accuracy ${esc(r.accuracy_delta)}<br>right ${esc(r.right_delta)}</td>
          <td>target ${num(r.target_total_tokens)}<br>baseline ${num(r.baseline_total_tokens)}<br>delta ${num(r.total_token_delta)}</td>
          <td>target ${pct(r.target_cached_token_percent)}<br>baseline ${pct(r.baseline_cached_token_percent)}<br>delta ${pct(r.cached_token_percent_delta)}</td>
          <td>target ${esc(r.target_llm_call_count)}<br>baseline ${esc(r.baseline_llm_call_count)}<br>delta ${esc(r.llm_call_delta)}</td>
          <td>${gateHtml(r.gates)}${r.release_readiness_blocking_requirements ? `<br><span class="bad">${esc(r.release_readiness_blocking_requirements)}</span>` : ""}</td>
          <td><a href="${esc(r.viewer_href)}">open run</a></td>
        </tr>`).join("") + `</tbody></table>`;
    }
    function renderRuns() {
      const runs = sorted(data.runs || [], runSort);
      document.getElementById("runs").innerHTML = `<table><thead><tr>${[
        th("run", "run_id", "run"),
        th("generated", "generated_at", "run"),
        th("mode", "mode", "run"),
        "<th>status</th>",
        "<th>gates</th>",
        "<th>provider/model</th>",
        "<th>tokens</th>",
        "<th>links</th>",
      ].join("")}</tr></thead><tbody>` +
        runs.map(r => {
          const h = r.head_to_head || {};
          const counts = h.status_counts || {};
          const tok = r.token_by_adapter || {};
          const release = r.gates?.release_readiness || {};
          return `<tr>
            <td>${esc(r.run_id)}<br><span class="muted">${esc(r.run_root)}</span></td>
            <td>${esc(r.generated_at || "")}</td>
            <td>${esc(r.mode || "")}</td>
            <td>${Object.entries(counts).map(([k,v]) => `<span class="pill ${k === "inferior" || k === "missing" ? "bad" : k === "weak" ? "warn" : "ok"}">${esc(k)} ${esc(v)}</span>`).join("")}</td>
            <td>${Object.entries(r.gates || {}).map(([k,v]) => `<span class="pill ${v.ok === true ? "ok" : v.ok === false ? "bad" : ""}">${esc(k)} ${v.ok === true ? "ok" : v.ok === false ? "blocked" : "n/a"}</span>`).join("")}${Array.isArray(release.blocking_requirements) && release.blocking_requirements.length ? `<br><span class="bad">${esc(release.blocking_requirements.join(", "))}</span>` : ""}</td>
            <td>${esc(r.provider || "")}<br>${esc(r.model || "")}<br>${esc(r.mode || "")}</td>
            <td>${Object.entries(tok).map(([k,v]) => `<span class="pill">${esc(k)} ${num(v.total_tokens)}</span>`).join("")}</td>
            <td><a href="${esc(r.viewer_href)}">viewer</a><br><a href="${esc(r.summary_href)}">summary</a></td>
          </tr>`;
        }).join("") + `</tbody></table>`;
    }
    for (const id of ["search", "benchmark", "status"]) document.addEventListener("input", e => { if (e.target.id === id) renderComparisons(); });
    document.addEventListener("change", e => { if (["benchmark", "status"].includes(e.target.id)) renderComparisons(); });
    document.addEventListener("click", e => {
      const button = e.target.closest("button[data-sort-key]");
      if (!button) return;
      const state = button.dataset.sortKind === "run" ? runSort : comparisonSort;
      if (state.key === button.dataset.sortKey) state.dir = state.dir === "asc" ? "desc" : "asc";
      else { state.key = button.dataset.sortKey; state.dir = "asc"; }
      if (button.dataset.sortKind === "run") renderRuns();
      else renderComparisons();
    });
    renderCards(); renderFilters(); renderComparisons(); renderRuns();
  </script>
</body>
</html>
"""


def _analysis_percent(value: Any) -> str:
    return f"{value * 100:.1f}%" if isinstance(value, int | float) and math.isfinite(value) else "n/a"


def _analysis_number(value: Any) -> str:
    if not isinstance(value, int | float) or not math.isfinite(value):
        return "n/a"
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _analysis_cache_percent(value: Any) -> str:
    return f"{value:.2f}%" if isinstance(value, int | float) and math.isfinite(value) else "n/a"


def render_code_agent_run_index_analysis(payload: dict[str, Any]) -> str:
    rows = payload.get("benchmark_rows")
    rows = rows if isinstance(rows, list) else []
    runs = payload.get("runs")
    runs = runs if isinstance(runs, list) else []
    included = set(included_benchmark_ids())
    covered = {str(row.get("benchmark")) for row in rows if isinstance(row, dict) and row.get("benchmark")}
    latest_by_benchmark = payload.get("latest_by_benchmark")
    latest_by_benchmark = latest_by_benchmark if isinstance(latest_by_benchmark, dict) else {}
    run_by_id = {
        str(run.get("run_id")): run
        for run in runs
        if isinstance(run, dict) and run.get("run_id")
    }

    def row_run_mode(row: dict[str, Any]) -> str:
        if row.get("run_mode"):
            return str(row.get("run_mode") or "")
        run = run_by_id.get(str(row.get("run_id") or ""))
        if isinstance(run, dict):
            return str(run.get("mode") or "")
        return ""

    release_covered = {
        str(row.get("benchmark"))
        for row in rows
        if isinstance(row, dict)
        and row.get("benchmark")
        and row_run_mode(row).startswith("live")
        and isinstance(row.get("target_total"), int | float)
    }
    missing = sorted(included - release_covered)

    latest_rows = [
        row
        for benchmark, row in latest_by_benchmark.items()
        if benchmark in included and isinstance(row, dict)
    ]
    latest_under_five = [
        row
        for row in latest_rows
        if isinstance(row.get("target_total"), int | float) and row.get("target_total") < 5
    ]
    latest_missing_total = [
        row
        for row in latest_rows
        if not isinstance(row.get("target_total"), int | float)
    ]
    historical_under_five = [
        row
        for row in rows
        if isinstance(row, dict)
        and isinstance(row.get("target_total"), int | float)
        and row.get("target_total") < 5
        and latest_by_benchmark.get(str(row.get("benchmark") or "")) is not row
    ]
    lines = [
        "# Code Agent Benchmark Analysis",
        "",
        f"Generated: {payload.get('generated_at') or ''}",
        f"Aggregate viewer: {Path(str(payload.get('index_root') or '')).joinpath('index.html')}",
        f"Scan root: {payload.get('scan_root') or payload.get('index_root') or ''}",
        (
            f"Runs indexed: {len(runs)}; benchmark rows: {len(rows)}; "
            f"included manifest coverage: {len(covered & included)}/{len(included)}; "
            f"release/live scored coverage: {len(release_covered & included)}/{len(included)}."
        ),
        "",
        "## Head-to-head Rows",
        "",
        "| benchmark | run | mode | status | elizaOS | OpenCode | token delta | cache delta | viewer |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in sorted(
        (row for row in rows if isinstance(row, dict)),
        key=lambda item: (str(item.get("benchmark") or ""), str(item.get("generated_at") or "")),
    ):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(row.get("benchmark") or ""),
                    str(row.get("run_id") or ""),
                    row_run_mode(row),
                    str(row.get("status") or "n/a"),
                    (
                        f"{_analysis_percent(row.get('target_accuracy'))} "
                        f"({_analysis_number(row.get('target_right'))}/{_analysis_number(row.get('target_total'))})"
                    ),
                    (
                        f"{_analysis_percent(row.get('baseline_accuracy'))} "
                        f"({_analysis_number(row.get('baseline_right'))}/{_analysis_number(row.get('baseline_total'))})"
                    ),
                    _analysis_number(row.get("total_token_delta")),
                    _analysis_cache_percent(row.get("cached_token_percent_delta")),
                    str(row.get("viewer_href") or ""),
                ]
            )
            + " |"
        )

    status_counts: dict[str, int] = {}
    for row in rows:
        if isinstance(row, dict):
            status = str(row.get("status") or "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1
    lines.extend(
        [
            "",
            "## Readout",
            "",
            "- Status counts: "
            + ", ".join(f"`{key}` {value}" for key, value in sorted(status_counts.items())),
            "- Rows with lower elizaOS accuracy than OpenCode: "
            + (
                ", ".join(
                    f"`{row.get('benchmark')}`"
                    for row in rows
                    if isinstance(row, dict)
                    and isinstance(row.get("accuracy_delta"), int | float)
                    and row.get("accuracy_delta") < 0
                )
                or "none"
            )
            + ".",
            "- Rows with no successful scored examples for elizaOS: "
            + (
                ", ".join(
                    f"`{row.get('benchmark')}`"
                    for row in rows
                    if isinstance(row, dict)
                    and row.get("target_right") == 0
                    and row.get("target_total")
                )
                or "none"
            )
            + ".",
            "",
            "## Coverage Caveats",
            "",
            "- Included manifest rows not indexed with a live/imported viewer: "
            + (", ".join(f"`{item}`" for item in missing) if missing else "none")
            + ".",
            "- Latest included rows with fewer than five target examples: "
            + (
                ", ".join(
                    (
                        f"`{row.get('benchmark')}` "
                        f"({_analysis_number(row.get('target_total'))}, {row_run_mode(row) or 'unknown mode'}"
                        + (
                            f"; {row.get('target_dataset_limit', {}).get('coverage_note')}"
                            if isinstance(row.get("target_dataset_limit"), dict)
                            and row.get("target_dataset_limit", {}).get("coverage_note")
                            else ""
                        )
                        + ")"
                    )
                    for row in latest_under_five
                )
                or "none"
            )
            + ".",
            "- Latest included rows without a scored target total: "
            + (
                ", ".join(
                    f"`{row.get('benchmark')}` ({row_run_mode(row) or 'unknown mode'})"
                    for row in latest_missing_total
                )
                or "none"
            )
            + ".",
            "- Historical rows with fewer than five target examples retained for comparison: "
            + (
                ", ".join(
                    f"`{row.get('benchmark')}` ({_analysis_number(row.get('target_total'))}, {row_run_mode(row) or 'unknown mode'})"
                    for row in historical_under_five
                )
                or "none"
            )
            + ".",
        ]
    )
    return "\n".join(lines) + "\n"


def write_code_agent_run_index(
    index_root: Path,
    *,
    summary_paths: list[Path] | None = None,
    scan_root: Path | None = None,
) -> dict[str, str]:
    index_root = index_root.expanduser().resolve()
    index_root.mkdir(parents=True, exist_ok=True)
    payload = build_code_agent_run_index_payload(
        index_root,
        summary_paths,
        scan_root=scan_root,
    )
    index_path = index_root / "index.html"
    data_path = index_root / "index-data.js"
    analysis_path = index_root / "analysis.md"
    data_path.write_text(
        "window.BENCHMARK_RUN_INDEX = "
        + json.dumps(payload, ensure_ascii=True, sort_keys=True)
        + ";\n",
        encoding="utf-8",
    )
    index_path.write_text(_code_agent_run_index_html(), encoding="utf-8")
    analysis_path.write_text(
        render_code_agent_run_index_analysis(payload),
        encoding="utf-8",
    )
    return {
        "index_root": str(index_root),
        "index_html": str(index_path),
        "index_data": str(data_path),
        "analysis_md": str(analysis_path),
        "run_count": str(len(payload.get("runs") or [])),
    }


def write_code_agent_latest_snapshots(
    latest_dir: Path,
    summary: dict[str, Any],
) -> dict[str, Any]:
    """Write one publishable latest JSON row per code-agent comparison."""

    latest_dir.mkdir(parents=True, exist_ok=True)
    rows = summary.get("report_rows")
    rows = rows if isinstance(rows, list) else []
    generated_at = str(summary.get("generated_at") or datetime.now(UTC).isoformat())
    run_config = summary.get("run_config")
    run_config = run_config if isinstance(run_config, dict) else {}
    written: list[str] = []
    expected_snapshot_paths: set[Path] = set()
    index: dict[str, Any] = {
        "updated_at": generated_at,
        "latest": {},
        "code_agent_matrix": {
            "summary_json": str(
                (summary.get("artifact_paths") or {}).get("summary_json") or ""
            ),
            "run_root": str(run_config.get("run_root") or ""),
            "target_adapter": DEFAULT_TARGET_ADAPTER,
            "baseline_adapter": DEFAULT_BASELINE_ADAPTER,
            "row_count": 0,
        },
        "matrix_contract": {
            "status": "complete",
            "summary": {
                "unsupported_real_cells": 0,
                "missing_required_real_cells": 0,
                "failed_required_real_cells": 0,
                "no_required_real_harness_benchmarks": 0,
            },
            "benchmarks": {},
        },
    }
    contract_benchmarks = index["matrix_contract"]["benchmarks"]
    failed_required = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        benchmark = str(row.get("benchmark") or "").strip()
        if not benchmark:
            continue
        score = row.get("target_accuracy")
        has_score = _is_finite_number(score)
        payload = {
            **row,
            "updated_at": generated_at,
            "benchmark_id": benchmark,
            "benchmark_directory": benchmark,
            "agent": CODE_AGENT_LATEST_AGENT,
            "provider": run_config.get("provider") or row.get("provider"),
            "model": run_config.get("model") or row.get("model"),
            "status": "pending",
            "comparison_status": row.get("status"),
            "score": float(score) if has_score else None,
            "unit": "accuracy",
            "higher_is_better": True,
            "run_root": run_config.get("run_root") or row.get("run_root"),
            "metrics": {
                "target_right": row.get("target_right"),
                "target_wrong": row.get("target_wrong"),
                "target_total": row.get("target_total"),
                "baseline_right": row.get("baseline_right"),
                "baseline_wrong": row.get("baseline_wrong"),
                "baseline_total": row.get("baseline_total"),
                "accuracy_delta": row.get("accuracy_delta"),
                "input_token_delta": row.get("input_token_delta"),
                "output_token_delta": row.get("output_token_delta"),
                "total_token_delta": row.get("total_token_delta"),
                "cached_token_percent_delta": row.get("cached_token_percent_delta"),
                "llm_call_delta": row.get("llm_call_delta"),
            },
            "token_metrics": {
                "target_input_tokens": row.get("target_input_tokens"),
                "target_output_tokens": row.get("target_output_tokens"),
                "target_total_tokens": row.get("target_total_tokens"),
                "target_cached_token_percent": row.get("target_cached_token_percent"),
                "target_llm_call_count": row.get("target_llm_call_count"),
                "baseline_input_tokens": row.get("baseline_input_tokens"),
                "baseline_output_tokens": row.get("baseline_output_tokens"),
                "baseline_total_tokens": row.get("baseline_total_tokens"),
                "baseline_cached_token_percent": row.get("baseline_cached_token_percent"),
                "baseline_llm_call_count": row.get("baseline_llm_call_count"),
            },
        }
        payload = _json_safe_value(payload)
        failure_reasons = _code_agent_latest_failure_reasons(payload)
        latest_status = "succeeded" if not failure_reasons else "failed"
        failure_reason = ", ".join(failure_reasons)
        payload["status"] = latest_status
        payload["failure_reason"] = failure_reason
        payload["failure_reasons"] = failure_reasons
        snapshot_path = (
            latest_dir
            / f"{sanitize(benchmark)}__{sanitize(CODE_AGENT_LATEST_AGENT)}.json"
        )
        expected_snapshot_paths.add(snapshot_path)
        snapshot_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True),
            encoding="utf-8",
        )
        written.append(str(snapshot_path))
        key = f"{benchmark}::{CODE_AGENT_LATEST_AGENT}"
        index["latest"][key] = {
            "path": str(snapshot_path),
            "score": payload["score"],
            "status": latest_status,
            "comparison_status": payload["comparison_status"],
            "reason": failure_reason,
            "updated_at": generated_at,
        }
        if latest_status != "succeeded":
            failed_required += 1
        contract_benchmarks[benchmark] = {
            "complete": latest_status == "succeeded",
            "cells": {
                CODE_AGENT_LATEST_AGENT: {
                    "required": True,
                    "state": latest_status,
                    "status": latest_status,
                    "score": payload["score"],
                    "reason": failure_reason,
                }
            },
        }
    index["code_agent_matrix"]["row_count"] = len(written)
    if failed_required:
        index["matrix_contract"]["status"] = "incomplete"
        index["matrix_contract"]["summary"]["failed_required_real_cells"] = failed_required
    if not written:
        index["matrix_contract"]["status"] = "incomplete"
        index["matrix_contract"]["summary"]["no_required_real_harness_benchmarks"] = 1
    stale_rows = _prune_stale_code_agent_latest_rows(
        latest_dir,
        expected_paths=expected_snapshot_paths,
    )
    index["code_agent_matrix"]["stale_row_count"] = len(stale_rows)
    index_path = latest_dir / "index.json"
    index_path.write_text(
        json.dumps(index, indent=2, sort_keys=True, ensure_ascii=True),
        encoding="utf-8",
    )
    return {
        "latest_dir": str(latest_dir),
        "latest_index": str(index_path),
        "latest_rows": written,
        "stale_latest_rows_pruned": [str(path) for path in stale_rows],
    }


def _prune_stale_code_agent_latest_rows(
    latest_dir: Path,
    *,
    expected_paths: set[Path],
) -> list[Path]:
    stale_paths: list[Path] = []
    suffix = f"__{sanitize(CODE_AGENT_LATEST_AGENT)}.json"
    expected_resolved = {path.resolve() for path in expected_paths}
    for path in latest_dir.glob(f"*{suffix}"):
        if path.resolve() in expected_resolved:
            continue
        try:
            path.unlink()
        except OSError:
            continue
        stale_paths.append(path)
    return stale_paths


def _code_agent_latest_failure_reasons(payload: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if not _is_finite_number(payload.get("score")):
        reasons.append("missing numeric score")
    if str(payload.get("mode") or "").strip() != "live":
        reasons.append("not live mode")
    comparison_status = str(payload.get("comparison_status") or "").strip()
    if comparison_status not in CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES:
        reasons.append("not comparable or better")
    expected_status = expected_code_agent_comparison_status(payload)
    if expected_status is not None and comparison_status != expected_status:
        reasons.append(f"comparison status should be {expected_status}")
    for key in CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            reasons.append(f"missing {key}")
    for key in CODE_AGENT_LATEST_REQUIRED_NUMERIC_FIELDS:
        if not _is_finite_number(payload.get(key)):
            reasons.append(f"missing numeric {key}")
    for key in CODE_AGENT_LATEST_REQUIRED_TRUE_FIELDS:
        if payload.get(key) is not True:
            reasons.append(f"{key} is not true")
    total_delta = payload.get("total_token_delta")
    if _is_finite_number(total_delta) and float(total_delta) > 0:
        reasons.append("total tokens worse")
    call_delta = payload.get("llm_call_delta")
    if _is_finite_number(call_delta) and float(call_delta) > 0:
        reasons.append("LLM calls worse")
    cache_delta = payload.get("cached_token_percent_delta")
    if _is_finite_number(cache_delta) and float(cache_delta) < 0:
        reasons.append("cached-token percent worse")
    return reasons


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _json_safe_value(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_safe_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_json_safe_value(child) for child in value]
    if isinstance(value, tuple):
        return [_json_safe_value(child) for child in value]
    return value


def write_preflight_artifacts(
    *,
    run_root: Path,
    args: argparse.Namespace,
    cell_pairs: tuple[tuple[str, str], ...],
    preflight: dict[str, Any],
) -> dict[str, Any]:
    preflight_json = run_root / "preflight.json"
    preflight_md = run_root / "preflight.md"
    exit_code = EXIT_OK if preflight.get("ok") else EXIT_PREFLIGHT_FAILED
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
        "exit_code": exit_code,
        "exit_reason": exit_reason_for_code(exit_code),
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
    summary["deferred_promotion_queue"] = build_deferred_promotion_queue(summary)
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
        "publish_latest_dir": str(args.publish_latest_dir or ""),
        "swe_bench_pro_evaluator_backend": os.environ.get(
            "SWE_BENCH_PRO_EVALUATOR_BACKEND", ""
        ).strip(),
        "swe_bench_pro_eval_num_workers": os.environ.get(
            "SWE_BENCH_PRO_EVAL_NUM_WORKERS", ""
        ).strip(),
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
        "enforce_release_readiness": bool(args.enforce_release_readiness),
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
                f"SWE-bench Pro evaluator backend: {run_config.get('swe_bench_pro_evaluator_backend', '')}",
                f"SWE-bench Pro eval workers: {run_config.get('swe_bench_pro_eval_num_workers', '')}",
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
                f"Enforce release readiness: {run_config.get('enforce_release_readiness')}",
            ]
        )
    if "exit_code" in summary or "exit_reason" in summary:
        lines.extend(
            [
                "",
                "## Run Result",
                "",
                f"Exit code: {summary.get('exit_code', '')}",
                f"Exit reason: {summary.get('exit_reason', '')}",
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
                f"Quality guardrail summary: {preflight.get('quality_guardrail_summary') or 'missing'} ({'present' if preflight.get('quality_guardrail_summary_present') else 'missing'}, {'required' if preflight.get('quality_guardrail_summary_required') else 'not required'}, {'clean' if preflight.get('quality_guardrail_summary_ok') else 'not clean' if preflight.get('quality_guardrail_summary_ok') is False else 'not checked'})",
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
        guardrail_findings = preflight.get("quality_guardrail_summary_blocking_findings")
        if isinstance(guardrail_findings, list) and guardrail_findings:
            lines.extend(
                [
                    "",
                    "### Quality Guardrail Findings",
                    "",
                    "| scope | reason | value | next action |",
                    "| --- | --- | --- | --- |",
                ]
            )
            for finding in guardrail_findings:
                if not isinstance(finding, dict):
                    continue
                lines.append(
                    "| {scope} | {reason} | {value} | {next_action} |".format(
                        scope=finding.get("scope", ""),
                        reason=finding.get("reason", ""),
                        value=finding.get("value", ""),
                        next_action=finding.get("next_action", ""),
                    )
                )
        unblock_steps = preflight.get("unblock_steps")
        if isinstance(unblock_steps, list) and unblock_steps:
            lines.extend(
                [
                    "",
                    "### Preflight Unblock Steps",
                    "",
                    "| kind | title | action | command |",
                    "| --- | --- | --- | --- |",
                ]
            )
            for step in unblock_steps:
                if not isinstance(step, dict):
                    continue
                lines.append(
                    "| {kind} | {title} | {action} | `{command}` |".format(
                        kind=step.get("kind", ""),
                        title=step.get("title", ""),
                        action=step.get("action", ""),
                        command=str(step.get("command", "")).replace("`", "\\`"),
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
    release_readiness = summary.get("release_readiness")
    if isinstance(release_readiness, dict):
        lines.extend(
            [
                "",
                "## Release Readiness",
                "",
                f"Status: {'ok' if release_readiness.get('ok') else 'blocked'}",
                f"Message: {release_readiness.get('message', '')}",
                f"Required checks: {release_readiness.get('passed_required_count', 0)}/{release_readiness.get('required_count', 0)}",
                f"Blocking requirements: {', '.join(release_readiness.get('blocking_requirements') or []) or '(none)'}",
            ]
        )
        checks = release_readiness.get("checks")
        if isinstance(checks, list) and checks:
            lines.extend(
                [
                    "",
                    "| id | required | ok | evidence | next action |",
                    "| --- | --- | --- | --- | --- |",
                ]
            )
            for check in checks:
                if not isinstance(check, dict):
                    continue
                lines.append(
                    "| {id} | {required} | {ok} | {evidence} | {next_action} |".format(
                        id=check.get("id", ""),
                        required=check.get("required"),
                        ok=check.get("ok"),
                        evidence=check.get("evidence", ""),
                        next_action=check.get("next_action", ""),
                    )
                )
        unblock_commands = release_readiness.get("unblock_commands")
        if isinstance(unblock_commands, list) and unblock_commands:
            lines.extend(
                [
                    "",
                    "### Release Unblock Commands",
                    "",
                    "| id | requirements | command |",
                    "| --- | --- | --- |",
                ]
            )
            for command in unblock_commands:
                if not isinstance(command, dict):
                    continue
                requirements = command.get("requirements")
                lines.append(
                    "| {id} | {requirements} | `{command_template}` |".format(
                        id=command.get("id", ""),
                        requirements=", ".join(requirements)
                        if isinstance(requirements, list)
                        else "",
                        command_template=str(command.get("command_template", "")).replace("`", "\\`"),
                    )
                )
    next_commands = summary.get("next_commands")
    if isinstance(next_commands, dict) and next_commands:
        lines.extend(["", "## Next Commands", ""])
        for label in (
            "retry_preflight",
            "live_evidence",
            "deferred_live_evidence",
            "release_preflight",
            "release_comparable",
        ):
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
                    "| benchmark | adapter | trajectory dir | files | turns | cached % | notes | rerun |",
                    "| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
                ]
            )
            for cell in blocking_cells:
                if not isinstance(cell, dict):
                    continue
                lines.append(
                    "| {benchmark} | {adapter} | {trajectory_dir} | {files} | {turns} | {cached_percent} | {notes} | `{rerun}` |".format(
                        benchmark=cell.get("benchmark", ""),
                        adapter=cell.get("adapter", ""),
                        trajectory_dir=cell.get("trajectory_dir", ""),
                        files=fmt(cell.get("trajectory_file_count"), 0),
                        turns=fmt(cell.get("trajectory_turn_count"), 0),
                        cached_percent=fmt(cell.get("cached_token_percent"), 2),
                        notes=", ".join(str(note) for note in cell.get("review_notes") or []),
                        rerun=cell.get("rerun_command_template", ""),
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
        audit = coverage.get("repo_local_audit")
        if isinstance(audit, dict):
            missing_manifest = audit.get("missing_manifest_directories")
            missing_manifest = missing_manifest if isinstance(missing_manifest, list) else []
            lines.extend(
                [
                    "",
                    "### Repo-Local Coverage Audit",
                    "",
                    f"Status: {'ok' if audit.get('ok') else 'blocked'}",
                    f"Audited directories: {audit.get('existing_directory_count', 0)}/{audit.get('directory_count', 0)}",
                    f"Message: {audit.get('message', '')}",
                ]
            )
            if missing_manifest:
                lines.extend(
                    [
                        "",
                        "| directory | benchmark | domains |",
                        "| --- | --- | --- |",
                    ]
                )
                for item in missing_manifest:
                    if not isinstance(item, dict):
                        continue
                    lines.append(
                        "| {directory} | {benchmark} | {domains} |".format(
                            directory=item.get("directory", ""),
                            benchmark=item.get("benchmark", ""),
                            domains=", ".join(str(domain) for domain in item.get("domains") or []),
                        )
                    )
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
                    "| priority | benchmark | domains | reason | promotion requirements |",
                    "| --- | --- | --- | --- | --- |",
                ]
            )
            for item in deferred:
                if not isinstance(item, dict):
                    continue
                lines.append(
                    "| {priority} | {benchmark} | {domains} | {reason} | {requirements} |".format(
                        priority=item.get("promotion_priority", ""),
                        benchmark=item.get("benchmark", ""),
                        domains=", ".join(str(domain) for domain in item.get("domains") or []),
                        reason=item.get("reason", ""),
                        requirements="; ".join(
                            str(requirement)
                            for requirement in item.get("promotion_requirements") or []
                        ),
                    )
                )
    promotion_queue = summary.get("deferred_promotion_queue")
    if isinstance(promotion_queue, list) and promotion_queue:
        lines.extend(
            [
                "",
                "## Deferred Promotion Queue",
                "",
                "| priority | benchmark | domains | next action | remaining | evidence command |",
                "| --- | --- | --- | --- | ---: | --- |",
            ]
        )
        for item in promotion_queue:
            if not isinstance(item, dict):
                continue
            lines.append(
                "| {priority} | {benchmark} | {domains} | {next_action} | {remaining} | `{command}` |".format(
                    priority=item.get("priority", ""),
                    benchmark=item.get("benchmark", ""),
                    domains=", ".join(str(domain) for domain in item.get("domains") or []),
                    next_action=item.get("next_action", ""),
                    remaining=item.get("remaining_count", ""),
                    command=item.get("evidence_command_template", ""),
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
                "| benchmark | status | reasons | accuracy delta | total token delta | cached % delta | LLM call delta | rerun |",
                "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
            ]
        )
        for item in efficiency_queue:
            if not isinstance(item, dict):
                continue
            lines.append(
                "| {benchmark} | {status} | {reasons} | {accuracy_delta} | {token_delta} | {cached_delta} | {llm_delta} | `{rerun}` |".format(
                    benchmark=item.get("benchmark", ""),
                    status=item.get("status", ""),
                    reasons="; ".join(str(reason) for reason in item.get("reasons") or []),
                    accuracy_delta=fmt(item.get("accuracy_delta")),
                    token_delta=fmt(item.get("total_token_delta"), 0),
                    cached_delta=fmt(item.get("cached_token_percent_delta"), 2),
                    llm_delta=fmt(item.get("llm_call_delta"), 0),
                    rerun=item.get("rerun_command_template", ""),
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
                "| priority | benchmark | status | diagnosis | focus | next action | accuracy delta | target failure | baseline failure | target trajectories | baseline trajectories |",
                "| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
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
                "| {priority} | {benchmark} | {status} | {diagnosis} | {focus} | {next_action} | {accuracy_delta} | {target_failure} | {baseline_failure} | {target_trajectory} | {baseline_trajectory} |".format(
                    priority=item.get("priority", ""),
                    benchmark=item.get("benchmark", ""),
                    status=item.get("status", ""),
                    diagnosis=item.get("primary_diagnosis") or "",
                    focus=", ".join(str(focus) for focus in item.get("suggested_focus") or []),
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
        lines.extend(
            [
                "",
                "### Trajectory Deltas",
                "",
                "| benchmark | turn delta | input delta | output delta | total delta | cached % delta | repeated prefix delta | mean latency delta | p95 latency delta |",
                "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for item in improvement_queue:
            if not isinstance(item, dict):
                continue
            delta = item.get("trajectory_delta")
            if not isinstance(delta, dict):
                continue
            lines.append(
                "| {benchmark} | {turn_delta} | {input_delta} | {output_delta} | {total_delta} | {cached_delta} | {repeat_delta} | {mean_latency_delta} | {p95_latency_delta} |".format(
                    benchmark=item.get("benchmark", ""),
                    turn_delta=fmt(delta.get("turn_delta"), 0),
                    input_delta=fmt(delta.get("input_token_delta"), 0),
                    output_delta=fmt(delta.get("output_token_delta"), 0),
                    total_delta=fmt(delta.get("total_token_delta"), 0),
                    cached_delta=fmt(delta.get("cached_token_percent_delta"), 2),
                    repeat_delta=fmt(delta.get("repeated_prefix_delta"), 0),
                    mean_latency_delta=fmt(delta.get("mean_latency_ms_delta"), 2),
                    p95_latency_delta=fmt(delta.get("p95_latency_ms_delta"), 2),
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
                command_path=str(cell_dir / "command.json"),
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
        help=(
            "Path to non-code validate-latest-readiness JSON output. Generate with: "
            f"{NON_CODE_GUARDRAIL_COMMAND}"
        ),
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
    parser.add_argument(
        "--enforce-release-readiness",
        action="store_true",
        help="Exit nonzero unless the final release-readiness checklist passes.",
    )
    parser.add_argument("--force", action="store_true", help="Re-run cells even when cell-result.json exists.")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing cell-result.json files.")
    parser.add_argument("--summarize", default="", help="Summarize an existing run root instead of executing.")
    parser.add_argument(
        "--publish-latest-dir",
        default="",
        help="Write code-agent head-to-head latest JSON snapshots to this directory.",
    )
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
    parser.add_argument(
        "--write-run-index",
        default="",
        help="Write a multi-run HTML index under this directory and exit.",
    )
    parser.add_argument(
        "--index-scan-root",
        default="",
        help="Directory to scan for summary.json files when writing a run index.",
    )
    parser.add_argument(
        "--index-summary",
        action="append",
        default=[],
        help="Summary JSON to include in --write-run-index. May be passed multiple times; defaults to scanning the index directory.",
    )
    parser.add_argument(
        "--update-run-index",
        nargs="?",
        const="__default__",
        default="",
        help=(
            "After a normal run, update a multi-run HTML index. With no value, "
            "writes <run-root-parent>/index and scans <run-root-parent>."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = workspace_root()
    if args.write_run_index:
        index_root = Path(args.write_run_index).expanduser().resolve()
        scan_root = (
            Path(args.index_scan_root).expanduser().resolve()
            if args.index_scan_root
            else None
        )
        summary_paths = [
            Path(path).expanduser().resolve()
            for path in (args.index_summary or [])
            if str(path).strip()
        ]
        paths = write_code_agent_run_index(
            index_root,
            summary_paths=summary_paths or None,
            scan_root=scan_root,
        )
        print(json.dumps(paths, indent=2, sort_keys=True))
        return EXIT_OK

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
            require_quality_guardrail_summary=bool(args.enforce_release_readiness),
            quality_guardrail_summary=str(args.quality_guardrail_summary or ""),
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
            write_preflight_artifacts(
                run_root=run_root,
                args=args,
                cell_pairs=cell_pairs,
                preflight=preflight,
            )
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
    summary["next_commands"] = _preflight_next_commands(
        args=args,
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
    summary["efficiency_queue"] = build_efficiency_queue(
        summary["head_to_head"],
        run_config=summary["run_config"],
    )
    summary["deferred_promotion_queue"] = build_deferred_promotion_queue(summary)
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
    summary["release_readiness"] = build_release_readiness(summary)
    summary["report_rows"] = build_report_rows(summary)
    summary["artifact_paths"] = {
        "run_root": str(run_root),
        "summary_json": str(run_root / "summary.json"),
        "summary_md": str(run_root / "summary.md"),
        **write_report_rows(run_root, summary["report_rows"]),
    }
    summary["artifact_paths"].update(write_code_agent_run_viewer(run_root, summary))
    if args.publish_latest_dir:
        summary["artifact_paths"].update(
            write_code_agent_latest_snapshots(
                Path(args.publish_latest_dir).expanduser().resolve(),
                summary,
            )
        )
    selected_exit_code = select_enforced_exit_code(args, summary)
    summary["exit_code"] = selected_exit_code
    summary["exit_reason"] = exit_reason_for_code(selected_exit_code)
    write_json(run_root / "summary.json", summary)
    (run_root / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    if args.update_run_index:
        index_root = (
            run_root.parent / "index"
            if args.update_run_index == "__default__"
            else Path(args.update_run_index).expanduser().resolve()
        )
        summary["artifact_paths"]["run_index"] = write_code_agent_run_index(
            index_root,
            scan_root=run_root.parent,
        )
        write_json(run_root / "summary.json", summary)
        (run_root / "summary.md").write_text(render_markdown(summary), encoding="utf-8")
    print(json.dumps({"run_root": str(run_root), "summary": str(run_root / "summary.json")}, indent=2))
    return selected_exit_code


def select_enforced_exit_code(args: argparse.Namespace, summary: dict[str, Any]) -> int:
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
    release_readiness = summary.get("release_readiness")
    if (
        args.enforce_release_readiness
        and isinstance(release_readiness, dict)
        and not release_readiness.get("ok")
    ):
        return EXIT_RELEASE_READINESS_FAILED
    return EXIT_OK


def exit_reason_for_code(code: int) -> str:
    for spec_code, name, _description in EXIT_CODE_SPECS:
        if spec_code == code:
            return name
    return "unknown"


if __name__ == "__main__":
    raise SystemExit(main())
